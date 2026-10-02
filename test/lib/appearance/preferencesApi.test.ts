// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import {
    BACKGROUND_MAX_BYTES,
    appearanceBackgroundUrl,
    deleteAppearanceBackground,
    diffAppearance,
    getAppearance,
    isDefaultAppearance,
    normalizeAppearance,
    parseAppearanceEvent,
    saveAppearance,
    uploadAppearanceBackground,
    validateBackgroundFile,
} from "../../../lib/appearance/preferencesApi.js";
import { configureApiBaseUrl, createApiClient } from "../../../lib/util/api.js";

afterEach(() => {
    vi.unstubAllGlobals();
    configureApiBaseUrl("");
});

const stored = {
    version: 1,
    mode: "dark",
    colors: { primary: "#112233" },
    background: { kind: "image", imageVersion: "abc123", dim: 0.3, blur: 4, fit: "tile" },
    updatedAt: "2026-09-21T10:00:00.000Z",
};

describe("normalizeAppearance", () => {
    it("keeps a well-formed object as it is", () => {
        expect(normalizeAppearance(stored)).toEqual(stored);
    });

    it("rejects anything that is not version 1 preferences", () => {
        expect(normalizeAppearance(undefined)).toBeUndefined();
        expect(normalizeAppearance(null)).toBeUndefined();
        expect(normalizeAppearance("dark")).toBeUndefined();
        expect(normalizeAppearance([])).toBeUndefined();
        expect(normalizeAppearance({ mode: "dark" })).toBeUndefined();
        expect(normalizeAppearance({ version: 2, mode: "dark" })).toBeUndefined();
    });

    it("defaults an unknown mode to system and drops unknown keys", () => {
        expect(normalizeAppearance({ version: 1, mode: "purple", extra: 1 })).toEqual({ version: 1, mode: "system" });
    });

    it("keeps only well-formed colours, lower-cased, and drops an empty colour set", () => {
        expect(
            normalizeAppearance({
                version: 1,
                mode: "light",
                colors: { primary: "#AABBCC", accent: "red", surface: "#fff", text: 12, other: "#000000" },
            }),
        ).toEqual({ version: 1, mode: "light", colors: { primary: "#aabbcc" } });
        expect(normalizeAppearance({ version: 1, mode: "light", colors: { accent: "url(x)" } })).toEqual({ version: 1, mode: "light" });
        expect(normalizeAppearance({ version: 1, mode: "light", colors: "red" })).toEqual({ version: 1, mode: "light" });
    });

    it("clamps dim and blur and defaults a missing or non-numeric one", () => {
        const background = (raw: unknown) =>
            normalizeAppearance({ version: 1, mode: "system", background: { kind: "color", color: "#101010", ...(raw as object) } })!.background;
        expect(background({ dim: 5, blur: 99 })).toMatchObject({ dim: 0.8, blur: 20 });
        expect(background({ dim: -1, blur: -3 })).toMatchObject({ dim: 0, blur: 0 });
        expect(background({ dim: "0.5", blur: NaN, fit: "stretch" })).toMatchObject({ dim: 0.2, blur: 0, fit: "cover" });
    });

    it("downgrades a kind that has nothing to show to none", () => {
        expect(normalizeAppearance({ version: 1, mode: "system", background: { kind: "image" } })!.background!.kind).toBe("none");
        expect(normalizeAppearance({ version: 1, mode: "system", background: { kind: "color", color: "bad" } })!.background!.kind).toBe("none");
        expect(normalizeAppearance({ version: 1, mode: "system", background: { kind: "sparkles" } })!.background!.kind).toBe("none");
        expect(normalizeAppearance({ version: 1, mode: "system", background: "x" })).toEqual({ version: 1, mode: "system" });
    });

    it("accepts a numeric or safe string image version and refuses anything that would need escaping", () => {
        const version = (imageVersion: unknown) =>
            normalizeAppearance({ version: 1, mode: "system", background: { kind: "image", imageVersion } })!.background!;
        expect(version(7)).toMatchObject({ kind: "image", imageVersion: 7 });
        expect(version("v-1.2_3")).toMatchObject({ kind: "image", imageVersion: "v-1.2_3" });
        expect(version("../../etc/passwd").kind).toBe("none");
        expect(version("a b").kind).toBe("none");
        expect(version(-1).kind).toBe("none");
        expect(version(Infinity).kind).toBe("none");
        expect(version("x".repeat(65)).kind).toBe("none");
    });

    it("keeps the colour behind an image, drops a retired invertDarkMessages key and ignores a bad timestamp", () => {
        const result = normalizeAppearance({
            version: 1,
            mode: "system",
            background: { kind: "image", imageVersion: "1", color: "#010203" },
            invertDarkMessages: true,
            updatedAt: { at: 1 },
        })!;
        expect(result.background).toMatchObject({ color: "#010203" });
        expect(result).not.toHaveProperty("invertDarkMessages");
        expect(result.updatedAt).toBeUndefined();
        expect(normalizeAppearance({ version: 1, mode: "system", updatedAt: 1234 })!.updatedAt).toBe(1234);
        expect(normalizeAppearance({ version: 1, mode: "system", updatedAt: NaN })!.updatedAt).toBeUndefined();
    });
});

