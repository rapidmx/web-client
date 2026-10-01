// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../testUtils.js";
import { buildReplyQuote } from "../../../lib/mail/compose/composeQuoting.js";
import {
    QUOTE_CACHE_MS,
    QUOTE_FETCH_TIMEOUT_MS,
    clearOriginalMessageCache,
    loadOriginalMessage,
    prefetchOriginalMessage,
} from "../../../apps/shared/components/mail/compose/quotedBody.js";

const message = { uid: "m 1", mailboxUid: "mb1", bodyPreview: "Preview" } as never;
const encrypted = { ...(message as object), encrypted: true } as never;

/** A raw message with an address-list To and Cc, one name RFC 2047-encoded and one holding a comma. */
const RAW_TEXT = ["Raw text", ""].join("\r\n");
const RAW = [
    "From: Bob <bob@partner.test>",
    'To: "Diaz, Dave" <dave@partner.test>,',
    " ada@example.com",
    "Cc: =?utf-8?q?Carol_Cruz?= <carol@partner.test>, not-an-address",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Raw text",
    "",
].join("\r\n");

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("loadOriginalMessage", () => {
    it("reads the raw message when the content response names no type at all", async () => {
        const fetchMock = mockFetch((url) =>
            url.endsWith("/raw") ? new Response(RAW) : new Response(null, { status: 200 }),
        );

        expect(await loadOriginalMessage(message, null)).toEqual({ body: { text: RAW_TEXT } });
        // The uid is escaped in both requests.
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/mail/messages/m%201/content", "/api/mail/messages/m%201/raw"]);
    });

    it("resolves nothing when the raw message can't be fetched either", async () => {
        mockFetch((url) => (url.endsWith("/raw") ? new Response("nope", { status: 500 }) : new Response(null, { status: 200 })));

        expect(await loadOriginalMessage(message, null)).toEqual({ body: {} });
    });

    it("recovers the original To and Cc from the raw headers, with their decoded display names", async () => {
        mockFetch(() => new Response(RAW));

        expect(await loadOriginalMessage(message, null, { recipients: true })).toEqual({
            body: { text: RAW_TEXT },
            recipients: [
                { address: "dave@partner.test", displayName: "Diaz, Dave", type: "to" },
                { address: "ada@example.com", type: "to" },
                { address: "carol@partner.test", displayName: "Carol Cruz", type: "cc" },
            ],
        });
    });

    it("fetches the raw message for the recipients even when the body came from the server", async () => {
        const fetchMock = mockFetch((url) =>
            url.endsWith("/raw") ? new Response(RAW) : new Response("<p>Body</p>", { headers: { "content-type": "text/html" } }),
        );

        const original = await loadOriginalMessage(message, null, { recipients: true });
        expect(original.body).toEqual({ html: "<p>Body</p>" });
        expect(original.recipients?.map((r) => r.address)).toEqual(["dave@partner.test", "ada@example.com", "carol@partner.test"]);
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/mail/messages/m%201/content", "/api/mail/messages/m%201/raw"]);
    });

    it("doesn't fetch the raw message when the recipients weren't asked for", async () => {
        const fetchMock = mockFetch(() => new Response("<p>Body</p>", { headers: { "content-type": "text/html" } }));

        expect(await loadOriginalMessage(message, null)).toEqual({ body: { html: "<p>Body</p>" } });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("leaves the recipients undefined when the raw headers name none", async () => {
        mockFetch(() => new Response("Subject: Hi\r\n\r\nRaw text\r\n"));

        expect(await loadOriginalMessage(message, null, { recipients: true })).toEqual({ body: { text: RAW_TEXT } });
    });

    it("prefers a verified message's protected headers, without fetching anything", async () => {
        const fetchMock = mockFetch(() => new Response("never", { status: 500 }));
        const security = {
            state: "signed_verified",
            html: "<p>Signed</p>",
            protectedHeaders: { from: "bob@partner.test", to: "Dave <dave@partner.test>", cc: "carol@partner.test", subject: "Hi" },
        } as never;

        expect(await loadOriginalMessage(message, security, { recipients: true })).toEqual({
            body: { html: "<p>Signed</p>" },
            recipients: [
                { address: "dave@partner.test", displayName: "Dave", type: "to" },
                { address: "carol@partner.test", type: "cc" },
            ],
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("recovers an encrypted message's recipients from its protected headers, and nothing else", async () => {
        const fetchMock = mockFetch(() => new Response("never", { status: 500 }));
        const security = {
            state: "encrypted",
            protectedHeaders: { from: "bob@partner.test", to: "dave@partner.test", subject: "Hi" },
        } as never;

        expect(await loadOriginalMessage(encrypted, security, { recipients: true })).toEqual({
            body: {},
            recipients: [{ address: "dave@partner.test", type: "to" }],
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("what a reply fetches, and when", () => {
    const htmlResponse = (html: string) => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });

    it("asks for the body once for a Reply and the click that follows a prefetch, and remembers it for a short while", async () => {
        const fetchMock = mockFetch(() => htmlResponse("<p>Body</p>"));

        prefetchOriginalMessage(message);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(await loadOriginalMessage(message, null)).toEqual({ body: { html: "<p>Body</p>" } });
        expect(await loadOriginalMessage(message, null)).toEqual({ body: { html: "<p>Body</p>" } });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("asks again once what it remembered is older than QUOTE_CACHE_MS", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            const fetchMock = mockFetch(() => htmlResponse("<p>Body</p>"));
            await loadOriginalMessage(message, null);
            vi.setSystemTime(Date.now() + QUOTE_CACHE_MS + 1);
            await loadOriginalMessage(message, null);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not remember a failure, and asks again the next time", async () => {
        const fetchMock = mockFetch(() => new Response("nope", { status: 500 }));
        await loadOriginalMessage(message, null);
        await loadOriginalMessage(message, null);
        expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/content"))).toHaveLength(2);
    });

    it("prefetches nothing for an encrypted message, whose body the server never has to give", () => {
        const fetchMock = mockFetch(() => htmlResponse("<p>Body</p>"));
        prefetchOriginalMessage(encrypted);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("gives up on a body that takes longer than QUOTE_FETCH_TIMEOUT_MS and quotes what it can from the raw message instead", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            mockFetch((url, init) => {
                if (url.endsWith("/raw")) {
                    return new Response(RAW);
                }
                return new Promise<Response>((_resolve, reject) => {
                    init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                });
            });
            const result = loadOriginalMessage(message, null);
            await vi.advanceTimersByTimeAsync(QUOTE_FETCH_TIMEOUT_MS);
            expect(await result).toEqual({ body: { text: RAW_TEXT } });
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops waiting for the raw message after QUOTE_FETCH_TIMEOUT_MS too, and quotes nothing rather than hang", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            mockFetch((url) => (url.endsWith("/raw") ? (new Promise<Response>(() => undefined)) : new Response(null, { status: 200 })));
            const result = loadOriginalMessage(message, null);
            await vi.advanceTimersByTimeAsync(QUOTE_FETCH_TIMEOUT_MS + 1);
            expect(await result).toEqual({ body: {} });
        } finally {
            vi.useRealTimers();
        }
    });

    it("forgets everything remembered on request", async () => {
        const fetchMock = mockFetch(() => htmlResponse("<p>Body</p>"));
        await loadOriginalMessage(message, null);
        clearOriginalMessageCache();
        await loadOriginalMessage(message, null);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe("a quoted original's embedded images", () => {
    const original = { uid: "img1", folderUid: "f1", mailboxUid: "mb1", bodyPreview: "" } as never;
    const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);
    const PNG_URI = "data:image/png;base64,iVBORw==";
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
    const shot = { uid: "a1", filename: "Screenshot 2025-12-02 223133.png", mimeType: "image/png", sizeBytes: 4, isInline: false };
    const logo = { uid: "a2", filename: "logo.png", mimeType: "image/png; name=logo.png", sizeBytes: 4, isInline: true, contentId: "Logo@x" };

    /** The server's answers: the body, the message's attachments and the bytes of each. */
    function server(body: string, attachments: unknown[] | Response, bytes: (uid: string) => Response = () => new Response(PNG_BYTES)) {
        return mockFetch((url) => {
            if (url.endsWith("/img1/content")) return html(body);
            if (url.startsWith("/api/mail/attachments?")) return attachments instanceof Response ? attachments : json(attachments);
            const match = /\/api\/mail\/attachments\/([^/]+)\/content$/.exec(url);
            return match ? bytes(match[1]) : new Response("no", { status: 404 });
        });
    }

    afterEach(() => {
        clearOriginalMessageCache();
    });

    it("brings a cid: image's picture into the quote as a data: URI, fetched with the session, from the message's own attachment", async () => {
        const fetchMock = server('<p>Look</p><img src="cid:logo@x" alt="logo">', [shot, logo]);

        expect(await loadOriginalMessage(original, null)).toEqual({ body: { html: `<p>Look</p><img src="${PNG_URI}" alt="logo">` } });

        const calls = fetchMock.mock.calls.map(([url, init]) => [url, init?.credentials]);
        expect(calls).toContainEqual(["/api/mail/attachments/a2/content", "include"]);
        expect(String(fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/mail/attachments?"))![0])).toContain("messageUid=img1");
    });

    it("quotes a message that is nothing but a picture the server left with only its alt text, from the attachment of that name", async () => {
        server('<img alt="Screenshot 2025-12-02 223133.png">', [shot]);
        expect(await loadOriginalMessage(original, null)).toEqual({ body: { html: `<img alt="Screenshot 2025-12-02 223133.png" src="${PNG_URI}">` } });
        // ... and the reply's quote shows it, instead of the empty blockquote an image-only message used to leave.
        const quote = buildReplyQuote({ ...(original as object), from: { address: "a@x.test" }, receivedDate: "2026-09-30T19:02:40Z", recipients: [] } as never, (await loadOriginalMessage(original, null)).body);
        expect(quote).toContain(`<img alt="Screenshot 2025-12-02 223133.png" src="${PNG_URI}">`);
    });

    it("asks for the attachments once for all of a message's images", async () => {
        const fetchMock = server('<img src="cid:logo@x"><img src="cid:logo@x">', [logo]);
        await loadOriginalMessage(original, null);
        expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/mail/attachments?"))).toHaveLength(1);
    });

    it("leaves an image alone when its picture can't be had: no such attachment, not a raster image, too large, or not served", async () => {
        const body = '<img src="cid:logo@x">';
        server(body, [{ ...logo, mimeType: "image/svg+xml" }]);
        expect(await loadOriginalMessage(original, null)).toEqual({ body: { html: body } });
        clearOriginalMessageCache();
        server(body, [{ ...logo, sizeBytes: 3_000_000 }]);
        expect(await loadOriginalMessage(original, null)).toEqual({ body: { html: body } });
        clearOriginalMessageCache();
        server(body, [shot]);
        expect(await loadOriginalMessage(original, null)).toEqual({ body: { html: body } });
        clearOriginalMessageCache();
        server(body, [logo], () => new Response("no", { status: 404 }));
        expect(await loadOriginalMessage(original, null)).toEqual({ body: { html: body } });
        clearOriginalMessageCache();
        // The server says it is small and sends more.
        server(body, [logo], () => new Response(new Uint8Array(2_000_001)));
        expect(await loadOriginalMessage(original, null)).toEqual({ body: { html: body } });
    });

    it("leaves the quote as it was when the attachments can't be listed", async () => {
        const body = '<img src="cid:logo@x">';
        server(body, new Response("no", { status: 500, headers: { "content-type": "application/json" } }));
        expect(await loadOriginalMessage(original, null)).toEqual({ body: { html: body } });
    });

    it("stops waiting for a picture after QUOTE_FETCH_TIMEOUT_MS, and quotes the text without it", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const body = '<p>Text</p><img src="cid:logo@x">';
            mockFetch((url) => {
                if (url.endsWith("/img1/content")) return html(body);
                if (url.startsWith("/api/mail/attachments?")) return json([logo]);
                return new Promise<Response>(() => undefined);
            });
            const result = loadOriginalMessage(original, null);
            await vi.advanceTimersByTimeAsync(QUOTE_FETCH_TIMEOUT_MS + 1);
            expect(await result).toEqual({ body: { html: body } });
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps the pictures that arrived before QUOTE_FETCH_TIMEOUT_MS, and cancels the one that has not", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const body = '<p>Text</p><img src="cid:logo@x"><img src="cid:slow@x">';
            const slow = { ...logo, uid: "a3", contentId: "Slow@x", filename: "slow.png" };
            let slowSignal: AbortSignal | undefined;
            mockFetch((url, init) => {
                if (url.endsWith("/img1/content")) return html(body);
                if (url.startsWith("/api/mail/attachments?")) return json([logo, slow]);
                if (url.endsWith("/a2/content")) return new Response(PNG_BYTES);
                slowSignal = init?.signal ?? undefined;
                return new Promise<Response>(() => undefined);
            });
            const result = loadOriginalMessage(original, null);
            await vi.advanceTimersByTimeAsync(QUOTE_FETCH_TIMEOUT_MS + 1);
            expect(await result).toEqual({ body: { html: `<p>Text</p><img src="${PNG_URI}"><img src="cid:slow@x">` } });
            expect(slowSignal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("takes a decrypted or verified message's pictures from the parts inside it, without a request", async () => {
        const fetchMock = mockFetch(() => new Response("never", { status: 500 }));
        const part = (over: object) => ({ contentType: "image/png", disposition: "inline", decode: () => PNG_BYTES, ...over });
        const security = {
            state: "signed_verified",
            html: '<img src="cid:Logo@x"><img alt="pic.png"><img src="cid:svg@x"><img src="cid:none@x">',
            attachments: [
                part({ contentId: "logo@x" }),
                part({ filename: "pic.png" }),
                part({ contentId: "svg@x", contentType: "image/svg+xml" }),
                part({ filename: "huge.png", decode: () => new Uint8Array(2_000_001) }),
            ],
        } as never;

        const result = await loadOriginalMessage(original, security);

        expect(result.body.html).toBe(`<img src="${PNG_URI}"><img alt="pic.png" src="${PNG_URI}"><img src="cid:svg@x"><img src="cid:none@x">`);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("quotes a decrypted body's image only when the entity has the part (a message with no parts quotes it unchanged)", async () => {
        const security = { state: "encrypted", html: '<img src="cid:logo@x">' } as never;
        expect(await loadOriginalMessage({ ...(original as object), encrypted: true } as never, security)).toEqual({ body: { html: '<img src="cid:logo@x">' } });
    });

    it("brings the pictures of a message read from its raw source too", async () => {
        const raw = ["Content-Type: text/html; charset=utf-8", "", '<img src="cid:logo@x">', ""].join("\r\n");
        mockFetch((url) => {
            if (url.endsWith("/img1/content")) return new Response(null, { status: 200 });
            if (url.endsWith("/img1/raw")) return new Response(raw);
            if (url.startsWith("/api/mail/attachments?")) return json([logo]);
            return new Response(PNG_BYTES);
        });
        const result = await loadOriginalMessage(original, null);
        expect(result.body.html).toContain(`src="${PNG_URI}"`);
    });
});
