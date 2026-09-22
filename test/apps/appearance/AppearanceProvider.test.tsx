// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import type { AppearancePreferences } from "@rapidmx/react-shared/appearance/preferencesApi.js";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import AppearanceProvider, {
    APPEARANCE_SAVE_DELAY_MS,
    mergeAppearance,
} from "../../../apps/shared/appearance/AppearanceProvider.js";
import { useAppearance } from "../../../apps/shared/appearance/resolvedTheme.js";
import { APPEARANCE_CACHE_KEY, cacheKeyOf, writeAppearanceCache } from "../../../apps/shared/appearance/appearanceCache.js";
import { APPEARANCE_STYLE_ID } from "../../../apps/shared/appearance/theme.js";

const measureImage = vi.hoisted(() => vi.fn());
vi.mock("../../../apps/shared/appearance/photo.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../apps/shared/appearance/photo.js")>()),
    measureImage,
}));

type Api = ReturnType<typeof useAppearance>;
let api: Api;

function Probe() {
    api = useAppearance();
    return null;
}

const stored = (extra: Partial<AppearancePreferences> = {}): AppearancePreferences => ({
    version: 1,
    mode: "system",
    updatedAt: "2026-09-21T10:00:00.000Z",
    ...extra,
});
const image = (extra: Record<string, unknown> = {}) => ({ kind: "image" as const, imageVersion: "v1", dim: 0.2, blur: 0, fit: "cover" as const, ...extra });

const style = () => document.getElementById(APPEARANCE_STYLE_ID);
const theme = () => document.documentElement.getAttribute("data-theme");
const cached = () => JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null");

/**
 * A fake server that implements the contract: GET (the defaults when nothing is stored), a PUT that merges a partial and refuses a body that
 * names the image, the upload, the delete. It records every call.
 */
function fakeServer(initial?: AppearancePreferences, options: { failPut?: (n: number) => Response | undefined; failPost?: Response; failDelete?: Response; putDelay?: () => Promise<void> } = {}) {
    let server: any = initial ? structuredClone(initial) : { version: 1, mode: "system", updatedAt: "1970-01-01T00:00:00.000Z" };
    let clock = 1;
    const tick = () => `2026-09-21T10:00:${String(10 + clock++).padStart(2, "0")}.000Z`;
    const calls: { method: string; url: string; body?: any }[] = [];
    const fetchMock = mockFetch(async (url, init) => {
        const method = init.method ?? "GET";
        const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
        calls.push({ method, url, body });
        if (url === "/api/mail/preferences/appearance/background") {
            if (method === "POST") {
                if (options.failPost) {
                    return options.failPost;
                }
                server = { ...server, background: { ...(server.background ?? { dim: 0, blur: 0, fit: "cover" }), kind: "image", imageVersion: `v${clock}` }, updatedAt: tick() };
                return jsonResponse(200, server);
            }
            if (options.failDelete) {
                return options.failDelete;
            }
            const { imageVersion: _gone, ...background } = server.background ?? { kind: "none", dim: 0, blur: 0, fit: "cover" };
            server = { ...server, background: { ...background, kind: "none" }, updatedAt: tick() };
            return jsonResponse(200, server);
        }
        if (method === "PUT") {
            await options.putDelay?.();
            const failure = options.failPut?.(calls.filter((call) => call.method === "PUT").length);
            if (failure) {
                return failure;
            }
            if (body.background && "imageVersion" in body.background) {
                return jsonResponse(400, { message: "'background.imageVersion' cannot be set." });
            }
            const colors = body.colors === null ? undefined : { ...server.colors, ...body.colors };
            for (const key of Object.keys(colors ?? {})) {
                if (colors[key] === null) {
                    delete colors[key];
                }
            }
            server = { ...server, mode: body.mode ?? server.mode, updatedAt: tick() };
            if (colors && Object.keys(colors).length > 0) {
                server.colors = colors;
            } else {
                delete server.colors;
            }
            if (body.background) {
                server.background = { dim: 0, blur: 0, fit: "cover", kind: "none", ...server.background, ...body.background };
                if (server.background.color === null) {
                    delete server.background.color;
                }
            }
            return jsonResponse(200, server);
        }
        return jsonResponse(200, server);
    });
    return { calls, fetchMock, puts: () => calls.filter((call) => call.method === "PUT"), current: () => server };
}

function mount(props: React.ComponentProps<typeof AppearanceProvider> = {}) {
    return render(
        <AppearanceProvider userUid="u1" lookUp={false} {...props}>
            <Probe />
        </AppearanceProvider>,
    );
}

async function flushTimers(ms = APPEARANCE_SAVE_DELAY_MS + 50) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

beforeEach(() => {
    measureImage.mockReset();
    measureImage.mockResolvedValue(undefined);
    document.documentElement.removeAttribute("data-theme");
    style()?.remove();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    style()?.remove();
    document.documentElement.removeAttribute("data-theme");
});

