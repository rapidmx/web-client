// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_BOOT_SCRIPT } from "../../../apps/shared/appearance/bootScript.js";
import { APPEARANCE_CACHE_KEY } from "../../../apps/shared/appearance/appearanceCache.js";
import { APPEARANCE_STYLE_ID } from "../../../apps/shared/appearance/theme.js";

function run() {
    // The script is what a layout puts in an inline <script>: run it as one, in the page's global scope.
    new Function(APPEARANCE_BOOT_SCRIPT)();
}

function cache(extra: Record<string, unknown> = {}) {
    localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify({ v: 1, key: "K1", t: 1000, mode: "dark", css: "html{--x:1}", ...extra }));
}

/** A stylesheet the server rendered into the page. */
function serverStyle(key: string, t: number, text = "server") {
    const server = document.createElement("style");
    server.id = APPEARANCE_STYLE_ID;
    server.setAttribute("data-key", key);
    server.setAttribute("data-t", String(t));
    server.textContent = text;
    document.head.appendChild(server);
    return server;
}

const style = () => document.getElementById(APPEARANCE_STYLE_ID);

beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-uid");
    style()?.remove();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("APPEARANCE_BOOT_SCRIPT", () => {
    it("has no dependencies: it is plain ES5 script, reading only the cache's key and the style element's id", () => {
        expect(APPEARANCE_BOOT_SCRIPT).toContain(APPEARANCE_CACHE_KEY);
        expect(APPEARANCE_BOOT_SCRIPT).toContain(APPEARANCE_STYLE_ID);
        expect(APPEARANCE_BOOT_SCRIPT).not.toMatch(/=>|\blet\b|\bconst\b|`/);
    });

    it("puts the cached stylesheet in the head and an explicit scheme on <html>", () => {
        cache();
        run();
        expect(style()!.parentElement).toBe(document.head);
        expect(style()!.textContent).toBe("html{--x:1}");
        expect(style()!.getAttribute("data-key")).toBe("K1");
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });

    it("sets light too, and takes the scheme off for System (the stylesheet's own media query follows the OS)", () => {
        cache({ mode: "light" });
        run();
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
        cache({ mode: "system" });
        run();
        expect(style()).not.toBeNull();
        expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    });

    it("does nothing without a cache, or with one it doesn't understand", () => {
        run();
        expect(style()).toBeNull();
        for (const bad of ["not json", JSON.stringify({ v: 2, key: "k", css: "x" }), JSON.stringify({ v: 1, key: "k" }), JSON.stringify({ v: 1, css: "x" }), "null"]) {
            localStorage.setItem(APPEARANCE_CACHE_KEY, bad);
            run();
            expect(style()).toBeNull();
        }
        expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    });

    it("does nothing when the cache belongs to another account", () => {
        document.documentElement.setAttribute("data-uid", "u2");
        cache({ uid: "u1" });
        run();
        expect(style()).toBeNull();
    });

    it("applies a cache with no owner, one the page can't compare, and one that is the signed-in user's", () => {
        document.documentElement.setAttribute("data-uid", "u2");
        cache();
        run();
        expect(style()).not.toBeNull();
        style()!.remove();
        document.documentElement.removeAttribute("data-uid");
        cache({ uid: "u1" });
        run();
        expect(style()).not.toBeNull();
        document.documentElement.setAttribute("data-uid", "u1");
        style()!.remove();
        run();
        expect(style()).not.toBeNull();
    });

    it("replaces the server's stylesheet when it was made from the same preferences (the cache also knows the measured image)", () => {
        serverStyle("K1", 5000);
        cache();
        run();
        expect(document.querySelectorAll(`#${APPEARANCE_STYLE_ID}`)).toHaveLength(1);
        expect(style()!.textContent).toBe("html{--x:1}");
    });

    it("prefers the browser's copy when it is newer than the page's, which the server may have cached for a minute", () => {
        serverStyle("OTHER", 500);
        cache({ t: 1000 });
        run();
        expect(style()!.textContent).toBe("html{--x:1}");
        expect(style()!.getAttribute("data-key")).toBe("K1");
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });

    it("leaves the server's stylesheet, and its scheme, when it is at least as new as the cache", () => {
        document.documentElement.setAttribute("data-theme", "light");
        serverStyle("OTHER", 1000);
        cache({ t: 1000 });
        run();
        expect(style()!.textContent).toBe("server");
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
        style()!.setAttribute("data-t", "2000");
        run();
        expect(style()!.textContent).toBe("server");
    });

    it("treats a server stylesheet without a time, or a cache without one, as the oldest", () => {
        const server = serverStyle("OTHER", 0);
        server.removeAttribute("data-t");
        cache({ t: undefined });
        run();
        // Both are 0: the server's wins the tie.
        expect(style()!.textContent).toBe("server");
        cache({ t: 5 });
        run();
        expect(style()!.textContent).toBe("html{--x:1}");
    });

    it("removes the server's stylesheet, and its scheme, when the cache says nothing is chosen (a reset the page hasn't heard of)", () => {
        document.documentElement.setAttribute("data-theme", "dark");
        serverStyle("OTHER", 500);
        cache({ css: "", mode: "system", t: 2000 });
        run();
        expect(style()).toBeNull();
        expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    });

    it("applies 'nothing chosen' quietly when there is no stylesheet to remove", () => {
        cache({ css: "", mode: "light" });
        run();
        expect(style()).toBeNull();
        expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });

    it("cannot break the page when storage throws", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(run).not.toThrow();
        expect(style()).toBeNull();
    });
});
