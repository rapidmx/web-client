// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { SEARCH_FIELD_WEIGHTS, normalizeServerScores } from "../../../lib/search/searchScoring.js";

describe("SEARCH_FIELD_WEIGHTS", () => {
    it("matches the spec's own field-weight table", () => {
        expect(SEARCH_FIELD_WEIGHTS).toEqual({ subject: 3, participants: 2, body: 1, attachmentText: 1 });
    });
});

describe("normalizeServerScores", () => {
    it("returns an empty array for an empty page", () => {
        expect(normalizeServerScores([])).toEqual([]);
    });

    it("normalizes a single result to 0 (no relative ordering to preserve)", () => {
        const result = { score: 7.5, entityUid: "m1" };
        expect(normalizeServerScores([result])).toEqual([{ result, normalizedScore: 0 }]);
    });

    it("normalizes every result to 0 when all scores are equal", () => {
        const results = [{ score: 3 }, { score: 3 }, { score: 3 }];
        expect(normalizeServerScores(results).map((r) => r.normalizedScore)).toEqual([0, 0, 0]);
    });

    it("normalizes the lowest score to 0 and the highest to 1, preserving relative order", () => {
        const results = [{ score: 10 }, { score: 30 }, { score: 20 }];
        const normalized = normalizeServerScores(results);
        expect(normalized.map((r) => r.normalizedScore)).toEqual([0, 1, 0.5]);
        // The original result objects are returned by reference, not copied.
        expect(normalized[0].result).toBe(results[0]);
        expect(normalized[1].result).toBe(results[1]);
        expect(normalized[2].result).toBe(results[2]);
    });

    it("handles an all-zero page the same as an all-equal page", () => {
        const results = [{ score: 0 }, { score: 0 }];
        expect(normalizeServerScores(results).map((r) => r.normalizedScore)).toEqual([0, 0]);
    });
});
