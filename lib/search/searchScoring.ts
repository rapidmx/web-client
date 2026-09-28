///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Client-side re-scoring per `specs/search.md` §7 "Ranking and Merge": scores from different search
 * sources are not comparable — a Postgres `ts_rank`, an OpenSearch `_score`, and a future local FTS5
 * `bm25()` value occupy different, provider-specific ranges. The spec requires normalizing every
 * source's scores into one shared space rather than interleaving raw values.
 *
 * This pass only has one source (Tier 1 - the server), so there is nothing to *merge* yet - the real
 * cross-tier merge (§7's full ranking pass, §8's composite pagination cursor) is Tier 2/3 work,
 * deliberately out of scope for this pass. What's implemented here is the normalization step itself,
 * written generically (one page's raw scores in, normalized scores out) so a future per-source call
 * into the same function is all cross-tier merging needs to add - not a second implementation of
 * normalization.
 */

/** The spec's own field-weight table (§7), exported for reuse by whichever component eventually
 * computes a *local* (Tier 2) score from decrypted content - the same weights must produce ranking
 * that matches today's server-side behavior. */
export const SEARCH_FIELD_WEIGHTS = {
    subject: 3,
    participants: 2,
    body: 1,
    attachmentText: 1,
} as const;

/**
 * Normalizes one page's raw provider scores into `[0, 1]`, preserving relative order, so a caller never
 * has to reason about a specific provider's raw score range. `0` for every result when every score in
 * the page is equal (including the degenerate single-result and all-zero cases) - there is no relative
 * ordering information to preserve in that case, and `0` is a safer default than an arbitrary `1`.
 */
export function normalizeServerScores<T extends { score: number }>(results: readonly T[]): { result: T; normalizedScore: number }[] {
    if (results.length === 0) {
        return [];
    }
    const maxScore = Math.max(...results.map((r) => r.score));
    const minScore = Math.min(...results.map((r) => r.score));
    const range = maxScore - minScore;
    return results.map((result) => ({
        result,
        normalizedScore: range === 0 ? 0 : (result.score - minScore) / range,
    }));
}
