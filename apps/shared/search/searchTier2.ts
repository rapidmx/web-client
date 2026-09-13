///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Tier 2 (`specs/search.md` §6) - the local encrypted index's public entry point, mirroring
 * `@rapidmx/react-shared`'s `searchTier3.ts#searchEncryptedCandidates()` in shape: given a parsed query
 * and this session's unlocked keys, return already-scored, already-sourced results plus how much of the
 * mailbox the local index actually covers right now.
 *
 * Returns `{ results: [], coverage: undefined }` - never throws, never rejects - both when `unlocked` is
 * absent (nothing is indexed without a master key to derive the index key from, the same "silently
 * contributes nothing" degradation `searchTier3.ts`'s own doc comment describes for its identical case)
 * and when anything about the local index itself fails (Worker/WASM/OPFS unsupported or unavailable in
 * this browser, a corrupted index mid-rebuild, a query timeout). This tier's own storage engine is
 * strictly best-effort infrastructure Tier 1 doesn't depend on - a caller `Promise.all()`-ing this
 * alongside Tier 1/Tier 3 (`apps/www/index.tsx`'s `searchMessages()`) must never see the *whole search*
 * fail just because this one, most novel piece had a bad moment.
 */
import type { UnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import type { ParsedSearchQuery } from "@rapidmx/react-shared/search/queryGrammar.js";
import type { SearchResult } from "@rapidmx/react-shared/search/searchApi.js";
import { deriveLocalIndexKey } from "./localIndexKey.js";
import { getLocalCoverage, initLocalIndex, searchLocal } from "./localIndexRpcClient.js";
import type { Coverage } from "./localIndexWorker.js";

export interface Tier2SearchOutcome {
    results: SearchResult[];
    /** `undefined` when `unlocked` was absent - there's no local index to report coverage for at all in
     * that case, distinct from a real, empty (just-built) index. */
    coverage?: Coverage;
}

/** Ensures this mailbox's local index connection is open before it's queried - idempotent
 * (`localIndexWorker.ts`'s own `init()` no-ops for an already-open mailbox), so callers never need to
 * coordinate with `LocalIndexLifecycle.tsx`'s own unlock-triggered `init()` call; whichever runs first
 * wins, and the other is a cheap no-op. */
async function ensureInitialized(mailboxUid: string, unlocked: UnlockedKeys): Promise<void> {
    const indexKey = await deriveLocalIndexKey(unlocked.masterKey, mailboxUid);
    await initLocalIndex({ mailboxUid, indexKey });
}

export async function searchLocalIndex(
    mailboxUid: string,
    parsed: ParsedSearchQuery,
    unlocked: UnlockedKeys | undefined,
    limit = 50,
): Promise<Tier2SearchOutcome> {
    if (!unlocked) {
        return { results: [] };
    }
    try {
        await ensureInitialized(mailboxUid, unlocked);
        const [hits, coverage] = await Promise.all([searchLocal(mailboxUid, parsed, limit), getLocalCoverage(mailboxUid)]);
        const results: SearchResult[] = hits.map((hit) => ({
            entityType: "message",
            entityUid: hit.entityUid,
            // Negated: bm25()'s own convention is "more negative is a better match" (SQLite), the
            // opposite of every other score this codebase merges (Postgres ts_rank, OpenSearch _score,
            // and normalizeServerScores() itself all treat "higher is better"). Negating here, once,
            // keeps that convention uniform for the caller (apps/www/index.tsx's merge layer) - it never
            // needs to know this tier's underlying scoring function works backwards from the others.
            score: -hit.score,
            snippet: hit.snippet,
            source: "local",
            metadataOnly: false,
        }));
        return { results, coverage };
    } catch {
        // See this function's own doc comment - a broken local index degrades to "nothing to contribute
        // this time," never a rejected search.
        return { results: [] };
    }
}
