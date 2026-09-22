// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { useMailConnection } from "../../../apps/shared/mail/useMailConnection.js";
import { sendState } from "../../../apps/shared/mail/outbox/sendState.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { PUSH_NOTICE_ID, PUSH_OFFLINE_NOTICE_MS } from "../../../apps/shared/notifications/pushStatus.js";

const mailbox = { uid: "mb1", ownerUserUid: "u1", displayName: "Me", primarySmtpAddress: "me@example.com", aliasAddresses: [] };
const folder = (uid: string, type: string, totalCount = 0) => ({ uid, mailboxUid: "mb1", name: type, type, unreadCount: 0, totalCount });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

function serve(folders: () => unknown[]) {
    return mockFetch((url) => {
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders());
        if (url.startsWith("/api/mail/messages")) return jsonResponse(200, []);
        throw new Error(`unexpected ${url}`);
    });
}

describe("useMailConnection - the Outbox indicator", () => {
    it("counts a message being sent in the Outbox at once, keeps it once the server has it, and takes it back when the send failed", async () => {
        serve(() => [folder("in", "inbox"), folder("ob", "outbox", 1)]);
        const { result } = renderHook(() => useMailConnection({ userUid: "u1", enabled: true }));
        await waitFor(() => expect(result.current.mailboxFolders[0]?.folders).toHaveLength(2));
        expect(sendState.countTracker).toBeDefined();

        let tracker!: ReturnType<NonNullable<typeof sendState.countTracker>>;
        act(() => {
            tracker = sendState.countTracker!("mb1");
        });
        expect(result.current.folderCounts.counts["ob"]).toEqual({ unread: 0, total: 2 });
        act(() => tracker.revert());
        expect(result.current.folderCounts.counts["ob"]).toEqual({ unread: 0, total: 1 });
        act(() => {
            sendState.countTracker!("mb1").settle();
        });
        expect(result.current.folderCounts.counts["ob"].total).toBe(2);
    });

    it("has nothing to count for a mailbox with no Outbox yet, and reads the folders back when the server accepted a message - the Outbox may have been created", async () => {
        let folders = [folder("in", "inbox")];
        const fetchMock = serve(() => folders);
        const { result } = renderHook(() => useMailConnection({ userUid: "u1", enabled: true }));
        await waitFor(() => expect(result.current.mailboxFolders[0]?.folders).toHaveLength(1));

        act(() => {
            sendState.countTracker!("mb1").settle();
            sendState.countTracker!("unknown").revert();
        });
        expect(result.current.folderCounts.counts).toEqual({});

        folders = [folder("in", "inbox"), folder("ob", "outbox", 1), folder("cal", "calendar")];
        const before = fetchMock.mock.calls.length;
        act(() => sendState.queuedListener!("mb1"));
        await waitFor(() => expect(result.current.mailboxFolders[0].folders.map((entry) => entry.uid)).toEqual(["in", "ob"]));
        expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
        // A failed read of the folders changes nothing.
        fetchMock.mockImplementation(() => jsonResponse(500, { message: "down" }));
        act(() => sendState.queuedListener!("mb1"));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(result.current.mailboxFolders[0].folders).toHaveLength(2);
    });

    it("registers only while it owns the connection, and lets go on unmount", async () => {
        serve(() => [folder("in", "inbox")]);
        const off = renderHook(() => useMailConnection({ userUid: "u1", enabled: false }));
        expect(sendState.countTracker).toBeUndefined();
        off.unmount();
        const { unmount } = renderHook(() => useMailConnection({ userUid: "u1", enabled: true }));
        expect(sendState.countTracker).toBeDefined();
        unmount();
        expect(sendState.countTracker).toBeUndefined();
        expect(sendState.queuedListener).toBeUndefined();
    });
});

describe("useMailConnection - the connection notice", () => {
    it("tells the user, subtly, that live updates are paused after ten seconds offline, and takes it back when the socket is", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        serve(() => [folder("in", "inbox")]);
        const { result } = renderHook(() => useMailConnection({ userUid: "u1", enabled: true }));
        await vi.waitFor(() => expect(result.current.status).toBe("ready"));
        const client = getPushClient() as unknown as { setStatus(status: string): void };

        act(() => client.setStatus("reconnecting"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(PUSH_OFFLINE_NOTICE_MS);
        });
        expect(getNotificationsSnapshot().visible.map((item) => item.id)).toEqual([PUSH_NOTICE_ID]);
        act(() => client.setStatus("open"));
        expect(getNotificationsSnapshot().visible).toEqual([]);
    });
});