describe("mergeAppearance", () => {
    const base = stored({ colors: { primary: "#112233" }, background: image() });

    it("replaces the mode, merges and clears colours, and merges into the background", () => {
        const merged = mergeAppearance(base, { mode: "dark", colors: { accent: "#445566", primary: null }, background: { blur: 9 } });
        expect(merged).toMatchObject({ mode: "dark", colors: { accent: "#445566" }, background: { blur: 9, dim: 0.2, imageVersion: "v1" }, updatedAt: base.updatedAt });
        expect(merged.colors).not.toHaveProperty("primary");
    });

    it("drops the colours when the last one is cleared, and the background when set to null", () => {
        expect(mergeAppearance(base, { colors: { primary: null } }).colors).toBeUndefined();
        expect(mergeAppearance(base, { background: null }).background).toBeUndefined();
    });

    it("keeps everything for an empty patch, and starts a background from the defaults", () => {
        expect(mergeAppearance(base, {})).toEqual(base);
        expect(mergeAppearance(stored(), { background: { kind: "color", color: "#010203" } }).background).toEqual({
            kind: "color",
            color: "#010203",
            dim: 0.2,
            blur: 0,
            fit: "cover",
        });
    });

    it("normalises: an invalid colour or an out-of-range number can't get through", () => {
        const merged = mergeAppearance(base, { colors: { text: "red" }, background: { dim: 5, blur: -3 } });
        expect(merged.colors).toEqual({ primary: "#112233" });
        expect(merged.background).toMatchObject({ dim: 0.8, blur: 0 });
    });

    it("has no timestamp when the source had none", () => {
        expect(mergeAppearance({ version: 1, mode: "system" }, { mode: "light" })).toEqual({ version: 1, mode: "light" });
    });
});

describe("applying what the server rendered", () => {
    it("writes one stylesheet in <head> and the explicit scheme", () => {
        mount({ initial: stored({ mode: "dark", colors: { primary: "#1e3a8a" } }) });
        expect(style()!.parentElement).toBe(document.head);
        expect(style()!.textContent).toContain("--rr-color-primary:#1e3a8a !important");
        expect(style()!.getAttribute("data-key")).toBe(cacheKeyOf(api.prefs));
        expect(theme()).toBe("dark");
        expect(api.prefs.colors).toEqual({ primary: "#1e3a8a" });
        expect(api.isDefault).toBe(false);
    });

    it("resolves System to the operating system's scheme, live", () => {
        const media = mockMatchMedia(false);
        mount({ initial: stored() });
        expect(theme()).toBe("light");
        expect(api.resolved).toBe("light");
        act(() => media.setMatches(true));
        expect(theme()).toBe("dark");
        expect(api.resolved).toBe("dark");
    });

    it("removes a server-rendered stylesheet when the preferences change nothing, and remembers 'nothing chosen' with the server's time", () => {
        const server = document.createElement("style");
        server.id = APPEARANCE_STYLE_ID;
        document.head.appendChild(server);
        mount({ initial: stored({ mode: "light" }) });
        expect(style()).toBeNull();
        expect(theme()).toBe("light");
        expect(cached()).toMatchObject({ css: "", mode: "light", t: Date.parse("2026-09-21T10:00:00.000Z"), uid: "u1" });
    });

    it("caches the stylesheet for the next page load, under the user, with the server's time and the image's version", () => {
        mount({ initial: stored({ colors: { primary: "#1e3a8a" }, background: image() }) });
        expect(cached()).toMatchObject({ v: 1, uid: "u1", mode: "system", t: Date.parse("2026-09-21T10:00:00.000Z"), prefs: { colors: { primary: "#1e3a8a" } } });
        expect(cached().css).toContain("html::before");
        expect(cached().css).toContain("/api/mail/preferences/appearance/background/v1");
    });

    it("treats a page prop that isn't preferences as absent, and asks the server", async () => {
        const { fetchMock } = fakeServer();
        mount({ initial: { nonsense: true }, lookUp: true });
        await act(async () => undefined);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/preferences/appearance", expect.anything());
        expect(api.prefs).toEqual({ version: 1, mode: "system", updatedAt: "1970-01-01T00:00:00.000Z" });
    });
});

