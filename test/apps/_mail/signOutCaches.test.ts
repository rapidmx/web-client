// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What the mail app remembers of message content for the session - and that all of it is dropped the moment a sign-out starts, and the
// one that grew without limit stays bounded.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../testUtils.js";
import { clearSigningOut, markSigningOut, onSigningOut } from "../../../apps/shared/components/mail/compose/composeFlushRegistry.js";
import { cachedBodyContent, fetchBodyContent } from "../../../apps/shared/components/mail/reading/bodyContent.js";
import { prefetchOriginalMessage } from "../../../apps/shared/components/mail/compose/quotedBody.js";
import { readListSnapshot, writeListSnapshot } from "../../../apps/shared/mail/listSnapshots.js";
import { markDecryptFailed, decryptFailedBefore, rememberDecrypted } from "../../../apps/shared/mail/decryptedMessages.js";

afterEach(() => {
    clearSigningOut();
    vi.unstubAllGlobals();
});

const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const original = (uid: string) => ({ uid, encrypted: false }) as never;

describe("starting a sign-out", () => {
    it("runs what was registered with onSigningOut", () => {
        const cleanup = vi.fn();
        onSigningOut(cleanup);
        markSigningOut();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it("drops the remembered bodies, list snapshots, decrypted subjects and Reply bodies", async () => {
        const fetchMock = mockFetch(() => html("<p>Body</p>"));
        await fetchBodyContent("m1", 1);
        writeListSnapshot("k", { messages: [], conversations: [], hasMore: false, selectedUid: null });
        markDecryptFailed("m1");
        rememberDecrypted("m2", "mb1", { subject: "Secret" });
        prefetchOriginalMessage(original("m1"));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(cachedBodyContent("m1", 1)).toBeDefined();
        expect(readListSnapshot("k")).toBeDefined();
        expect(decryptFailedBefore("m1")).toBe(true);

        markSigningOut();

        expect(cachedBodyContent("m1", 1)).toBeUndefined();
        expect(readListSnapshot("k")).toBeUndefined();
        expect(decryptFailedBefore("m1")).toBe(false);
        // The Reply body was dropped too: asked for again, it is fetched again.
        prefetchOriginalMessage(original("m1"));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    });
});

describe("the remembered Reply bodies", () => {
    it("are limited in number, the oldest going first, so a long session does not keep every message it was asked about", async () => {
        const fetchMock = mockFetch(() => html("<p>Body</p>"));
        for (let i = 0; i < 25; i++) {
            prefetchOriginalMessage(original(`q${i}`));
        }
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(25));

        // The newest is still remembered: no request. The oldest was dropped: a new one.
        prefetchOriginalMessage(original("q24"));
        expect(fetchMock).toHaveBeenCalledTimes(25);
        prefetchOriginalMessage(original("q0"));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(26));
    });

    it("drop what has expired when another is remembered", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            const fetchMock = mockFetch(() => html("<p>Body</p>"));
            prefetchOriginalMessage(original("old"));
            await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
            vi.setSystemTime(Date.now() + 31_000);
            prefetchOriginalMessage(original("new"));
            await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
            prefetchOriginalMessage(original("new"));
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});