describe("validateBackgroundFile", () => {
    it("accepts the four raster types up to the limit", () => {
        for (const type of ["image/png", "image/jpeg", "image/webp", "image/avif"]) {
            expect(validateBackgroundFile({ type, size: 1000 })).toBeUndefined();
        }
        expect(validateBackgroundFile({ type: "image/png", size: BACKGROUND_MAX_BYTES })).toBeUndefined();
    });

    it("refuses other types, including SVG and GIF", () => {
        expect(validateBackgroundFile({ type: "image/svg+xml", size: 10 })).toMatch(/PNG, JPEG, WebP or AVIF/);
        expect(validateBackgroundFile({ type: "image/gif", size: 10 })).toMatch(/PNG, JPEG, WebP or AVIF/);
        expect(validateBackgroundFile({ type: "", size: 10 })).toMatch(/PNG, JPEG, WebP or AVIF/);
    });

    it("refuses a file over 8 MB, saying how big it is, and an empty one", () => {
        expect(validateBackgroundFile({ type: "image/png", size: BACKGROUND_MAX_BYTES + 1 })).toBe("That image is 8.0 MB; the limit is 8 MB.");
        expect(validateBackgroundFile({ type: "image/png", size: 12.5 * 1024 * 1024 })).toBe("That image is 12.5 MB; the limit is 8 MB.");
        expect(validateBackgroundFile({ type: "image/png", size: 0 })).toBe("That file is empty.");
    });
});

describe("isDefaultAppearance", () => {
    it("is true for nothing chosen and false for any choice", () => {
        expect(isDefaultAppearance(undefined)).toBe(true);
        expect(isDefaultAppearance({ version: 1, mode: "system" })).toBe(true);
        expect(isDefaultAppearance({ version: 1, mode: "system", background: { kind: "none", dim: 0, blur: 0, fit: "cover" } })).toBe(true);
        expect(isDefaultAppearance({ version: 1, mode: "dark" })).toBe(false);
        expect(isDefaultAppearance({ version: 1, mode: "system", colors: { primary: "#000000" } })).toBe(false);
        expect(
            isDefaultAppearance({ version: 1, mode: "system", background: { kind: "color", color: "#000000", dim: 0, blur: 0, fit: "cover" } }),
        ).toBe(false);
    });
});

describe("getAppearance", () => {
    it("reads and normalises the stored preferences", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, stored));
        expect(await getAppearance()).toEqual(stored);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/preferences/appearance", expect.anything());
    });

    it("is undefined for a 404 and for a body that isn't preferences", async () => {
        mockFetch(() => jsonResponse(404, { message: "none" }));
        expect(await getAppearance()).toBeUndefined();
        mockFetch(() => jsonResponse(200, {}));
        expect(await getAppearance()).toBeUndefined();
    });

    it("rethrows any other failure", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        await expect(getAppearance()).rejects.toMatchObject({ status: 500 });
        mockFetch(() => Promise.reject(new TypeError("offline")));
        await expect(getAppearance()).rejects.toThrow("offline");
    });
});

describe("saveAppearance", () => {
    it("PUTs the preferences and returns what the server stored", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, stored));
        const { updatedAt: _ignored, ...input } = stored;
        expect(await saveAppearance(input as never)).toEqual(stored);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/preferences/appearance",
            expect.objectContaining({ method: "PUT", body: JSON.stringify(input) }),
        );
    });

    it("fails when the answer is not preferences", async () => {
        mockFetch(() => jsonResponse(200, { ok: true }));
        await expect(saveAppearance({ version: 1, mode: "dark" })).rejects.toMatchObject({ status: 502 });
    });

    it("throws the server's error", async () => {
        mockFetch(() => jsonResponse(400, { message: "bad colour", code: "api-101" }));
        await expect(saveAppearance({ version: 1, mode: "dark" })).rejects.toMatchObject({ message: "bad colour", status: 400 });
    });
});