describe("the page's copy can be a minute old", () => {
    it("uses the browser's copy when it is newer, before anything paints", () => {
        const pageCopy = stored({ mode: "light", updatedAt: "2026-09-21T10:00:00.000Z" });
        writeAppearanceCache(stored({ mode: "dark", colors: { primary: "#222222" }, updatedAt: "2026-09-21T10:00:30.000Z" }), "html{--x:1}", Date.parse("2026-09-21T10:00:30.000Z"), "u1");
        mount({ initial: pageCopy });
        expect(api.prefs.mode).toBe("dark");
        expect(api.prefs.colors).toEqual({ primary: "#222222" });
        expect(theme()).toBe("dark");
    });

    it("uses the page's copy when the browser's is older, is someone else's, or is the same time", () => {
        const pageCopy = stored({ mode: "light", updatedAt: "2026-09-21T10:00:30.000Z" });
        const cacheOf = (t: number, uid?: string) =>
            writeAppearanceCache(stored({ mode: "dark", updatedAt: "2026-09-21T10:00:00.000Z" }), "html{}", t, uid);
        cacheOf(Date.parse("2026-09-21T10:00:00.000Z"), "u1");
        mount({ initial: pageCopy });
        expect(api.prefs.mode).toBe("light");
        cacheOf(Date.parse("2026-09-21T10:01:00.000Z"), "someone-else");
        mount({ initial: pageCopy });
        expect(api.prefs.mode).toBe("light");
        cacheOf(Date.parse("2026-09-21T10:00:30.000Z"));
        mount({ initial: pageCopy });
        expect(api.prefs.mode).toBe("light");
    });

    it("uses a newer cache that has no owner, and the browser's 'nothing chosen' over a page that still shows a background", () => {
        writeAppearanceCache({ version: 1, mode: "system", updatedAt: "2026-09-21T10:00:00.000Z" }, "", Date.parse("2026-09-21T10:05:00.000Z"));
        mount({ initial: stored({ mode: "dark", background: image() }) });
        expect(api.prefs.background).toBeUndefined();
        expect(style()).toBeNull();
    });

    it("asks the server anyway, and shows what is true now", async () => {
        const server = fakeServer(stored({ mode: "dark", colors: { primary: "#333333" }, updatedAt: "2026-09-21T10:09:00.000Z" }));
        mount({ initial: stored({ mode: "light" }), lookUp: true });
        await act(async () => undefined);
        expect(server.calls.map((call) => call.method)).toEqual(["GET"]);
        expect(api.prefs).toMatchObject({ mode: "dark", colors: { primary: "#333333" } });
        expect(theme()).toBe("dark");
    });

    it("leaves the screen alone when the server says what it already shows", async () => {
        fakeServer(stored({ mode: "dark" }));
        mount({ initial: stored({ mode: "dark" }), lookUp: true });
        const before = api;
        await act(async () => undefined);
        expect(api.prefs.mode).toBe("dark");
        expect(before.prefs).toBe(api.prefs);
    });
});

describe("without the page's copy", () => {
    it("leaves what the boot script applied until the server answers, then applies the server's answer", async () => {
        const cachedPrefs = stored({ mode: "dark", colors: { primary: "#111111" } });
        writeAppearanceCache(cachedPrefs, "html{--boot:1}", 1, "u1");
        const boot = document.createElement("style");
        boot.id = APPEARANCE_STYLE_ID;
        boot.textContent = "html{--boot:1}";
        document.head.appendChild(boot);
        const { fetchMock } = fakeServer(stored({ mode: "light", colors: { primary: "#222222" }, updatedAt: "2026-09-21T10:09:00.000Z" }));
        mount({ lookUp: true });
        // Before the answer: the cache's preferences are shown.
        expect(api.prefs.colors).toEqual({ primary: "#111111" });
        await act(async () => undefined);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(api.prefs.colors).toEqual({ primary: "#222222" });
        expect(style()!.textContent).toContain("#222222");
        expect(theme()).toBe("light");
    });

    it("ignores a cache that belongs to someone else", async () => {
        writeAppearanceCache(stored({ colors: { primary: "#111111" } }), "html{}", 1, "someone-else");
        fakeServer();
        mount({ lookUp: true });
        expect(api.prefs.colors).toBeUndefined();
        await act(async () => undefined);
        expect(style()).toBeNull();
    });

    it("uses a cache with no owner, and keeps it when the server can't answer", async () => {
        writeAppearanceCache(stored({ colors: { primary: "#111111" } }), "html{}", 1);
        mockFetch(async () => jsonResponse(500, { message: "down" }));
        mount({ lookUp: true });
        await act(async () => undefined);
        expect(api.prefs.colors).toEqual({ primary: "#111111" });
    });

    it("keeps the cache when the server can't be reached, and shows the defaults for a user with none", async () => {
        writeAppearanceCache(stored({ colors: { primary: "#111111" } }), "html{}", 1, "u1");
        mockFetch(async () => {
            throw new TypeError("offline");
        });
        const first = mount({ lookUp: true });
        await act(async () => undefined);
        expect(api.prefs.colors).toEqual({ primary: "#111111" });
        first.unmount();

        fakeServer();
        mount({ lookUp: true });
        await act(async () => undefined);
        expect(api.prefs).toMatchObject({ version: 1, mode: "system" });
        expect(api.isDefault).toBe(true);
        expect(style()).toBeNull();
        expect(cached()).toMatchObject({ css: "", mode: "system", t: 0 });
    });

    it("does not ask when told not to (the admin and escrow consoles), or with no user", async () => {
        writeAppearanceCache(stored({ colors: { primary: "#111111" } }), "html{}", 1, "u1");
        const { fetchMock } = fakeServer();
        mount({ lookUp: false });
        await act(async () => undefined);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(api.prefs.colors).toEqual({ primary: "#111111" });
        mount({ userUid: undefined, lookUp: true });
        await act(async () => undefined);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not let a late answer undo a change made meanwhile", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let answer!: (response: Response) => void;
        mockFetch((_url, init) => {
            if ((init.method ?? "GET") === "GET") {
                return new Promise<Response>((resolve) => (answer = resolve));
            }
            return Promise.resolve(jsonResponse(200, { ...JSON.parse(init.body as string), updatedAt: "2026-09-21T10:00:05.000Z" }));
        });
        mount({ lookUp: true });
        act(() => api.setPrefs({ mode: "dark" }));
        await act(async () => answer(jsonResponse(200, stored({ mode: "light" }))));
        expect(api.prefs.mode).toBe("dark");
    });
});

