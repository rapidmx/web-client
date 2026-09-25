///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The pieces of searching several mailboxes at once (Mail's "All mailboxes" views, and a search widened from one mailbox's folder to every
 * mailbox the reader can read). Nothing here talks to the server: `apps/www/index.tsx` fans its own per-mailbox pipeline (Tier 1 server search,
 * Tier 2 local index, Tier 3 server-narrowed encrypted candidates) out across mailboxes and uses these to bound that fan-out, to merge what
 * comes back into one ranked list and to say, in words, which mailbox could not be searched and why.
 *
 * A search of one mailbox is the same code with a list of one: nothing here changes what that returns.
 */
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import type { SearchResult } from "@rapidmx/react-shared/search/searchApi.js";
import { normalizeServerScores } from "@rapidmx/react-shared/search/searchScoring.js";

/**
 * How far a cross-mailbox search fans out. Exported (and mutable) so a test can shrink them instead of building 26 mailboxes or waiting a
 * minute for a timeout; nothing else writes to it.
 */
export const SEARCH_LIMITS = {
    /** How many mailboxes are worked on at once. */
    concurrency: 4,
    /** The most mailboxes one search covers - the caller's own first, then the shared ones (`orderMailboxes()`); a note says how many were left out. */
    maxMailboxes: 25,
    /** How long one mailbox's Tier 1 (server) request may take before that mailbox is given up on, so one wedged mailbox cannot hold the search. */
    tier1TimeoutMs: 15_000,
    /** The same for a mailbox's Tier 3 pass (fetching and decrypting up to a couple of hundred candidates, so much longer). */
    tier3TimeoutMs: 60_000,
    /** The most result rows a search keeps on screen (the page's own cap for a list, `MAX_LOADED_ROWS`, applies to a search too). */
    maxRows: 500,
};

/** The least a mailbox is asked for on one page while several are searched, so a search over many mailboxes still moves at a sensible pace. */
const MIN_MAILBOX_PAGE_SIZE = 10;

/**
 * How many results each mailbox contributes to one page. One mailbox gives the whole page; with several the page is shared out between them
 * (never below `MIN_MAILBOX_PAGE_SIZE`), so the merged first page stays about one page long instead of growing by the number of mailboxes.
 */
export function searchPageSize(mailboxCount: number, pageSize: number): number {
    return Math.max(MIN_MAILBOX_PAGE_SIZE, Math.ceil(pageSize / Math.max(1, mailboxCount)));
}

/** A search hit that remembers which mailbox it was found in. */
export interface MailboxHit extends SearchResult {
    mailboxUid: string;
}

export function tagHits(mailboxUid: string, hits: SearchResult[]): MailboxHit[] {
    return hits.map((hit) => ({ ...hit, mailboxUid }));
}

/** One hit's identity across mailboxes: the same entity uid found in two mailboxes is two hits. */
export function hitKey(hit: { mailboxUid: string; entityUid: string }): string {
    return `${hit.mailboxUid}\u0000${hit.entityUid}`;
}

/**
 * Merges Tier 1 (server, possibly `metadataOnly` for an encrypted message), Tier 2 (local index, fully decrypted and re-scored) and Tier 3
 * (server-narrowed candidates, decrypted and re-scored) results into one ranked list, per `specs/search.md` §7's "client MUST re-score all
 * results it can see... normalise into the same space rather than interleaving raw scores": each tier is normalized independently via
 * `normalizeServerScores()` before merging, since a Postgres/OpenSearch score, a local `bm25()` score, and Tier 3's own term-count score all
 * occupy unrelated ranges. A hit present in more than one list keeps only the last-inserted entry (Tier 2 wins over Tier 3 wins over Tier 1) -
 * Tier 2 and Tier 3 both represent genuine, content-verified scores for the same message, so which one "wins" on overlap doesn't change
 * correctness, only which of two equally-valid scores is shown; either supersedes Tier 1's metadata-only guess for the same message.
 *
 * Each tier's list is pooled across every mailbox searched before it is normalized, so one mailbox's best hit is not automatically "1.0"
 * next to another's: the ranking is the same rule as for one mailbox, applied to the merged lists. A hit's identity is its mailbox and its
 * entity uid (`hitKey()`), so the same uid can only collapse within a mailbox. Ties keep the order the lists were given in (a stable sort), which
 * the caller makes the mailboxes' display order.
 *
 * Called progressively - each time with whatever tiers have reported so far (an empty array for the rest). Pure and stateless.
 */
export function mergeSearchResults(tier1: MailboxHit[], tier2: MailboxHit[], tier3: MailboxHit[]): MailboxHit[] {
    const merged = new Map<string, { result: MailboxHit; normalizedScore: number }>();
    for (const tier of [tier1, tier3, tier2]) {
        for (const entry of normalizeServerScores(tier)) {
            merged.set(hitKey(entry.result), entry);
        }
    }
    return Array.from(merged.values())
        .sort((a, b) => b.normalizedScore - a.normalizedScore)
        .map((entry) => entry.result);
}

/** Raised by `withTimeout()`. */
export class SearchTimeoutError extends Error {
    constructor() {
        super("The search took too long.");
        this.name = "SearchTimeoutError";
    }
}

/** `promise`, or a rejection with `SearchTimeoutError` if it has not settled after `ms` (never, for a non-finite `ms`). The work is not aborted - a late answer is just dropped. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (!Number.isFinite(ms)) {
        return promise;
    }
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new SearchTimeoutError()), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (reason) => {
                clearTimeout(timer);
                reject(reason);
            },
        );
    });
}

/**
 * Runs `task` for every item, at most `concurrency` at a time, starting them in order. Stops starting new ones once `isCancelled()` (the search
 * was superseded) or once one has rejected - which is then this function's own rejection, after the ones already running have settled.
 */
export async function runLimited<T>(
    items: readonly T[],
    concurrency: number,
    task: (item: T) => Promise<void>,
    isCancelled: () => boolean,
): Promise<void> {
    let next = 0;
    let failed = false;
    const worker = async () => {
        while (!failed && !isCancelled() && next < items.length) {
            const item = items[next++];
            try {
                await task(item);
            } catch (err) {
                failed = true;
                throw err;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** Why one mailbox's search failed, as a short phrase for the notice: the class of failure, never the server's own text. */
export function classifyFailure(err: unknown): string {
    if (err instanceof SearchTimeoutError) {
        return "timed out";
    }
    if (err instanceof ApiRequestError) {
        if (err.status === 401 || err.status === 403) {
            return "access denied";
        }
        return err.status >= 500 ? "server error" : "rejected by the server";
    }
    return "network error";
}

/** A mailbox that could not be (fully) searched. `encrypted` is set when only its Tier 3 pass (the encrypted mail) failed - its other results are in. */
export interface MailboxFailure {
    mailboxUid: string;
    /** The mailbox's display name, as it was when the search ran. */
    mailboxName: string;
    encrypted: boolean;
    reason: string;
}

/** The body of the "Some results may be missing" notice: which mailboxes, and why each. */
export function describeFailures(failures: readonly MailboxFailure[]): string {
    return `${failures
        .map((failure) => `${failure.mailboxName} (${failure.encrypted ? "encrypted mail: " : ""}${failure.reason})`)
        .join(", ")} could not be searched.`;
}
