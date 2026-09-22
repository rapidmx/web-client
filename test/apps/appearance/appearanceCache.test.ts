// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppearancePreferences } from "@rapidmx/react-shared/appearance/preferencesApi.js";
import {
    APPEARANCE_CACHE_KEY,
    cacheKeyOf,
    clearAppearanceCache,
    readAppearanceCache,
    timeOf,
    writeAppearanceCache,
} from "../../../apps/shared/appearance/appearanceCache.js";

const prefs: AppearancePreferences = {
    version: 1,
    mode: "dark",
    colors: { primary: "#1e3a8a" },
    background: { kind: "image", imageVersion: "v1", dim: 0.3, blur: 2, fit: "cover" },
    updatedAt: "2026-09-21T10:00:00.000Z",
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe("timeOf", () => {
    it("reads an ISO date or milliseconds, and is 0 for none or nonsense", () => {
        expect(timeOf("2026-09-21T10:00:00.000Z")).toBe(Date.parse("2026-09-21T10:00:00.000Z"));
        expect(timeOf(1234)).toBe(1234);
        expect(timeOf(undefined)).toBe(0);
        expect(timeOf("yesterday")).toBe(0);
        expect(timeOf(NaN)).toBe(0);
        expect(timeOf("1970-01-01T00:00:00.000Z")).toBe(0);
    });
});

describe("appearance cache", () => {
    it("writes the prefs, the finished stylesheet, the time and who they belong to, and reads them back", () => {
        writeAppearanceCache(prefs, "html{}", 5000, "u1", { version: "v1", range: { lo: { r: 10, g: 10, b: 10 }, hi: { r: 200, g: 200, b: 200 } } });
        const cache = readAppearanceCache()!;
        expect(cache).toMatchObject({ v: 1, uid: "u1", t: 5000, mode: "dark", css: "html{}", prefs, measured: { version: "v1", levels: [10, 200] } });
        expect(cache.key).toBe(cacheKeyOf(prefs));
        expect(JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY)!).key).toBe(cache.key);
    });

    it("leaves out what isn't known: the account and the measurement", () => {
        writeAppearanceCache(prefs, "html{}", 1);
        const cache = readAppearanceCache()!;
        expect(cache.uid).toBeUndefined();
        expect(cache.measured).toBeUndefined();
    });

    it("keeps 'nothing chosen' as an empty stylesheet rather than nothing, so it is newer than a stale page", () => {
        writeAppearanceCache({ version: 1, mode: "system" }, "", 9000, "u1");
        expect(readAppearanceCache()).toMatchObject({ css: "", t: 9000, mode: "system" });
    });

    it("keys on the preferences' content in one key order, so any change is a different key and the same content is the same key", () => {
        expect(cacheKeyOf(prefs)).toBe(cacheKeyOf({ ...prefs }));
        expect(cacheKeyOf(prefs)).not.toBe(cacheKeyOf({ ...prefs, mode: "light" }));
        // Keys written in another order (the imageVersion last, say) still name the same preferences.
        const reordered = {
            updatedAt: prefs.updatedAt,
            background: { imageVersion: "v1", fit: "cover", blur: 2, dim: 0.3, kind: "image" },
            colors: prefs.colors,
            mode: "dark",
            version: 1,
        } as AppearancePreferences;
        expect(cacheKeyOf(reordered)).toBe(cacheKeyOf(prefs));
        // Something that isn't preferences still gets a key.
        expect(cacheKeyOf({ nonsense: true } as never)).toBe('{"nonsense":true}');
    });

    it("clears on request", () => {
        writeAppearanceCache(prefs, "html{}", 1);
        clearAppearanceCache();
        expect(readAppearanceCache()).toBeUndefined();
    });

    it("re-validates what it reads: another version, no prefs, no stylesheet, bad JSON, or hostile values give nothing or a cleaned copy", () => {
        const store = (value: unknown) => localStorage.setItem(APPEARANCE_CACHE_KEY, typeof value === "string" ? value : JSON.stringify(value));
        store("not json");
        expect(readAppearanceCache()).toBeUndefined();
        store({ v: 2, prefs, css: "x" });
        expect(readAppearanceCache()).toBeUndefined();
        store({ v: 1, prefs: { version: 1 }, css: 5 });
        expect(readAppearanceCache()).toBeUndefined();
        store({ v: 1, css: "x" });
        expect(readAppearanceCache()).toBeUndefined();
        store({ v: 1, prefs: { version: 1, mode: "dark", colors: { primary: "url(javascript:x)" } }, css: "x", uid: 5, t: "soon", measured: { version: "v", levels: [1] } });
        const cleaned = readAppearanceCache()!;
        expect(cleaned).toMatchObject({ mode: "dark", css: "x", prefs: { version: 1, mode: "dark" }, t: 0 });
        expect(cleaned.prefs.colors).toBeUndefined();
        expect(cleaned.uid).toBeUndefined();
        expect(cleaned.measured).toBeUndefined();
        store({ v: 1, prefs, css: "", t: Infinity });
        expect(readAppearanceCache()!.t).toBe(0);
        localStorage.clear();
        expect(readAppearanceCache()).toBeUndefined();
    });

    it("survives storage that throws, everywhere", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("full");
        });
        vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(readAppearanceCache()).toBeUndefined();
        expect(() => writeAppearanceCache(prefs, "html{}", 1)).not.toThrow();
        expect(() => clearAppearanceCache()).not.toThrow();
    });
});