describe("changing preferences", () => {
    it("applies the change at once and saves after a quiet moment: one request, only what changed", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const server = fakeServer(stored());
        mount({ initial: stored() });
        act(() => api.setPrefs({ colors: { primary: "#1e3a8a" } }));
        expect(style()!.textContent).toContain("#1e3a8a");
        expect(api.saving).toBe(true);
        act(() => api.setPrefs({ colors: { primary: "#1e3a8b" } }));
        act(() => api.setPrefs({ mode: "dark" }));
        expect(theme()).toBe("dark");
        expect(server.puts()).toHaveLength(0);
        await flushTimers();
        expect(server.puts()).toHaveLength(1);
        expect(server.puts()[0].body).toEqual({ version: 1, mode: "dark", colors: { primary: "#1e3a8b" } });
        expect(api.saving).toBe(false);
        expect(api.error).toBeNull();
        // The server's timestamp is adopted; the values are the ones sent.
        expect(api.prefs).toMatchObject({ mode: "dark", colors: { primary: "#1e3a8b" } });
        expect(api.prefs.updatedAt).toBe(server.current().updatedAt);
    });

    it("clears a colour with null, and sends nothing when the change puts things back as the server has them", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const server = fakeServer(stored({ colors: { primary: "#111111", accent: "#222222" } }));
        mount({ initial: stored({ colors: { primary: "#111111", accent: "#222222" } }) });
        act(() => api.setPrefs({ colors: { accent: null } }));
        await flushTimers();
        expect(server.puts()[0].body).toEqual({ version: 1, colors: { accent: null } });
        act(() => api.setPrefs({ colors: { accent: "#333333" } }));
        act(() => api.setPrefs({ colors: { accent: null } }));
        await flushTimers();
        expect(server.puts()).toHaveLength(1);
    });

    it("sends a change made while a save is in flight as a second save, in order, never two at once", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let release!: () => void;
        let first = true;
        const server = fakeServer(stored(), {
            putDelay: () => {
                if (!first) {
                    return Promise.resolve();
                }
                first = false;
                return new Promise<void>((resolve) => (release = resolve));
            },
        });
        mount({ initial: stored() });
        act(() => api.setPrefs({ mode: "dark" }));
        await flushTimers();
        expect(server.puts()).toHaveLength(1);
        act(() => api.setPrefs({ mode: "light" }));
        await flushTimers();
        expect(server.puts()).toHaveLength(1);
        await act(async () => release());
        await act(async () => undefined);
        expect(server.puts()).toHaveLength(2);
        expect(server.puts()[1].body).toEqual({ version: 1, mode: "light" });
        await act(async () => undefined);
        expect(api.saving).toBe(false);
        expect(api.prefs.mode).toBe("light");
        expect(server.current().mode).toBe("light");
    });

    it("puts the server's copy back and says why when a save fails, and clears the message on request", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        fakeServer(stored({ colors: { primary: "#111111" } }), { failPut: () => jsonResponse(400, { message: "'colors.primary' must be a colour written as #rrggbb." }) });
        mount({ initial: stored({ colors: { primary: "#111111" } }) });
        act(() => api.setPrefs({ colors: { primary: "#999999" } }));
        expect(style()!.textContent).toContain("#999999");
        await flushTimers();
        expect(api.prefs.colors).toEqual({ primary: "#111111" });
        expect(style()!.textContent).toContain("#111111");
        expect(api.error).toBe("'colors.primary' must be a colour written as #rrggbb.");
        expect(api.saving).toBe(false);
        act(() => api.clearError());
        expect(api.error).toBeNull();
    });

    it("uses its own words for a failure that says nothing", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        mockFetch(async () => {
            throw new TypeError("offline");
        });
        mount({ initial: stored() });
        act(() => api.setPrefs({ mode: "dark" }));
        await flushTimers();
        expect(api.error).toBe("Your appearance could not be saved. It has been put back.");
        expect(api.prefs.mode).toBe("system");
    });

    it("forgets the last error when the next change is made", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        fakeServer(stored(), { failPut: () => jsonResponse(500, { message: "no" }) });
        mount({ initial: stored() });
        act(() => api.setPrefs({ mode: "dark" }));
        await flushTimers();
        expect(api.error).toBe("no");
        act(() => api.setPrefs({ mode: "light" }));
        expect(api.error).toBeNull();
    });

    it("saves a change still waiting when the page is hidden, and when the provider goes away", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const server = fakeServer(stored());
        const { unmount } = mount({ initial: stored() });
        act(() => api.setPrefs({ mode: "dark" }));
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(server.puts()).toHaveLength(0);
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(server.puts()).toHaveLength(1);
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
        act(() => api.setPrefs({ mode: "light" }));
        unmount();
        await act(async () => undefined);
        expect(server.puts()).toHaveLength(2);
    });

    it("stamps the browser's copy with the moment of an unsaved change, newer than the page it came from", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        vi.setSystemTime(new Date("2026-09-21T11:00:00.000Z"));
        fakeServer(stored());
        mount({ initial: stored() });
        act(() => api.setPrefs({ mode: "dark" }));
        expect(cached().t).toBe(Date.parse("2026-09-21T11:00:00.000Z"));
        expect(cached().mode).toBe("dark");
    });
});

