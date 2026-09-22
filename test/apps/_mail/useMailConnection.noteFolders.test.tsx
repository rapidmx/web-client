// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// A folder the client meets in a message (a list's rows, a conversation's folders) that its sidebar does not know is asked for - once.
import React from "react";
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { useMailConnection } from "../../../apps/shared/mail/useMailConnection.js";
import { COUNT_REFRESH_DELAY_MS } from "../../../apps/shared/mail/folderCounts.js";
import MailShell, { useMailShell } from "../../../apps/shared/components/mail/layout/MailShell.js";

const mailbox = { uid: "mb1", ownerUserUid: "u1", displayName: "Me", primarySmtpAddress: "me@example.com", aliasAddresses: [] };
const folder = (uid: string, type: string) => ({ uid, version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: type, type, unreadCount: 0, totalCount: 0 });

let server: unknown[];
let listings: number;

beforeEach(() => {
    vi.useFakeTimers();
    server = [folder("in", "inbox"), folder("dr", "drafts")];
    listings = 0;
    mockFetch((url) => {
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) {
            listings++;
            return jsonResponse(200, server);
        }
        throw new Error(`unexpected ${url}`);
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function ready() {
    const view = renderHook(() => useMailConnection({ userUid: "u1", enabled: true }));
    await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.result.current.mailboxFolders[0].folders).toHaveLength(2);
    return view;
}

const settle = () =>
    act(async () => {
        await vi.advanceTimersByTimeAsync(COUNT_REFRESH_DELAY_MS + 50);
    });

describe("noteFolderUids", () => {
    it("lists the mailbox's folders again, once for a burst, when a message lives in a folder the sidebar does not know - and files it", async () => {
        const view = await ready();
        server = [...server, folder("se", "sent_items")];
        const before = listings;

        act(() => {
            view.result.current.noteFolderUids(["in", "se"]);
            view.result.current.noteFolderUids(new Set(["se", "se-2"]));
        });
        expect(view.result.current.mailboxFolders[0].folders).toHaveLength(2);
        await settle();
        expect(view.result.current.mailboxFolders[0].folders.map((f) => f.uid)).toEqual(["in", "dr", "se"]);
        expect(listings - before).toBe(1);
    });

    it("does nothing for folders it knows, empty uids, or one it has already asked about (another app's folder cannot make it ask for ever)", async () => {
        const view = await ready();
        const before = listings;
        act(() => view.result.current.noteFolderUids(["in", "dr", ""]));
        await settle();
        expect(listings).toBe(before);

        act(() => view.result.current.noteFolderUids(["calendar-folder"]));
        await settle();
        const asked = listings;
        expect(asked).toBeGreaterThan(before);
        act(() => view.result.current.noteFolderUids(["calendar-folder"]));
        await settle();
        expect(listings).toBe(asked);
    });
});

describe("the mail shell's context", () => {
    it("offers noteFolderUids to a page under it, and is a no-op outside a shell", async () => {
        let outside: ReturnType<typeof useMailShell> | undefined;
        function Outside() {
            outside = useMailShell();
            return null;
        }
        render(<Outside />);
        expect(() => outside!.noteFolderUids(["x"])).not.toThrow();

        let inside: ReturnType<typeof useMailShell> | undefined;
        function Inside() {
            inside = useMailShell();
            return null;
        }
        render(
            <MailShell userUid="u1">
                <Inside />
            </MailShell>,
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        server = [...server, folder("se", "sent_items")];
        const before = listings;
        act(() => inside!.noteFolderUids(["se"]));
        await settle();
        expect(listings).toBeGreaterThan(before);
    });
});
