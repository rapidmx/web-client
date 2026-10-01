// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    GRAVATAR_PREFERENCE_EVENT,
    GRAVATAR_PREFERENCE_KEY,
    gravatarEnabled,
    gravatarUrl,
    isGravatarMissing,
    markGravatarMissing,
    setGravatarEnabled,
    subscribeGravatarPreference,
} from "../../../lib/contacts/gravatar.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
});

describe("gravatarUrl", () => {
    it("hashes the trimmed, lowercased address, asks for a 404 when there is no picture, and rounds the size", async () => {
        const url = await gravatarUrl("  MyEmailAddress@Example.com ", 96.4);
        expect(url).toMatch(/^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?s=96&d=404$/);
        expect(await gravatarUrl("myemailaddress@example.com", 96)).toBe(url);
        expect(await gravatarUrl("myemailaddress@example.com", 0)).toMatch(/\?s=1&d=404$/);
    });

    it("has nothing for an empty address", async () => {
        expect(await gravatarUrl("   ", 64)).toBeUndefined();
    });

    it("has nothing where the browser has no Web Crypto, or it fails", async () => {
        vi.stubGlobal("crypto", {});
        expect(await gravatarUrl("nocrypto@example.com", 64)).toBeUndefined();
        vi.stubGlobal("crypto", { subtle: { digest: () => Promise.reject(new Error("no")) } });
        expect(await gravatarUrl("failing@example.com", 64)).toBeUndefined();
    });
});

describe("gravatarEnabled", () => {
    it("is off until the reader turns it on, and an old explicit off stays off", () => {
        expect(gravatarEnabled()).toBe(false);
        localStorage.setItem(GRAVATAR_PREFERENCE_KEY, "off");
        expect(gravatarEnabled()).toBe(false);
        localStorage.setItem(GRAVATAR_PREFERENCE_KEY, "on");
        expect(gravatarEnabled()).toBe(true);
    });

    it("stays off when the browser will not hand out its storage", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("denied");
        });
        expect(gravatarEnabled()).toBe(false);
    });
});

describe("setGravatarEnabled and subscribeGravatarPreference", () => {
    it("stores the choice as on/off and tells subscribers in this tab", () => {
        const listener = vi.fn();
        const unsubscribe = subscribeGravatarPreference(listener);
        setGravatarEnabled(true);
        expect(localStorage.getItem(GRAVATAR_PREFERENCE_KEY)).toBe("on");
        expect(listener).toHaveBeenCalledTimes(1);
        setGravatarEnabled(false);
        expect(localStorage.getItem(GRAVATAR_PREFERENCE_KEY)).toBe("off");
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
        globalThis.dispatchEvent(new Event(GRAVATAR_PREFERENCE_EVENT));
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("hears the preference change in another tab, but not another key", () => {
        const listener = vi.fn();
        const unsubscribe = subscribeGravatarPreference(listener);
        globalThis.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
        expect(listener).not.toHaveBeenCalled();
        globalThis.dispatchEvent(new StorageEvent("storage", { key: GRAVATAR_PREFERENCE_KEY }));
        globalThis.dispatchEvent(new StorageEvent("storage", { key: null }));
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
        globalThis.dispatchEvent(new StorageEvent("storage", { key: GRAVATAR_PREFERENCE_KEY }));
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("still notifies, and stays off, where storage refuses the write", () => {
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("denied");
        });
        const listener = vi.fn();
        const unsubscribe = subscribeGravatarPreference(listener);
        setGravatarEnabled(true);
        expect(gravatarEnabled()).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    });
});

describe("missing pictures", () => {
    it("remembers a URL Gravatar had no picture at", () => {
        const url = "https://gravatar.com/avatar/abc?s=64&d=404";
        expect(isGravatarMissing(url)).toBe(false);
        markGravatarMissing(url);
        expect(isGravatarMissing(url)).toBe(true);
    });
});