describe("the background image", () => {
    function stubBlobUrls() {
        const create = vi.fn(() => "blob:local-preview");
        const revoke = vi.fn();
        Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
        return { create, revoke };
    }

    class LoadingImage {
        static last: LoadingImage | undefined;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = "";
        constructor() {
            LoadingImage.last = this;
        }
    }

    beforeEach(() => {
        LoadingImage.last = undefined;
        vi.stubGlobal("Image", LoadingImage);
    });

    it("shows the picture at once from a local preview, stores it, then swaps to the stored image once that has loaded", async () => {
        const { create, revoke } = stubBlobUrls();
        const server = fakeServer(stored());
        measureImage.mockResolvedValue({ lo: { r: 10, g: 10, b: 10 }, hi: { r: 200, g: 200, b: 200 } });
        mount({ initial: stored() });
        const file = new File(["png"], "photo.png", { type: "image/png" });
        let done!: Promise<void>;
        await act(async () => {
            done = api.uploadBackground(file);
        });
        // In flight: the local preview is what shows.
        expect(create).toHaveBeenCalledWith(file);
        expect(style()!.textContent).toContain('url("blob:local-preview")');
        await act(async () => done);
        expect(server.calls.find((call) => call.method === "POST")).toBeDefined();
        const version = server.current().background.imageVersion;
        expect(api.prefs.background).toMatchObject({ kind: "image", imageVersion: version });
        // The stored image is loading; the preview stays until it is there.
        expect(LoadingImage.last!.src).toBe(`/api/mail/preferences/appearance/background/${version}`);
        expect(style()!.textContent).toContain('url("blob:local-preview")');
        expect(api.backgroundUrl).toBe("blob:local-preview");
        await act(async () => LoadingImage.last!.onload!());
        expect(revoke).toHaveBeenCalledWith("blob:local-preview");
        expect(api.backgroundUrl).toBe(`/api/mail/preferences/appearance/background/${version}`);
        expect(style()!.textContent).toContain(`url("/api/mail/preferences/appearance/background/${version}")`);
        // The measured lightness of the preview carried over to the stored image, and is cached for the next load.
        expect(api.measured).toEqual({ lo: { r: 10, g: 10, b: 10 }, hi: { r: 200, g: 200, b: 200 } });
        expect(measureImage).toHaveBeenCalledTimes(1);
        expect(cached().measured).toEqual({ version, levels: [10, 200] });
    });

    it("also swaps when the stored image fails to load", async () => {
        const { revoke } = stubBlobUrls();
        fakeServer(stored());
        mount({ initial: stored() });
        await act(async () => api.uploadBackground(new Blob(["x"], { type: "image/png" })));
        await act(async () => LoadingImage.last!.onerror!());
        expect(revoke).toHaveBeenCalledWith("blob:local-preview");
    });

    it("rolls back and says so when the upload fails", async () => {
        const { revoke } = stubBlobUrls();
        fakeServer(stored(), { failPost: jsonResponse(413, { message: "That image is too large." }) });
        mount({ initial: stored() });
        await act(async () => api.uploadBackground(new Blob(["x"], { type: "image/png" })));
        expect(api.prefs.background).toBeUndefined();
        expect(api.error).toBe("That image is too large.");
        expect(api.backgroundUrl).toBeUndefined();
        expect(revoke).toHaveBeenCalledWith("blob:local-preview");
        expect(style()).toBeNull();
    });

    it("uses its own words when the upload fails without a message, and when the server keeps no image", async () => {
        stubBlobUrls();
        mockFetch(async () => {
            throw new TypeError("offline");
        });
        mount({ initial: stored() });
        await act(async () => api.uploadBackground(new Blob(["x"], { type: "image/png" })));
        expect(api.error).toBe("That image could not be uploaded.");
        mockFetch(async () => jsonResponse(200, stored()));
        await act(async () => api.uploadBackground(new Blob(["x"], { type: "image/png" })));
        expect(api.error).toBe("The server did not keep the image.");
    });

    it("saves the values the server doesn't have when a slider moved while the image uploaded - never naming the image or the kind early", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        stubBlobUrls();
        let release!: () => void;
        let uploading = true;
        const server = fakeServer(stored(), {
            putDelay: async () => undefined,
        });
        const realPost = server.fetchMock.getMockImplementation() as (url: string, init: RequestInit) => Promise<Response>;
        server.fetchMock.mockImplementation((url: string, init: RequestInit) => {
            if (uploading && url.endsWith("/background") && init.method === "POST") {
                return new Promise<Response>((resolve) => {
                    release = () => {
                        uploading = false;
                        resolve(realPost(url, init));
                    };
                });
            }
            return realPost(url, init);
        });
        mount({ initial: stored() });
        let done!: Promise<void>;
        await act(async () => {
            done = api.uploadBackground(new Blob(["x"], { type: "image/png" }));
        });
        act(() => api.setPrefs({ background: { blur: 9 } }));
        await flushTimers();
        // The save that fired during the upload names neither the kind nor the image (the server would refuse both).
        expect(server.puts().map((call) => call.body)).toEqual([{ version: 1, background: { blur: 9, dim: 0.2 } }]);
        await act(async () => release());
        await act(async () => done);
        await flushTimers();
        expect(server.current().background).toMatchObject({ kind: "image", blur: 9 });
        expect(api.error).toBeNull();
    });

    it("stores a picture chosen straight after another change first, so the older save can't land after it", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        stubBlobUrls();
        const server = fakeServer(stored());
        mount({ initial: stored() });
        act(() => api.setPrefs({ mode: "dark" }));
        await act(async () => {
            void api.uploadBackground(new Blob(["x"], { type: "image/png" }));
            await vi.advanceTimersByTimeAsync(10);
        });
        expect(server.calls.slice(0, 2).map((call) => `${call.method} ${call.url.replace("/api/mail/preferences/appearance", "")}`)).toEqual([
            "PUT ",
            "POST /background",
        ]);
    });

    it("measures a stored image once, when it is first shown, and only for an image", async () => {
        measureImage.mockResolvedValue({ lo: { r: 30, g: 30, b: 30 }, hi: { r: 220, g: 220, b: 220 } });
        mount({ initial: stored({ background: image({ imageVersion: "v3" }) }) });
        await act(async () => undefined);
        expect(measureImage).toHaveBeenCalledWith("/api/mail/preferences/appearance/background/v3");
        expect(api.measured).toEqual({ lo: { r: 30, g: 30, b: 30 }, hi: { r: 220, g: 220, b: 220 } });
        expect(style()!.textContent).toMatch(/--rr-panel-alpha:0\.[56]\d? !important/);
        measureImage.mockClear();
        mount({ initial: stored({ background: { kind: "color", color: "#334455", dim: 0, blur: 0, fit: "cover" } }) });
        await act(async () => undefined);
        expect(measureImage).not.toHaveBeenCalled();
    });

    it("keeps assuming the worst when measuring isn't possible", async () => {
        measureImage.mockResolvedValue(undefined);
        mount({ initial: stored({ background: image({ imageVersion: "v4" }) }) });
        await act(async () => undefined);
        expect(api.measured).toBeUndefined();
    });

    it("starts from the measurement the cache holds, so the first stylesheet already has its panel opacity", async () => {
        writeAppearanceCache(stored({ background: image({ imageVersion: "v5" }) }), "html{}", 1, "u1", {
            version: "v5",
            range: { lo: { r: 40, g: 40, b: 40 }, hi: { r: 210, g: 210, b: 210 } },
        });
        mount({ initial: stored({ background: image({ imageVersion: "v5" }) }) });
        expect(api.measured).toEqual({ lo: { r: 40, g: 40, b: 40 }, hi: { r: 210, g: 210, b: 210 } });
        expect(measureImage).not.toHaveBeenCalled();
    });

    it("ignores a cached measurement of another image", async () => {
        writeAppearanceCache(stored({ background: image({ imageVersion: "old" }) }), "html{}", 1, "u1", {
            version: "old",
            range: { lo: { r: 40, g: 40, b: 40 }, hi: { r: 210, g: 210, b: 210 } },
        });
        mount({ initial: stored({ background: image({ imageVersion: "new" }) }) });
        expect(api.measured).toBeUndefined();
    });

    it("removes the image: the page changes at once and the server deletes it", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const server = fakeServer(stored({ background: image() }));
        mount({ initial: stored({ background: image() }) });
        await act(async () => {
            void api.removeBackground();
        });
        expect(api.prefs.background).toMatchObject({ kind: "none" });
        expect(api.prefs.background).not.toHaveProperty("imageVersion");
        expect(style()).toBeNull();
        await flushTimers();
        expect(server.calls.map((call) => call.method)).toContain("DELETE");
        // The delete already left the server with no image and kind none: nothing more to say.
        expect(server.puts()).toHaveLength(0);
        expect(api.error).toBeNull();
    });

    it("also saves what else differs after the removal (a slider moved before it)", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const server = fakeServer(stored({ background: image() }));
        mount({ initial: stored({ background: image() }) });
        act(() => api.setPrefs({ background: { blur: 7 } }));
        await act(async () => {
            void api.removeBackground();
        });
        await flushTimers();
        expect(server.current().background).toMatchObject({ kind: "none", blur: 7 });
    });

    it("puts the image back and says so when it can't be removed", async () => {
        fakeServer(stored({ background: image() }), { failDelete: jsonResponse(500, { message: "not now" }) });
        mount({ initial: stored({ background: image() }) });
        await act(async () => api.removeBackground());
        expect(api.prefs.background).toMatchObject({ kind: "image", imageVersion: "v1" });
        expect(api.error).toBe("not now");
    });

    it("says something for a removal that fails without a message", async () => {
        mockFetch(async () => {
            throw new TypeError("offline");
        });
        mount({ initial: stored({ background: image() }) });
        await act(async () => api.removeBackground());
        expect(api.error).toBe("The background could not be removed.");
    });

    it("releases a preview it still holds when the provider goes away", async () => {
        const { revoke } = stubBlobUrls();
        mockFetch(() => new Promise<Response>(() => undefined));
        const { unmount } = mount({ initial: stored() });
        await act(async () => {
            void api.uploadBackground(new Blob(["x"], { type: "image/png" }));
        });
        unmount();
        expect(revoke).toHaveBeenCalledWith("blob:local-preview");
    });
});

