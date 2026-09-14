// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ELECTRON_DEFAULT_BYTE_BUDGET_BYTES,
    WEB_DEFAULT_BYTE_BUDGET_BYTES,
    getDefaultLocalIndexByteBudget,
    getLocalIndexByteBudget,
    setLocalIndexByteBudget,
} from "../../../apps/shared/search/localIndexSizePreference.js";

const STORAGE_KEY = "rapidmx:local-index-byte-budget";

afterEach(() => {
    localStorage.clear();
    delete (window as unknown as { rapidmx?: unknown }).rapidmx;
    vi.restoreAllMocks();
});

describe("localIndexSizePreference", () => {
    it("defaults to the web budget in a browser tab and the roomier budget inside Electron", () => {
        expect(getDefaultLocalIndexByteBudget()).toBe(WEB_DEFAULT_BYTE_BUDGET_BYTES);
        (window as unknown as { rapidmx?: unknown }).rapidmx = {};
        expect(getDefaultLocalIndexByteBudget()).toBe(ELECTRON_DEFAULT_BYTE_BUDGET_BYTES);
    });

    it("round-trips a saved budget, including 0 (unlimited)", () => {
        expect(getLocalIndexByteBudget()).toBe(WEB_DEFAULT_BYTE_BUDGET_BYTES);
        setLocalIndexByteBudget(250);
        expect(getLocalIndexByteBudget()).toBe(250);
        setLocalIndexByteBudget(0);
        expect(getLocalIndexByteBudget()).toBe(0);
    });

    it.each([["not-a-number"], ["-5"], ["Infinity"]])("falls back to the default for a corrupted stored value (%s)", (stored) => {
        localStorage.setItem(STORAGE_KEY, stored);
        expect(getLocalIndexByteBudget()).toBe(WEB_DEFAULT_BYTE_BUDGET_BYTES);
    });

    it("falls back to the default when localStorage throws, and swallows a failed save", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("SecurityError");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("QuotaExceededError");
        });
        expect(getLocalIndexByteBudget()).toBe(WEB_DEFAULT_BYTE_BUDGET_BYTES);
        expect(() => setLocalIndexByteBudget(100)).not.toThrow();
    });
});
