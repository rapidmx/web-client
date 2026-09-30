// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { GRAVATAR_PREFERENCE_KEY, gravatarEnabled, gravatarUrl } from "../../../lib/contacts/gravatar.js";

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
    it("is on unless the reader turned it off", () => {
        expect(gravatarEnabled()).toBe(true);
        localStorage.setItem(GRAVATAR_PREFERENCE_KEY, "off");
        expect(gravatarEnabled()).toBe(false);
    });

    it("stays on when the browser will not hand out its storage", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("denied");
        });
        expect(gravatarEnabled()).toBe(true);
    });
});