describe("resetting", () => {
    it("goes back to the defaults at once, removes a stored image, and clears what else was set", async () => {
        const start = stored({ mode: "dark", colors: { primary: "#111111" }, background: image() });
        const server = fakeServer(start);
        mount({ initial: start });
        await act(async () => {
            void api.reset();
        });
        expect(api.prefs).toEqual({ version: 1, mode: "system" });
        expect(style()).toBeNull();
        expect(theme()).toBe("light");
        await act(async () => undefined);
        expect(server.calls.map((call) => call.method)).toEqual(["DELETE", "PUT"]);
        expect(server.calls[1].body).toEqual({ version: 1, mode: "system", colors: null });
        expect(server.current()).toMatchObject({ mode: "system", background: { kind: "none" } });
        expect(server.current().colors).toBeUndefined();
        // Remembered as "nothing chosen" (an empty stylesheet), newer than the page that still shows the background.
        expect(cached()).toMatchObject({ css: "", mode: "system" });
    });

    it("does not delete an image there isn't, and sends nothing when the server already has the defaults", async () => {
        const server = fakeServer(stored({ mode: "dark" }));
        mount({ initial: stored({ mode: "dark" }) });
        await act(async () => api.reset());
        expect(server.calls.map((call) => call.method)).toEqual(["PUT"]);
        await act(async () => api.reset());
        expect(server.calls.map((call) => call.method)).toEqual(["PUT"]);
    });

    it("drops a change still waiting to be saved", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const server = fakeServer(stored({ mode: "dark" }));
        mount({ initial: stored({ mode: "dark" }) });
        act(() => api.setPrefs({ mode: "light" }));
        await act(async () => {
            void api.reset();
        });
        await flushTimers();
        expect(server.puts().map((call) => call.body.mode)).toEqual(["system"]);
    });

    it("puts everything back and says so when it fails", async () => {
        fakeServer(stored({ mode: "dark" }), { failPut: () => jsonResponse(500, { message: "nope" }) });
        mount({ initial: stored({ mode: "dark" }) });
        await act(async () => api.reset());
        expect(api.prefs.mode).toBe("dark");
        expect(api.error).toBe("nope");
    });

    it("says something for a failure without a message", async () => {
        mockFetch(async () => {
            throw new TypeError("offline");
        });
        mount({ initial: stored({ mode: "dark" }) });
        await act(async () => api.reset());
        expect(api.error).toBe("Your appearance could not be reset.");
    });
});

