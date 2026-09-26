///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { routedPage } from "./_routedPage.js";
import { useNavigate } from "../shared/navigation/AppRouter.js";
import { whenIdle } from "../shared/navigation/idle.js";
import { prefetchComposeWindow } from "../shared/components/mail/compose/ComposeContext.js";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HiOutlineFlag, HiOutlineLockClosed, HiOutlinePaperClip } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    Folder,
    Mailbox,
    Message,
    MessageListFilter,
    MessageListParams,
    archiveMessage,
    bulkUpdateMessages,
    createFolder,
    getMessage,
    getMessageRawContent,
    listFolders,
    listMessages,
    moveMessages,
    setMessagesFlagged,
} from "@rapidmx/react-shared/mail/mailApi.js";
import { Label, listLabels } from "@rapidmx/react-shared/mail/labelsApi.js";
import {
    ConversationListParams,
    ConversationSummary,
    listConversationMessages,
    listConversations,
} from "@rapidmx/react-shared/mail/conversationsApi.js";
import { SearchResult, search as searchMailbox } from "@rapidmx/react-shared/search/searchApi.js";
import { parseSearchQuery, type ParsedSearchQuery } from "@rapidmx/react-shared/search/queryGrammar.js";
import { searchLocalIndex } from "../shared/search/searchTier2.js";
import {
    MailboxFailure,
    MailboxHit,
    SEARCH_LIMITS,
    classifyFailure,
    describeFailures,
    hitKey,
    mergeSearchResults,
    runLimited,
    searchPageSize,
    tagHits,
    withTimeout,
} from "../shared/search/crossMailboxSearch.js";
import type { Coverage } from "../shared/search/localIndexWorker.js";
import { getUnlockedKeys, subscribeKeySession, UnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import { useMessageAttachments } from "@rapidmx/react-shared/mail/mailDetailHooks.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import MailShell, {
    AggregateFolderType,
    MailboxFolders,
    MailShellProps,
    useMailShell,
} from "../shared/components/mail/layout/MailShell.js";
import MailAddress from "../shared/components/mail/MailAddress.js";
import OutboxRowStatus from "../shared/components/mail/OutboxRowStatus.js";
import { mergeFirstPage } from "../shared/mail/mergeFirstPage.js";
import { isOwnMailbox, orderMailboxes, primaryMailboxUid } from "../shared/mail/primaryMailbox.js";
import { listSnapshotKey, readListSnapshot, saveListScroll, writeListSnapshot } from "../shared/mail/listSnapshots.js";
import { setReadStateMany } from "../shared/mail/messageReadState.js";
import { useMarkMessageRead } from "../shared/mail/useMarkMessageRead.js";
import { ROW_FOCUS_CLASS, UnreadBar, UnreadLabel, dateClass, isUnread, rowClass, senderClass, subjectClass } from "../shared/components/mail/unreadStyle.js";
import { LazyConversationThreadPane, LazyMessageDetailPane, prefetchReadingPane } from "../shared/components/mail/LazyReadingPane.js";
import ConversationList from "../shared/components/mail/ConversationList.js";
import type { ConversationThreadHead } from "../shared/components/mail/ConversationThreadPane.js";
import SwipeRow from "../shared/components/mail/SwipeRow.js";
import InviteRowChip from "../shared/components/mail/invite/InviteRowChip.js";
import MoveToFolderDialog from "../shared/components/mail/MoveToFolderDialog.js";
import { EncryptedPreview } from "../shared/components/mail/reading/EncryptedPreview.js";
import MailListToolbar from "../shared/components/mail/MailListToolbar.js";
import MailSelectionBar from "../shared/components/mail/MailSelectionBar.js";
import EmptyFolderBar from "../shared/components/mail/EmptyFolderBar.js";
import { EMPTIABLE_FOLDER_TYPES } from "../shared/mail/permanentDelete.js";
import { usePermanentDelete } from "../shared/mail/usePermanentDelete.js";
import { useMailboxUpdateAccess } from "../shared/mail/useMailboxUpdateAccess.js";
import {
    CONVERSATION_SORT_NOTE,
    CONVERSATION_SORT_UNAVAILABLE,
    MAIL_LIST_CLASSIFICATION_FILTERS,
    MailListPreferences,
    getMailListPreferences,
    setMailListPreferences,
    sortConversations,
} from "../shared/components/mail/listPreferences.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Skeleton, { SkeletonList } from "@rapidmx/react-shared/components/feedback/Skeleton.js";
import { useUnlockPrompt } from "../shared/components/layout/UnlockPromptProvider.js";
import { SHORTCUTS } from "../shared/keyboard/keymap.js";
import { isActivatable } from "../shared/keyboard/targets.js";
import { useShortcut } from "../shared/keyboard/useShortcut.js";
import { notifyApiError } from "../shared/notifications/apiErrors.js";

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
    // Imported once for all the rows, by whichever needs it first.
    let securityModule: Promise<typeof import("@rapidmx/react-shared/crypto/messageSecurity.js")> | undefined;
    const entries = await Promise.all(
        encrypted.map(async (message): Promise<[string, DecryptedRow] | null> => {
            try {
                const rawMime = await getMessageRawContent(message.uid);
                // Loaded here, on first use: the S/MIME code (PKI.js, ASN.1, X.509) is over half a megabyte and an inbox with
                // no encrypted mail in it never needs it.
                const { evaluateMessageSecurity } = await (securityModule ??= import("@rapidmx/react-shared/crypto/messageSecurity.js"));
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

/** `type:` narrows `entityTypes`; when absent this still defaults to `["message"]` — a non-message hit
 * (contact/calendarEvent/note/task) has no `Message` to resolve via `getMessage()` below and is simply
 * dropped by the same eventually-consistent-index fallback that already existed, rather than rendered
 * (this inbox list only ever shows message rows; a real multi-entity-type results view is a separate,
 * larger UI project outside this pass). Shared by both the fresh-search orchestration and `loadMore()`
 * below, which each build this from the same `ParsedSearchQuery` differently only in `cursor`. */
function tier1SearchParams(parsed: ParsedSearchQuery, cursor: string | undefined, mailboxUid: string, limit: number) {
    return {
        // The mailbox being searched - omitted, the server searches the caller's *own* mailbox, which is the
        // wrong one whenever a shared mailbox's folder is being viewed (or several mailboxes are searched at once).
        mailboxUid,
        types: parsed.entityTypes ?? ["message"],
        cursor,
        limit,
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

function capSkeletons(tier1Hits: MailboxHit[]): MailboxHit[] {
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

/** Keyed by the exact query windows Tier 3 actually ran (`tier3Windows()` - which already reflect the query,
 * the "Search all mail" toggle, and Tier 2's coverage at the time), not just the query: the same query
 * narrowed differently (a build finished, new mail moved the coverage end) must not reuse a result that was
 * computed over a different date range. */
function tier3CacheKey(mailboxUid: string, windows: ParsedSearchQuery[], unlocked: boolean): string {
    return `${mailboxUid}|${JSON.stringify(windows)}|${String(unlocked)}`;
}

/** A search query's cache/cursor identity - stable across re-parsing the identical raw text, and
 * distinct for anything else (§8's "a query fingerprint, so a cursor cannot be replayed against a
 * different query"). `JSON.stringify` on `ParsedSearchQuery` is deterministic here because every one of
 * its own fields is a primitive or a `Date` (which serializes to a fixed ISO string) - no nested object
 * whose key order could vary between two structurally-identical parses of the same text. */
function queryFingerprint(parsed: ParsedSearchQuery): string {
    return JSON.stringify(parsed);
}

/** The date windows Tier 3 still has to search: the query's own range minus Tier 2's guaranteed coverage
 * `[coverage.indexedFrom, coverage.indexedUntil]`, unless the reader explicitly asked to "Search all mail".
 * Tier 2 already holds fully-decrypted, current content for that range, so re-fetching and re-decrypting it
 * through Tier 3's slower candidate-narrowing path would be pure waste. Yields up to two windows - older than
 * the coverage (`before:` tightened to `indexedFrom`) and newer than it (`after:` raised to `indexedUntil`,
 * since nothing indexes mail that arrived after the build pass started) - never *widening* a bound the query
 * already specified, and none at all when the query lies entirely inside the coverage.
 *
 * Only narrows once Tier 2 reports a finished, complete build pass from this session: while it's still
 * building (or a pass stopped early - a failed folder listing, the byte budget) `indexedFrom` is just the
 * oldest row that happens to be present, not a guarantee every encrypted message since then is indexed, and
 * narrowing on it would silently drop encrypted results neither tier returns. */
function tier3Windows(parsed: ParsedSearchQuery, coverage: Coverage | undefined, searchAllMail: boolean): ParsedSearchQuery[] {
    if (searchAllMail || !coverage?.indexedFrom || !coverage.indexedUntil || coverage.building || !coverage.complete) {
        return [parsed];
    }
    const coveredFrom = new Date(coverage.indexedFrom);
    const coveredUntil = new Date(coverage.indexedUntil);
    const windows: ParsedSearchQuery[] = [];
    if (!parsed.after || parsed.after.getTime() < coveredFrom.getTime()) {
        windows.push({ ...parsed, before: parsed.before && parsed.before.getTime() < coveredFrom.getTime() ? parsed.before : coveredFrom });
    }
    if (!parsed.before || parsed.before.getTime() > coveredUntil.getTime()) {
        windows.push({ ...parsed, after: parsed.after && parsed.after.getTime() > coveredUntil.getTime() ? parsed.after : coveredUntil });
    }
    return windows;
}

/** Runs Tier 3 over each window and merges the candidates (a uid can't match in two disjoint windows, but a
 * message whose date sits exactly on a boundary may come back from both). */
async function searchTier3Windows(
    windows: ParsedSearchQuery[],
    unlocked: UnlockedKeys | undefined,
    mailboxUid: string,
    loadTier3: () => Promise<typeof import("@rapidmx/react-shared/search/searchTier3.js")>,
): Promise<SearchResult[]> {
    // Loaded on first use, with the S/MIME code it decrypts through (see `decryptEncryptedRows()`) - once for however many mailboxes a search
    // covers: `loadTier3` hands every one of them the same import.
    const { searchEncryptedCandidates } = await loadTier3();
    const pages = await Promise.all(
        windows.map((window) => searchEncryptedCandidates(window, unlocked, TIER3_CANDIDATE_LIMIT, { mailboxUid })),
    );
    const merged = new Map<string, SearchResult>();
    for (const result of pages.flat()) {
        if (!merged.has(result.entityUid)) {
            merged.set(result.entityUid, result);
        }
    }
    return [...merged.values()];
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
    /** How many candidates the `Tier3Cache` entry holds - 0 for a mailbox whose Tier 3 pass failed, which has nothing to slice. */
    tier3Total: number;
    /** The `Tier3Cache` entry the first page was sliced from - later pages keep slicing the same one. */
    tier3Key: string;
    /** Whether any of the three tiers still has more to give for this mailbox. */
    more: boolean;
}

/** The paging state of one search across every mailbox it covers: one composite cursor per mailbox, each advancing on its own (a mailbox with
 * nothing more to give is simply left out of the next round), under one query fingerprint. A search of one mailbox has one entry. */
interface SearchCursor {
    fingerprint: string;
    /** How many results each mailbox was asked for per page - fixed for the search, from the number of mailboxes it covers. */
    pageSize: number;
    perMailbox: Map<string, CompositeCursor>;
}

/** `undefined` for a missing, corrupted, or foreign-query cursor - every caller already treats "no
 * cursor" as "start this tier from the beginning," so there's no separate error path needed here. */
function decodeCursor(raw: SearchCursor | undefined, fingerprint: string): SearchCursor | undefined {
    return raw?.fingerprint === fingerprint ? raw : undefined;
}

/** One mailbox's part of a search that is running: what each of its tiers has reported so far. */
interface MailboxRun {
    mailboxUid: string;
    /** The mailbox's keys as they were when the search started - none means Tier 2 and Tier 3 have nothing to contribute for it. */
    unlocked: UnlockedKeys | undefined;
    tier1: MailboxHit[];
    tier1Cursor?: string;
    tier2: MailboxHit[];
    tier2More: boolean;
    coverage?: Coverage;
    /** The first page of Tier 3's candidates, out of `tier3Total` (cached under `tier3Key`). */
    tier3: MailboxHit[];
    tier3Total: number;
    tier3Key: string;
    /** Tier 1 and Tier 2 have answered (or the mailbox failed); a failed mailbox takes no part in the rest. */
    tier1Settled: boolean;
    /** Tier 3 has answered, or failed - from then on this mailbox's unconfirmed metadata-only hits are pruned rather than shown as skeletons. */
    tier3Settled: boolean;
    failed: boolean;
}

/** The mailboxes a search's `cursor` can still be paged for. */
function mailboxesWithMore(cursor: SearchCursor): string[] {
    return [...cursor.perMailbox].filter(([, mailboxCursor]) => mailboxCursor.more).map(([uid]) => uid);
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

/** How far outside the scroll container's visible area the load-more sentinel still counts as "in view". */
const LOAD_MORE_ROOT_MARGIN_PX = 200;

/** How many full pages in a row that added no new rows the list keeps loading on its own before it shows a
 * "Load more" button instead. */
const MAX_EMPTY_PAGE_CONTINUATIONS = 3;

/** Hard ceiling on how many rows one list (the plain message list or the conversation list) keeps as live
 * React state/DOM at once. `MAX_EMPTY_PAGE_CONTINUATIONS` above only bounds a streak of *empty* pages, not
 * the total accumulated row count - infinite scroll on its own has no natural stopping point, so a reader
 * who fully scrolls a large mailbox would otherwise keep every row ever fetched mounted forever. Past this
 * cap, `loadMore()` stops fetching further pages and the list shows a "refine your search" banner instead of
 * the load-more sentinel - deliberately not virtualization (a larger, riskier change this bug's own writeup
 * called for only if trivial, which it isn't given this file's existing structure): capping the row count is
 * the same fix's low-risk cousin, since the unbounded-memory failure mode is identical either way. */
const MAX_LOADED_ROWS = 500;

/** `true` when `more` has at least one row `shown` doesn't - i.e. appending it actually adds rows. Generic
 * over the row's own identity so both the message list (`uid`) and the conversation list
 * (`conversationId`) page the same way. */
function hasUnseenRows<T>(shown: T[], more: T[], idOf: (row: T) => string): boolean {
    const seen = new Set(shown.map(idOf));
    return more.some((row) => !seen.has(idOf(row)));
}

/** The load-more sentinel's actual current geometry against its scroll container, with the same margin the
 * IntersectionObserver uses. */
function isWithinLoadMoreRange(sentinel: HTMLElement, root: HTMLElement): boolean {
    const rect = sentinel.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    return rect.top <= rootRect.bottom + LOAD_MORE_ROOT_MARGIN_PX && rect.bottom >= rootRect.top - LOAD_MORE_ROOT_MARGIN_PX;
}

/** Appends `more` to `shown`, skipping any row already shown - a later page can repeat rows (Tier 1 and
 * Tier 2/3 cursors advance independently, so the same message can come back from a different tier on a
 * later page; a plain folder listing's pages shift when new mail arrives between fetches). Generic for the
 * same reason `hasUnseenRows()` is.
 *
 * `cap`, when given, truncates the result to its first `cap` rows (dropping the tail) rather than letting
 * accumulated pages grow without bound - see `MAX_LOADED_ROWS`'s own doc comment for why this exists. */
function appendUnseenRows<T>(shown: T[], more: T[], idOf: (row: T) => string, cap?: number): T[] {
    const seen = new Set(shown.map(idOf));
    const unseen: T[] = [];
    for (const row of more) {
        if (!seen.has(idOf(row))) {
            seen.add(idOf(row));
            unseen.push(row);
        }
    }
    if (unseen.length === 0) {
        return shown;
    }
    const combined = [...shown, ...unseen];
    return cap !== undefined && combined.length > cap ? combined.slice(0, cap) : combined;
}

const messageUid = (message: Message) => message.uid;
const conversationKey = (conversation: ConversationSummary) => conversation.conversationId;

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
async function fetchAggregateMessages(
    mailboxFolders: MailboxFolders[],
    type: AggregateFolderType,
    filter: MessageListFilter,
): Promise<Message[]> {
    const perMailbox = await Promise.all(
        mailboxFolders.map(async ({ mailbox, folders }) => {
            const folder = folders.find((f) => f.type === type);
            if (!folder) {
                return { mailbox, messages: [] as Message[] };
            }
            // The filter is a server-side one per mailbox; the *sort* deliberately isn't offered here (see
            // this function's own pagination scope trim) - each mailbox contributes its own newest page and
            // they're merged newest-first, which a different sort key couldn't be made honest across an
            // arbitrary number of independently-paged folders.
            const messages = await listMessages(folder.uid, { limit: MESSAGE_PAGE_SIZE, filter }).catch(() => [] as Message[]);
            return { mailbox, messages };
        }),
    );
    return mergeInboxMessages(perMailbox);
}

/** One conversation's part of a set of search results. */
interface ResultGroup {
    /** The conversation's id - a message that belongs to no thread is its own conversation. */
    id: string;
    /** The mailbox the conversation is in: the same id in two mailboxes (a message sent to both) is two conversations. */
    mailboxUid: string;
    /** Only the messages of the conversation that are among the results, in the order they were ranked. */
    messages: Message[];
}

/** Groups search results by the conversation each message belongs to - within its own mailbox - the groups in the order of their first result. */
function groupByConversation(results: Message[]): ResultGroup[] {
    const groups = new Map<string, ResultGroup>();
    for (const message of results) {
        const id = message.conversationId ?? message.uid;
        const key = `${message.mailboxUid}\u0000${id}`;
        const group = groups.get(key);
        if (group) {
            group.messages.push(message);
        } else {
            groups.set(key, { id, mailboxUid: message.mailboxUid, messages: [message] });
        }
    }
    return [...groups.values()];
}

function InboxPage(props: MailShellProps) {
    return (
        <MailShell {...props}>
            <InboxContent userUid={props.userUid} />
        </MailShell>
    );
}

function InboxContent({ userUid }: { userUid?: string }) {
    const { folderUid, mailboxUid, mailboxes, mailboxFolders, aggregateFolderType, onFolderCreated, noteFolderUids, live, trackMessageChange, folderCountOf, mobileSearchSlot } = useMailShell();
    const isMobile = useIsMobile();
    const navigate = useNavigate();
    const { requestUnlock } = useUnlockPrompt();
    const [messages, setMessages] = useState<Message[]>([]);
    const [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [loading, setLoading] = useState(true);
    // Once a list is on screen and the browser has nothing better to do, fetch the code a click on a message (the reading pane)
    // or on Compose/Reply (the compose window, with its editor) would otherwise wait for.
    useEffect(() => {
        if (loading) {
            return;
        }
        return whenIdle(() => {
            prefetchReadingPane();
            prefetchComposeWindow();
        });
    }, [loading]);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedUid, setSelectedUid] = useState<string | null>(null);
    // The thread the conversation list opened, and which of its messages was picked - the reading pane
    // shows the whole conversation, positioned at that message (see `ConversationThreadPane`).
    // The mailbox is the open thread's own: a search over several mailboxes can open one that is not the page's mailbox.
    const [openThread, setOpenThread] = useState<{ conversation: ConversationThreadHead; uid: string; mailboxUid: string } | null>(null);
    // Messages the page has a newer copy of than `ConversationList` fetched (so far only the one the reading
    // pane just marked read), applied over its own child rows so they don't stay bold after being read.
    const [conversationPatches, setConversationPatches] = useState<Record<string, Message>>({});
    // Folders this session created on demand for a bulk Delete/Report junk - see `resolveFolderOfType()`.
    const lazyFoldersRef = useRef<Map<string, string>>(new Map());
    const [selectMode, setSelectMode] = useState(false);
    const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
    // Select mode over the *conversation* list ticks whole conversations rather than messages: the rows
    // there are conversations, and a bulk action on one means "every message of it that is in this folder".
    // Their messages are fetched (once, cached here) as each conversation is ticked, so the selection bar
    // and every bulk action below keep working on the `Message[]` they already take.
    const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(new Set());
    const [conversationMessagesById, setConversationMessagesById] = useState<Record<string, Message[]>>({});
    // A ticked conversation whose messages are still being fetched - every bulk action is held meanwhile,
    // or it would act on a selection that is still arriving.
    const [resolvingSelection, setResolvingSelection] = useState(0);
    const [bulkBusy, setBulkBusy] = useState(false);
    // Delete on what is already in Deleted Items, and Empty folder: confirmed, then done for good (see `usePermanentDelete()`).
    const permanent = usePermanentDelete();
    // Bumped to force the list effect below to re-run - a bulk update is deliberately neither atomic nor
    // all-or-nothing (see `bulkUpdateMessages()`), so a rejection means refetching rather than guessing
    // which half of the selection actually landed.
    const [refreshKey, setRefreshKey] = useState(0);
    const [searchInput, setSearchInput] = useState("");
    const [searchQuery, setSearchQuery] = useState("");
    const [snippets, setSnippets] = useState<Record<string, string>>({});
    // The *open mailbox's* labels, for the Filter menu's Labels submenu, select mode's Apply label, and -
    // unless the selected message belongs to another mailbox - the reading pane's own Labels menu.
    const [mailboxLabels, setMailboxLabels] = useState<Label[]>([]);
    // The selected message's own mailbox's labels, when that is a different mailbox from the open one: in
    // search and aggregate views it can be, and its labels must not be offered as a filter for this one.
    // Empty (and never fetched) otherwise - see `labels` below.
    const [otherMailboxLabels, setOtherMailboxLabels] = useState<Label[]>([]);
    // Tier 2's own reported window coverage for each mailbox the current search covers - empty outside a search, and
    // holding nothing for a mailbox until Tier 2 has resolved for it in this search pass (or at all, for one without a local index).
    const [coverages, setCoverages] = useState<Record<string, Coverage | undefined>>({});
    // The mailboxes the current search could not (fully) search, and why - only a search over several mailboxes carries on past a
    // failed one (a search of one mailbox fails as a whole, as it always has).
    const [searchFailures, setSearchFailures] = useState<MailboxFailure[]>([]);
    // "Search all mailboxes" from a mailbox's own folder: the search is widened to every mailbox the reader can read. Reset with the search
    // (see the effects below), and by leaving the folder.
    const [searchAllMailboxes, setSearchAllMailboxes] = useState(false);
    // Keyed by message uid - see decryptEncryptedRows(). Never cleared on folder/search switches (a
    // decrypted row stays decrypted while its keys stay unlocked; re-decrypting on every navigation would
    // waste work for no benefit) - only cleared when the mailbox's keys are locked (see the
    // `subscribeKeySession()` effect below).
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
    // re-run. Stored as the mailbox/folder/query it was requested for, not a plain flag, so it resets the
    // moment any of those change - derived in the same render, so the search effect never runs a new
    // query with a previous query's unbounded Tier 3 window first.
    const [searchAllMailKey, setSearchAllMailKey] = useState<string | null>(null);
    const searchAllMailScope = `${mailboxUid ?? ""}\n${folderUid ?? ""}\n${searchQuery}`;
    const searchAllMail = searchAllMailKey === searchAllMailScope;
    // The mailbox unlock/decrypt call sites below treat as "the" mailbox when there's no single selected
    // one (aggregate mode) - mirrors `MailShell`'s own identical `defaultMailboxUid` fallback. An
    // aggregate-view row from a *different*, not-yet-unlocked mailbox stays locked until that mailbox's
    // own folder view is opened directly - an accepted limitation, not a bug (see `MailShell`'s own doc
    // comment on the same tradeoff for its `LocalIndexLifecycle`/`KeyEnrollmentGate` wiring).
    // Always set once this page renders: a caller with no mailbox at all gets `MailboxProvisioning` from the shell instead.
    const activeMailboxUid = (mailboxUid ?? primaryMailboxUid(mailboxes, userUid))!;
    const mailboxKeys = mailboxes.find((mb) => mb.uid === activeMailboxUid)?.keys ?? [];
    // False for a mailbox shared with the reader view-only: Empty folder is not offered there (the server would refuse it).
    const mailboxWritable = useMailboxUpdateAccess(mailboxes.find((mb) => mb.uid === activeMailboxUid));
    // The Sort/Filter menus' and "Show as conversations"' current settings, remembered per mailbox across
    // reloads (`listPreferences.ts`). Read during render, not in an effect, so the very first listing
    // already uses the remembered arrangement rather than fetching the default one and immediately
    // refetching it - and kept per mailbox rather than as one value plus a "which mailbox is this?" check,
    // so switching mailbox simply reads the other entry. What this session has changed wins over the store,
    // which a storage-blocked browser refuses to keep.
    const [preferencesByMailbox, setPreferencesByMailbox] = useState<Record<string, MailListPreferences>>({});
    const preferences: MailListPreferences = preferencesByMailbox[activeMailboxUid] ?? getMailListPreferences(activeMailboxUid);
    function updatePreferences(patch: Partial<MailListPreferences>) {
        const next = { ...preferences, ...patch };
        setPreferencesByMailbox((prev) => ({ ...prev, [activeMailboxUid]: next }));
        setMailListPreferences(activeMailboxUid, next);
    }
    // What a search covers. In a mailbox's own folder it is that mailbox (all of its folders, as it always was); in an "All mailboxes" view - or
    // once the reader has widened it from a folder - it is every mailbox they can read, the very set those views aggregate: the ones whose
    // folders could be listed (a mailbox whose listing failed, say a delegate grant without mail access, is not readable). Tier 1/2/3 are all
    // mailbox-scoped, so a search over several is the same per-mailbox search once for each, merged (see the search effect below). Own
    // mailboxes come first, so the cap on how many are searched at once leaves out shared ones before the reader's own.
    const readableMailboxes = mailboxFolders.filter((mf) => !mf.error).map((mf) => mf.mailbox);
    const crossMailbox = !!aggregateFolderType || searchAllMailboxes;
    // `in:<folder>` names a folder, and a folder belongs to one mailbox: only that mailbox can have results, so only it is searched (a folder none of
    // them has is left to the server to say so of every mailbox).
    const inFolderUid = crossMailbox ? parseSearchQuery(searchQuery).folderUid : undefined;
    const mailboxesWithFolder = inFolderUid
        ? mailboxFolders.filter((mf) => !mf.error && mf.folders.some((f) => f.uid === inFolderUid)).map((mf) => mf.mailbox)
        : [];
    const searchableMailboxes = mailboxesWithFolder.length > 0 ? mailboxesWithFolder : readableMailboxes;
    const searchedMailboxes = crossMailbox ? orderMailboxes(searchableMailboxes, userUid).slice(0, SEARCH_LIMITS.maxMailboxes) : [];
    // A single mailbox's own folder always has one; a cross-mailbox search has whichever it covers.
    const searchTargetUids = crossMailbox ? searchedMailboxes.map((mb) => mb.uid) : [mailboxUid!];
    // A dependency of the search effect, which can't take the array itself.
    const searchTargetKey = searchTargetUids.join(",");
    // Search works whichever way the list is arranged. Its results are messages, so while a query is held the list is fetched as
    // messages (`asConversations` is about the list's data and is false then), and when the reader arranges by conversation they are
    // shown grouped under their conversation - only the messages that match - with the whole thread in the reading pane
    // (`threadPane`, which follows the arrangement the reader chose and not the query).
    const isSearching = searchQuery.length > 0;
    /** How many rows the list on screen keeps: the same 500 for a search as for a listing (`SEARCH_LIMITS.maxRows`, which a test can shrink). */
    const rowCap = isSearching ? SEARCH_LIMITS.maxRows : MAX_LOADED_ROWS;
    const asConversations = preferences.showAsConversations && !isSearching;
    const threadPane = preferences.showAsConversations;
    const groupedResults = isSearching && preferences.showAsConversations;
    // Focused/Other is an Inbox-only concept (`FocusedInboxUtils.classifyMessage()` short-circuits to
    // Focused for every other folder), and
    // search results are ranked across folders rather than listed from one, so neither tab is offered
    // there. Not offered for an aggregate view either (each mailbox classifies independently; merging
    // that is out of scope).
    const foldersOf = (ofMailbox: string) => mailboxFolders.find((mf) => mf.mailbox.uid === ofMailbox)?.folders ?? [];
    const currentFolders = foldersOf(activeMailboxUid);
    const currentFolderIsInbox = currentFolders.find((f) => f.uid === folderUid)?.type === "inbox";
    const offerClassificationFilters = currentFolderIsInbox && !isSearching && !aggregateFolderType;
    // A remembered Focused/Other filter must not silently narrow a folder that has no Focused Inbox to
    // speak of - it stays remembered for when the Inbox is opened again, but doesn't apply meanwhile.
    const effectiveFilter: MessageListFilter =
        (preferences.filter === "focused" || preferences.filter === "other") && !offerClassificationFilters
            ? "all"
            : preferences.filter;
    // Left out entirely rather than sent empty, so a list with no label filter asks for exactly the URL it
    // always did.
    const labelFilter = preferences.labelUids.length > 0 ? { labelUids: preferences.labelUids } : {};
    // Every server-side list parameter the toolbar controls, in one place so the first page and each
    // `loadMore()` page can't drift apart.
    const listParams: MessageListParams = {
        limit: MESSAGE_PAGE_SIZE,
        sortBy: preferences.sortBy,
        sortOrder: preferences.sortOrder,
        filter: effectiveFilter,
        ...labelFilter,
    };
    // A dependency of the list effect and of `loadMore()`, which can't take the array itself (a new one
    // every render would refetch on every render).
    const labelFilterKey = preferences.labelUids.join(",");
    /** The sort the *server* is being asked for, as one dependency value. Empty while conversations are
     * shown: `GET /mail/messages/conversations` takes no sort parameters at all, so those rows are ordered
     * in the browser (`sortConversations()`) and rearranging them must not refetch the identical page -
     * which would also collapse whichever conversations the reader had expanded. */
    const serverSortKey = asConversations ? "" : `${preferences.sortBy}:${preferences.sortOrder}`;
    /** The conversation list's own equivalent of `listParams` - a function because the page differs. */
    function conversationParams(page: number): ConversationListParams {
        return { folderUid, filter: effectiveFilter, ...labelFilter, page, limit: MESSAGE_PAGE_SIZE };
    }
    // How far into the folder's *current* server-side listing the rows fetched so far reach. Offset
    // paging, not a cursor (`listMessages()` has none): a row removed locally (archived, scheduled send
    // cancelled) also left the folder server-side, shifting every later message back by one - so each
    // removal steps this back too, or the next page would silently skip a message. See `loadMore()`.
    const listedOffsetRef = useRef(0);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    // Where the message the keyboard just removed from the list (deleted, archived, moved) was: the next Down/Up continues from that spot, so
    // clearing an inbox from the keyboard walks down it instead of jumping back to the top. Cleared by any selection.
    const removedAnchorRef = useRef<number | null>(null);
    // State (via a callback ref), not a plain ref: the sentinel mounts and unmounts as the list loads,
    // filters, and empties, and the observer effect below must re-attach to whichever node is current.
    const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
    const loadMoreErrorRef = useRef<string | null>(null);
    loadMoreErrorRef.current = loadMoreError;
    const loadMoreInFlightRef = useRef(false);
    // Bumped by `loadMore()` for each page that added at least one row - the only event the continuation
    // effect below keeps loading after. A counter rather than watching `loadingMore` flip back to false: a
    // fast response can settle before React ever renders the `true`, so that flip isn't reliably observable.
    const [appendedPageCount, setAppendedPageCount] = useState(0);
    // Consecutive full pages that added no new rows (every row was already shown - e.g. new mail shifted the
    // folder's pages). Such a page still counts as progress for the continuation effect, up to
    // `MAX_EMPTY_PAGE_CONTINUATIONS` in a row; past that, `loadMoreStalled` shows a "Load more" button
    // instead, so a server that keeps repeating rows is never looped on.
    const emptyPageStreakRef = useRef(0);
    const [loadMoreStalled, setLoadMoreStalled] = useState(false);
    const messagesRef = useRef(messages);
    messagesRef.current = messages;
    const conversationsRef = useRef(conversations);
    conversationsRef.current = conversations;
    // Reset to a fresh Map at the start of every new search pass (see the search effect below) - see
    // resolveHitsToMessages()'s own doc comment on why this needs to persist *within* one pass but not
    // across passes (a stale `null` for a uid that's since become resolvable elsewhere must not stick).
    const resolvedMessageCacheRef = useRef<Map<string, Message | null>>(new Map());
    // Session-scoped, never explicitly cleared - see Tier3Cache's own doc comment above.
    const tier3CacheRef = useRef<Tier3Cache>(new Map());
    // The latest cursor this search pass has reached (one composite cursor per mailbox searched) - read by loadMore(), written at the end
    // of both the fresh-search orchestration and loadMore() itself. Not React state: it never drives a
    // render on its own, only what loadMore() does with it later.
    const compositeCursorRef = useRef<SearchCursor | undefined>(undefined);
    // Guards every async load below - each search stage, the plain folder/conversation/aggregate listings,
    // and `loadMore()` - against a stale, still-in-flight pass clobbering state for a newer one that started
    // after it (the query, folder, or view changed) - the same `loadSeq`-style monotonic-id pattern already used elsewhere in this codebase (e.g.
    // `settings/privacy/index.tsx`'s `ExportSection`), generalized here across three independently-timed
    // async stages instead of one.
    const searchRunIdRef = useRef(0);
    // Bumped whenever `activeMailboxUid`'s keys are locked (see the `subscribeKeySession()` effect below) - a
    // decrypt that started before the lock checks it before storing its now-stale plaintext rows.
    const lockGenerationRef = useRef(0);
    // `messages` themselves aren't a dependency here on purpose - a message uid, once decrypted, is
    // never re-decrypted just because the list re-renders with the same rows (e.g. a folder-unrelated
    // state update elsewhere). New rows (a fresh page load, load-more, or a completed search) each
    // re-trigger this the normal way, by changing `messages` itself.
    //
    // The auto-decrypt below covers every mailbox whose keys are unlocked - in aggregate mode and in a search over several mailboxes `messages`
    // spans them, and a mailbox unlocked from the search's own banner has rows to show. The manual unlock banner (`handleUnlockList()`) is
    // still about `activeMailboxUid` only (see its own doc comment above): a row of a locked mailbox stays "Encrypted message".
    const undecryptedEncrypted = messages.filter((m) => m.subject === ENCRYPTED_SUBJECT_PLACEHOLDER && !decryptedRows[m.uid]);
    const undecryptedEncryptedUids = undecryptedEncrypted.filter((m) => m.mailboxUid === activeMailboxUid).map((m) => m.uid);

    // Once unlocked, silently decrypt this page's own encrypted rows to show their real subject/preview -
    // no prompt needed here, the same way searchEncryptedCandidates() already auto-includes decrypted
    // matches once unlocked without asking again. Only the *first* unlock (or a fresh page of messages
    // arriving) needs this; `handleUnlockList()` below covers the not-yet-unlocked case explicitly.
    useEffect(() => {
        let cancelled = false;
        const lockGeneration = lockGenerationRef.current;
        const rowsByMailbox = new Map<string, Message[]>();
        for (const message of undecryptedEncrypted) {
            rowsByMailbox.set(message.mailboxUid, [...(rowsByMailbox.get(message.mailboxUid) ?? []), message]);
        }
        for (const [rowsMailboxUid, rows] of rowsByMailbox) {
            const unlocked = getUnlockedKeys(rowsMailboxUid);
            if (!unlocked) {
                continue;
            }
            void decryptEncryptedRows(rows, unlocked).then((decrypted) => {
                // A lock while this was in flight already cleared `decryptedRows` - never put them back.
                if (!cancelled && lockGeneration === lockGenerationRef.current && Object.keys(decrypted).length > 0) {
                    setDecryptedRows((prev) => ({ ...prev, ...decrypted }));
                }
            });
        }
        return () => {
            cancelled = true;
        };
    }, [messages, unlockRefresh]);

    // Locking a mailbox's keys (idle timeout, "Destroy keys on this device now", sign-out) must take its
    // decrypted content off screen too, not just out of memory: decrypted subjects/previews, search
    // snippets (Tier 2/3 snippets are decrypted content), and the already-decrypted Tier 3 candidates. A
    // live search re-runs, so Tier 2/3 contribute nothing again until the user unlocks. Read through a ref
    // so the subscription itself doesn't churn on every render.
    const keyLockStateRef = useRef({ activeMailboxUid, isSearching, searchTargetUids });
    keyLockStateRef.current = { activeMailboxUid, isSearching, searchTargetUids };
    useEffect(
        () =>
            subscribeKeySession(({ mailboxUid: changedMailboxUid, state }) => {
                const current = keyLockStateRef.current;
                // The open mailbox's, or - while searching - any mailbox the search covers: their decrypted hits are on screen too.
                const relevant = changedMailboxUid === current.activeMailboxUid || (current.isSearching && current.searchTargetUids.includes(changedMailboxUid));
                if (state !== "locked" || !relevant) {
                    return;
                }
                lockGenerationRef.current += 1;
                setDecryptedRows({});
                setSnippets({});
                tier3CacheRef.current.clear();
                if (current.isSearching) {
                    setUnlockRefresh((n) => n + 1);
                }
            }),
        [],
    );

    async function handleUnlockList() {
        try {
            const unlocked = await requestUnlock(activeMailboxUid, mailboxKeys);
            const lockGeneration = lockGenerationRef.current;
            const decrypted = await decryptEncryptedRows(
                messages.filter((m) => m.subject === ENCRYPTED_SUBJECT_PLACEHOLDER && m.mailboxUid === activeMailboxUid),
                unlocked,
            );
            if (lockGeneration === lockGenerationRef.current) {
                setDecryptedRows((prev) => ({ ...prev, ...decrypted }));
            }
        } catch {
            // User dismissed the unlock dialog - rows stay exactly as they were.
        }
    }

    /** The mailboxes a search over several could include encrypted mail from if they were unlocked: the ones with keys that are locked right now.
     * `unlockable` are the reader's own - a shared mailbox's keys belong to its owner, and unlocking them is not something this page can ask for. */
    const lockedSearchMailboxes = crossMailbox ? searchedMailboxes.filter((mb) => (mb.keys?.length ?? 0) > 0 && !getUnlockedKeys(mb.uid)) : [];
    const unlockableSearchMailboxes = lockedSearchMailboxes.filter((mb) => isOwnMailbox(mb, userUid));
    const sharedLockedSearchMailboxes = lockedSearchMailboxes.filter((mb) => !isOwnMailbox(mb, userUid));
    /** Unlocked mailboxes with encrypted mail to search that have no local index on this device (the index is only built for the open mailbox), so
     * only Tier 3 - server-narrowed, bounded - reaches their encrypted mail. */
    const serverOnlyMailboxes = crossMailbox
        ? searchedMailboxes.filter((mb) => (mb.keys?.length ?? 0) > 0 && !!getUnlockedKeys(mb.uid) && !coverages[mb.uid]?.indexedFrom)
        : [];
    /** The one mailbox's own coverage, for a search of one. */
    const coverage = coverages[mailboxUid ?? ""];
    /** A folder's search can be widened to every mailbox, when there is more than one to widen it to. */
    const widenable = !aggregateFolderType && readableMailboxes.length > 1;

    async function handleUnlockSearch() {
        try {
            if (crossMailbox) {
                // One prompt per locked mailbox of the reader's own, in turn; a dismissed one stops the rest.
                for (const mailbox of unlockableSearchMailboxes) {
                    await requestUnlock(mailbox.uid, mailbox.keys!);
                    setUnlockRefresh((n) => n + 1);
                }
                return;
            }
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
    const labelsMailboxUid = threadPane ? (openThread?.mailboxUid ?? activeMailboxUid) : (selectedMessageMailboxUid ?? activeMailboxUid);
    // Almost always the open mailbox's own labels, already fetched below - so `labels` reuses that list
    // rather than asking for the identical one a second time (which is what this page did on every single
    // view). Only a selected message from *another* mailbox - a search hit or an aggregate-view row - needs
    // its own fetch, and only then is this state used at all.
    const otherMailbox = labelsMailboxUid !== activeMailboxUid;
    const labels = otherMailbox ? otherMailboxLabels : mailboxLabels;
    // `labelsMailboxUid` is always set: `MailShell` only renders this component once at least one mailbox
    // exists, so `activeMailboxUid` (its fallback) always resolves.
    useEffect(() => {
        if (!otherMailbox) {
            setOtherMailboxLabels([]);
            return;
        }
        let cancelled = false;
        setOtherMailboxLabels([]);
        listLabels(labelsMailboxUid, { limit: 200 })
            .then((result) => {
                if (!cancelled) {
                    setOtherMailboxLabels(result);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [labelsMailboxUid, otherMailbox]);

    useEffect(() => {
        let cancelled = false;
        setMailboxLabels([]);
        listLabels(activeMailboxUid, { limit: 200 })
            .then((result) => {
                if (!cancelled) {
                    setMailboxLabels(result);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [activeMailboxUid]);

    // Debounce the raw input into the query actually searched, so every keystroke doesn't fire a request.
    useEffect(() => {
        const handle = setTimeout(() => setSearchQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [searchInput]);

    // Choosing another folder no longer loads a new page, so what was being searched for would follow the reader into it: the
    // search box and its results are cleared instead, as the page load used to. (The first selection resolves after mount - the
    // shell reads the URL and lists the folders in effects - and is not a change of folder.)
    const selectionKey = `${mailboxUid ?? ""}|${folderUid ?? ""}|${aggregateFolderType ?? ""}`;
    const shownSelectionRef = useRef<string | null>(null);
    useEffect(() => {
        const shown = shownSelectionRef.current;
        if (shown !== null && shown !== selectionKey) {
            setSearchInput("");
            setSearchQuery("");
            setSearchAllMailboxes(false);
        }
        if (folderUid || aggregateFolderType) {
            shownSelectionRef.current = selectionKey;
        }
    }, [selectionKey]);
    // A search widened to every mailbox lasts for that search: once the box is emptied the next one starts in the open folder's mailbox again.
    useEffect(() => {
        if (searchQuery === "") {
            setSearchAllMailboxes(false);
        }
    }, [searchQuery]);
    // Rows can be ticked in the results of a search over every mailbox, but not in the listing they came out of: clearing the search leaves select mode.
    useEffect(() => {
        if (aggregateFolderType && !isSearching) {
            setSelectMode(false);
        }
    }, [aggregateFolderType, isSearching]);

    // Which listing this is, for the short-lived snapshot of each folder that makes going back to one instant (see
    // `listSnapshots.ts`). A search, an aggregate view and a folder that hasn't resolved have no snapshot.
    const listKey = listSnapshotKey({
        mailboxUid: activeMailboxUid,
        folderUid,
        conversations: asConversations,
        filter: effectiveFilter,
        labels: labelFilterKey,
        sort: serverSortKey,
    });
    const snapshotable = !!folderUid && !isSearching && !aggregateFolderType;
    /** The key of the listing `messages`/`conversations` currently hold - not `listKey` while a new folder's rows are still coming. */
    const shownListKeyRef = useRef<string | null>(null);
    /** A scroll position to put the list back at once its rows are on screen (a snapshot's). */
    const pendingScrollRef = useRef<number | null>(null);
    useLayoutEffect(() => {
        if (pendingScrollRef.current !== null && !loading && scrollContainerRef.current) {
            scrollContainerRef.current.scrollTop = pendingScrollRef.current;
            pendingScrollRef.current = null;
        }
    });
    // Keeps the snapshot of the folder on screen current - rows added by "load more" or live updates, a read message, the selection.
    useEffect(() => {
        if (snapshotable && !loading && shownListKeyRef.current === listKey) {
            writeListSnapshot(listKey, { messages, conversations, hasMore, selectedUid });
        }
    }, [snapshotable, loading, listKey, messages, conversations, hasMore, selectedUid]);

    // Loads whichever list the current folder, arrangement and search state call for, and resets every
    // piece of per-listing state (selection, paging, select mode) that a previous listing left behind.
    useEffect(() => {
        setSelectedUid(null);
        setOpenThread(null);
        setConversationPatches({});
        setSelectedUids(new Set());
        setSelectedConversationIds(new Set());
        setConversationMessagesById({});
        listedOffsetRef.current = 0;
        compositeCursorRef.current = undefined;
        setHasMore(false);
        setLoadMoreError(null);
        setLoadMoreStalled(false);
        emptyPageStreakRef.current = 0;
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
        // A folder shown a moment ago is put on screen at once and revalidated behind the rows; one that was not shows a skeleton.
        const snapshot = snapshotable ? readListSnapshot(listKey) : undefined;

        if (!folderUid && !aggregateFolderType) {
            // The shell hasn't resolved this mailbox's folders yet (the render below says so). Listing
            // anything now means a request whose answer is thrown away the moment the Inbox arrives - and
            // for conversations a mailbox-wide grouping pass, the most expensive listing there is.
            setMessages([]);
            setConversations([]);
            setLoading(false);
            return;
        }
        if (aggregateFolderType && mailboxFolders.length === 0) {
            // The same, for a merged view: it has no folder of its own, but it is built from every
            // mailbox's folders, and this effect re-runs the moment they arrive. Listing twice is what
            // that cost before.
            setMessages([]);
            setConversations([]);
            setLoading(true);
            return;
        }

        if (asConversations) {
            // Conversations stay single-mailbox (not aggregated across mailboxes in this pass) - in
            // aggregate mode this falls back to `activeMailboxUid`, the same mailbox unlock/labels use
            // (always set - `MailShell` only renders this component once at least one mailbox exists).
            // They're scoped to the selected folder (`folderUid`, absent only in aggregate mode), so the
            // conversation list matches the folder the sidebar has selected rather than the whole mailbox.
            if (snapshot) {
                setConversations(snapshot.conversations);
                listedOffsetRef.current = snapshot.conversations.length;
                setHasMore(snapshot.hasMore);
                shownListKeyRef.current = listKey;
                pendingScrollRef.current = snapshot.scrollTop;
                setLoading(false);
            } else {
                setLoading(true);
            }
            setError(null);
            listConversations(activeMailboxUid, conversationParams(0))
                .then((result) => {
                    if (isCurrentRun()) {
                        shownListKeyRef.current = listKey;
                        if (snapshot) {
                            // Folded into what is already shown, as a live refresh does, so the reader's place is kept.
                            const merged = mergeFirstPage(snapshot.conversations, result, conversationKey, MESSAGE_PAGE_SIZE);
                            setConversations(merged.rows);
                            listedOffsetRef.current = merged.complete ? result.length : snapshot.conversations.length + merged.added;
                            setHasMore(!merged.complete);
                            return;
                        }
                        setConversations(result);
                        listedOffsetRef.current = result.length;
                        setHasMore(result.length === MESSAGE_PAGE_SIZE);
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

        if (aggregateFolderType && !isSearching) {
            setLoading(true);
            setError(null);
            // hasMore stays false (set above) - see fetchAggregateMessages()'s own pagination scope trim.
            void fetchAggregateMessages(mailboxFolders, aggregateFolderType, effectiveFilter)
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

        setLoading(!snapshot);
        setError(null);

        if (isSearching) {
            setCoverages({});
            setSearchFailures([]);
            setPendingUids(new Set());
            setTier1Done(false);
            setTier2Done(false);
            setTier3Done(false);
            resolvedMessageCacheRef.current = new Map();
            const parsed = parseSearchQuery(searchQuery);
            const fingerprint = queryFingerprint(parsed);
            // What each mailbox is asked for per page: the whole page for one mailbox, a share of it for several.
            const pageSize = searchPageSize(searchTargetUids.length, MESSAGE_PAGE_SIZE);
            // Only a search over several mailboxes gives up on a slow one - a search of one is left to take as long as it takes.
            const tier1TimeoutMs = crossMailbox ? SEARCH_LIMITS.tier1TimeoutMs : Infinity;
            const tier3TimeoutMs = crossMailbox ? SEARCH_LIMITS.tier3TimeoutMs : Infinity;
            const mailboxNames = new Map(searchedMailboxes.map((mb) => [mb.uid, mb.displayName]));
            const isSuperseded = () => searchRunIdRef.current !== myRunId;
            // Tier 3's code, imported when the first mailbox needs it and shared by the rest.
            let tier3Module: Promise<typeof import("@rapidmx/react-shared/search/searchTier3.js")> | undefined;
            const loadTier3 = () => (tier3Module ??= import("@rapidmx/react-shared/search/searchTier3.js"));
            const failures: MailboxFailure[] = [];
            /** The failed mailbox's notice entry. A search of one mailbox has none: its failure fails the search. */
            const noteFailure = (uid: string, encrypted: boolean, err: unknown) => {
                failures.push({ mailboxUid: uid, mailboxName: mailboxNames.get(uid)!, encrypted, reason: classifyFailure(err) });
            };
            // One entry per mailbox searched, in the order they are shown in - which is also the order ties are ranked in.
            const runs = new Map<string, MailboxRun>(
                searchTargetUids.map((uid): [string, MailboxRun] => [
                    uid,
                    {
                        mailboxUid: uid,
                        unlocked: getUnlockedKeys(uid),
                        tier1: [],
                        tier2: [],
                        tier2More: false,
                        tier3: [],
                        tier3Total: 0,
                        tier3Key: "",
                        tier1Settled: false,
                        tier3Settled: false,
                        failed: false,
                    },
                ]),
            );
            const runList = [...runs.values()];

            // A reveal that started before another one but finished after it must not put its older, smaller picture back.
            let revealsStarted = 0;
            let revealsApplied = 0;
            // Recomputes and re-renders the merged list from whatever tiers have reported so far, across every mailbox -
            // called once after Tier 1+2 (interim: unconfirmed Tier 1 metadataOnly hits render as
            // skeletons) and again after Tier 3 (final: anything still unconfirmed is pruned instead -
            // §_Progressive Results_' "Skeletons resolve or disappear"); a search over several mailboxes also calls it as each one
            // reports, and a mailbox is "final" for its own hits as soon as its own Tier 3 has. Bails out if a
            // newer search pass has since started.
            async function reveal() {
                const revealId = ++revealsStarted;
                const capped = capSkeletons(runList.flatMap((run) => run.tier1));
                const tier2Hits = runList.flatMap((run) => run.tier2);
                const tier3Hits = runList.flatMap((run) => run.tier3);
                const confirmed = new Set([...tier2Hits, ...tier3Hits].map(hitKey));
                const isUnconfirmed = (hit: MailboxHit) => !!hit.metadataOnly && !confirmed.has(hitKey(hit));
                const effectiveTier1 = capped.filter((hit) => !runs.get(hit.mailboxUid)!.tier3Settled || !isUnconfirmed(hit));
                const merged = mergeSearchResults(effectiveTier1, tier2Hits, tier3Hits).slice(0, rowCap);
                const { messages: resolved, snippets: resolvedSnippets } = await resolveHitsToMessages(
                    merged,
                    resolvedMessageCacheRef.current,
                );
                if (isSuperseded() || revealId < revealsApplied) {
                    return;
                }
                revealsApplied = revealId;
                setMessages(resolved);
                setSnippets(resolvedSnippets);
                if (resolved.length > 0) {
                    // The first mailbox to answer with anything replaces the loading skeleton.
                    setLoading(false);
                }
                const pending = new Set<string>();
                for (const hit of capped) {
                    if (!runs.get(hit.mailboxUid)!.tier3Settled && isUnconfirmed(hit)) {
                        pending.add(hit.entityUid);
                    }
                }
                setPendingUids(pending);
            }

            void (async () => {
                try {
                    // Tier 1 (server) and Tier 2 (local index) of every mailbox, a few at a time.
                    await runLimited(
                        searchTargetUids,
                        SEARCH_LIMITS.concurrency,
                        async (uid) => {
                            const run = runs.get(uid)!;
                            try {
                                const [tier1Page, tier2Page] = await Promise.all([
                                    withTimeout(searchMailbox(parsed.text, tier1SearchParams(parsed, undefined, uid, pageSize)), tier1TimeoutMs),
                                    searchLocalIndex(uid, parsed, run.unlocked, pageSize, 0),
                                ]);
                                if (isSuperseded()) {
                                    return;
                                }
                                run.tier1 = tagHits(uid, tier1Page.results);
                                run.tier1Cursor = tier1Page.nextCursor;
                                run.tier2 = tagHits(uid, tier2Page.results);
                                run.tier2More = tier2Page.hasMore;
                                run.coverage = tier2Page.coverage;
                            } catch (err) {
                                if (!crossMailbox) {
                                    throw err;
                                }
                                run.failed = true;
                                noteFailure(uid, false, err);
                            }
                            run.tier1Settled = true;
                            if (crossMailbox && runList.some((other) => !other.tier1Settled)) {
                                void reveal();
                            }
                        },
                        isSuperseded,
                    );
                    if (isSuperseded()) {
                        return;
                    }
                    setTier1Done(true);
                    setTier2Done(true);
                    setCoverages(Object.fromEntries(runList.map((run) => [run.mailboxUid, run.coverage])));
                    setSearchFailures([...failures]);
                    setLoading(false);
                    if (failures.length === runList.length) {
                        // Not one mailbox could be searched (or there were none to search): that is a failed search, not missing results.
                        setError("Search failed.");
                        return;
                    }
                    await reveal();

                    // Tier 3 (server-narrowed encrypted candidates) of every mailbox that answered, each over the window its own local index
                    // leaves uncovered - a mailbox with no local index is searched over the query's whole range.
                    await runLimited(
                        runList.filter((run) => !run.failed),
                        SEARCH_LIMITS.concurrency,
                        async (run) => {
                            try {
                                const windows = tier3Windows(parsed, run.coverage, searchAllMail);
                                const cacheKey = tier3CacheKey(run.mailboxUid, windows, !!run.unlocked);
                                let tier3Full = tier3CacheRef.current.get(cacheKey);
                                if (!tier3Full) {
                                    tier3Full = await withTimeout(
                                        searchTier3Windows(windows, run.unlocked, run.mailboxUid, loadTier3),
                                        tier3TimeoutMs,
                                    );
                                    if (isSuperseded()) {
                                        return;
                                    }
                                    tier3CacheRef.current.set(cacheKey, tier3Full);
                                }
                                run.tier3 = tagHits(run.mailboxUid, tier3Full.slice(0, pageSize));
                                run.tier3Total = tier3Full.length;
                                run.tier3Key = cacheKey;
                            } catch (err) {
                                if (!crossMailbox) {
                                    throw err;
                                }
                                noteFailure(run.mailboxUid, true, err);
                            }
                            run.tier3Settled = true;
                            if (crossMailbox && runList.some((other) => !other.failed && !other.tier3Settled)) {
                                void reveal();
                            }
                        },
                        isSuperseded,
                    );
                    if (isSuperseded()) {
                        return;
                    }
                    setTier3Done(true);
                    setSearchFailures([...failures]);
                    const cursor: SearchCursor = { fingerprint, pageSize, perMailbox: new Map() };
                    for (const run of runList) {
                        if (!run.failed) {
                            cursor.perMailbox.set(run.mailboxUid, {
                                tier1Cursor: run.tier1Cursor,
                                tier2Offset: run.tier2.length,
                                tier3Offset: run.tier3.length,
                                tier3Total: run.tier3Total,
                                tier3Key: run.tier3Key,
                                more: !!run.tier1Cursor || run.tier2More || run.tier3.length < run.tier3Total,
                            });
                        }
                    }
                    compositeCursorRef.current = cursor;
                    setHasMore(mailboxesWithMore(cursor).length > 0);
                    await reveal();
                } catch (err) {
                    if (!isSuperseded()) {
                        setError(err instanceof ApiRequestError ? err.message : "Search failed.");
                        setLoading(false);
                    }
                }
            })();
            return invalidate;
        }

        // Set: the guard at the top of this effect returned for a view with neither a folder nor an
        // aggregate type, and the aggregate branch above returned for the one with an aggregate type.
        if (snapshot) {
            setMessages(snapshot.messages);
            listedOffsetRef.current = snapshot.messages.length;
            setHasMore(snapshot.hasMore);
            // The selection the reader left the folder with, if that message is still there.
            setSelectedUid(snapshot.messages.some((m) => m.uid === snapshot.selectedUid) ? snapshot.selectedUid : null);
            shownListKeyRef.current = listKey;
            pendingScrollRef.current = snapshot.scrollTop;
        }
        listMessages(folderUid!, listParams)
            .then((results) => {
                if (isCurrentRun()) {
                    shownListKeyRef.current = listKey;
                    if (snapshot) {
                        // Folded into what is already shown, as a live refresh does: the reader's place, selection and paged-in
                        // rows stay, and a row they changed since (a higher version) is not put back.
                        const merged = mergeFirstPage(snapshot.messages, results, messageUid, MESSAGE_PAGE_SIZE, (current, next) =>
                            current.version >= next.version ? current : next,
                        );
                        setMessages(merged.rows);
                        listedOffsetRef.current = merged.complete ? results.length : snapshot.messages.length + merged.added;
                        setHasMore(!merged.complete);
                        return;
                    }
                    setMessages(results);
                    listedOffsetRef.current = results.length;
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
        // `refreshKey` is a dependency for the same reason: a failed bulk action bumps it to refetch,
        // since a bulk update applies until its first rejection rather than all-or-nothing.
    }, [
        asConversations,
        serverSortKey,
        effectiveFilter,
        labelFilterKey,
        refreshKey,
        folderUid,
        mailboxUid,
        isSearching,
        searchQuery,
        unlockRefresh,
        searchAllMail,
        aggregateFolderType,
        // Only a merged listing is built from the folder tree; for a single folder a folder appearing in the sidebar (the Outbox, Sent Items) must not reload
        // the list on screen and forget its selection. A search over several mailboxes is built from the *mailboxes* instead (`searchTargetKey`), so a
        // folder appearing while it runs does not restart it either.
        aggregateFolderType && !isSearching ? mailboxFolders : null,
        crossMailbox,
        searchTargetKey,
        activeMailboxUid,
    ]);

    // Which folders the messages on screen live in: one the sidebar does not know (the Outbox and Sent Items are made by the server on first use) is looked for -
    // its mailbox's folders are listed again, once - so it appears without a reload. A conversation names every folder it has a message in.
    useEffect(() => {
        noteFolderUids([...messages.map((message) => message.folderUid), ...conversations.flatMap((conversation) => conversation.folderUids)]);
    }, [messages, conversations, noteFolderUids]);

    // New mail without a reload. `live` is bumped by a push event, a reconnect, the safety-net poll or the tab coming back (see
    // `useMailLiveUpdates()`); this then quietly refetches the first page of whatever is listed and folds it in - unlike the
    // effect above it resets nothing: not the selection, the open thread, select mode, the scroll position or the rows
    // already paged in, and nothing it fetches is marked read. It stands aside for a search (whose rows aren't a folder's),
    // a listing still loading and a "load more" in flight, and for events about folders the list isn't showing - a
    // conversation list, which can span folders, refreshes for any. Any failure is silent: the next tick tries again.
    const liveRunRef = useRef(0);
    useEffect(() => {
        if (live.tick === 0 || isSearching || loading || loadMoreInFlightRef.current || (!folderUid && !aggregateFolderType)) {
            return;
        }
        if (!asConversations && live.folderUids) {
            const shown = new Set(
                aggregateFolderType
                    ? mailboxFolders.flatMap((entry) => entry.folders.filter((f) => f.type === aggregateFolderType).map((f) => f.uid))
                    : [folderUid!],
            );
            if (![...live.folderUids].some((uid) => shown.has(uid))) {
                return;
            }
        }
        // Superseded by a newer refresh, or by any reload of the list itself (which bumps the search run id).
        const listRun = searchRunIdRef.current;
        const myRun = ++liveRunRef.current;
        const isCurrent = () => searchRunIdRef.current === listRun && liveRunRef.current === myRun;
        void (async () => {
            try {
                if (asConversations) {
                    const fresh = await listConversations(activeMailboxUid, conversationParams(0));
                    if (!isCurrent()) {
                        return;
                    }
                    const merged = mergeFirstPage(conversationsRef.current, fresh, conversationKey, MESSAGE_PAGE_SIZE);
                    setConversations(merged.rows);
                    listedOffsetRef.current = merged.complete ? fresh.length : listedOffsetRef.current + merged.added;
                    setHasMore(!merged.complete);
                } else if (aggregateFolderType) {
                    // No paging here (see `fetchAggregateMessages()`): the fresh merged first pages are the list.
                    const fresh = await fetchAggregateMessages(mailboxFolders, aggregateFolderType, effectiveFilter);
                    if (isCurrent()) {
                        setMessages(fresh);
                    }
                } else {
                    const fresh = await listMessages(folderUid!, listParams);
                    if (!isCurrent()) {
                        return;
                    }
                    // A row the reader has just changed (a higher version) is not put back by a fetch that began before.
                    // Equal versions are the same server state, so the row on screen - which may carry an optimistic read/unread
                    // flip the server has not answered yet - wins too.
                    const merged = mergeFirstPage(messagesRef.current, fresh, messageUid, MESSAGE_PAGE_SIZE, (current, next) =>
                        current.version >= next.version ? current : next,
                    );
                    setMessages(merged.rows);
                    listedOffsetRef.current = merged.complete ? fresh.length : listedOffsetRef.current + merged.added;
                    setHasMore(!merged.complete);
                }
            } catch {
                // Quiet by design - see above.
            }
        })();
    }, [live.tick]);

    function handleSearchAllMail() {
        setSearchAllMailKey(searchAllMailScope);
    }

    const loadMore = useCallback(async () => {
        const parsed = parseSearchQuery(searchQuery);
        const fingerprint = queryFingerprint(parsed);
        // While searching, a load-more continues from this query's own cursor - absent until its first page
        // has fully finished (the ref may still hold an earlier query's), in which case there's nowhere to
        // continue from yet.
        const searchCursor = decodeCursor(compositeCursorRef.current, fingerprint);
        // Reads the ref, not `conversations`/`messages` state, so this callback (and the observer effect
        // watching it) don't need to be recreated every time a page lands - the same reason every other
        // check below reads a ref rather than closing over state.
        const atRowCap = (asConversations ? conversationsRef.current.length : messagesRef.current.length) >= rowCap;
        if (
            loadMoreInFlightRef.current ||
            !hasMore ||
            loading ||
            atRowCap ||
            // A search over every mailbox has no folder of its own (nor does a listing that has not resolved one).
            (!asConversations && !folderUid && !isSearching) ||
            (isSearching && !searchCursor)
        ) {
            return;
        }
        // A ref, not `loadingMore` state: the observer and the continuation effect below can both call in the
        // same tick, each closing over a render where `loadingMore` was still false.
        loadMoreInFlightRef.current = true;
        setLoadMoreError(null);
        setLoadMoreStalled(false);
        setLoadingMore(true);
        /** Records whether a landed page added rows, and whether the continuation effect should keep going. */
        const notePageLanded = (addedRows: boolean, moreRemain: boolean) => {
            if (addedRows) {
                emptyPageStreakRef.current = 0;
                setAppendedPageCount((n) => n + 1);
            } else if (moreRemain) {
                emptyPageStreakRef.current += 1;
                if (emptyPageStreakRef.current <= MAX_EMPTY_PAGE_CONTINUATIONS) {
                    setAppendedPageCount((n) => n + 1);
                } else {
                    emptyPageStreakRef.current = 0;
                    setLoadMoreStalled(true);
                }
            }
        };
        // A query/folder/view change while this page is in flight bumps the run id (see the effect above) -
        // its rows then belong to a list that's no longer on screen and must not be appended to the new one.
        const myRunId = searchRunIdRef.current;
        const isCurrentRun = () => searchRunIdRef.current === myRunId;
        try {
            if (asConversations) {
                const page = Math.floor(listedOffsetRef.current / MESSAGE_PAGE_SIZE);
                const more = await listConversations(activeMailboxUid, conversationParams(page));
                if (!isCurrentRun()) {
                    return;
                }
                const addedRows = hasUnseenRows(conversationsRef.current, more, conversationKey);
                setConversations((prev) => appendUnseenRows(prev, more, conversationKey, rowCap));
                setHasMore(more.length === MESSAGE_PAGE_SIZE);
                listedOffsetRef.current = page * MESSAGE_PAGE_SIZE + more.length;
                notePageLanded(addedRows, more.length === MESSAGE_PAGE_SIZE);
            } else if (isSearching) {
                const cursor = searchCursor!;
                const tier1TimeoutMs = crossMailbox ? SEARCH_LIMITS.tier1TimeoutMs : Infinity;
                // Every mailbox with more to give is asked for its own next page - the others (exhausted, or given up on) stay as they are.
                const attempted = mailboxesWithMore(cursor);
                const pages = new Map<string, { tier1: MailboxHit[]; tier1Cursor?: string; tier2: MailboxHit[]; tier2More: boolean; tier3: MailboxHit[] }>();
                const failedMailboxes: MailboxFailure[] = [];
                const failedErrors: unknown[] = [];
                await runLimited(
                    attempted,
                    SEARCH_LIMITS.concurrency,
                    async (uid) => {
                        const mailboxCursor = cursor.perMailbox.get(uid)!;
                        try {
                            const [tier1Page, tier2Page] = await Promise.all([
                                withTimeout(
                                    searchMailbox(parsed.text, tier1SearchParams(parsed, mailboxCursor.tier1Cursor, uid, cursor.pageSize)),
                                    tier1TimeoutMs,
                                ),
                                searchLocalIndex(uid, parsed, getUnlockedKeys(uid), cursor.pageSize, mailboxCursor.tier2Offset),
                            ]);
                            // The first page cached this pass under `tier3Key` before it created the cursor - unless Tier 3 had nothing to give.
                            const tier3Page =
                                mailboxCursor.tier3Offset < mailboxCursor.tier3Total
                                    ? tier3CacheRef.current
                                          .get(mailboxCursor.tier3Key)!
                                          .slice(mailboxCursor.tier3Offset, mailboxCursor.tier3Offset + cursor.pageSize)
                                    : [];
                            pages.set(uid, {
                                tier1: tagHits(uid, tier1Page.results),
                                tier1Cursor: tier1Page.nextCursor,
                                tier2: tagHits(uid, tier2Page.results),
                                tier2More: tier2Page.hasMore,
                                tier3: tagHits(uid, tier3Page),
                            });
                        } catch (err) {
                            // One mailbox failing to give its next page must not stop the others' (a search of one has nothing else to show).
                            if (!crossMailbox) {
                                throw err;
                            }
                            failedErrors.push(err);
                            failedMailboxes.push({
                                mailboxUid: uid,
                                mailboxName: searchedMailboxes.find((mb) => mb.uid === uid)!.displayName,
                                encrypted: false,
                                reason: classifyFailure(err),
                            });
                        }
                    },
                    () => !isCurrentRun(),
                );
                if (failedErrors.length === attempted.length) {
                    // No mailbox answered: that is a failed page (with Retry), not a page with fewer rows.
                    throw failedErrors[0];
                }
                const answered = [...pages.values()];

                // Unlike the fresh-search pass above, a load-more page is resolved and appended in one
                // shot rather than progressively revealed - rows already on screen shouldn't reorder or
                // grow skeletons out from under a reader who has since scrolled past them. Any Tier 1
                // metadataOnly hit this page that neither Tier 2 nor Tier 3 (both already awaited above)
                // confirms simply keeps showing its existing placeholder text rather than a live skeleton
                // - a deliberate, documented scope trim of progressive reveal to the first page only.
                const merged = mergeSearchResults(
                    capSkeletons(answered.flatMap((page) => page.tier1)),
                    answered.flatMap((page) => page.tier2),
                    answered.flatMap((page) => page.tier3),
                );
                const { messages: more, snippets: moreSnippets } = await resolveHitsToMessages(merged, resolvedMessageCacheRef.current);
                if (!isCurrentRun()) {
                    return;
                }
                const addedRows = hasUnseenRows(messagesRef.current, more, messageUid);
                setMessages((prev) => appendUnseenRows(prev, more, messageUid, rowCap));
                setSnippets((prev) => ({ ...prev, ...moreSnippets }));
                setSearchFailures((prev) => [...prev, ...failedMailboxes]);

                const perMailbox = new Map(cursor.perMailbox);
                for (const uid of attempted) {
                    const previous = cursor.perMailbox.get(uid)!;
                    const page = pages.get(uid);
                    if (!page) {
                        // Failed just now: given up on for the rest of this search (the notice says so).
                        perMailbox.set(uid, { ...previous, more: false });
                        continue;
                    }
                    const nextTier3Offset = previous.tier3Offset + page.tier3.length;
                    perMailbox.set(uid, {
                        tier1Cursor: page.tier1Cursor,
                        tier2Offset: previous.tier2Offset + page.tier2.length,
                        tier3Offset: nextTier3Offset,
                        tier3Total: previous.tier3Total,
                        tier3Key: previous.tier3Key,
                        more: !!page.tier1Cursor || page.tier2More || nextTier3Offset < previous.tier3Total,
                    });
                }
                const nextCursor: SearchCursor = { ...cursor, perMailbox };
                compositeCursorRef.current = nextCursor;
                const moreRemain = mailboxesWithMore(nextCursor).length > 0;
                setHasMore(moreRemain);
                notePageLanded(addedRows, moreRemain);
            } else {
                // The page containing the first message not fetched yet. After a local removal that offset is
                // no longer a page boundary, so this page overlaps rows already shown - `appendUnseenRows()`
                // drops those - rather than skipping the message that shifted back across the boundary.
                const page = Math.floor(listedOffsetRef.current / MESSAGE_PAGE_SIZE);
                const more = await listMessages(folderUid!, { ...listParams, page });
                if (!isCurrentRun()) {
                    return;
                }
                const addedRows = hasUnseenRows(messagesRef.current, more, messageUid);
                setMessages((prev) => appendUnseenRows(prev, more, messageUid, rowCap));
                setHasMore(more.length === MESSAGE_PAGE_SIZE);
                listedOffsetRef.current = page * MESSAGE_PAGE_SIZE + more.length;
                notePageLanded(addedRows, more.length === MESSAGE_PAGE_SIZE);
            }
        } catch (err) {
            // Shown next to the sentinel with a Retry button - never auto-retried (see the continuation
            // effect below), so a failing server isn't hammered while the sentinel stays in view.
            if (isCurrentRun()) {
                setLoadMoreError(err instanceof ApiRequestError ? err.message : "Could not load more messages.");
            }
        } finally {
            loadMoreInFlightRef.current = false;
            setLoadingMore(false);
        }
    }, [
        hasMore,
        loading,
        asConversations,
        serverSortKey,
        effectiveFilter,
        labelFilterKey,
        folderUid,
        isSearching,
        searchQuery,
        mailboxUid,
        activeMailboxUid,
        crossMailbox,
        searchTargetKey,
    ]);

    // Always calls the latest `loadMore` closure so the effect below doesn't need `loadMore` itself in its
    // dependency array (it changes on every keystroke/page load, which would otherwise mean nothing here).
    const loadMoreRef = useRef(loadMore);
    loadMoreRef.current = loadMore;

    // Keyed on the sentinel node itself (see `sentinel`'s own comment): it unmounts whenever the list shows
    // "Loading..." and remounts afterwards, so an observer attached once to an earlier node would watch a
    // detached element forever. Only ever rendered in "By date" mode, so no view-mode check is needed.
    useEffect(() => {
        if (!sentinel) {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting) && !loadMoreErrorRef.current) {
                    void loadMoreRef.current();
                }
            },
            { root: scrollContainerRef.current, rootMargin: `${LOAD_MORE_ROOT_MARGIN_PX}px` },
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [sentinel]);

    // An observer only reports *changes* - a sentinel still in view after a page lands (the new rows didn't
    // push it out of view, e.g. the Focused/Other filter hid every one of them) never reports again, so
    // keep loading while it's still in view. Only after a page that appended rows, or a full page of rows
    // already shown (bounded - see `emptyPageStreakRef`), never after a failure, and only when the sentinel's
    // real geometry says it's still in view (the observer's last report may predate the rows that just landed).
    useEffect(() => {
        if (appendedPageCount === 0) {
            return;
        }
        // The scroll container is always mounted whenever a sentinel is (the sentinel lives inside it).
        if (sentinel && isWithinLoadMoreRange(sentinel, scrollContainerRef.current!)) {
            void loadMoreRef.current();
        }
    }, [appendedPageCount]);

    /**
     * Replaces one listed row - and, in the conversation list, the opened message and the child row
     * standing for it - with a newer copy the reading pane just produced.
     *
     * A conversation's *parent* row has no copy to replace: it is a summary of the whole thread, and its
     * "2 unread" chip and bold styling come from a count the server worked out when the list was fetched.
     * So when a message changes read state (`previous` and `updated` differ in it - the optimistic copy of a message just
     * read, or its revert), that count moves by one here - otherwise a conversation kept claiming unread mail the reader
     * had just read, until the whole list was reloaded.
     */
    function patchListedMessage(updated: Message, previous?: Message) {
        setMessages((prev) => prev.map((m) => (m.uid === updated.uid ? updated : m)));
        // `ConversationList` fetched its own copy of this message when the thread was expanded; hand it the
        // newer one so the child row doesn't keep showing a stale read/flag state.
        setConversationPatches((prev) => ({ ...prev, [updated.uid]: updated }));
        const unreadChange = previous ? Number(isUnread(updated)) - Number(isUnread(previous)) : 0;
        if (unreadChange !== 0) {
            setConversations((prev) =>
                prev.map((conversation) =>
                    conversation.messageUids.includes(updated.uid)
                        ? { ...conversation, unreadCount: Math.max(0, conversation.unreadCount + unreadChange) }
                        : conversation,
                ),
            );
        }
    }

    function removeListedMessages(uids: Set<string>) {
        const selectedIndex = messagesRef.current.findIndex((m) => m.uid === selectedUid);
        if (selectedUid && uids.has(selectedUid) && selectedIndex !== -1) {
            removedAnchorRef.current = selectedIndex;
        }
        setMessages((prev) => prev.filter((m) => !uids.has(m.uid)));
        listedOffsetRef.current = Math.max(0, listedOffsetRef.current - uids.size);
        setSelectedUid((prev) => (prev && uids.has(prev) ? null : prev));
    }

    function removeListedMessage(uid: string) {
        removeListedMessages(new Set([uid]));
    }

    // The conversation list opens a whole thread in `ConversationThreadPane`, which loads and marks read
    // its own messages; only the flat list feeds the single-message pane below.
    const selected = threadPane ? null : (messages.find((m) => m.uid === selectedUid) ?? null);
    const attachments = useMessageAttachments(selected);
    useMarkMessageRead(selected, patchListedMessage);
    // Search results can span every folder in the mailbox, not just the one selected in the sidebar - a
    // selected message's own folderUid is the only reliable source for its actual folder type once
    // searching (outside search, every message in `messages` already comes from `folderUid` itself, so
    // this falls back to the sidebar selection unchanged). Aggregate views span every *mailbox* too, so
    // the folder list consulted is the selected message's own mailbox's, not the shell's ambient one. A
    // conversation spans folders for the same reason (an Inbox message and the Sent Items copy of its reply).
    const spansFolders = isSearching || !!aggregateFolderType || threadPane;
    const selectedFolderUid = spansFolders ? (selected?.folderUid ?? folderUid) : folderUid;
    const selectedMailboxUid = spansFolders ? (selected?.mailboxUid ?? activeMailboxUid) : mailboxUid;
    const folders = mailboxFolders.find((mf) => mf.mailbox.uid === selectedMailboxUid)?.folders ?? [];
    const isSentItems = folders.find((f) => f.uid === selectedFolderUid)?.type === "sent_items";
    const isOutbox = folders.find((f) => f.uid === selectedFolderUid)?.type === "outbox";
    const draftsFolderUid = folders.find((f) => f.type === "drafts")?.uid;

    /** What a row actually shows as its subject - the decrypted one where this device recovered it, a
     * readable stand-in for an encrypted one it hasn't, and a placeholder for a message with no subject. */
    function rowSubject(message: Message): string {
        return (
            decryptedRows[message.uid]?.subject ||
            (message.subject === ENCRYPTED_SUBJECT_PLACEHOLDER ? "Encrypted message" : message.subject) ||
            "(no subject)"
        );
    }

    /** The conversation list's selection as plain messages: every message of every ticked conversation
     * that is in the folder being listed. A conversation spans folders (an Inbox message and the Sent
     * Items copy of its reply), and the list only ever showed this folder's half of it, so a bulk action
     * from here must not reach into the other folders' copies either. */
    const selectedConversationMessages = [...selectedConversationIds].flatMap((id) =>
        (conversationMessagesById[id] ?? []).filter((m) => !folderUid || m.folderUid === folderUid),
    );
    const selectedMessages = asConversations
        ? selectedConversationMessages
        : messages.filter((m) => selectedUids.has(m.uid));
    /** How many rows the list is actually showing - conversations or messages, whichever it lists. What the
     * Select toggle is enabled by: there is nothing to select in a list with no rows. */
    const listedRowCount = asConversations ? conversations.length : messages.length;
    /** The conversation rows in the order the reader arranged them. The endpoint takes no sort parameters
     * of its own (it pages by latest activity), so the arrangement is applied here, to the rows fetched so
     * far - which the Sort menu says on screen. `conversations` itself stays in the order the pages
     * arrived, so paging keeps appending to the same accumulated set. */
    const listedConversations = sortConversations(conversations, preferences.sortBy, preferences.sortOrder);

    /** `true` once whichever list is on screen has hit `MAX_LOADED_ROWS` *and* the server still has more to
     * give - `appendUnseenRows()` itself already stopped growing the array at that point, and `loadMore()`
     * refuses to fetch further pages (see its own `atRowCap` check); this just drives the "refine your
     * search" banner replacing the load-more sentinel below. The `hasMore` half matters at the edge: a
     * mailbox/search whose true size lands at or near the cap can have its very last page be a partial one,
     * which correctly turns `hasMore` false - without checking it here, the banner would still claim rows
     * are being hidden even though every one of them is already on screen. */
    const rowCapReached = hasMore && (asConversations ? conversations.length : messages.length) >= rowCap;

    function leaveSelectMode() {
        setSelectMode(false);
        setSelectedUids(new Set());
        setSelectedConversationIds(new Set());
    }

    function toggleSelected(uid: string) {
        setSelectedUids((prev) => {
            const next = new Set(prev);
            if (next.has(uid)) {
                next.delete(uid);
            } else {
                next.add(uid);
            }
            return next;
        });
    }

    /** Loads (once) the messages behind each of `ids`, so a ticked conversation resolves to the messages
     * every bulk action below acts on. If any of them fails to load, none of that batch stays ticked and
     * a pop-up says why - better than acting on the part of a selection that happened to arrive. */
    async function resolveConversations(ids: string[]) {
        const missing = ids.filter((id) => !conversationMessagesById[id]);
        if (missing.length === 0) {
            return;
        }
        setResolvingSelection((n) => n + 1);
        try {
            const loaded = await Promise.all(
                missing.map(async (id) => [id, await listConversationMessages(activeMailboxUid, id)] as const),
            );
            setConversationMessagesById((prev) => ({ ...prev, ...Object.fromEntries(loaded) }));
        } catch (err) {
            notifyApiError(err, "Couldn't load the messages in one of those conversations");
            setSelectedConversationIds((prev) => {
                const next = new Set(prev);
                for (const id of missing) {
                    next.delete(id);
                }
                return next;
            });
        } finally {
            setResolvingSelection((n) => n - 1);
        }
    }

    function toggleConversationSelected(conversation: ConversationSummary) {
        const id = conversation.conversationId;
        const ticking = !selectedConversationIds.has(id);
        setSelectedConversationIds((prev) => {
            const next = new Set(prev);
            if (ticking) {
                next.add(id);
            } else {
                next.delete(id);
            }
            return next;
        });
        if (ticking) {
            void resolveConversations([id]);
        }
    }

    function selectAllConversations() {
        const ids = conversations.map(conversationKey);
        setSelectedConversationIds(new Set(ids));
        void resolveConversations(ids);
    }

    /**
     * Runs one bulk action over the current selection, then either patches the affected rows in place or
     * drops them (a move takes them out of the folder being listed).
     *
     * A bulk update is applied element by element server-side and stops at its first rejection, so a
     * failure leaves an unknown prefix of the selection already changed (see `bulkUpdateMessages()`) -
     * which is why a failure reloads the list rather than trying to reconcile it, and says so ("all of those messages" in the pop-up's
     * title: some may have changed).
     *
     * `chosen` is the selection bar's ticked messages unless the caller (a keyboard shortcut acting on the one open message or conversation)
     * names its own. Resolves whether it succeeded.
     */
    async function runBulkAction(
        action: (chosen: Message[]) => Promise<Message[]>,
        removesRows: boolean,
        chosen: Message[] = selectedMessages,
    ): Promise<boolean> {
        setBulkBusy(true);
        try {
            const updated = await action(chosen);
            if (removesRows) {
                // A move (Delete, Archive, Report junk, Move to): the source folders' badges go down, the target's up. Reading
                // and unreading are tracked by `setReadStateMany()` itself, as they happen.
                const movedByUid = new Map(updated.map((m) => [m.uid, m]));
                for (const before of chosen) {
                    const after = movedByUid.get(before.uid);
                    if (after) {
                        trackMessageChange(before, after).settle();
                    }
                }
            }
            if (asConversations) {
                // A conversation row is a summary of its messages - its count, unread count, participants
                // and preview all move when a bulk action changes or empties part of it - so the list is
                // reloaded rather than patched row by row.
                setSelectedConversationIds(new Set());
                setConversationMessagesById({});
                setRefreshKey((n) => n + 1);
            } else if (removesRows) {
                removeListedMessages(new Set(chosen.map((m) => m.uid)));
            } else {
                const byUid = new Map(updated.map((m) => [m.uid, m]));
                setMessages((prev) => prev.map((m) => byUid.get(m.uid) ?? m));
            }
            setSelectedUids(new Set());
            return true;
        } catch (err) {
            notifyApiError(err, chosen.length === 1 ? "Couldn't update the message" : "Couldn't update all of those messages");
            setSelectedUids(new Set());
            setSelectedConversationIds(new Set());
            setConversationMessagesById({});
            setRefreshKey((n) => n + 1);
            return false;
        } finally {
            setBulkBusy(false);
        }
    }

    /** Archive has no folder to move into until the mailbox has one: the server creates it lazily on the
     * first single-message archive, so that call both creates the folder and archives the first message,
     * and the rest of the selection is then moved into the folder it reports. */
    async function bulkArchive(chosen: Message[]): Promise<Message[]> {
        return inEachMailbox(chosen, async (ofMailbox, group) => {
            const archiveFolderUid = foldersOf(ofMailbox).find((f) => f.type === "archive")?.uid;
            if (archiveFolderUid) {
                return moveMessages(group, archiveFolderUid);
            }
            const first = await archiveMessage(group[0].uid);
            const rest = group.slice(1);
            return rest.length === 0 ? [first] : [first, ...(await moveMessages(rest, first.folderUid))];
        });
    }

    /**
     * Runs `action` once for every mailbox `chosen` has messages in and gathers what each returns. Folders belong to a mailbox, so anything that
     * moves messages into "the" Archive or Deleted Items has to do so per mailbox: a search over several mailboxes lists hits from more than one, while
     * every other list holds one mailbox's messages and this is one call, as it always was.
     */
    async function inEachMailbox(chosen: Message[], action: (ofMailbox: string, group: Message[]) => Promise<Message[]>): Promise<Message[]> {
        const groups = new Map<string, Message[]>();
        for (const message of chosen) {
            groups.set(message.mailboxUid, [...(groups.get(message.mailboxUid) ?? []), message]);
        }
        return (await Promise.all([...groups].map(([ofMailbox, group]) => action(ofMailbox, group)))).flat();
    }

    /**
     * This mailbox's folder of `type`. The server makes every well-known folder itself (when the mailbox is made, and again when the folders are listed
     * if one is missing), so a folder the page's tree lacks is asked for - the tree may simply be out of date - and used, never created a second time: a
     * duplicate of a well-known type is invisible to the server (it answers with the oldest) but would be a second row in the sidebar. Only a server that
     * really has none (an older one, which makes Deleted Items and Junk on first use) is asked to create it.
     *
     * A folder found or created here may not be in `mailboxFolders` yet, so it is filed there and remembered per mailbox and type until the page
     * reloads; otherwise a second Delete would ask again.
     */
    async function resolveFolderOfType(type: Folder["type"], name: string, ofMailbox: string): Promise<string> {
        const key = `${ofMailbox}:${type}`;
        const known = foldersOf(ofMailbox).find((f) => f.type === type)?.uid ?? lazyFoldersRef.current.get(key);
        if (known) {
            return known;
        }
        const listed = (await listFolders(ofMailbox)).find((f) => f.type === type);
        if (listed) {
            onFolderCreated(listed);
            lazyFoldersRef.current.set(key, listed.uid);
            return listed.uid;
        }
        const created = await createFolder({ mailboxUid: ofMailbox, name, type });
        lazyFoldersRef.current.set(key, created.uid);
        return created.uid;
    }

    /** Moves `chosen` into each of its mailbox's own folder of `type` (Deleted Items, Junk), making it where the server has none yet. */
    function moveToFolderOfType(chosen: Message[], type: Folder["type"], name: string): Promise<Message[]> {
        return inEachMailbox(chosen, async (ofMailbox, group) => moveMessages(group, await resolveFolderOfType(type, name, ofMailbox)));
    }

    /**
     * Sets every selected message's labels in one bulk update: each ends up with `labelUids`, plus the
     * ones left partially applied (`keepPartial`) that it already had, plus any label this mailbox no
     * longer defines - a label the menu couldn't show isn't one the reader chose to remove.
     *
     * `bulkUpdateMessages()` rather than `setMessagesLabels()`, which is its one-list-for-everyone special
     * case: with a partially-applied row each message keeps a *different* list.
     */
    function applyLabelsToSelection(labelUids: string[], keepPartial: string[]) {
        void runBulkAction(
            (chosen) =>
                bulkUpdateMessages(
                    chosen.map((message) => {
                        const kept = (message.labelUids ?? []).filter(
                            (uid) => keepPartial.includes(uid) || !mailboxLabels.some((label) => label.uid === uid),
                        );
                        return { uid: message.uid, version: message.version, labelUids: [...new Set([...labelUids, ...kept])] };
                    }),
                ),
            false,
        );
    }

    function moveSelectionToType(type: Folder["type"], name: string, chosen?: Message[]) {
        return runBulkAction((moving) => moveToFolderOfType(moving, type, name), true, chosen);
    }

    /**
     * Permanently deletes `chosen` - messages that are already in Deleted Items - once the reader has confirmed it (`usePermanentDelete()`
     * asks, deletes, tells the badges and says what happened). The rows that went leave the list, and selection and advance behave as for
     * Archive; a conversation list is reloaded, as after every bulk action on it, and so is a flat one when the server refused some
     * (those stay listed, and the reload shows what is really there). Resolves whether anything was deleted.
     */
    async function purgeChosen(chosen: Message[]): Promise<boolean> {
        const outcome = await permanent.requestPermanentDelete(chosen);
        if (!outcome) {
            return false;
        }
        if (asConversations) {
            setSelectedConversationIds(new Set());
            setConversationMessagesById({});
            setRefreshKey((n) => n + 1);
        } else {
            removeListedMessages(new Set(outcome.deleted.map((m) => m.uid)));
            if (outcome.failed.length > 0) {
                setRefreshKey((n) => n + 1);
            }
        }
        setSelectedUids(new Set());
        return outcome.deleted.length > 0;
    }

    /** Empty folder: permanently deletes everything in the folder being listed (Deleted Items or Junk Email) after the reader has confirmed. */
    async function emptyListedFolder(folder: Folder, count: number | undefined) {
        const outcome = await permanent.requestEmptyFolder({ uid: folder.uid, name: folder.name }, count);
        if (!outcome) {
            return;
        }
        if (outcome.emptied) {
            setMessages([]);
            setConversations([]);
        }
        setSelectedUid(null);
        setOpenThread(null);
        setSelectedUids(new Set());
        setSelectedConversationIds(new Set());
        setConversationMessagesById({});
        // What is really left - after a partial delete, or one that failed outright - is whatever the server lists.
        setRefreshKey((n) => n + 1);
    }

    // ---- Swiping a row on a phone (see `SwipeRow`): right to left archives, left to right asks for a folder. Both go through the same
    // ---- bulk path as the selection bar's Archive and Move to, so the badges, the optimistic bookkeeping and the failure pop-up are one
    // ---- implementation. Not offered where the actions aren't (an aggregate view spans mailboxes, search results are a mixed bag, the
    // ---- Outbox is the server's send queue) or while rows are being ticked.
    const listingOutbox = currentFolders.find((f) => f.uid === folderUid)?.type === "outbox";
    const swipeEnabled = isMobile && !selectMode && !aggregateFolderType && !isSearching && !listingOutbox;
    /** What a swipe's Move to is about, while its folder prompt is open: one message, or every message of a conversation in this folder. */
    const [moveDialog, setMoveDialog] = useState<{ messages: Message[] } | { conversation: ConversationSummary } | null>(null);

    /** The messages a swiped conversation stands for (the ones in the folder being listed), or `null` after saying why they couldn't be loaded. */
    async function swipedConversationMessages(conversation: ConversationThreadHead): Promise<Message[] | null> {
        try {
            return await loadOpenConversation(conversation);
        } catch (err) {
            notifyApiError(err, "Couldn't load the messages in that conversation");
            return null;
        }
    }

    /** Archives what a swipe took away. Resolves whether it went through, so the row comes back when it didn't. */
    async function swipeArchive(target: Message[] | ConversationSummary): Promise<boolean> {
        if (bulkBusy || resolvingSelection > 0) {
            return false;
        }
        const chosen = Array.isArray(target) ? target : await swipedConversationMessages(target);
        if (!chosen || chosen.length === 0) {
            return false;
        }
        return runBulkAction(bulkArchive, true, chosen);
    }

    async function swipeMove(folderUidToMoveTo: string): Promise<void> {
        // Only ever asked by the folder prompt, which is only open while `moveDialog` is set.
        const target = moveDialog!;
        const chosen = "messages" in target ? target.messages : await swipedConversationMessages(target.conversation);
        if (!chosen || chosen.length === 0) {
            setMoveDialog(null);
            return;
        }
        await runBulkAction((moving) => moveMessages(moving, folderUidToMoveTo), true, chosen);
        setMoveDialog(null);
    }

    const loadMoreStatus = loadingMore ? (
        "Loading more\u2026"
    ) : loadMoreError ? (
        <span className="inline-flex items-center gap-2">
            <span role="alert" className="text-danger">
                {loadMoreError}
            </span>
            <button type="button" onClick={() => void loadMoreRef.current()} className="text-primary-dark hover:underline font-medium">
                Retry
            </button>
        </span>
    ) : loadMoreStalled ? (
        <button type="button" onClick={() => void loadMoreRef.current()} className="text-primary-dark hover:underline font-medium">
            Load more
        </button>
    ) : null;

    /** One message's row of the flat list - and, in search results grouped by conversation, of a group. */
    function renderMessageRow(message: Message) {
        return (
            <SwipeRow
                as="li"
                enabled={swipeEnabled}
                onArchive={() => swipeArchive([message])}
                onMove={() => setMoveDialog({ messages: [message] })}
                key={message.uid}
                data-message-uid={message.uid}
                data-unread={isUnread(message) ? "true" : undefined}
                className={rowClass(
                    { unread: isUnread(message), selected: message.uid === selectedUid || selectedUids.has(message.uid) },
                    "flex items-stretch",
                )}
            >
                <UnreadBar unread={isUnread(message)} />
                {selectMode && (
                    <span className="shrink-0 flex items-center pl-3">
                        <input
                            type="checkbox"
                            checked={selectedUids.has(message.uid)}
                            onChange={() => toggleSelected(message.uid)}
                            aria-label={`Select ${rowSubject(message)}`}
                            className="w-4 h-4 accent-primary"
                        />
                    </span>
                )}
                {/* The open button and, for a meeting request, its RSVP chip: a button can't hold a button, so the chip is the button's sibling. */}
                <div className="flex-1 min-w-0 flex flex-col">
                    <button
                        type="button"
                        data-row-open
                        onClick={() => handleSelect(message)}
                        className={["w-full text-left px-4 py-3", ROW_FOCUS_CLASS].join(" ")}
                    >
                        <UnreadLabel unread={isUnread(message)} />
                        <div className="flex items-center justify-between gap-2 text-sm">
                            <MailAddress recipient={message.from} className={senderClass(isUnread(message))} />
                            <span className={["text-xs shrink-0", dateClass(isUnread(message))].join(" ")}>
                                {new Date(message.receivedDate).toLocaleDateString()}
                            </span>
                        </div>
                        {crossMailbox && (
                            // The views where a row needs to say which mailbox it came from: an "All mailboxes" listing and a search over several.
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
                                <div className={["text-sm truncate", subjectClass(isUnread(message))].join(" ")}>
                                    {rowSubject(message)}
                                </div>
                                <div className="flex items-center gap-2 text-xs text-text-muted font-normal">
                                    <span className="truncate">
                                        {snippets[message.uid] ||
                                            decryptedRows[message.uid]?.preview ||
                                            message.bodyPreview ||
                                            (message.encrypted ? <EncryptedPreview /> : null)}
                                    </span>
                                    {message.hasAttachments && <HiOutlinePaperClip size={12} aria-label="Has attachments" />}
                                    {message.flags.flagged && (
                                        <HiOutlineFlag size={12} aria-label="Flagged" className="text-danger" />
                                    )}
                                </div>
                                {/* What the server is doing with a message in Outbox: sending, retrying, or why it wasn't sent. */}
                                {isOutbox && <OutboxRowStatus message={message} />}
                            </>
                        )}
                    </button>
                    <InviteRowChip message={message} onResponded={(updated) => patchListedMessage(updated)} />
                </div>
            </SwipeRow>
        );
    }

    /** Search results arranged by conversation: the messages that matched, grouped under the conversation each belongs to, in the order of the
     * first match of each - the order the results are ranked in. `null` when the list is not showing grouped results. */
    const resultGroups = groupedResults ? groupByConversation(messages) : null;

    /** The search box: in the list on a desktop (flat lists only), in the shell's header beside the folders button on a phone. */
    const searchField = (
        <input
            ref={searchInputRef}
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search all mail…"
            aria-label="Search all mail"
            className={["w-full text-sm px-3 rounded-md border border-border bg-surface", isMobile ? "py-2" : "py-1.5"].join(" ")}
        />
    );

    function handleSelect(message: Message) {
        if (selectMode) {
            toggleSelected(message.uid);
            return;
        }
        if (preferences.showAsConversations) {
            // A search result of a list arranged by conversation: the reading pane is the whole thread, opened at this message.
            openThreadOf(message);
            return;
        }
        if (isMobile) {
            navigate(`/messages/${encodeURIComponent(message.uid)}`);
            return;
        }
        removedAnchorRef.current = null;
        setSelectedUid(message.uid);
    }

    /** A message of a conversation, as the thread pane names it: the conversation's id (a message with no thread is its own) and the
     * subject to head it with while the thread loads. */
    function threadHeadOf(message: Message): ConversationThreadHead {
        return { conversationId: message.conversationId ?? message.uid, subject: message.subject ?? "", messageCount: 1 };
    }

    /** Opens the whole thread a message belongs to, positioned at it - the phone's message page, or the reading pane. */
    function openThreadOf(message: Message) {
        const conversation = threadHeadOf(message);
        if (isMobile) {
            navigate(`/messages/${encodeURIComponent(message.uid)}?conversation=${encodeURIComponent(conversation.conversationId)}`);
            return;
        }
        removedAnchorRef.current = null;
        setSelectedUid(message.uid);
        setOpenThread({ conversation, uid: message.uid, mailboxUid: message.mailboxUid });
    }

    /** Opens a conversation in the reading pane, positioned at one of its messages: the one a child row
     * stands for, or the latest for a parent row. The thread pane loads the thread itself. */
    function handleOpenConversation(conversation: ConversationSummary, uid: string) {
        if (selectMode) {
            // Same rule as `handleSelect()` for a message row: while selecting, a row's own button ticks
            // the row rather than opening it.
            toggleConversationSelected(conversation);
            return;
        }
        if (isMobile) {
            // The message page shows the whole conversation, positioned at this message, when it is given the conversation.
            navigate(`/messages/${encodeURIComponent(uid)}?conversation=${encodeURIComponent(conversation.conversationId)}`);
            return;
        }
        removedAnchorRef.current = null;
        setSelectedUid(uid);
        setOpenThread({ conversation, uid, mailboxUid: activeMailboxUid });
    }

    // ---- Keyboard shortcuts (see `shared/keyboard`). Each is registered only while this view can do it, and calls what the toolbar and
    // ---- the selection bar call: the same bulk-action path (`runBulkAction()` - so the same optimistic badge tracking, the same rollback,
    // ---- the same lazily created Deleted Items folder), never a second implementation. Reply, Reply all, Forward, Archive and Move to are
    // ---- registered by the reading pane itself (`MessageDetailPane`'s `shortcuts`), which owns those handlers.
    const inConversations = asConversations;
    /** The selection bar isn't offered in the aggregate listing (its rows belong to several mailboxes), and neither are these - but the results of a
     * search over them are, each hit acted on in its own mailbox (see `inEachMailbox()`). */
    const keyboardActions = !aggregateFolderType || isSearching;
    /** What the keyboard acts on exists: the ticked rows in select mode, else the message (or conversation) open in the reading pane. */
    const keyboardTargetExists = selectMode ? selectedMessages.length > 0 : threadPane ? openThread !== null : selected !== null;
    const rowCount = inConversations ? listedConversations.length : messages.length;
    const canMoveSelection = !selectMode && !isMobile && !loading && rowCount > 0;

    /** The type of a message's folder - looked for in every mailbox's, as a search over several has messages from each. */
    function folderTypeOf(folderUidOfMessage: string): Folder["type"] | undefined {
        return mailboxFolders.flatMap((mf) => mf.folders).find((f) => f.uid === folderUidOfMessage)?.type;
    }

    /** Whether a message is in its mailbox's Deleted Items - where Delete is the permanent one. */
    function inDeletedItems(message: Message): boolean {
        return folderTypeOf(message.folderUid) === "deleted_items";
    }

    /** Moves the keyboard's focus to a row - and scrolls it into view - once the selection has moved to it. */
    function focusRow(uid: string) {
        // Only called from a key press, when the list is on screen.
        const row = [...scrollContainerRef.current!.querySelectorAll<HTMLElement>("[data-message-uid]")].find(
            (element) => element.getAttribute("data-message-uid") === uid,
        );
        row?.scrollIntoView({ block: "nearest" });
        row?.querySelector<HTMLElement>("[data-row-open]")?.focus({ preventScroll: true });
    }

    /** The index of the selected row: the open message's, or the open conversation's; -1 with nothing selected. */
    function selectedRowIndex(): number {
        if (inConversations) {
            return openThread ? listedConversations.findIndex((c) => c.conversationId === openThread.conversation.conversationId) : -1;
        }
        return messages.findIndex((m) => m.uid === selectedUid);
    }

    function selectRow(index: number) {
        if (inConversations) {
            const conversation = listedConversations[index];
            handleOpenConversation(conversation, conversation.latestMessageUid);
            focusRow(conversation.latestMessageUid);
        } else {
            const message = messages[index];
            handleSelect(message);
            focusRow(message.uid);
        }
    }

    function selectNeighbour(step: 1 | -1) {
        const current = selectedRowIndex();
        // After the selected message left the list (deleted, archived) the next row is the one that slid into its place.
        const anchor = removedAnchorRef.current;
        const target = current === -1 && anchor !== null ? (step === 1 ? anchor : anchor - 1) : current + step;
        selectRow(Math.min(rowCount - 1, Math.max(0, target)));
    }

    function selectNextUnread(step: 1 | -1) {
        const isRowUnread = (index: number) => (inConversations ? listedConversations[index].unreadCount > 0 : isUnread(messages[index]));
        for (let index = selectedRowIndex() + step; index >= 0 && index < rowCount; index += step) {
            if (isRowUnread(index)) {
                selectRow(index);
                return;
            }
        }
    }

    /** The messages of the open conversation that are in the folder being listed - fetched (once) like a ticked conversation's. `ofMailbox` is the
     * conversation's mailbox: a search over several mailboxes can open one that is not the page's, and the same conversation id can exist in two. */
    async function loadOpenConversation(conversation: ConversationThreadHead, ofMailbox = activeMailboxUid): Promise<Message[]> {
        const id = conversation.conversationId;
        const cacheKey = ofMailbox === activeMailboxUid ? id : `${ofMailbox}\u0000${id}`;
        let all = conversationMessagesById[cacheKey];
        if (!all) {
            all = await listConversationMessages(ofMailbox, id);
            const loaded = all;
            setConversationMessagesById((prev) => ({ ...prev, [cacheKey]: loaded }));
        }
        // What a search over several mailboxes finds is in every folder of them, not just the one open.
        return all.filter((m) => !folderUid || crossMailbox || m.folderUid === folderUid);
    }

    /**
     * What the keyboard acts on - the ticked rows in select mode, else the open message or conversation - keeping only the messages `applies`
     * accepts (Mark read leaves out what is already read: nothing to do then). Nothing (an empty list) while another bulk action or a
     * permanent delete is on the wire, like the bar's buttons, or when the open conversation could not be loaded.
     */
    async function keyboardTargets(applies: (message: Message) => boolean = () => true): Promise<Message[]> {
        if (bulkBusy || resolvingSelection > 0 || permanent.busy) {
            return [];
        }
        let chosen: Message[];
        try {
            chosen = selectMode
                ? selectedMessages
                : threadPane
                  ? await loadOpenConversation(openThread!.conversation, openThread!.mailboxUid)
                  : [selected!];
        } catch (err) {
            notifyApiError(err, "Couldn't load the messages in that conversation");
            return [];
        }
        return chosen.filter(applies);
    }

    /** Closes the open thread (and the selection in it) - what a delete of the whole conversation leaves nothing to show of. */
    function closeOpenThread() {
        setOpenThread(null);
        setSelectedUid(null);
    }

    /** Runs a bulk action on `chosen` (from `keyboardTargets()`), closing the open thread after a move away from it. */
    async function actOnKeyboardTargets(chosen: Message[], action: (chosen: Message[]) => Promise<Message[]>, removesRows: boolean) {
        if (chosen.length === 0) {
            return;
        }
        const succeeded = await runBulkAction(action, removesRows, chosen);
        if (succeeded && removesRows && threadPane && !selectMode) {
            closeOpenThread();
        }
    }

    /** Runs a bulk action on what the keyboard acts on (`keyboardTargets()`). */
    async function runOnKeyboardTargets(
        action: (chosen: Message[]) => Promise<Message[]>,
        removesRows: boolean,
        applies: (message: Message) => boolean = () => true,
    ) {
        await actOnKeyboardTargets(await keyboardTargets(applies), action, removesRows);
    }

    /**
     * Delete, from the keyboard: what is in Deleted Items is permanently deleted (after a confirmation), anything else moves to its mailbox's
     * Deleted Items - as the selection bar's Delete does. A mix (search results from several folders) moves only what is not in Deleted Items yet.
     */
    async function deleteFromKeyboard() {
        const targets = await keyboardTargets();
        if (targets.length > 0 && targets.every(inDeletedItems)) {
            if ((await purgeChosen(targets)) && threadPane && !selectMode) {
                closeOpenThread();
            }
            return;
        }
        await actOnKeyboardTargets(
            targets.filter((message) => !inDeletedItems(message)),
            (chosen) => moveToFolderOfType(chosen, "deleted_items", "Deleted Items"),
            true,
        );
    }

    useShortcut(SHORTCUTS.mail.next, () => selectNeighbour(1), { enabled: canMoveSelection });
    useShortcut(SHORTCUTS.mail.previous, () => selectNeighbour(-1), { enabled: canMoveSelection });
    useShortcut(SHORTCUTS.mail.nextUnread, () => selectNextUnread(1), { enabled: canMoveSelection });
    useShortcut(SHORTCUTS.mail.previousUnread, () => selectNextUnread(-1), { enabled: canMoveSelection });
    useShortcut(SHORTCUTS.mail.delete, () => void deleteFromKeyboard(), { enabled: keyboardActions && keyboardTargetExists });
    useShortcut(
        SHORTCUTS.mail.markRead,
        () =>
            void runOnKeyboardTargets(
                (chosen) => setReadStateMany(chosen, true, { patch: patchListedMessage, track: trackMessageChange }),
                false,
                isUnread,
            ),
        { enabled: keyboardActions && keyboardTargetExists },
    );
    useShortcut(
        SHORTCUTS.mail.markUnread,
        () =>
            void runOnKeyboardTargets(
                (chosen) => setReadStateMany(chosen, false, { patch: patchListedMessage, track: trackMessageChange }),
                false,
                (message) => !isUnread(message),
            ),
        { enabled: keyboardActions && keyboardTargetExists },
    );
    useShortcut(
        SHORTCUTS.mail.flag,
        () =>
            // Flags them all unless every one already is - what the bar's Flag and Unflag would do on this selection.
            void runOnKeyboardTargets((chosen) => setMessagesFlagged(chosen, !chosen.every((m) => m.flags.flagged)), false),
        { enabled: keyboardActions && keyboardTargetExists },
    );
    useShortcut(
        SHORTCUTS.mail.open,
        (event) => {
            // Enter on a row that is not selected yet is the row button's own click (it selects). On the selected one - or with the focus
            // elsewhere - it opens the message on its own page, as it does in Outlook.
            const rowUid = (event.target as Element).closest("[data-message-uid]")?.getAttribute("data-message-uid");
            if (rowUid ? rowUid !== selectedUid : isActivatable(event.target)) {
                return false;
            }
            navigate(`/messages/${encodeURIComponent(selectedUid!)}`);
        },
        { enabled: !selectMode && selectedUid !== null },
    );
    useShortcut(
        SHORTCUTS.mail.close,
        () => {
            if (document.activeElement === searchInputRef.current && searchInput !== "") {
                setSearchInput("");
            } else if (selectMode) {
                leaveSelectMode();
            } else {
                setSelectedUid(null);
                setOpenThread(null);
            }
        },
        { enabled: selectMode || selectedUid !== null || openThread !== null || searchInput !== "" },
    );
    useShortcut(SHORTCUTS.mail.search, () => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
    });

    // Folders and labels belong to one mailbox. A search over several mailboxes can have a selection in more than one: Move to needs it to be in one
    // (and offers that mailbox's folders), and Apply label needs it to be in the open mailbox, whose labels are the ones loaded. Archive, Delete and
    // Report junk go to each hit's own mailbox's folders (`inEachMailbox()`), so they need nothing of the sort.
    const selectedMailboxUids = new Set(selectedMessages.map((m) => m.mailboxUid));
    const selectionMailboxUid = crossMailbox && selectedMailboxUids.size === 1 ? [...selectedMailboxUids][0] : activeMailboxUid;
    const moveDisabledReason =
        crossMailbox && selectedMailboxUids.size > 1 ? "The selected messages are in different mailboxes - select messages from one mailbox to move them" : undefined;
    const labelsDisabledReason =
        crossMailbox && selectedMessages.some((m) => m.mailboxUid !== activeMailboxUid)
            ? "Labels can only be applied here to messages in the open mailbox"
            : undefined;
    // Delete is the permanent one for what is in Deleted Items: for the selection when there is one (search results can come from any folder),
    // else for the folder being viewed, so the button says so before anything is ticked.
    const deletesPermanently =
        selectedMessages.length > 0 ? selectedMessages.every(inDeletedItems) : currentFolders.find((f) => f.uid === folderUid)?.type === "deleted_items";
    // Empty folder is offered at the top of the list of a mailbox's own Deleted Items or Junk Email - not for search results, nor for the "All
    // mailboxes" views, which have no one folder to empty.
    const emptiableFolder = !isSearching && !aggregateFolderType ? currentFolders.find((f) => f.uid === folderUid && EMPTIABLE_FOLDER_TYPES.includes(f.type)) : undefined;
    // How many it holds as the sidebar's counts have it (kept right as messages leave), unless that says none while the list shows some.
    const emptiableCount = emptiableFolder && folderCountOf(emptiableFolder).total > 0 ? folderCountOf(emptiableFolder).total : undefined;
    const emptyDisabledReason = !mailboxWritable
        ? "This mailbox is shared with you view-only"
        : listedRowCount === 0 && emptiableCount === undefined
          ? "This folder is already empty"
          : undefined;

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
            <div
                ref={scrollContainerRef}
                // Remembered as it moves (not when the list is left: by then React has already detached the element), so
                // the folder - or Mail, after another app - comes back where it was.
                onScroll={(event) => saveListScroll(listKey, event.currentTarget.scrollTop)}
                className="w-full md:w-96 shrink-0 md:border-r border-border overflow-y-auto"
            >
                {selectMode ? (
                    <MailSelectionBar
                        selected={selectedMessages}
                        listed={messages}
                        totals={
                            asConversations
                                ? { selected: selectedConversationIds.size, listed: conversations.length, noun: "conversation" }
                                : undefined
                        }
                        onSelectAll={() =>
                            asConversations
                                ? selectAllConversations()
                                : setSelectedUids(new Set(messages.map((m) => m.uid)))
                        }
                        onClearSelection={() =>
                            asConversations ? setSelectedConversationIds(new Set()) : setSelectedUids(new Set())
                        }
                        onCancel={leaveSelectMode}
                        folders={foldersOf(selectionMailboxUid)}
                        currentFolderUid={folderUid}
                        labels={mailboxLabels}
                        mailboxUid={selectionMailboxUid}
                        moveDisabledReason={moveDisabledReason}
                        labelsDisabledReason={labelsDisabledReason}
                        onLabelCreated={(label) => setMailboxLabels((prev) => [...prev, label])}
                        onFolderCreated={onFolderCreated}
                        onApplyLabels={applyLabelsToSelection}
                        onSetRead={(read) =>
                            void runBulkAction(
                                // Optimistic: the rows and the folder badges change now, and change back if the server refuses.
                                (chosen) => setReadStateMany(chosen, read, { patch: patchListedMessage, track: trackMessageChange }),
                                false,
                            )
                        }
                        onSetFlagged={(flagged) => void runBulkAction((chosen) => setMessagesFlagged(chosen, flagged), false)}
                        shortcuts={keyboardActions}
                        onArchive={() => void runBulkAction(bulkArchive, true)}
                        onMoveTo={async (targetFolderUid) => {
                            await runBulkAction((chosen) => moveMessages(chosen, targetFolderUid), true);
                        }}
                        onReportJunk={() => void moveSelectionToType("junk", "Junk Email")}
                        onDelete={() =>
                            void (deletesPermanently
                                ? purgeChosen(selectedMessages)
                                : // A mix (search results from several folders) moves only what is not in Deleted Items yet.
                                  moveSelectionToType("deleted_items", "Deleted Items", selectedMessages.filter((m) => !inDeletedItems(m))))
                        }
                        deletesPermanently={deletesPermanently}
                        busy={bulkBusy || resolvingSelection > 0 || permanent.busy}
                    />
                ) : (
                    <MailListToolbar
                        sortBy={preferences.sortBy}
                        sortOrder={preferences.sortOrder}
                        filter={preferences.filter}
                        labelUids={preferences.labelUids}
                        labels={mailboxLabels}
                        mailboxUid={activeMailboxUid}
                        onLabelCreated={(label) => setMailboxLabels((prev) => [...prev, label])}
                        onLabelUidsChange={(nextLabelUids) => updatePreferences({ labelUids: nextLabelUids })}
                        showAsConversations={preferences.showAsConversations}
                        onSortChange={(sortBy, sortOrder) => updatePreferences({ sortBy, sortOrder })}
                        onFilterChange={(filter) => updatePreferences({ filter })}
                        onShowAsConversationsChange={(showAsConversations) => updatePreferences({ showAsConversations })}
                        selectMode={selectMode}
                        onSelectModeChange={setSelectMode}
                        offerClassificationFilters={offerClassificationFilters}
                        filterDisabled={isSearching}
                        filterDisabledReason="Filters don't apply to search results"
                        sortKeysDisabled={isSearching || !!aggregateFolderType}
                        // A conversation row is a thread summary, so only some of the keys have anything to
                        // order by - the rest stay pickable and are applied to the rows already fetched.
                        unavailableSortKeys={asConversations ? CONVERSATION_SORT_UNAVAILABLE : undefined}
                        sortKeysNote={
                            isSearching
                                ? "Search results are ranked by relevance rather than sorted."
                                : aggregateFolderType
                                  ? "This view merges the newest mail from every mailbox and is always listed by date."
                                  : asConversations
                                    ? CONVERSATION_SORT_NOTE
                                    : undefined
                        }
                        selectDisabled={(!!aggregateFolderType && !isSearching) || loading || listedRowCount === 0}
                        selectDisabledReason={
                            aggregateFolderType && !isSearching
                                ? "Open a mailbox's own folder to select messages"
                                : loading
                                  ? "Wait for this folder to finish loading"
                                  : "There is nothing here to select"
                        }
                    />
                )}
                {!isMobile && <div className="p-2 border-b border-border">{searchField}</div>}
                {isMobile && mobileSearchSlot && createPortal(searchField, mobileSearchSlot)}
                {emptiableFolder && !selectMode && (
                    <EmptyFolderBar
                        folderName={emptiableFolder.name}
                        count={emptiableCount}
                        disabled={!!emptyDisabledReason || permanent.busy || bulkBusy}
                        disabledReason={emptyDisabledReason}
                        onEmpty={() => void emptyListedFolder(emptiableFolder, emptiableCount)}
                    />
                )}
                {permanent.dialog}
                {/* Two tabs, as Outlook has: Focused and Other. There is no "All" tab - the whole Inbox is
                    still one pick away, in the Filter menu, which is where every other named filter lives
                    and the only place that can show which of them is really in force. A stored `all` (or
                    Unread, Flagged, ...) therefore still lists what it always did, with neither tab
                    pressed, rather than being migrated into one of these two halves behind the reader's
                    back - see `MAIL_LIST_FILTERS`, which still offers it. */}
                {offerClassificationFilters && (
                    <div className="flex border-b border-border text-xs">
                        {MAIL_LIST_CLASSIFICATION_FILTERS.map(({ value, label }) => (
                            <button
                                key={value}
                                type="button"
                                aria-pressed={preferences.filter === value}
                                onClick={() => updatePreferences({ filter: value })}
                                className={[
                                    "flex-1 py-1.5 font-semibold",
                                    preferences.filter === value
                                        ? "text-primary-dark border-b-2 border-primary-dark"
                                        : "text-text-muted",
                                ].join(" ")}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                )}

                {isSearching && (
                    <div className="px-4 py-1.5 text-xs text-text-muted border-b border-border flex items-center justify-between gap-2">
                        {/* §_Progressive Results_: "Never show a hard count until every tier has reported.
                            Display n of ??, or omit the count. A settled count is the signal that ordering
                            is final." */}
                        <span className="flex flex-col">
                            <span>
                                {tier1Done && tier2Done && tier3Done
                                    ? `${messages.length} result${messages.length === 1 ? "" : "s"}`
                                    : `${messages.length} of ??`}
                            </span>
                            {crossMailbox && <span data-testid="search-scope">All mailboxes</span>}
                        </span>
                        <span className="flex flex-col items-end gap-0.5">
                            {tier2Done && !searchAllMail && (
                                <button
                                    type="button"
                                    onClick={handleSearchAllMail}
                                    title={
                                        crossMailbox
                                            ? "Also search encrypted mail from before each mailbox's local index begins"
                                            : undefined
                                    }
                                    className="text-primary-dark hover:underline font-medium shrink-0"
                                >
                                    {/* "All mail" already means every mailbox here, so this says what it adds. */}
                                    {crossMailbox ? "Search older encrypted mail" : "Search all mail"}
                                </button>
                            )}
                            {widenable && (
                                <button
                                    type="button"
                                    onClick={() => setSearchAllMailboxes(!searchAllMailboxes)}
                                    className="text-primary-dark hover:underline font-medium shrink-0"
                                >
                                    {searchAllMailboxes ? "Search this mailbox only" : "Search all mailboxes"}
                                </button>
                            )}
                        </span>
                    </div>
                )}
                {crossMailbox && isSearching && searchableMailboxes.length > searchedMailboxes.length && (
                    <div role="status" className="px-4 py-1.5 text-xs text-text-muted border-b border-border">
                        Searched {searchedMailboxes.length} of {searchableMailboxes.length} mailboxes - the most that are searched at once.
                    </div>
                )}
                {crossMailbox && isSearching && searchFailures.length > 0 && (
                    <div role="status" className="px-4 py-1.5 text-xs text-text-muted border-b border-border bg-surface-alt">
                        Some results may be missing: {describeFailures(searchFailures)}
                    </div>
                )}
                {isSearching && !crossMailbox && coverage?.indexedFrom && (
                    <div className="px-4 py-1.5 text-xs text-text-muted border-b border-border">
                        Local search covers messages back to {new Date(coverage.indexedFrom).toLocaleDateString()}
                        {coverage.building ? " (still building)" : ""}
                        {searchAllMail
                            ? " - searching everything, not just recent mail."
                            : " - older encrypted mail is still searched, just slower."}
                    </div>
                )}
                {isSearching && crossMailbox && tier2Done && serverOnlyMailboxes.length > 0 && (
                    <div className="px-4 py-1.5 text-xs text-text-muted border-b border-border">
                        There is no local index on this device for {serverOnlyMailboxes.map((mb) => mb.displayName).join(", ")}: its encrypted mail is searched
                        through the server instead, which is slower and looks at a limited number of messages.
                    </div>
                )}
                {isSearching && crossMailbox && lockedSearchMailboxes.length > 0 && (
                    <div className="px-4 py-2 border-b border-border bg-surface-alt flex flex-col gap-1">
                        {unlockableSearchMailboxes.length > 0 && (
                            <button
                                type="button"
                                onClick={handleUnlockSearch}
                                className="inline-flex items-center gap-1 text-xs font-medium text-primary-dark hover:underline"
                            >
                                <HiOutlineLockClosed size={12} aria-hidden="true" />
                                Unlock to include encrypted messages from {unlockableSearchMailboxes.map((mb) => mb.displayName).join(", ")}
                            </button>
                        )}
                        {sharedLockedSearchMailboxes.length > 0 && (
                            <p className="text-xs text-text-muted">
                                Encrypted messages in {sharedLockedSearchMailboxes.map((mb) => mb.displayName).join(", ")} are not included: only the
                                mailbox&rsquo;s owner can unlock them.
                            </p>
                        )}
                    </div>
                )}
                {isSearching && !crossMailbox && !getUnlockedKeys(mailboxUid!) && (
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
                {!isSearching && !asConversations && undecryptedEncryptedUids.length > 0 && !getUnlockedKeys(activeMailboxUid) && (
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
                    // A skeleton of rows rather than a line of text: the list keeps its shape while a folder that was not shown a
                    // moment ago loads (one that was is shown at once, from its snapshot).
                    <div role="status" aria-busy="true" className="p-4">
                        <span className="sr-only">Loading&hellip;</span>
                        <SkeletonList count={8} />
                    </div>
                ) : asConversations ? (
                    <>
                        <ConversationList
                            conversations={listedConversations}
                            newestFirst={preferences.sortBy === "date" && preferences.sortOrder === "desc"}
                            mailboxUid={activeMailboxUid}
                            selectedUid={selectedUid}
                            messageOverrides={conversationPatches}
                            onMeetingResponded={patchListedMessage}
                            onOpenMessage={handleOpenConversation}
                            selectMode={selectMode}
                            selectedConversationIds={selectedConversationIds}
                            onToggleSelected={toggleConversationSelected}
                            swipe={{
                                enabled: swipeEnabled,
                                onArchive: swipeArchive,
                                onMove: (conversation) => setMoveDialog({ conversation }),
                            }}
                        />
                        {hasMore && !rowCapReached && (
                            <div ref={setSentinel} data-testid="load-more-sentinel" className="p-4 text-center text-xs text-text-muted">
                                {loadMoreStatus}
                            </div>
                        )}
                        {rowCapReached && (
                            <p className="p-4 text-center text-xs text-text-muted">
                                Showing the most recent {rowCap} conversations &mdash; refine your search or filters to see more.
                            </p>
                        )}
                    </>
                ) : messages.length === 0 ? (
                    <>
                        <p className="p-4 text-sm text-text-muted">
                            {isSearching
                                ? `No messages match "${searchQuery}".`
                                : effectiveFilter === "all"
                                  ? "No messages in this folder."
                                  : "No messages here."}
                        </p>
                        {/* Still offered while a filter hides every loaded row - what it's looking for may be
                            on a later page. */}
                        {hasMore && (
                            <div ref={setSentinel} data-testid="load-more-sentinel" className="p-4 text-center text-xs text-text-muted">
                                {loadMoreStatus}
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        <ul className={swipeEnabled ? "overflow-x-clip" : undefined}>
                            {resultGroups
                                ? resultGroups.map((group) => (
                                      <li key={`${group.mailboxUid}\u0000${group.id}`} data-search-group={group.id}>
                                          <div className="px-4 py-1.5 bg-surface-alt border-b border-border text-xs text-text-muted flex items-center justify-between gap-2">
                                              <span className="truncate font-semibold">{rowSubject(group.messages[0])}</span>
                                              <span className="shrink-0">
                                                  {group.messages.length} matching message{group.messages.length === 1 ? "" : "s"}
                                              </span>
                                          </div>
                                          <ul>{group.messages.map(renderMessageRow)}</ul>
                                      </li>
                                  ))
                                : messages.map(renderMessageRow)}
                        </ul>
                        {hasMore && !rowCapReached && (
                            <div ref={setSentinel} data-testid="load-more-sentinel" className="p-4 text-center text-xs text-text-muted">
                                {loadMoreStatus}
                            </div>
                        )}
                        {rowCapReached && (
                            <p className="p-4 text-center text-xs text-text-muted">
                                Showing the most recent {rowCap} messages &mdash; refine your search or filters to see more.
                            </p>
                        )}
                        {aggregateFolderType && !isSearching && (
                            <p className="p-4 text-center text-xs text-text-muted">
                                Showing the most recent mail from each mailbox. Open a specific mailbox&rsquo;s folder to
                                see older mail.
                            </p>
                        )}
                    </>
                )}
            </div>
            {/* The reading pane's own height: a row of the full-height mail view, stretched to it by the
                flex chain rather than by a percentage (an explicit height would opt it out of that
                stretching), with `min-h-0` so a long message scrolls inside it instead of pushing it past
                the window. Everything below - the thread pane, each message's `MessageDetailPane`, the
                body iframe that cannot measure itself - takes its height from here, never from a `vh`
                number of its own. */}
            <div className="hidden md:flex flex-1 min-w-0 min-h-0">
                {threadPane ? (
                    <LazyConversationThreadPane
                        conversation={openThread?.conversation ?? null}
                        selectedUid={openThread?.uid ?? null}
                        mailboxUid={labelsMailboxUid}
                        folders={foldersOf(labelsMailboxUid)}
                        labels={labels}
                        shortcuts={!selectMode}
                        onMessagePatched={patchListedMessage}
                        onMessageRemoved={(updated) => removeListedMessage(updated.uid)}
                        onLabelCreated={(label) => (otherMailbox ? setOtherMailboxLabels : setMailboxLabels)((prev) => [...prev, label])}
                        onFolderCreated={onFolderCreated}
                    />
                ) : (
                <LazyMessageDetailPane
                    shortcuts={!selectMode}
                    message={selected}
                    attachments={attachments}
                    isSentItems={isSentItems}
                    onRecalled={patchListedMessage}
                    isOutbox={isOutbox}
                    onReceiptHandled={patchListedMessage}
                    draftsFolderUid={draftsFolderUid}
                    folders={folders}
                    onMoved={(updated) => {
                        // Same reasoning as onArchived below - a move takes the message out of the folder
                        // being listed, so it leaves the list rather than being patched in place.
                        removeListedMessage(updated.uid);
                    }}
                    onFolderCreated={onFolderCreated}
                    onScheduledSendCanceled={(updated) => {
                        // The message moved out of the currently-viewed Outbox folder (into Drafts)
                        // - unlike a recall, which patches a message in place, this removes it from
                        // the list entirely, matching what a real folder switch would show.
                        removeListedMessage(updated.uid);
                    }}
                    onArchived={(updated) => {
                        // Same reasoning as onScheduledSendCanceled above - the message moved out of
                        // whichever folder is currently being viewed (into Archive), so it's removed
                        // from the list rather than patched in place.
                        removeListedMessage(updated.uid);
                    }}
                    onChanged={patchListedMessage}
                    labels={labels}
                    onLabelsChanged={patchListedMessage}
                    onLabelCreated={(label) =>
                        (otherMailbox ? setOtherMailboxLabels : setMailboxLabels)((prev) => [...prev, label])
                    }
                />
                )}
            </div>
            <MoveToFolderDialog
                open={moveDialog !== null}
                onClose={() => setMoveDialog(null)}
                mailboxUid={activeMailboxUid}
                folders={currentFolders}
                currentFolderUid={folderUid}
                count={moveDialog === null ? 1 : "messages" in moveDialog ? moveDialog.messages.length : moveDialog.conversation.messageCount}
                onMove={swipeMove}
                onFolderCreated={onFolderCreated}
            />
        </div>
    );
}

export default routedPage("/", InboxPage);
