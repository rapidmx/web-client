///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useCallback, useEffect, useRef, useState } from "react";
import { HiOutlineLockClosed } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Message, MessageClassification, getMessage, getMessageRawContent, listMessages } from "@rapidmx/react-shared/mail/mailApi.js";
import { Label, listLabels } from "@rapidmx/react-shared/mail/labelsApi.js";
import { ConversationSummary, listConversations } from "@rapidmx/react-shared/mail/conversationsApi.js";
import { SearchResult, search as searchMailbox } from "@rapidmx/react-shared/search/searchApi.js";
import { parseSearchQuery } from "@rapidmx/react-shared/search/queryGrammar.js";
import { normalizeServerScores } from "@rapidmx/react-shared/search/searchScoring.js";
import { searchEncryptedCandidates } from "@rapidmx/react-shared/search/searchTier3.js";
import { searchLocalIndex } from "../shared/search/searchTier2.js";
import type { Coverage } from "../shared/search/localIndexWorker.js";
import { getUnlockedKeys, UnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import { evaluateMessageSecurity } from "@rapidmx/react-shared/crypto/messageSecurity.js";
import { useMarkMessageRead, useMessageAttachments } from "@rapidmx/react-shared/mail/mailDetailHooks.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import MailShell, { MailShellProps, useMailShell } from "../shared/components/mail/layout/MailShell.js";
import MessageDetailPane from "../shared/components/mail/MessageDetailPane.js";
import ConversationList from "../shared/components/mail/ConversationList.js";
import ConversationThreadPane from "../shared/components/mail/ConversationThreadPane.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
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
 * Deliberately not the spec's full skeleton/reordering "Progressive Results" UX (§_Progressive
 * Results_) - that's real, separate UI work; this returns one final merged list once every tier
 * resolves, same as how the search box already waits on one round-trip today. */
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

/** Resolves one page of search hits into full `Message` records for display, plus each hit's own
 * `snippet` (keyed by message uid) for rendering in place of the plain `bodyPreview` while searching.
 *
 * `rawQuery` is parsed once, client-side, via `queryGrammar.ts`'s `parseSearchQuery()` — the operator
 * grammar (`from:`/`to:`/`subject:`/`has:attachment`/`before:`/`after:`/`in:`/`is:`/`label:`/`type:`,
 * `specs/search.md` §14) is extracted into structured filters passed to the server, while the
 * remaining free text (quotes, `-` negation, `OR` all preserved) still drives ranking as `q`.
 * `type:` narrows `entityTypes`; when absent this still defaults to `["message"]` — a non-message hit
 * (contact/calendarEvent/note/task) has no `Message` to resolve via `getMessage()` below and is simply
 * dropped by the same eventually-consistent-index fallback that already existed, rather than rendered
 * (this inbox list only ever shows message rows; a real multi-entity-type results view is a separate,
 * larger UI project outside this pass).
 *
 * Tier 2 (`searchTier2.ts#searchLocalIndex()`, the local encrypted index) and Tier 3
 * (`searchTier3.ts#searchEncryptedCandidates()`, server-narrowed candidates) both run alongside Tier 1
 * only for the first page (`cursor` absent) - neither has pagination wiring yet (Tier 3's own deliberate
 * scope trim, documented in that module; Tier 2's local FTS5 query likewise only returns its own
 * top-`limit` page today), so a `loadMore()` continuation stays Tier-1-only. Both silently contribute
 * nothing when this mailbox has no unlocked keys this session (`getUnlockedKeys()` returns `undefined`) -
 * nothing for either to decrypt/query, same as `MessageDetailPane`'s own encrypted-message handling
 * elsewhere. `coverage` (from Tier 2) is `undefined` in that same case, and on any later page. */
async function searchMessages(
    mailboxUid: string,
    rawQuery: string,
    cursor?: string,
): Promise<{ messages: Message[]; nextCursor?: string; snippets: Record<string, string>; coverage?: Coverage }> {
    const parsed = parseSearchQuery(rawQuery);
    const unlocked = getUnlockedKeys(mailboxUid);
    const [page, tier2, tier3Results] = await Promise.all([
        searchMailbox(parsed.text, {
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
        }),
        cursor ? Promise.resolve({ results: [] as SearchResult[], coverage: undefined }) : searchLocalIndex(mailboxUid, parsed, unlocked),
        cursor ? Promise.resolve<SearchResult[]>([]) : searchEncryptedCandidates(parsed, unlocked),
    ]);
    const mergedResults = mergeSearchResults(page.results, tier2.results, tier3Results);
    const resolved = await Promise.all(
        mergedResults.map(async (hit) => {
            const message = await getMessage(hit.entityUid).catch(() => null);
            return message ? { message, snippet: hit.snippet } : null;
        }),
    );
    // A search hit can briefly outlive the message it points to (index updates are eventually consistent,
    // and a message can be deleted after being indexed) - drop anything that no longer resolves rather than
    // rendering a broken entry.
    const messages: Message[] = [];
    const snippets: Record<string, string> = {};
    for (const entry of resolved) {
        if (!entry) {
            continue;
        }
        messages.push(entry.message);
        if (entry.snippet) {
            snippets[entry.message.uid] = entry.snippet;
        }
    }
    return { messages, nextCursor: page.nextCursor, snippets, coverage: tier2.coverage };
}