describe("live updates from another tab or device", () => {
    function push(type: string, action: string, data?: unknown) {
        const client = getPushClient() as unknown as { eventListeners: Set<(event: unknown) => void> };
        act(() => client.eventListeners.forEach((listener) => listener({ type, action, data })));
    }

    it("applies preferences another client changed", () => {
        mount({ initial: stored({ mode: "light" }) });
        push("AppearancePreferencesMongo", "update", stored({ mode: "dark", colors: { primary: "#222222" }, updatedAt: "2026-09-21T10:07:00.000Z" }));
        expect(api.prefs).toMatchObject({ mode: "dark", colors: { primary: "#222222" } });
        expect(theme()).toBe("dark");
        expect(style()!.textContent).toContain("#222222");
    });

    it("goes back to the defaults when they were deleted", () => {
        mount({ initial: stored({ mode: "dark" }) });
        push("AppearancePreferencesSQL", "delete");
        expect(api.prefs).toEqual({ version: 1, mode: "system" });
    });

    it("ignores other events, its own echo and anything that says the same as the screen", () => {
        mount({ initial: stored({ mode: "dark" }) });
        push("MessageMongo", "update", { uid: "m1" });
        push("AppearancePreferencesMongo", "touch", stored({ mode: "light" }));
        push("AppearancePreferencesMongo", "update", { nonsense: true });
        push("AppearancePreferencesMongo", "update", stored({ mode: "dark", updatedAt: "2026-09-21T10:59:00.000Z" }));
        expect(api.prefs.mode).toBe("dark");
        expect(api.prefs.updatedAt).toBe("2026-09-21T10:00:00.000Z");
    });

    it("does not undo a change this tab is still sending", () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        mount({ initial: stored({ mode: "dark" }) });
        act(() => api.setPrefs({ mode: "light" }));
        push("AppearancePreferencesMongo", "update", stored({ mode: "system", updatedAt: "2026-09-21T10:08:00.000Z" }));
        expect(api.prefs.mode).toBe("light");
    });

    it("does not listen without a user", () => {
        mount({ initial: stored({ mode: "dark" }), userUid: undefined });
        push("AppearancePreferencesMongo", "update", stored({ mode: "light", updatedAt: "2026-09-21T10:08:00.000Z" }));
        expect(api.prefs.mode).toBe("dark");
    });

    it("stops listening when unmounted", () => {
        const { unmount } = mount({ initial: stored({ mode: "dark" }) });
        unmount();
        const client = getPushClient() as unknown as { eventListeners: Set<unknown> };
        expect(client.eventListeners.size).toBe(0);
    });
});

