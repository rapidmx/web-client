// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../testUtils.js";
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
