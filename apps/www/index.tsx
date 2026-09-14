///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useCallback, useEffect, useRef, useState } from "react";
import { HiOutlineLockClosed } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Mailbox, Message, MessageClassification, getMessage, getMessageRawContent, listMessages } from "@rapidmx/react-shared/mail/mailApi.js";
import { Label, listLabels } from "@rapidmx/react-shared/mail/labelsApi.js";
import { ConversationSummary, listConversations } from "@rapidmx/react-shared/mail/conversationsApi.js";
import { SearchResult, search as searchMailbox } from "@rapidmx/react-shared/search/searchApi.js";
import { parseSearchQuery, type ParsedSearchQuery } from "@rapidmx/react-shared/search/queryGrammar.js";
import { normalizeServerScores } from "@rapidmx/react-shared/search/searchScoring.js";
import { searchEncryptedCandidates } from "@rapidmx/react-shared/search/searchTier3.js";
import { searchLocalIndex } from "../shared/search/searchTier2.js";
import type { Coverage } from "../shared/search/localIndexWorker.js";
import { getUnlockedKeys, UnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import { evaluateMessageSecurity } from "@rapidmx/react-shared/crypto/messageSecurity.js";
import { useMarkMessageRead, useMessageAttachments } from "@rapidmx/react-shared/mail/mailDetailHooks.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import MailShell, {
    AggregateFolderType,
    MailboxFolders,
    MailShellProps,
    useMailShell,
} from "../shared/components/mail/layout/MailShell.js";
import MessageDetailPane from "../shared/components/mail/MessageDetailPane.js";
import ConversationList from "../shared/components/mail/ConversationList.js";
import ConversationThreadPane from "../shared/components/mail/ConversationThreadPane.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Skeleton from "@rapidmx/react-shared/components/feedback/Skeleton.js";
import { useUnlockPrompt } from "../shared/components/layout/UnlockPromptProvider.js";

type ViewMode = "date" | "conversation";

const MESSAGE_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;
const LIST_PREVIEW_MAX_LENGTH = 160;

/** The literal outer-envelope `Subject` every encrypted message carries server-side - RFC 9788's
 * `hcp_baseline` policy obscures it to this exact string (see `smimeMessage.ts`'s
 * `applyBaselineOuterHeaders()`), which is also all `Message.subject` ever shows for one of these until
 * decrypted client-side. Used here to recognize which loaded rows are worth decrypting for display. */
const ENCRYPTED_SUBJECT_PLACEHOLDER = "[...]";

/** A row's client-recovered subject/preview, once decrypted - `undefined` fields mean nothing better
 * than the placeholder/blank server value was recoverable for that field specifically. */
interface DecryptedRow {
    subject?: string;
    preview?: string;
}

/** Strips HTML down to plain text, for a short list-row preview of a decrypted body - mirrors
 * `searchTier3.ts`'s own private `stripHtml()` (not currently exported from `@rapidmx/react-shared`,
 * so duplicated here rather than pulled in through a package change just for this one small, pure
 * helper). Not a security boundary - the output only ever feeds plain text display, truncated below,
 * never rendered back into any DOM. */