describe("the corners of uploading, removing and resetting", () => {
    class Preloads {
        static all: Preloads[] = [];
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = "";
        constructor() {
            Preloads.all.push(this);
        }
    }

    beforeEach(() => {
        Preloads.all = [];
        vi.stubGlobal("Image", Preloads);
    });

    it("carries on from the defaults when a change that was waiting fails and takes the preferences back to nothing", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        let failed = false;
        const server = fakeServer(undefined, {
            failPut: () => {
                failed = true;
                return jsonResponse(500, { message: "no" });
            },
        });
        Object.assign(URL, { createObjectURL: () => "blob:one", revokeObjectURL: vi.fn() });
        mount({ lookUp: false });
        act(() => api.setPrefs({ mode: "dark" }));
        await act(async () => {
            void api.uploadBackground(new Blob(["x"], { type: "image/png" }));
            await vi.advanceTimersByTimeAsync(10);
        });
        expect(failed).toBe(true);
        // The failed save put things back to "nothing" (no server copy at all), and the upload still stored its picture.
        expect(server.calls.some((call) => call.method === "POST")).toBe(true);
        expect(api.prefs.background).toMatchObject({ kind: "image" });
        expect(api.prefs.mode).toBe("system");
    });

    it("leaves a newer preview alone when an older picture finishes loading", async () => {
        const revoke = vi.fn();
        let n = 0;
        Object.assign(URL, { createObjectURL: () => `blob:${++n}`, revokeObjectURL: revoke });
        fakeServer(stored());
        mount({ initial: stored() });
        await act(async () => api.uploadBackground(new Blob(["one"], { type: "image/png" })));
        const first = Preloads.all[0];
        await act(async () => api.uploadBackground(new Blob(["two"], { type: "image/png" })));
        revoke.mockClear();
        // The first stored image loads late: the preview on screen is the second's, and stays.
        await act(async () => first.onload!());
        expect(revoke).not.toHaveBeenCalledWith("blob:2");
        expect(api.backgroundUrl).toBe("blob:2");
    });

    it("keeps what it has when the server answers a delete with nothing", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const start = stored({ background: image() });
        const server = fakeServer(start);
        server.fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
            server.calls.push({ method: init.method ?? "GET", url });
            return init.method === "DELETE" ? new Response(null, { status: 204 }) : jsonResponse(200, { version: 1, mode: "system", background: { kind: "none", dim: 0.2, blur: 0, fit: "cover" }, updatedAt: "2026-09-21T10:30:00.000Z" });
        });
        mount({ initial: start });
        await act(async () => {
            void api.removeBackground();
        });
        await flushTimers();
        expect(api.error).toBeNull();
        expect(api.prefs.background).toMatchObject({ kind: "none" });
        // ... and the same for a reset.
        await act(async () => {
            void api.reset();
        });
        await flushTimers();
        expect(api.error).toBeNull();
        expect(api.prefs).toEqual({ version: 1, mode: "system" });
    });

    it("resets an image the server still has when that answer is empty too", async () => {
        const start = stored({ mode: "dark", background: image() });
        const server = fakeServer(start);
        server.fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
            server.calls.push({ method: init.method ?? "GET", url });
            return init.method === "DELETE" ? new Response(null, { status: 204 }) : jsonResponse(200, { version: 1, mode: "system", updatedAt: "2026-09-21T10:30:00.000Z" });
        });
        mount({ initial: start });
        await act(async () => api.reset());
        expect(server.calls.map((call) => call.method)).toEqual(["DELETE", "PUT"]);
        expect(api.error).toBeNull();
    });
});

describe("removing a background nobody has set", () => {
    it("starts from the defaults when the preferences are not known at all", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const server = fakeServer();
        mount({ lookUp: false });
        expect(api.prefs).toEqual({ version: 1, mode: "system" });
        await act(async () => {
            void api.removeBackground();
        });
        await flushTimers();
        expect(server.calls.map((call) => call.method)).toContain("DELETE");
        expect(api.prefs.background).toMatchObject({ kind: "none" });
        expect(api.error).toBeNull();
    });
});
