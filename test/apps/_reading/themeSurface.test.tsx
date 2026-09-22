// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SURFACES, readThemeSurface, surfaceKey, useThemeSurface } from "../../../apps/shared/components/mail/reading/themeSurface.js";

/** jsdom resolves no `var()`: answer the probe's colour from a table of the page's tokens, as a browser would. */
function stubTokens(tokens: Record<string, string>) {
    return vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
        const name = /var\((--[\w-]+)/.exec((element as HTMLElement).style.color)?.[1];
        return { color: (name && tokens[name]) || "rgba(0, 0, 0, 0)" } as CSSStyleDeclaration;
    });
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("data-theme");
});

describe("readThemeSurface", () => {
    it("reads the page's own tokens, and leaves no probe behind", () => {
        stubTokens({
            "--rr-color-surface": "rgb(20, 24, 30)",
            "--rr-color-bg": "rgb(10, 12, 14)",
            "--rr-color-text": "rgb(250, 250, 240)",
            "--rr-color-primary-dark": "rgb(1, 200, 100)",
        });
        expect(readThemeSurface("dark")).toEqual({
            dark: true,
            background: { r: 20, g: 24, b: 30 },
            text: { r: 250, g: 250, b: 240 },
            link: { r: 1, g: 200, b: 100 },
        });
        expect(document.body.querySelectorAll("span")).toHaveLength(0);
    });

    it("paints a translucent surface over the page background, so the body area is always opaque", () => {
        stubTokens({ "--rr-color-surface": "rgba(0, 0, 0, 0.5)", "--rr-color-bg": "rgb(100, 100, 100)", "--rr-color-text": "rgba(255, 255, 255, 0.5)" });
        const surface = readThemeSurface("dark");
        expect(surface.background).toEqual({ r: 50, g: 50, b: 50 });
        expect(surface.text).toEqual({ r: 177.5, g: 177.5, b: 177.5 });
    });

    it("composites a translucent page background over the scheme's own, and falls back to the built-in scheme for what is not defined", () => {
        stubTokens({ "--rr-color-bg": "rgba(0, 0, 0, 0.5)" });
        const surface = readThemeSurface("light");
        expect(surface.background).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
        expect(surface.text).toEqual(DEFAULT_SURFACES.light.text);
        expect(surface.link).toEqual(DEFAULT_SURFACES.light.link);
        stubTokens({});
        expect(readThemeSurface("dark")).toEqual(DEFAULT_SURFACES.dark);
    });

    it("is the built-in scheme where there is no document (server-side rendering) or no body yet", () => {
        vi.stubGlobal("document", undefined);
        expect(readThemeSurface("dark")).toBe(DEFAULT_SURFACES.dark);
        vi.stubGlobal("document", { body: null });
        expect(readThemeSurface("light")).toBe(DEFAULT_SURFACES.light);
    });
});

describe("surfaceKey", () => {
    it("changes exactly when a colour or the scheme does", () => {
        const a = DEFAULT_SURFACES.dark;
        expect(surfaceKey(a)).toBe(surfaceKey({ ...a }));
        expect(surfaceKey(a)).not.toBe(surfaceKey({ ...a, text: { r: 1, g: 2, b: 3 } }));
        expect(surfaceKey(a)).not.toBe(surfaceKey({ ...a, link: { r: 1, g: 2, b: 3 } }));
        expect(surfaceKey(a)).not.toBe(surfaceKey({ ...a, background: { r: 1, g: 2, b: 3 } }));
        expect(surfaceKey(a)).not.toBe(surfaceKey({ ...a, dark: false }));
    });
});

describe("useThemeSurface", () => {
    it("is the scheme's surface, and the right one at once when the scheme changes", () => {
        const { result, rerender } = renderHook(({ theme }) => useThemeSurface(theme), { initialProps: { theme: "light" as "light" | "dark" } });
        expect(result.current.dark).toBe(false);
        rerender({ theme: "dark" });
        expect(result.current.dark).toBe(true);
        expect(result.current.background).toEqual(DEFAULT_SURFACES.dark.background);
    });

    it("follows the page's colours when they are changed at runtime, and keeps its identity when they have not changed", async () => {
        stubTokens({ "--rr-color-surface": "rgb(20, 20, 20)" });
        const { result } = renderHook(() => useThemeSurface("dark"));
        expect(result.current.background).toEqual({ r: 20, g: 20, b: 20 });
        const before = result.current;
        await act(async () => {
            document.documentElement.setAttribute("style", "--irrelevant: 1");
        });
        expect(result.current).toBe(before);
        stubTokens({ "--rr-color-surface": "rgb(40, 40, 40)" });
        await act(async () => {
            document.documentElement.setAttribute("style", "--rr-color-surface: rgb(40, 40, 40)");
        });
        expect(result.current.background).toEqual({ r: 40, g: 40, b: 40 });

        // ...and when the Appearance provider rewrites its `<style>` in the head.
        const style = document.createElement("style");
        document.head.appendChild(style);
        await act(async () => undefined);
        stubTokens({ "--rr-color-surface": "rgb(60, 60, 60)" });
        await act(async () => {
            style.textContent = ":root{--rr-color-surface:#3c3c3c}";
        });
        expect(result.current.background).toEqual({ r: 60, g: 60, b: 60 });
        style.remove();
    });

    it("stops watching the page when it is unmounted, and copes with a browser that has no MutationObserver", () => {
        const disconnect = vi.fn();
        const observe = vi.fn();
        vi.stubGlobal("MutationObserver", function () {
            return { observe, disconnect };
        });
        const { unmount } = renderHook(() => useThemeSurface("light"));
        expect(observe).toHaveBeenCalledWith(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
        expect(observe).toHaveBeenCalledWith(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
        unmount();
        expect(disconnect).toHaveBeenCalled();

        vi.stubGlobal("MutationObserver", undefined);
        const { result } = renderHook(() => useThemeSurface("light"));
        expect(result.current.dark).toBe(false);
    });
});