function stripHtmlToText(html: string): string {
    return html
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;/gi, "'")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Decrypts the subject/preview of every currently-loaded row whose subject is still the RFC 9788
 * placeholder (i.e. every encrypted message this device hasn't already resolved), keyed by uid - the
 * inbox-list counterpart to `MessageDetailPane`'s own single-message decrypt and `searchTier3.ts`'s
 * per-candidate decrypt. Bounded to `messages` (at most one loaded page, `MESSAGE_PAGE_SIZE`), never the
 * whole mailbox - matching `searchEncryptedCandidates()`'s own "bounded, not everything" scope. Runs only
 * once `unlocked` is available (the caller decides when to call this - see `InboxContent`'s own effect
 * and `handleUnlockList()`), and a single row's fetch/decrypt failure never blocks the rest.
 */
async function decryptEncryptedRows(messages: Message[], unlocked: UnlockedKeys): Promise<Record<string, DecryptedRow>> {
    const encrypted = messages.filter((m) => m.subject === ENCRYPTED_SUBJECT_PLACEHOLDER);
    const entries = await Promise.all(
        encrypted.map(async (message): Promise<[string, DecryptedRow] | null> => {
            try {
                const rawMime = await getMessageRawContent(message.uid);
                const security = await evaluateMessageSecurity(rawMime, unlocked);
                if (!security.subject && !security.html) {
                    return null;
                }
                const preview = security.html ? stripHtmlToText(security.html).slice(0, LIST_PREVIEW_MAX_LENGTH) : undefined;
                return [message.uid, { subject: security.subject, preview }];
            } catch {
                return null;
            }
        }),
    );
    const result: Record<string, DecryptedRow> = {};
    for (const entry of entries) {
        if (entry) {
            result[entry[0]] = entry[1];
        }
    }
    return result;
}

/** Merges Tier 1 (server, possibly `metadataOnly` for an encrypted message), Tier 2 (local index, fully
 * decrypted and re-scored), and Tier 3 (server-narrowed candidates, decrypted and re-scored) results into
 * one ranked list, per `specs/search.md` §7's "client MUST re-score all results it can see... normalise
 * into the same space rather than interleaving raw scores": each tier is normalized independently via
 * `normalizeServerScores()` before merging, since a Postgres/OpenSearch score, a local `bm25()` score,
 * and this module's own Tier 3 term-count score all occupy unrelated ranges. A uid present in more than
 * one list keeps only the last-inserted entry (Tier 2 wins over Tier 3 wins over Tier 1) - Tier 2 and
 * Tier 3 both represent genuine, content-verified scores for the same message, so which one "wins" on
 * overlap doesn't change correctness, only which of two equally-valid scores is shown; either supersedes
 * Tier 1's metadata-only guess for the same uid.
 *
 * Called progressively - once per tier as it resolves, each time with whatever tiers have reported so
 * far (an empty array for the rest) - by `InboxContent`'s own search orchestration below, per §_Progressive
 * Results_' "reordering is permitted and preferred over appending." This function itself stays pure and
 * stateless; it has no notion of "in progress" versus "final." */
function mergeSearchResults(tier1: SearchResult[], tier2: SearchResult[], tier3: SearchResult[]): SearchResult[] {
    const normalizedTier1 = normalizeServerScores(tier1);
    const normalizedTier2 = normalizeServerScores(tier2);
    const normalizedTier3 = normalizeServerScores(tier3);
    const merged = new Map<string, { result: SearchResult; normalizedScore: number }>();
    for (const entry of normalizedTier1) {
        merged.set(entry.result.entityUid, entry);
    }
    for (const entry of normalizedTier3) {
        merged.set(entry.result.entityUid, entry);
    }
    for (const entry of normalizedTier2) {
        merged.set(entry.result.entityUid, entry);
    }
    return Array.from(merged.values())
        .sort((a, b) => b.normalizedScore - a.normalizedScore)
        .map((entry) => entry.result);
}

/** `type:` narrows `entityTypes`; when absent this still defaults to `["message"]` — a non-message hit
 * (contact/calendarEvent/note/task) has no `Message` to resolve via `getMessage()` below and is simply
 * dropped by the same eventually-consistent-index fallback that already existed, rather than rendered
 * (this inbox list only ever shows message rows; a real multi-entity-type results view is a separate,
 * larger UI project outside this pass). Shared by both the fresh-search orchestration and `loadMore()`
 * below, which each build this from the same `ParsedSearchQuery` differently only in `cursor`. */
function tier1SearchParams(parsed: ParsedSearchQuery, cursor: string | undefined) {
    return {
        types: parsed.entityTypes ?? ["message"],
        cursor,
        limit: MESSAGE_PAGE_SIZE,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        hasAttachment: parsed.hasAttachment,
        before: parsed.before,
        after: parsed.after,
        folderUid: parsed.folderUid,
        flags: parsed.flags,
        labels: parsed.labels,
    };
}

/** How many of Tier 1's own `metadataOnly` hits (§7: "an encrypted entity matched only on server-visible
 * metadata... MUST be rendered as skeleton entries in place... using the metadata score as a provisional
 * position") are shown as skeleton rows at once - §_Progressive Results_' "Skeletons MUST be capped, at
 * approximately one and a half pages." A non-`metadataOnly` Tier 1 hit (a real, already-scored content
 * match — always the case for unencrypted mail) is never a skeleton and is never subject to this cap.
 *
 * A Tier 3 candidate that Tier 1 did *not* already surface has no provisional score/position of its own
 * under the spec's own wording above, so it is deliberately never pre-rendered as a skeleton here either
 * - it simply appears, fully resolved, once Tier 3 confirms it (see `InboxContent`'s search
 * orchestration). */
const SKELETON_CAP = Math.round(MESSAGE_PAGE_SIZE * 1.5);

function capSkeletons(tier1Hits: SearchResult[]): SearchResult[] {
    let skeletonsSeen = 0;
    return tier1Hits.filter((hit) => {
        if (!hit.metadataOnly) {
            return true;
        }
        skeletonsSeen += 1;
        return skeletonsSeen <= SKELETON_CAP;
    });
}

/** How many candidates Tier 3 pulls per distinct search - larger than one page's worth so several
 * `loadMore()` pages can be sliced from one decrypt pass (see `Tier3Cache` below) instead of a second,
 * separately expensive server round trip and re-decrypt for the same query. Bounded, not unlimited - per
 * this module's own `tier1SearchParams()` sibling, Tier 3's own candidate-narrowing is already the
 * "heaviest single client-side cost" tier (`specs/search.md` §9's identical framing for attachment
 * extraction); a query whose true candidate set exceeds this simply pages out once this cache is
 * exhausted; `loadMore()` reflects that honestly via `hasMore`. */
const TIER3_CANDIDATE_LIMIT = 200;

/** One entry per distinct (mailbox, query, "search all mail" toggle, unlocked-or-not) combination this
 * tab has already run Tier 3 for - keyed by `tier3CacheKey()` below. Tier 3's decrypt-and-match pass
 * (`searchEncryptedCandidates()`) is by far this search's most expensive step, so it runs once per
 * combination; every subsequent `loadMore()` page for that same combination slices further into the
 * same already-decrypted array. Session-scoped, per tab, with no explicit eviction - a small map that's
 * simply never read again once the query changes, the same shape `InboxContent`'s own `decryptedRows`
 * state already accepts for a similar "worth keeping around, not worth actively pruning" tradeoff.
 *
 * The unlocked-or-not dimension matters: re-running an identical query right after an on-demand unlock
 * (`handleUnlockSearch()`) MUST NOT reuse the "nothing to contribute" entry that same query cached while
 * still locked - `searchEncryptedCandidates()` degrades to `[]` for an absent `unlocked`, and that empty
 * result is exactly as cacheable/reusable as a real one, just under a different key. */
type Tier3Cache = Map<string, SearchResult[]>;

function tier3CacheKey(mailboxUid: string, fingerprint: string, searchAllMail: boolean, unlocked: boolean): string {
    return `${mailboxUid}|${fingerprint}|${String(searchAllMail)}|${String(unlocked)}`;
}

/** A search query's cache/cursor identity - stable across re-parsing the identical raw text, and
 * distinct for anything else (§8's "a query fingerprint, so a cursor cannot be replayed against a
 * different query"). `JSON.stringify` on `ParsedSearchQuery` is deterministic here because every one of
 * its own fields is a primitive or a `Date` (which serializes to a fixed ISO string) - no nested object
 * whose key order could vary between two structurally-identical parses of the same text. */
function queryFingerprint(parsed: ParsedSearchQuery): string {
    return JSON.stringify(parsed);
}

/** Tier 3's own `before` bound, tightened to Tier 2's already-covered window (`coverage.indexedFrom`)
 * unless the reader explicitly asked to "Search all mail" - Tier 2 already holds fully-decrypted,
 * current content for everything at least that recent, so re-fetching and re-decrypting the same range
 * through Tier 3's slower candidate-narrowing path would be pure waste. Never *widens* an existing
 * `before:` the query already specified.
 *
 * Only applied once Tier 2 reports a finished, complete build pass: while it's still building (or a pass
 * stopped early - a failed folder listing, the byte budget) `indexedFrom` is just the oldest row that
 * happens to be present, not a guarantee every encrypted message since then is indexed, and narrowing
 * on it would silently drop encrypted results neither tier returns. */
function tightenBeforeToCoverage(parsed: ParsedSearchQuery, coverage: Coverage | undefined, searchAllMail: boolean): ParsedSearchQuery {
    if (searchAllMail || !coverage?.indexedFrom || coverage.building || !coverage.complete) {
        return parsed;
    }
    const coverageBound = new Date(coverage.indexedFrom);
    const effectiveBefore = parsed.before && parsed.before.getTime() < coverageBound.getTime() ? parsed.before : coverageBound;
    return { ...parsed, before: effectiveBefore };
}

/** The paging state for one search, composited across all three tiers (`specs/search.md` §8) - opaque to
 * every caller the same way `SearchResultPage.nextCursor` is opaque to callers of `search()` itself.
 * Tier 1 keeps the server's own opaque cursor unmodified; Tier 2 (the local index) and Tier 3 (the
 * cached, already-decrypted candidate array - see `Tier3Cache` above) are both this client's own state,
 * so their "position" is just a plain offset into each. */
interface CompositeCursor {
    tier1Cursor?: string;
    tier2Offset: number;
    tier3Offset: number;
    fingerprint: string;
}

/** `undefined` for a missing, corrupted, or foreign-query cursor - every caller already treats "no
 * cursor" as "start this tier from the beginning," so there's no separate error path needed here. */
function decodeCursor(raw: CompositeCursor | undefined, fingerprint: string): CompositeCursor | undefined {
    return raw?.fingerprint === fingerprint ? raw : undefined;
}

/** Resolves every hit's `entityUid` to a full `Message` via `getMessage()`, reusing `cache` across
 * repeated calls within the same search pass - `InboxContent`'s own search orchestration below re-merges
 * and re-resolves the *entire* current hit set each time a tier resolves, so without this cache every
 * stage would re-fetch messages an earlier stage already fetched. A hit whose message no longer resolves
 * (deleted after being indexed, or the fetch itself failed) is cached as `null` and dropped - the same
 * "a search hit can briefly outlive the message it points to" tolerance this function's inline
 * predecessor already had. */
async function resolveHitsToMessages(
    hits: SearchResult[],
    cache: Map<string, Message | null>,
): Promise<{ messages: Message[]; snippets: Record<string, string> }> {
    const toFetch = hits.filter((hit) => !cache.has(hit.entityUid));
    await Promise.all(
        toFetch.map(async (hit) => {
            const message = await getMessage(hit.entityUid).catch(() => null);
            cache.set(hit.entityUid, message);
        }),
    );
    const messages: Message[] = [];
    const snippets: Record<string, string> = {};
    for (const hit of hits) {
        const message = cache.get(hit.entityUid);
        if (!message) {
            continue;
        }
        messages.push(message);
        if (hit.snippet) {
            snippets[message.uid] = hit.snippet;
        }
    }
    return { messages, snippets };
}

/** Appends `more` to `shown`, skipping any uid already shown - a later page can repeat rows (Tier 1 and
 * Tier 2/3 cursors advance independently, so the same message can come back from a different tier on a
 * later page; a plain folder listing's pages shift when new mail arrives between fetches). */
function appendUnseenMessages(shown: Message[], more: Message[]): Message[] {
    const seen = new Set(shown.map((m) => m.uid));
    const unseen: Message[] = [];
    for (const message of more) {
        if (!seen.has(message.uid)) {
            seen.add(message.uid);
            unseen.push(message);
        }
    }
    return unseen.length === 0 ? shown : [...shown, ...unseen];
}

/** Flattens and sorts a per-mailbox fetch into one merged, newest-first list - the aggregate ("All
 * Inboxes" etc.) equivalent of `mergeSearchResults()` above, but simpler: an aggregated message has no
 * natural relevance score to normalize, so this only ever sorts by `receivedDate`. */
function mergeInboxMessages(perMailbox: { mailbox: Mailbox; messages: Message[] }[]): Message[] {
    return perMailbox
        .flatMap((entry) => entry.messages)
        .sort((a, b) => new Date(b.receivedDate).getTime() - new Date(a.receivedDate).getTime());
}

/**
 * Fans out one `listMessages()` call per accessible mailbox that has a folder of `type`, merges the
 * results newest-first. A mailbox with no matching folder, or whose fetch fails, simply contributes
 * nothing - one mailbox's absence/failure must not blank out every other mailbox's messages.
 *
 * **Pagination scope trim (deliberate, matching this file's own documented Tier 2/3 tradeoffs)**: there is
 * no composite cursor across an arbitrary number of independently-paginated mailboxes in this pass - this
 * always fetches exactly each mailbox's own first page (`MESSAGE_PAGE_SIZE`) and the caller never offers a
 * "load more" for the result (see `InboxContent`'s own `hasMore` handling in aggregate mode) - a real
 * composite-cursor "load more" per mailbox is a natural v2 if usage shows people scrolling past the first
 * page in aggregate view often.
 */
async function fetchAggregateMessages(mailboxFolders: MailboxFolders[], type: AggregateFolderType): Promise<Message[]> {
    const perMailbox = await Promise.all(
        mailboxFolders.map(async ({ mailbox, folders }) => {
            const folder = folders.find((f) => f.type === type);
            if (!folder) {
                return { mailbox, messages: [] as Message[] };
            }
            const messages = await listMessages(folder.uid, { limit: MESSAGE_PAGE_SIZE }).catch(() => [] as Message[]);
            return { mailbox, messages };
        }),
    );
    return mergeInboxMessages(perMailbox);
}

export default function InboxPage(props: MailShellProps) {
    return (
        <MailShell {...props}>
            <InboxContent />
        </MailShell>
    );
}

function InboxContent() {
    const { folderUid, mailboxUid, mailboxes, mailboxFolders, aggregateFolderType } = useMailShell();
    const isMobile = useIsMobile();
    const { requestUnlock } = useUnlockPrompt();
    const [viewMode, setViewMode] = useState<ViewMode>("date");
    const [messages, setMessages] = useState<Message[]>([]);
    const [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedUid, setSelectedUid] = useState<string | null>(null);
    const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
    const [classificationFilter, setClassificationFilter] = useState<MessageClassification | "all">("all");
    const [searchInput, setSearchInput] = useState("");
    const [searchQuery, setSearchQuery] = useState("");
    const [snippets, setSnippets] = useState<Record<string, string>>({});
    const [labels, setLabels] = useState<Label[]>([]);
    // Tier 2's own reported window coverage for the current search - undefined outside a search, or
    // before Tier 2 has resolved yet for this search pass.
    const [coverage, setCoverage] = useState<Coverage | undefined>(undefined);
    // Keyed by message uid - see decryptEncryptedRows(). Never cleared on folder/search switches (a
    // decrypted row stays decrypted for the rest of the session; re-decrypting on every navigation would
    // waste work for no benefit), only ever added to.
    const [decryptedRows, setDecryptedRows] = useState<Record<string, DecryptedRow>>({});
    // Bumped after a successful on-demand unlock to re-run the search effect below - it's not a
    // dependency the effect could otherwise react to (getUnlockedKeys() is a plain module-level read, not
    // React state; see keySession.ts's own doc comment).
    const [unlockRefresh, setUnlockRefresh] = useState(0);
    // §_Progressive Results_: which of the current search's uids are still an unconfirmed Tier 1
    // `metadataOnly` guess (rendered as a skeleton row - see the JSX below) - empty outside a search, and
    // always empty again once every tier has reported for the current pass (each unresolved entry is by
    // then either confirmed, real content, or pruned - see the search orchestration effect).
    const [pendingUids, setPendingUids] = useState<Set<string>>(new Set());
    // Withholds a hard result count until every tier has reported for the current search pass (§_Progressive
    // Results_: "Never show a hard count until every tier has reported... A settled count is the signal
    // that ordering is final"). Reset on every fresh search; irrelevant outside search mode.
    const [tier1Done, setTier1Done] = useState(false);
    const [tier2Done, setTier2Done] = useState(false);
    const [tier3Done, setTier3Done] = useState(false);
    // Toggled by the "Search all mail" action next to the results count - removes Tier 3's own default
    // bound (tightened to Tier 2's coverage window otherwise - see tightenBeforeToCoverage()) for one
    // re-run. Reset to false whenever the query itself changes (see the search effect's own dependency).
    const [searchAllMail, setSearchAllMail] = useState(false);
    // Search stays real-folder-only - Tier 1/2/3 are all deeply mailbox/folder-scoped, and extending them
    // to span an arbitrary number of mailboxes is out of scope for this pass (see the aggregate-fetch
    // branch below, which the search effect never reaches while `folderUid` is unset).
    const isSearching = viewMode === "date" && searchQuery.length > 0 && !aggregateFolderType;
    const pageRef = useRef(0);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    // The mailbox unlock/decrypt call sites below treat as "the" mailbox when there's no single selected
    // one (aggregate mode) - mirrors `MailShell`'s own identical `defaultMailboxUid` fallback. An
    // aggregate-view row from a *different*, not-yet-unlocked mailbox stays locked until that mailbox's
    // own folder view is opened directly - an accepted limitation, not a bug (see `MailShell`'s own doc
    // comment on the same tradeoff for its `LocalIndexLifecycle`/`KeyEnrollmentGate` wiring).
    const activeMailboxUid = mailboxUid ?? mailboxes.find((mb) => mb.ownerUserUid)?.uid ?? mailboxes[0]?.uid;
    const mailboxKeys = mailboxes.find((mb) => mb.uid === activeMailboxUid)?.keys ?? [];
    // Reset to a fresh Map at the start of every new search pass (see the search effect below) - see
    // resolveHitsToMessages()'s own doc comment on why this needs to persist *within* one pass but not
    // across passes (a stale `null` for a uid that's since become resolvable elsewhere must not stick).
    const resolvedMessageCacheRef = useRef<Map<string, Message | null>>(new Map());
    // Session-scoped, never explicitly cleared - see Tier3Cache's own doc comment above.
    const tier3CacheRef = useRef<Tier3Cache>(new Map());
    // The latest composite cursor this search pass has reached - read by loadMore(), written at the end
    // of both the fresh-search orchestration and loadMore() itself. Not React state: it never drives a
    // render on its own, only what loadMore() does with it later.
    const compositeCursorRef = useRef<CompositeCursor | undefined>(undefined);
    // Guards every async load below - each search stage, the plain folder/conversation/aggregate listings,
    // and `loadMore()` - against a stale, still-in-flight pass clobbering state for a newer one that started
    // after it (the query, folder, or view changed) - the same `loadSeq`-style monotonic-id pattern already used elsewhere in this codebase (e.g.
    // `settings/privacy/index.tsx`'s `ExportSection`), generalized here across three independently-timed
    // async stages instead of one.
    const searchRunIdRef = useRef(0);
    // `messages` themselves aren't a dependency here on purpose - a message uid, once decrypted, is
    // never re-decrypted just because the list re-renders with the same rows (e.g. a folder-unrelated
    // state update elsewhere). New rows (a fresh page load, load-more, or a completed search) each
    // re-trigger this the normal way, by changing `messages` itself.
    //
    // Scoped to `activeMailboxUid`'s own rows only - in aggregate mode `messages` can span several
    // mailboxes, but only one mailbox's keys are ever being unlocked/tracked here (see `activeMailboxUid`'s
    // own doc comment above); an encrypted row from any other mailbox simply isn't a candidate for this
    // auto-decrypt or the manual unlock banner below.
    const undecryptedEncryptedUids = messages
        .filter((m) => m.subject === ENCRYPTED_SUBJECT_PLACEHOLDER && !decryptedRows[m.uid] && m.mailboxUid === activeMailboxUid)
        .map((m) => m.uid);

    // Once unlocked, silently decrypt this page's own encrypted rows to show their real subject/preview -
    // no prompt needed here, the same way searchEncryptedCandidates() already auto-includes decrypted
    // matches once unlocked without asking again. Only the *first* unlock (or a fresh page of messages
    // arriving) needs this; `handleUnlockList()` below covers the not-yet-unlocked case explicitly.
    useEffect(() => {
        if (undecryptedEncryptedUids.length === 0 || !activeMailboxUid) {
            return;
        }
        const unlocked = getUnlockedKeys(activeMailboxUid);
        if (!unlocked) {
            return;
        }
        let cancelled = false;
        void decryptEncryptedRows(
            messages.filter((m) => undecryptedEncryptedUids.includes(m.uid)),
            unlocked,
        ).then((decrypted) => {
            if (!cancelled && Object.keys(decrypted).length > 0) {
                setDecryptedRows((prev) => ({ ...prev, ...decrypted }));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [messages, unlockRefresh]);

    async function handleUnlockList() {
        try {
            const unlocked = await requestUnlock(activeMailboxUid, mailboxKeys);
            const decrypted = await decryptEncryptedRows(
                messages.filter((m) => m.subject === ENCRYPTED_SUBJECT_PLACEHOLDER && m.mailboxUid === activeMailboxUid),
                unlocked,
            );
            setDecryptedRows((prev) => ({ ...prev, ...decrypted }));
        } catch {
            // User dismissed the unlock dialog - rows stay exactly as they were.
        }
    }

    async function handleUnlockSearch() {
        try {
            await requestUnlock(activeMailboxUid, mailboxKeys);
            setUnlockRefresh((n) => n + 1);
        } catch {
            // User dismissed the unlock dialog - the search results stay exactly as they were.
        }
    }

    // Labels are mailbox-wide, not folder-scoped - fetched once per mailbox rather than per message, and
    // handed to the detail pane below. A failure here just means the Labels control stays hidden (an empty
    // `labels` array) rather than blocking the rest of the inbox. Keyed on the *selected message's own*
    // mailbox: aggregate views and search results can show messages from a mailbox other than
    // `activeMailboxUid`, and offering that mailbox's labels would let a label from the wrong mailbox be
    // applied. The conversation view stays scoped to `activeMailboxUid`, the mailbox its threads come from.
    const selectedMessageMailboxUid = messages.find((m) => m.uid === selectedUid)?.mailboxUid;
    const labelsMailboxUid = viewMode === "date" ? (selectedMessageMailboxUid ?? activeMailboxUid) : activeMailboxUid;
    // `labelsMailboxUid` is always set: `MailShell` only renders this component once at least one mailbox
    // exists, so `activeMailboxUid` (its fallback) always resolves.
    useEffect(() => {
        let cancelled = false;
        setLabels([]);
        listLabels(labelsMailboxUid, { limit: 200 })
            .then((result) => {
                if (!cancelled) {
                    setLabels(result);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [labelsMailboxUid]);

    // Debounce the raw input into the query actually searched, so every keystroke doesn't fire a request.
    useEffect(() => {
        const handle = setTimeout(() => setSearchQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [searchInput]);

    // Conversations are computed mailbox-wide (see `conversationsApi.ts`), not scoped to the selected
    // folder — switching into "By conversation" mode replaces the per-folder list entirely, and the
    // folder-tree sidebar's own selection becomes purely informational until switching back to "By date".
    useEffect(() => {
        setSelectedUid(null);
        setSelectedConversationId(null);
        setClassificationFilter("all");
        pageRef.current = 0;
        compositeCursorRef.current = undefined;
        setHasMore(false);
        // Every run - search or not - supersedes whatever an earlier run (or a `loadMore()` it started)
        // still has in flight; each async callback below checks this before touching state.
        searchRunIdRef.current += 1;
        const myRunId = searchRunIdRef.current;
        const isCurrentRun = () => searchRunIdRef.current === myRunId;
        // Also invalidates on unmount, so nothing lands after the component is gone. Unconditional: this
        // cleanup only ever runs for the latest run of this effect (React runs it before the next run
        // bumps the id, or on unmount), so the id is always still `myRunId` here.
        const invalidate = () => {
            searchRunIdRef.current += 1;
        };

        if (viewMode === "conversation") {
            // Conversations stay single-mailbox (not aggregated across mailboxes in this pass) - in
            // aggregate mode this falls back to `activeMailboxUid`, the same mailbox unlock/labels use
            // (always set - `MailShell` only renders this component once at least one mailbox exists).
            setLoading(true);
            setError(null);
            listConversations(activeMailboxUid)
                .then((result) => {
                    if (isCurrentRun()) {
                        setConversations(result);
                    }
                })
                .catch((err) => {
                    if (isCurrentRun()) {
                        setError(err instanceof ApiRequestError ? err.message : "Could not load conversations.");
                    }
                })
                .finally(() => {
                    if (isCurrentRun()) {
                        setLoading(false);
                    }
                });
            return invalidate;
        }

        if (aggregateFolderType) {
            setLoading(true);
            setError(null);
            // hasMore stays false (set above) - see fetchAggregateMessages()'s own pagination scope trim.
            void fetchAggregateMessages(mailboxFolders, aggregateFolderType)
                .then((results) => {
                    if (isCurrentRun()) {
                        setMessages(results);
                    }
                })
                .finally(() => {
                    if (isCurrentRun()) {
                        setLoading(false);
                    }
                });
            return invalidate;
        }

        if (!folderUid) {
            setMessages([]);
            setLoading(false);
            return;
        }
        setLoading(true);
        setError(null);

        if (isSearching) {
            setCoverage(undefined);
            setPendingUids(new Set());
            setTier1Done(false);
            setTier2Done(false);
            setTier3Done(false);
            resolvedMessageCacheRef.current = new Map();
            const parsed = parseSearchQuery(searchQuery);
            const unlocked = getUnlockedKeys(mailboxUid!);
            const fingerprint = queryFingerprint(parsed);

            // Recomputes and re-renders the merged list from whatever tiers have reported so far -
            // called once after Tier 1+2 (interim: unconfirmed Tier 1 metadataOnly hits render as
            // skeletons) and again after Tier 3 (final: anything still unconfirmed is pruned instead -
            // §_Progressive Results_' "Skeletons resolve or disappear"). Bails out via `myRunId` if a
            // newer search pass has since started.
            async function reveal(tier1Hits: SearchResult[], tier2Hits: SearchResult[], tier3Hits: SearchResult[], final: boolean) {
                const capped = capSkeletons(tier1Hits);
                const confirmed = new Set([...tier2Hits, ...tier3Hits].map((r) => r.entityUid));
                const effectiveTier1 = final ? capped.filter((hit) => !hit.metadataOnly || confirmed.has(hit.entityUid)) : capped;
                const merged = mergeSearchResults(effectiveTier1, tier2Hits, tier3Hits);
                const { messages: resolved, snippets: resolvedSnippets } = await resolveHitsToMessages(
                    merged,
                    resolvedMessageCacheRef.current,
                );
                if (searchRunIdRef.current !== myRunId) {
                    return;
                }
                setMessages(resolved);
                setSnippets(resolvedSnippets);
                if (final) {
                    setPendingUids(new Set());
                } else {
                    const pending = new Set<string>();
                    for (const hit of capped) {
                        if (hit.metadataOnly && !confirmed.has(hit.entityUid)) {
                            pending.add(hit.entityUid);
                        }
                    }
                    setPendingUids(pending);
                }
            }

            void (async () => {
                try {
                    const [tier1Page, tier2Page] = await Promise.all([
                        searchMailbox(parsed.text, tier1SearchParams(parsed, undefined)),
                        searchLocalIndex(mailboxUid!, parsed, unlocked, MESSAGE_PAGE_SIZE, 0),
                    ]);
                    if (searchRunIdRef.current !== myRunId) {
                        return;
                    }
                    setTier1Done(true);
                    setTier2Done(true);
                    setCoverage(tier2Page.coverage);
                    setLoading(false);
                    await reveal(tier1Page.results, tier2Page.results, [], false);

                    const tightened = tightenBeforeToCoverage(parsed, tier2Page.coverage, searchAllMail);
                    const cacheKey = tier3CacheKey(mailboxUid!, fingerprint, searchAllMail, !!unlocked);
                    let tier3Full = tier3CacheRef.current.get(cacheKey);
                    if (!tier3Full) {
                        tier3Full = await searchEncryptedCandidates(tightened, unlocked, TIER3_CANDIDATE_LIMIT);
                        if (searchRunIdRef.current !== myRunId) {
                            return;
                        }
                        tier3CacheRef.current.set(cacheKey, tier3Full);
                    }
                    const tier3Page = tier3Full.slice(0, MESSAGE_PAGE_SIZE);
                    setTier3Done(true);
                    compositeCursorRef.current = {
                        tier1Cursor: tier1Page.nextCursor,
                        tier2Offset: tier2Page.results.length,
                        tier3Offset: tier3Page.length,
                        fingerprint,
                    };
                    setHasMore(!!tier1Page.nextCursor || tier2Page.hasMore || tier3Page.length < tier3Full.length);
                    await reveal(tier1Page.results, tier2Page.results, tier3Page, true);
                } catch (err) {
                    if (searchRunIdRef.current === myRunId) {
                        setError(err instanceof ApiRequestError ? err.message : "Search failed.");
                        setLoading(false);
                    }
                }
            })();
            return invalidate;
        }

        listMessages(folderUid, { limit: MESSAGE_PAGE_SIZE })
            .then((results) => {
                if (isCurrentRun()) {
                    setMessages(results);
                    setHasMore(results.length === MESSAGE_PAGE_SIZE);
                }
            })
            .catch((err) => {
                if (isCurrentRun()) {
                    setError(err instanceof ApiRequestError ? err.message : "Could not load messages.");
                }
            })
            .finally(() => {
                if (isCurrentRun()) {
                    setLoading(false);
                }
            });
        return invalidate;
        // `unlockRefresh`/`searchAllMail` are dependencies solely so `handleUnlockSearch()`/"Search all
        // mail" can force this effect to re-run the search above - Tier 3 (encrypted) results silently
        // contribute nothing without unlocked keys, so this is what actually makes them appear once the
        // user unlocks, and what makes "Search all mail" actually remove Tier 3's coverage bound. Neither
        // has any effect on the non-search branch below; re-running it with identical inputs just
        // re-fetches the same page.
    }, [viewMode, folderUid, mailboxUid, isSearching, searchQuery, unlockRefresh, searchAllMail, aggregateFolderType, mailboxFolders, activeMailboxUid]);

    function handleSearchAllMail() {
        setSearchAllMail(true);
    }

    const loadMore = useCallback(async () => {
        if (loadingMore || !hasMore || loading || viewMode !== "date" || !folderUid) {
            return;
        }
        setLoadingMore(true);
        // A query/folder/view change while this page is in flight bumps the run id (see the effect above) -
        // its rows then belong to a list that's no longer on screen and must not be appended to the new one.
        const myRunId = searchRunIdRef.current;
        const isCurrentRun = () => searchRunIdRef.current === myRunId;
        try {
            if (isSearching) {
                const parsed = parseSearchQuery(searchQuery);
                const unlocked = getUnlockedKeys(mailboxUid!);
                const fingerprint = queryFingerprint(parsed);
                const cursor = decodeCursor(compositeCursorRef.current, fingerprint);

                const [tier1Page, tier2Page] = await Promise.all([
                    searchMailbox(parsed.text, tier1SearchParams(parsed, cursor?.tier1Cursor)),
                    searchLocalIndex(mailboxUid!, parsed, unlocked, MESSAGE_PAGE_SIZE, cursor?.tier2Offset ?? 0),
                ]);
                const cacheKey = tier3CacheKey(mailboxUid!, fingerprint, searchAllMail, !!unlocked);
                const tier3Full = tier3CacheRef.current.get(cacheKey) ?? [];
                const tier3Offset = cursor?.tier3Offset ?? 0;
                const tier3Page = tier3Full.slice(tier3Offset, tier3Offset + MESSAGE_PAGE_SIZE);

                // Unlike the fresh-search pass above, a load-more page is resolved and appended in one
                // shot rather than progressively revealed - rows already on screen shouldn't reorder or
                // grow skeletons out from under a reader who has since scrolled past them. Any Tier 1
                // metadataOnly hit this page that neither Tier 2 nor Tier 3 (both already awaited above)
                // confirms simply keeps showing its existing placeholder text rather than a live skeleton
                // - a deliberate, documented scope trim of progressive reveal to the first page only.
                const merged = mergeSearchResults(capSkeletons(tier1Page.results), tier2Page.results, tier3Page);
                const { messages: more, snippets: moreSnippets } = await resolveHitsToMessages(merged, resolvedMessageCacheRef.current);
                if (!isCurrentRun()) {
                    return;
                }
                setMessages((prev) => appendUnseenMessages(prev, more));
                setSnippets((prev) => ({ ...prev, ...moreSnippets }));

                const nextTier3Offset = tier3Offset + tier3Page.length;
                compositeCursorRef.current = {
                    tier1Cursor: tier1Page.nextCursor,
                    tier2Offset: (cursor?.tier2Offset ?? 0) + tier2Page.results.length,
                    tier3Offset: nextTier3Offset,
                    fingerprint,
                };
                setHasMore(!!tier1Page.nextCursor || tier2Page.hasMore || nextTier3Offset < tier3Full.length);
            } else {
                const nextPage = pageRef.current + 1;
                const more = await listMessages(folderUid, { page: nextPage, limit: MESSAGE_PAGE_SIZE });
                if (!isCurrentRun()) {
                    return;
                }
                setMessages((prev) => appendUnseenMessages(prev, more));
                setHasMore(more.length === MESSAGE_PAGE_SIZE);
                pageRef.current = nextPage;
            }
        } catch (err) {
            if (isCurrentRun()) {
                setError(err instanceof ApiRequestError ? err.message : "Could not load more messages.");
            }
        } finally {
            setLoadingMore(false);
        }
    }, [loadingMore, hasMore, loading, viewMode, folderUid, isSearching, searchQuery, searchAllMail, mailboxUid]);

    // Always calls the latest `loadMore` closure so the effect below doesn't need `loadMore` itself in its
    // dependency array (it changes on every keystroke/page load, which would otherwise mean nothing here).
    const loadMoreRef = useRef(loadMore);
    loadMoreRef.current = loadMore;

    // `hasMore` is deliberately a dependency: the sentinel div only renders while `hasMore` is true (see
    // the JSX below), so this effect must re-run when it flips - otherwise a run that fires before the
    // first page of results has loaded (sentinel not in the DOM yet, `sentinelRef.current` still null)
    // would bail out once and never attach an observer to the sentinel that appears moments later.
    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || viewMode !== "date") {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting) {
                    void loadMoreRef.current();
                }
            },
            { root: scrollContainerRef.current, rootMargin: "200px" },
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [viewMode, folderUid, isSearching, searchQuery, hasMore]);

    const selected = messages.find((m) => m.uid === selectedUid) ?? null;
    const selectedConversation = conversations.find((c) => c.conversationId === selectedConversationId) ?? null;
    const attachments = useMessageAttachments(selected);
    useMarkMessageRead(selected, (updated) => setMessages((prev) => prev.map((m) => (m.uid === updated.uid ? updated : m))));
    // Search results can span every folder in the mailbox, not just the one selected in the sidebar - a
    // selected message's own folderUid is the only reliable source for its actual folder type once
    // searching (outside search, every message in `messages` already comes from `folderUid` itself, so
    // this falls back to the sidebar selection unchanged). Aggregate views span every *mailbox* too, so
    // the folder list consulted is the selected message's own mailbox's, not the shell's ambient one.
    const spansFolders = isSearching || !!aggregateFolderType;
    const selectedFolderUid = spansFolders ? (selected?.folderUid ?? folderUid) : folderUid;
    const selectedMailboxUid = spansFolders ? (selected?.mailboxUid ?? activeMailboxUid) : mailboxUid;
    const folders = mailboxFolders.find((mf) => mf.mailbox.uid === selectedMailboxUid)?.folders ?? [];
    const isSentItems = folders.find((f) => f.uid === selectedFolderUid)?.type === "sent_items";
    const isOutbox = folders.find((f) => f.uid === selectedFolderUid)?.type === "outbox";
    const isInbox = folders.find((f) => f.uid === selectedFolderUid)?.type === "inbox";
    const draftsFolderUid = folders.find((f) => f.type === "drafts")?.uid;

    // Focused/Other is an Inbox-only concept (see `MessageDetailPane`'s own `isInbox` doc comment) — the
    // sub-tabs only ever render there, so a message with no `inferenceClassification` (the common case:
    // absent means Focused) or an explicit `"focused"` counts as Focused, everything else as Other. Not
    // offered for an aggregate view (each mailbox classifies independently; merging that is out of scope).
    const visibleMessages =
        !isSearching && !aggregateFolderType && isInbox && classificationFilter !== "all"
            ? messages.filter((m) =>
                  classificationFilter === "other"
                      ? m.inferenceClassification === "other"
                      : m.inferenceClassification !== "other",
              )
            : messages;

    function handleSelect(message: Message) {
        if (isMobile) {
            window.location.href = `/messages/${encodeURIComponent(message.uid)}`;
            return;
        }
        setSelectedUid(message.uid);
    }

    function handleSelectConversation(conversation: ConversationSummary) {
        if (isMobile) {
            // No dedicated mobile thread route yet — the existing single-message detail route already
            // handles any message uid regardless of conversation grouping, so land on the most recent
            // message in the thread rather than building a second mobile detail page for this phase.
            // `messageUids` always has at least one entry — a `ConversationSummary` only ever exists
            // because it was grouped from real messages (see `BaseMessageRoute.conversations()`).
            const latestUid = conversation.messageUids[conversation.messageUids.length - 1];
            window.location.href = `/messages/${encodeURIComponent(latestUid)}`;
            return;
        }
        setSelectedConversationId(conversation.conversationId);
    }

    if (!folderUid && !aggregateFolderType) {
        // `MailShell` never renders this component at all until a mailbox is resolved (see its own
        // full-screen `MailboxProvisioning` takeover otherwise) — this is purely the brief gap before
        // that mailbox's own folder list has finished loading, not a "no mailbox" state. Distinct text
        // from the message list's own "Loading…" below — otherwise the two transient states become
        // indistinguishable to anything (a test, a user re-reading the screen) that catches this one.
        return <p className="p-8 text-sm text-text-muted">Loading your mailbox&hellip;</p>;
    }

    return (
        <div className="flex h-full min-h-0">
            <div ref={scrollContainerRef} className="w-full md:w-96 shrink-0 md:border-r border-border overflow-y-auto">
                <div className="flex border-b border-border text-sm">
                    <button
                        type="button"
                        onClick={() => setViewMode("date")}
                        className={[
                            "flex-1 py-2 font-semibold",
                            viewMode === "date" ? "text-primary-dark border-b-2 border-primary-dark" : "text-text-muted",
                        ].join(" ")}
                    >
                        By date
                    </button>
                    <button
                        type="button"
                        onClick={() => setViewMode("conversation")}
                        className={[
                            "flex-1 py-2 font-semibold",
                            viewMode === "conversation" ? "text-primary-dark border-b-2 border-primary-dark" : "text-text-muted",
                        ].join(" ")}
                    >
                        By conversation
                    </button>
                </div>
                {viewMode === "conversation" && (
                    <p className="p-3 text-xs text-text-muted border-b border-border">
                        Showing every conversation in this mailbox — the selected folder doesn&apos;t filter this view.
                    </p>
                )}
                {viewMode === "date" && (
                    <div className="p-2 border-b border-border">
                        <input
                            type="search"
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                            placeholder={aggregateFolderType ? "Open a mailbox's own folder to search" : "Search all mail…"}
                            aria-label="Search all mail"
                            disabled={!!aggregateFolderType}
                            className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-surface disabled:opacity-55"
                        />
                    </div>
                )}
                {viewMode === "date" && isInbox && !isSearching && !aggregateFolderType && (
                    <div className="flex border-b border-border text-xs">
                        {(["all", "focused", "other"] as const).map((value) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setClassificationFilter(value)}
                                className={[
                                    "flex-1 py-1.5 font-semibold",
                                    classificationFilter === value
                                        ? "text-primary-dark border-b-2 border-primary-dark"
                                        : "text-text-muted",
                                ].join(" ")}
                            >
                                {value === "all" ? "All" : value === "focused" ? "Focused" : "Other"}
                            </button>
                        ))}
                    </div>
                )}

                {isSearching && (
                    <div className="px-4 py-1.5 text-xs text-text-muted border-b border-border flex items-center justify-between gap-2">
                        {/* §_Progressive Results_: "Never show a hard count until every tier has reported.
                            Display n of ??, or omit the count. A settled count is the signal that ordering
                            is final." */}
                        <span>
                            {tier1Done && tier2Done && tier3Done
                                ? `${visibleMessages.length} result${visibleMessages.length === 1 ? "" : "s"}`
                                : `${visibleMessages.length} of ??`}
                        </span>
                        {tier2Done && !searchAllMail && (
                            <button
                                type="button"
                                onClick={handleSearchAllMail}
                                className="text-primary-dark hover:underline font-medium shrink-0"
                            >
                                Search all mail
                            </button>
                        )}
                    </div>
                )}
                {isSearching && coverage?.indexedFrom && (
                    <div className="px-4 py-1.5 text-xs text-text-muted border-b border-border">
                        Local search covers messages back to {new Date(coverage.indexedFrom).toLocaleDateString()}
                        {coverage.building ? " (still building)" : ""}
                        {searchAllMail
                            ? " - searching everything, not just recent mail."
                            : " - older encrypted mail is still searched, just slower."}
                    </div>
                )}
                {isSearching && !getUnlockedKeys(mailboxUid!) && (
                    <div className="px-4 py-2 border-b border-border bg-surface-alt">
                        <button
                            type="button"
                            onClick={handleUnlockSearch}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary-dark hover:underline"
                        >
                            <HiOutlineLockClosed size={12} aria-hidden="true" />
                            Unlock to include encrypted messages in these results
                        </button>
                    </div>
                )}
                {!isSearching && viewMode === "date" && undecryptedEncryptedUids.length > 0 && !getUnlockedKeys(activeMailboxUid) && (
                    <div className="px-4 py-2 border-b border-border bg-surface-alt">
                        <button
                            type="button"
                            onClick={handleUnlockList}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary-dark hover:underline"
                        >
                            <HiOutlineLockClosed size={12} aria-hidden="true" />
                            Unlock to show {undecryptedEncryptedUids.length === 1 ? "an encrypted message's" : "encrypted messages'"} subject
                        </button>
                    </div>
                )}

                {error && (
                    <div className="p-4">
                        <Alert>{error}</Alert>
                    </div>
                )}

                {loading ? (
                    <p className="p-4 text-sm text-text-muted">Loading&hellip;</p>
                ) : viewMode === "conversation" ? (
                    <ConversationList
                        conversations={conversations}
                        selectedId={selectedConversationId}
                        onSelect={handleSelectConversation}
                    />
                ) : visibleMessages.length === 0 ? (
                    <p className="p-4 text-sm text-text-muted">
                        {isSearching
                            ? `No messages match "${searchQuery}".`
                            : classificationFilter === "all"
                              ? "No messages in this folder."
                              : "No messages here."}
                    </p>
                ) : (
                    <>
                        <ul>
                            {visibleMessages.map((message) => (
                                <li key={message.uid}>
                                    <button
                                        type="button"
                                        onClick={() => handleSelect(message)}
                                        className={[
                                            "w-full text-left px-4 py-3 border-b border-border",
                                            message.uid === selectedUid ? "bg-primary/10" : "hover:bg-surface-alt",
                                            message.flags.read ? "" : "font-semibold",
                                        ].join(" ")}
                                    >
                                        <div className="flex items-center justify-between gap-2 text-sm">
                                            <span className="truncate">{message.from.displayName || message.from.address}</span>
                                            <span className="text-xs text-text-muted shrink-0">
                                                {new Date(message.receivedDate).toLocaleDateString()}
                                            </span>
                                        </div>
                                        {aggregateFolderType && (
                                            // The one view where a row needs to say which mailbox it came from.
                                            <div className="text-xs text-text-muted truncate font-normal">
                                                {mailboxes.find((mb) => mb.uid === message.mailboxUid)?.displayName}
                                            </div>
                                        )}
                                        {isSearching && pendingUids.has(message.uid) ? (
                                            // §_Progressive Results_: "Unresolved encrypted results MUST
                                            // be rendered as skeleton entries in place, not appended on
                                            // arrival." This uid is a Tier 1 metadataOnly guess Tier 2/3
                                            // haven't confirmed (or ruled out) yet.
                                            <div className="flex flex-col gap-1.5 py-0.5">
                                                <Skeleton height="h-3.5" className="w-2/3 rounded-sm" />
                                                <Skeleton height="h-3" className="w-full rounded-sm" />
                                            </div>
                                        ) : (
                                            <>
                                                <div className="text-sm truncate">
                                                    {decryptedRows[message.uid]?.subject ||
                                                        (message.subject === ENCRYPTED_SUBJECT_PLACEHOLDER
                                                            ? "Encrypted message"
                                                            : message.subject) ||
                                                        "(no subject)"}
                                                </div>
                                                <div className="text-xs text-text-muted truncate font-normal">
                                                    {snippets[message.uid] || decryptedRows[message.uid]?.preview || message.bodyPreview}
                                                </div>
                                            </>
                                        )}
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {hasMore && (
                            <div ref={sentinelRef} className="p-4 text-center text-xs text-text-muted">
                                {loadingMore ? "Loading more…" : ""}
                            </div>
                        )}
                        {aggregateFolderType && (
                            <p className="p-4 text-center text-xs text-text-muted">
                                Showing the most recent mail from each mailbox. Open a specific mailbox&rsquo;s folder to
                                see older mail.
                            </p>
                        )}
                    </>
                )}
            </div>
            <div className="hidden md:flex flex-1 min-w-0">
                {viewMode === "conversation" ? (
                    <ConversationThreadPane
                        conversation={selectedConversation}
                        folders={mailboxFolders.find((mf) => mf.mailbox.uid === activeMailboxUid)?.folders ?? []}
                        labels={labels}
                    />
                ) : (
                    <MessageDetailPane
                        message={selected}
                        attachments={attachments}
                        isSentItems={isSentItems}
                        onRecalled={(updated) => setMessages((prev) => prev.map((m) => (m.uid === updated.uid ? updated : m)))}
                        isOutbox={isOutbox}
                        isInbox={isInbox}
                        onClassified={(updated) => setMessages((prev) => prev.map((m) => (m.uid === updated.uid ? updated : m)))}
                        onReceiptHandled={(updated) => setMessages((prev) => prev.map((m) => (m.uid === updated.uid ? updated : m)))}
                        draftsFolderUid={draftsFolderUid}
                        onScheduledSendCanceled={(updated) => {
                            // The message moved out of the currently-viewed Outbox folder (into Drafts)
                            // — unlike a recall, which patches a message in place, this removes it from
                            // the list entirely, matching what a real folder switch would show.
                            setMessages((prev) => prev.filter((m) => m.uid !== updated.uid));
                            setSelectedUid(null);
                        }}
                        onArchived={(updated) => {
                            // Same reasoning as onScheduledSendCanceled above — the message moved out of
                            // whichever folder is currently being viewed (into Archive), so it's removed
                            // from the list rather than patched in place.
                            setMessages((prev) => prev.filter((m) => m.uid !== updated.uid));
                            setSelectedUid(null);
                        }}
                        labels={labels}
                        onLabelsChanged={(updated) => setMessages((prev) => prev.map((m) => (m.uid === updated.uid ? updated : m)))}
                    />
                )}
            </div>
        </div>
    );
}