describe("uploadAppearanceBackground", () => {
    it("posts the raw bytes with the file's own content type and returns the preferences", async () => {
        const file = new File(["png"], "photo.png", { type: "image/png" });
        const fetchMock = mockFetch(() => jsonResponse(200, stored));
        expect(await uploadAppearanceBackground(file)).toEqual(stored);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/preferences/appearance/background",
            expect.objectContaining({ method: "POST", body: file, credentials: "include" }),
        );
        expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get("Content-Type")).toBe("image/png");
    });

    it("targets the configured API base URL and falls back to octet-stream for an untyped blob", async () => {
        configureApiBaseUrl("https://mail.example.com");
        const fetchMock = mockFetch(() => jsonResponse(200, stored));
        await uploadAppearanceBackground(new Blob(["x"]));
        expect(fetchMock.mock.calls[0][0]).toBe("https://mail.example.com/api/mail/preferences/appearance/background");
        expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get("Content-Type")).toBe("application/octet-stream");
    });

    it("throws the server's message, its error field, its status text, or a default", async () => {
        const file = new File(["x"], "p.png", { type: "image/png" });
        mockFetch(() => jsonResponse(413, { message: "too large", code: "api-101" }));
        await expect(uploadAppearanceBackground(file)).rejects.toMatchObject({ message: "too large", status: 413, code: "api-101" });
        mockFetch(() => jsonResponse(400, { error: "bad type" }));
        await expect(uploadAppearanceBackground(file)).rejects.toMatchObject({ message: "bad type" });
        mockFetch(() => new Response(null, { status: 500, statusText: "Server Error" }));
        await expect(uploadAppearanceBackground(file)).rejects.toMatchObject({ message: "Server Error" });
        mockFetch(() => new Response(null, { status: 500, statusText: "" }));
        await expect(uploadAppearanceBackground(file)).rejects.toMatchObject({ message: "Upload failed." });
    });

    it("treats an unparseable success body as not preferences", async () => {
        const file = new File(["x"], "p.png", { type: "image/png" });
        mockFetch(() => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }));
        await expect(uploadAppearanceBackground(file)).rejects.toMatchObject({ status: 502 });
        mockFetch(() => emptyResponse(200));
        await expect(uploadAppearanceBackground(file)).rejects.toMatchObject({ status: 502 });
    });
});

describe("deleteAppearanceBackground", () => {
    it("DELETEs and returns the preferences the server answers with", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...stored, background: undefined }));
        expect(await deleteAppearanceBackground()).toMatchObject({ mode: "dark" });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/preferences/appearance/background", expect.objectContaining({ method: "DELETE" }));
    });

    it("is undefined for an empty answer", async () => {
        mockFetch(() => emptyResponse(204));
        expect(await deleteAppearanceBackground()).toBeUndefined();
    });
});

describe("appearanceBackgroundUrl", () => {
    it("builds the immutable image URL, escaping the version and honouring the API base URL", () => {
        expect(appearanceBackgroundUrl("abc")).toBe("/api/mail/preferences/appearance/background/abc");
        expect(appearanceBackgroundUrl(12)).toBe("/api/mail/preferences/appearance/background/12");
        expect(appearanceBackgroundUrl("a/b")).toBe("/api/mail/preferences/appearance/background/a%2Fb");
        configureApiBaseUrl("https://mail.example.com");
        expect(appearanceBackgroundUrl("abc")).toBe("https://mail.example.com/api/mail/preferences/appearance/background/abc");
    });
});

describe("parseAppearanceEvent", () => {
    it("reads the preferences from an update or create of the model", () => {
        expect(parseAppearanceEvent({ type: "AppearancePreferencesMongo", action: "update", data: stored })).toEqual(stored);
        expect(parseAppearanceEvent({ type: "AppearancePreferencesSQL", action: "create", data: stored })).toEqual(stored);
    });

    it("is null for a delete, and undefined for other events or data that is not preferences", () => {
        expect(parseAppearanceEvent({ type: "AppearancePreferencesMongo", action: "delete" })).toBeNull();
        expect(parseAppearanceEvent({ type: "MessageMongo", action: "update", data: stored })).toBeUndefined();
        expect(parseAppearanceEvent({ type: "AppearancePreferencesMongo", action: "touch", data: stored })).toBeUndefined();
        expect(parseAppearanceEvent({ type: "AppearancePreferencesMongo", action: "update", data: { nope: 1 } })).toBeUndefined();
        expect(parseAppearanceEvent({ type: "AppearancePreferencesMongo", data: stored })).toBeUndefined();
    });
});