export default function InboxPage(props: MailShellProps) {
    return (
        <MailShell {...props}>
            <InboxContent />
        </MailShell>
    );
}

function InboxContent() {
    const { folderUid, mailboxUid, mailboxes, folders } = useMailShell();
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
    // before Tier 2 has anything to report (not yet unlocked, or a loadMore continuation - see
    // searchMessages()'s own doc comment on why coverage is only ever populated on the first page).
    const [coverage, setCoverage] = useState<Coverage | undefined>(undefined);
    // Keyed by message uid - see decryptEncryptedRows(). Never cleared on folder/search switches (a
    // decrypted row stays decrypted for the rest of the session; re-decrypting on every navigation would
    // waste work for no benefit), only ever added to.
    const [decryptedRows, setDecryptedRows] = useState<Record<string, DecryptedRow>>({});
    // Bumped after a successful on-demand unlock to re-run the search effect below - it's not a
    // dependency the effect could otherwise react to (getUnlockedKeys() is a plain module-level read, not
    // React state; see keySession.ts's own doc comment).
    const [unlockRefresh, setUnlockRefresh] = useState(0);
    const isSearching = viewMode === "date" && searchQuery.length > 0;
    const pageRef = useRef(0);
    const cursorRef = useRef<string | undefined>(undefined);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const mailboxKeys = mailboxes.find((mb) => mb.uid === mailboxUid)?.keys ?? [];
    // `messages` themselves aren't a dependency here on purpose - a message uid, once decrypted, is
    // never re-decrypted just because the list re-renders with the same rows (e.g. a folder-unrelated
    // state update elsewhere). New rows (a fresh page load, load-more, or a completed search) each
    // re-trigger this the normal way, by changing `messages` itself.
    const undecryptedEncryptedUids = messages.filter((m) => m.subject === ENCRYPTED_SUBJECT_PLACEHOLDER && !decryptedRows[m.uid]).map((m) => m.uid);

    // Once unlocked, silently decrypt this page's own encrypted rows to show their real subject/preview -
    // no prompt needed here, the same way searchEncryptedCandidates() already auto-includes decrypted
    // matches once unlocked without asking again. Only the *first* unlock (or a fresh page of messages
    // arriving) needs this; `handleUnlockList()` below covers the not-yet-unlocked case explicitly.
    useEffect(() => {
        if (undecryptedEncryptedUids.length === 0) {
            return;
        }
        const unlocked = getUnlockedKeys(mailboxUid!);
        if (!unlocked) {
            return;
        }
        let cancelled = false;
        decryptEncryptedRows(
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages, unlockRefresh]);

    async function handleUnlockList() {
        try {
            const unlocked = await requestUnlock(mailboxUid!, mailboxKeys);
            const decrypted = await decryptEncryptedRows(
                messages.filter((m) => m.subject === ENCRYPTED_SUBJECT_PLACEHOLDER),
                unlocked,
            );
            setDecryptedRows((prev) => ({ ...prev, ...decrypted }));
        } catch {
            // User dismissed the unlock dialog - rows stay exactly as they were.
        }
    }

    async function handleUnlockSearch() {
        try {
            await requestUnlock(mailboxUid!, mailboxKeys);
            setUnlockRefresh((n) => n + 1);
        } catch {
            // User dismissed the unlock dialog - the search results stay exactly as they were.
        }
    }

    // Labels are mailbox-wide, not folder-scoped - fetched once per mailbox rather than per message, and
    // handed to every `MessageDetailPane` instance below. A failure here just means the Labels control
    // stays hidden (an empty `labels` array) rather than blocking the rest of the inbox - it's a small
    // enhancement, not critical path the way the message list itself is. No `mailboxUid` guard needed -
    // `MailShell` never renders this component at all until `mailboxUid` has resolved (same invariant
    // `searchMessages(mailboxUid!, ...)` below already relies on).
    useEffect(() => {
        listLabels(mailboxUid!, { limit: 200 })
            .then(setLabels)
            .catch(() => setLabels([]));
    }, [mailboxUid]);

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
        cursorRef.current = undefined;
        setHasMore(false);

        if (viewMode === "conversation") {
            // `mailboxUid` is always set by this point — `MailShell` only ever resolves `folderUid`
            // (this component's own guard just below, gating everything before this effect can even
            // run with `viewMode === "conversation"`) after `mailboxUid` is already known.
            setLoading(true);
            setError(null);
            listConversations(mailboxUid!)
                .then(setConversations)
                .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load conversations."))
                .finally(() => setLoading(false));
            return;
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
            searchMessages(mailboxUid!, searchQuery)
                .then(({ messages: results, nextCursor, snippets: newSnippets, coverage: newCoverage }) => {
                    setMessages(results);
                    setSnippets(newSnippets);
                    setHasMore(!!nextCursor);
                    cursorRef.current = nextCursor;
                    setCoverage(newCoverage);
                })
                .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Search failed."))
                .finally(() => setLoading(false));
            return;
        }

        listMessages(folderUid, { limit: MESSAGE_PAGE_SIZE })
            .then((results) => {
                setMessages(results);
                setHasMore(results.length === MESSAGE_PAGE_SIZE);
            })
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load messages."))
            .finally(() => setLoading(false));
        // `unlockRefresh` is a dependency solely so `handleUnlockSearch()` can force this effect to
        // re-run `searchMessages()` after a successful on-demand unlock - Tier 3 (encrypted) results
        // silently contribute nothing without unlocked keys, so this is what actually makes them appear
        // once the user unlocks. It has no effect on the non-search branches above; re-running them with
        // identical inputs just re-fetches the same page.
    }, [viewMode, folderUid, mailboxUid, isSearching, searchQuery, unlockRefresh]);

    const loadMore = useCallback(async () => {
        if (loadingMore || !hasMore || loading || viewMode !== "date" || !folderUid) {
            return;
        }
        setLoadingMore(true);
        try {
            if (isSearching) {
                const { messages: more, nextCursor, snippets: moreSnippets } = await searchMessages(mailboxUid!, searchQuery, cursorRef.current);
                setMessages((prev) => [...prev, ...more]);
                setSnippets((prev) => ({ ...prev, ...moreSnippets }));
                setHasMore(!!nextCursor);
                cursorRef.current = nextCursor;
            } else {
                const nextPage = pageRef.current + 1;
                const more = await listMessages(folderUid, { page: nextPage, limit: MESSAGE_PAGE_SIZE });
                setMessages((prev) => [...prev, ...more]);
                setHasMore(more.length === MESSAGE_PAGE_SIZE);
                pageRef.current = nextPage;
            }
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not load more messages.");
        } finally {
            setLoadingMore(false);
        }
    }, [loadingMore, hasMore, loading, viewMode, folderUid, isSearching, searchQuery]);

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
    // this falls back to the sidebar selection unchanged).
    const selectedFolderUid = isSearching ? (selected?.folderUid ?? folderUid) : folderUid;
    const isSentItems = folders.find((f) => f.uid === selectedFolderUid)?.type === "sent_items";
    const isOutbox = folders.find((f) => f.uid === selectedFolderUid)?.type === "outbox";
    const isInbox = folders.find((f) => f.uid === selectedFolderUid)?.type === "inbox";
    const draftsFolderUid = folders.find((f) => f.type === "drafts")?.uid;

    // Focused/Other is an Inbox-only concept (see `MessageDetailPane`'s own `isInbox` doc comment) — the
    // sub-tabs only ever render there, so a message with no `inferenceClassification` (the common case:
    // absent means Focused) or an explicit `"focused"` counts as Focused, everything else as Other.
    const visibleMessages =
        !isSearching && isInbox && classificationFilter !== "all"
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

    if (!folderUid) {
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
                            placeholder="Search all mail…"
                            aria-label="Search all mail"
                            className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-surface"
                        />
                    </div>
                )}
                {viewMode === "date" && isInbox && !isSearching && (
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

                {isSearching && coverage?.indexedFrom && (
                    <div className="px-4 py-1.5 text-xs text-text-muted border-b border-border">
                        Local search covers messages back to {new Date(coverage.indexedFrom).toLocaleDateString()}
                        {coverage.building ? " (still building)" : ""} - older encrypted mail is still searched, just slower.
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
                {!isSearching && viewMode === "date" && undecryptedEncryptedUids.length > 0 && !getUnlockedKeys(mailboxUid!) && (
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
                                        <div className="text-sm truncate">
                                            {decryptedRows[message.uid]?.subject ||
                                                (message.subject === ENCRYPTED_SUBJECT_PLACEHOLDER ? "Encrypted message" : message.subject) ||
                                                "(no subject)"}
                                        </div>
                                        <div className="text-xs text-text-muted truncate font-normal">
                                            {snippets[message.uid] || decryptedRows[message.uid]?.preview || message.bodyPreview}
                                        </div>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {hasMore && (
                            <div ref={sentinelRef} className="p-4 text-center text-xs text-text-muted">
                                {loadingMore ? "Loading more…" : ""}
                            </div>
                        )}
                    </>
                )}
            </div>
            <div className="hidden md:flex flex-1 min-w-0">
                {viewMode === "conversation" ? (
                    <ConversationThreadPane conversation={selectedConversation} folders={folders} labels={labels} />
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
