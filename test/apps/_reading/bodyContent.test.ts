// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureApiBaseUrl } from "@rapidmx/react-shared/util/api.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    ACCEPT,
    MAX_INLINE_IMAGE_BYTES,
    absoluteAttachmentUrl,
    attachmentSource,
    cachedBodyContent,
    clearBodyContentCache,
    fetchBodyContent,
    makeCidResolver,
} from "../../../apps/shared/components/mail/reading/bodyContent.js";

afterEach(() => {
    clearBodyContentCache();
    configureApiBaseUrl("");
    vi.unstubAllGlobals();
});

describe("fetchBodyContent", () => {
    it("asks for the sanitized content with the reader's credentials, and reads HTML as HTML", async () => {
        const fetchMock = mockFetch(() => new Response("<p>x</p>", { headers: { "content-type": "text/html; charset=utf-8" } }));
        const signal = new AbortController().signal;
        await expect(fetchBodyContent("m 1", 3, signal)).resolves.toEqual({ kind: "html", html: "<p>x</p>" });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m%201/content", { credentials: "include", headers: { Accept: ACCEPT }, signal });
    });

    it("reads anything else - the server's plain-text fallback, or no type at all - as text", async () => {
        mockFetch(() => new Response("hello", { headers: { "content-type": "text/plain" } }));
        await expect(fetchBodyContent("m1", 1)).resolves.toEqual({ kind: "text", text: "hello" });
        // A body with no Content-Type header at all.
        mockFetch(() => new Response(new Uint8Array([104, 105])));
        await expect(fetchBodyContent("m2", 1)).resolves.toEqual({ kind: "text", text: "hi" });
    });

    it("remembers a body per uid and version, and forgets it on request", async () => {
        const fetchMock = mockFetch(() => new Response("<p>x</p>", { headers: { "content-type": "text/html" } }));
        await fetchBodyContent("m1", 1);
        await fetchBodyContent("m1", 1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(cachedBodyContent("m1", 1)).toEqual({ kind: "html", html: "<p>x</p>" });
        expect(cachedBodyContent("m1", 2)).toBeUndefined();
        await fetchBodyContent("m1", 2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        clearBodyContentCache();
        expect(cachedBodyContent("m1", 1)).toBeUndefined();
    });

    it("keeps at most forty bodies, dropping the oldest", async () => {
        const fetchMock = mockFetch(() => new Response("x", { headers: { "content-type": "text/plain" } }));
        for (let i = 0; i < 41; i++) await fetchBodyContent(`m${i}`, 1);
        expect(cachedBodyContent("m0", 1)).toBeUndefined();
        expect(cachedBodyContent("m1", 1)).toBeDefined();
        expect(cachedBodyContent("m40", 1)).toBeDefined();
        expect(fetchMock).toHaveBeenCalledTimes(41);
    });

    it("does not remember a failure", async () => {
        const fetchMock = mockFetch(() => jsonResponse(500, { message: "down" }));
        await expect(fetchBodyContent("m1", 1)).rejects.toMatchObject({ message: "down", status: 500 });
        await expect(fetchBodyContent("m1", 1)).rejects.toBeDefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("explains a failure with the server's message, else its error field, else the status text, else a generic line", async () => {
        mockFetch(() => jsonResponse(404, { message: "gone", code: "api-404" }));
        await expect(fetchBodyContent("m1", 1)).rejects.toMatchObject({ message: "gone", status: 404, code: "api-404" });
        mockFetch(() => jsonResponse(400, { error: "bad" }));
        await expect(fetchBodyContent("m1", 1)).rejects.toMatchObject({ message: "bad" });
        mockFetch(() => new Response("x", { status: 502, statusText: "Bad Gateway" }));
        await expect(fetchBodyContent("m1", 1)).rejects.toMatchObject({ message: "Bad Gateway", status: 502 });
        mockFetch(() => new Response(null, { status: 503, statusText: "Unavailable" }));
        await expect(fetchBodyContent("m1", 1)).rejects.toMatchObject({ message: "Unavailable", status: 503 });
        mockFetch(() => new Response("{not json", { status: 500, statusText: "", headers: { "content-type": "application/json" } }));
        await expect(fetchBodyContent("m1", 1)).rejects.toMatchObject({ message: "Could not load this message." });
    });
});

describe("attachment URLs", () => {
    it("are absolute - the frame is a document of its own - and follow a configured API origin", () => {
        expect(absoluteAttachmentUrl("a 1")).toBe(`${window.location.origin}/api/mail/attachments/a%201/content`);
        expect(attachmentSource()).toBe(`${window.location.origin}/api/mail/attachments/`);
        configureApiBaseUrl("https://mail.example.com/");
        expect(absoluteAttachmentUrl("a1")).toBe("https://mail.example.com/api/mail/attachments/a1/content");
        expect(attachmentSource()).toBe("https://mail.example.com/api/mail/attachments/");
    });
});

describe("makeCidResolver", () => {
    const attachments = [
        { uid: "a1", contentId: "logo@x", filename: "logo.png" },
        { uid: "a2", filename: "notes.pdf" },
    ] as never;

    it("resolves a server message's inline image to the attachment whose Content-ID it names", () => {
        const resolve = makeCidResolver(attachments, undefined);
        expect(resolve("logo@x")).toBe(`${window.location.origin}/api/mail/attachments/a1/content`);
        expect(resolve("other@x")).toBeUndefined();
        expect(makeCidResolver(undefined, undefined)("logo@x")).toBeUndefined();
    });

    it("resolves a decrypted message's inline image from the part inside it, as an embedded image", () => {
        const part = (contentType: string, decode: () => Uint8Array | undefined, contentId = "logo@x") => ({ contentType, disposition: "inline", contentId, decode });
        const png = part("image/png", () => new Uint8Array([137, 80, 78, 71]));
        expect(makeCidResolver(undefined, [png as never])("logo@x")).toBe("data:image/png;base64,iVBORw==");
        expect(makeCidResolver(undefined, [png as never])("other@x")).toBeUndefined();
        // Not an image type, invalid content, or too big: nothing to show.
        expect(makeCidResolver(undefined, [part("text/html", () => new Uint8Array([1])) as never])("logo@x")).toBeUndefined();
        expect(makeCidResolver(undefined, [part("image/png", () => undefined) as never])("logo@x")).toBeUndefined();
        expect(makeCidResolver(undefined, [part("image/png", () => new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1)) as never])("logo@x")).toBeUndefined();
        // A big one is encoded in slices, byte for byte.
        const big = new Uint8Array(70_000).map((_, i) => i % 251);
        const uri = makeCidResolver(undefined, [part("image/jpeg", () => big) as never])("logo@x")!;
        expect(uri.startsWith("data:image/jpeg;base64,")).toBe(true);
        expect(Uint8Array.from(atob(uri.split(",")[1]), (c) => c.charCodeAt(0))).toEqual(big);
    });

    it("looks only inside the decrypted content for a decrypted message, never at the server's attachments", () => {
        expect(makeCidResolver(attachments, [])("logo@x")).toBeUndefined();
    });
});