describe("diffAppearance", () => {
    const server = {
        version: 1 as const,
        mode: "dark" as const,
        colors: { primary: "#112233", accent: "#445566" },
        background: { kind: "image" as const, imageVersion: "v1", dim: 0.3, blur: 4, fit: "tile" as const },
        updatedAt: "t1",
    };

    it("is undefined when nothing differs, or when nothing is set and nothing was stored", () => {
        const { updatedAt: _ignored, ...same } = server;
        expect(diffAppearance(server, same)).toBeUndefined();
        expect(diffAppearance(undefined, { version: 1, mode: "system" })).toBeUndefined();
        expect(diffAppearance(undefined, { version: 1, mode: "system", background: { kind: "none", dim: 0, blur: 0, fit: "cover" } })).toBeUndefined();
    });

    it("sends only what changed: the mode, one colour, one number", () => {
        expect(diffAppearance(server, { ...server, mode: "light" })).toEqual({ version: 1, mode: "light" });
        expect(diffAppearance(server, { ...server, colors: { ...server.colors, primary: "#abcdef" } })).toEqual({ version: 1, colors: { primary: "#abcdef" } });
        expect(diffAppearance(server, { ...server, background: { ...server.background, blur: 9 } })).toEqual({ version: 1, background: { blur: 9 } });
        expect(diffAppearance(server, { ...server, background: { ...server.background, dim: 0.5, fit: "cover" } })).toEqual({
            version: 1,
            background: { dim: 0.5, fit: "cover" },
        });
    });

    it("clears a colour that is gone with null, and all of them with colors: null", () => {
        expect(diffAppearance(server, { ...server, colors: { primary: "#112233" } })).toEqual({ version: 1, colors: { accent: null } });
        expect(diffAppearance(server, { version: 1, mode: "dark", background: server.background })).toEqual({ version: 1, colors: null });
    });

    it("sets colours on a user who had none", () => {
        expect(diffAppearance(undefined, { version: 1, mode: "system", colors: { text: "#000000" } })).toEqual({ version: 1, colors: { text: "#000000" } });
    });

    it("turns a background that is gone into kind none, never background: null", () => {
        expect(diffAppearance(server, { version: 1, mode: "dark", colors: server.colors })).toEqual({ version: 1, background: { kind: "none" } });
        const noneAlready = { ...server, background: { ...server.background, kind: "none" as const } };
        expect(diffAppearance(noneAlready, { version: 1, mode: "dark", colors: server.colors })).toBeUndefined();
    });

    it("sends a colour background's kind and colour together, and clears the colour with null", () => {
        const colour = { kind: "color" as const, color: "#336699", dim: 0, blur: 0, fit: "cover" as const };
        expect(diffAppearance(undefined, { version: 1, mode: "system", background: colour })).toEqual({ version: 1, background: { kind: "color", color: "#336699" } });
        expect(diffAppearance({ ...server, background: colour }, { ...server, background: { ...colour, kind: "none", color: undefined } })).toEqual({
            version: 1,
            background: { kind: "none", color: null },
        });
    });

    it("never names the image, and only switches to an image the server holds", () => {
        const kept = { ...server, background: { ...server.background, kind: "none" as const } };
        // Switching back to the image the server kept.
        expect(diffAppearance(kept, { ...server, background: { ...server.background, kind: "image" } })).toEqual({ version: 1, background: { kind: "image" } });
        // A version the server doesn't know (an upload in flight): no kind, no version - only the other fields.
        const uploading = { version: 1 as const, mode: "dark" as const, colors: server.colors, background: { kind: "image" as const, imageVersion: "local", dim: 0.6, blur: 4, fit: "tile" as const } };
        expect(diffAppearance(undefined, { ...uploading, colors: undefined, mode: "system" })).toEqual({ version: 1, background: { dim: 0.6, blur: 4, fit: "tile" } });
        expect(diffAppearance(kept, uploading)).toEqual({ version: 1, background: { dim: 0.6 } });
        // An image kind with no version at all.
        expect(diffAppearance(undefined, { version: 1, mode: "system", background: { kind: "image", dim: 0, blur: 0, fit: "cover" } })).toBeUndefined();
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, stored));

        await getAppearance(client);
        await saveAppearance({ version: 1, mode: "dark" }, client);
        await deleteAppearanceBackground(client);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, stored));
        await getAppearance();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/preferences/appearance", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});

describe("uploadAppearanceBackground with a client", () => {
    it("goes through an explicit client, to that account's origin with its token, when given one", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, stored));
        const client = createApiClient({ baseUrl: "https://a.example.com", getAccessToken: async () => "tok" });
        await uploadAppearanceBackground(new Blob(["x"], { type: "image/png" }), client);
        expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/a\.example\.com\/api\//);
        expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers).get("Authorization")).toBe("jwt tok");
    });
});
