// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
/**
 * Covers `resolveRRuleExport`'s CJS-interop fallback — the branch that only actually fires under
 * this framework's real SSR module loader (confirmed directly: SSR-ing the calendar page throws
 * without it — see `recurrence.ts`'s header comment), never under vitest's own module resolution,
 * which always exposes `RRule` as a direct named export. Exercised here with a plain object shaped
 * the way Node's CJS/ESM interop actually produces it (`RRule` reachable only via `.default`), rather
 * than via `vi.mock` — vitest's own mock module throws on accessing a property the mock doesn't
 * define, so it can't reproduce "the property is simply absent" the way a real namespace object can.
 */
import { RRule } from "rrule";
import { describe, expect, it } from "vitest";
import { resolveRRuleExport } from "../../../lib/calendar/recurrence.js";

describe("resolveRRuleExport", () => {
    it("returns the direct named export when present (the real-ESM / test-environment shape)", () => {
        expect(resolveRRuleExport({ RRule } as unknown as Parameters<typeof resolveRRuleExport>[0])).toBe(RRule);
    });

    it("falls back to .default.RRule when the named export is absent (Node's CJS-interop shape)", () => {
        const ns = { default: { RRule } } as unknown as Parameters<typeof resolveRRuleExport>[0];
        expect(resolveRRuleExport(ns)).toBe(RRule);
    });
});
