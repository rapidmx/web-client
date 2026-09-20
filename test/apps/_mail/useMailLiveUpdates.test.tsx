// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    LIVE_EVENT_DEBOUNCE_MS,
    LIVE_POLL_INTERVAL_MS,
    MailLiveUpdates,
    pushChannelsFor,
    useMailLiveUpdates,
} from "../../../apps/shared/mail/useMailLiveUpdates.js";

/** A stand-in for the browser's WebSocket that a test drives by hand. */
class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    readyState = 1;
    sent: any[] = [];
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(public url: string) {
        FakeWebSocket.instances.push(this);
    }
    send(data: string) {
        this.sent.push(JSON.parse(data));
    }
    close() {
        this.readyState = 3;
    }
    receive(frame: unknown) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
    greet(channels: string[] = ["u1"]) {
        this.receive({ id: 0, type: "SUBSCRIBED", success: true, data: channels });
    }
    drop() {
        this.onclose?.({});
    }
}

/** The broadcast channel sign-out is announced on, as a controllable stand-in. */
class FakeBroadcastChannel {
    static instances: FakeBroadcastChannel[] = [];
    closed = false;
    listeners: ((e: MessageEvent) => void)[] = [];
    constructor(public name: string) {
        FakeBroadcastChannel.instances.push(this);
    }
    addEventListener(_type: string, listener: (e: MessageEvent) => void) {
        this.listeners.push(listener);
    }
    close() {
        this.closed = true;
    }
    static announce(message: unknown) {
        for (const channel of FakeBroadcastChannel.instances) {
            channel.listeners.forEach((listener) => listener({ data: message } as MessageEvent));
        }
    }
}

const folder = (uid: string, mailboxUid: string, type: string, unreadCount = 0) => ({
    uid,
    version: 0,
    dateCreated: "",
    dateModified: "",
    mailboxUid,
    name: type,
    type,
    unreadCount,
    totalCount: 0,
});
const mailbox = (uid: string) => ({ uid, ownerUserUid: "u1", displayName: uid, primarySmtpAddress: `${uid}@example.com` });

const MB1 = mailbox("mb1");
const MB2 = mailbox("mb2");
const FOLDERS = [
    { mailbox: MB1 as any, folders: [folder("f1-sent", "mb1", "sent_items"), folder("f1-inbox", "mb1", "inbox", 2), folder("f1-user", "mb1", "user")] },
    { mailbox: MB2 as any, folders: [folder("f2-inbox", "mb2", "inbox", 5)] },
];

let latest: MailLiveUpdates;
const onFolderCreated = vi.fn();

function Harness(props: { userUid?: string; mailboxFolders?: typeof FOLDERS; mailboxes?: any[] }) {
    latest = useMailLiveUpdates({
        userUid: "userUid" in props ? props.userUid : "u1",
        mailboxes: props.mailboxes ?? [MB1, MB2],
        mailboxFolders: props.mailboxFolders ?? FOLDERS,
        onFolderCreated,
    });
    return null;
}

/** Answers each mailbox's folder list with the given unread counts. */
function mockFolderCounts(unread: Record<string, number>) {
    return mockFetch((url) => {
        if (url.startsWith("/api/mail/folders")) {
            const mailboxUid = new URLSearchParams(url.split("?")[1]).get("mailboxUid")!;
            const source = FOLDERS.find((entry) => entry.mailbox.uid === mailboxUid)!;
            return jsonResponse(
                200,
                source.folders.map((f) => ({ ...f, unreadCount: unread[f.uid] ?? f.unreadCount })),
            );
        }
        throw new Error(`unexpected ${url}`);
    });
}

function setVisibility(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

function socket(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    FakeBroadcastChannel.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    setVisibility("visible");
    onFolderCreated.mockClear();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetPushClient();
    // @ts-expect-error - restore jsdom's own getter
    delete document.visibilityState;
});

async function flushTimers(ms: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

describe("pushChannelsFor", () => {
    it("lists every inbox first, then the other folders in each mailbox's order, then the mailbox uids", () => {
        expect(pushChannelsFor(FOLDERS, [MB1 as any, MB2 as any])).toEqual([
            "f1-inbox",
            "f2-inbox",
            "f1-sent",
            "f1-user",
            "mb1",
            "mb2",
        ]);
    });

    it("has nothing for no mailboxes and never repeats a channel", () => {
        expect(pushChannelsFor([], [])).toEqual([]);
        expect(pushChannelsFor([FOLDERS[0], FOLDERS[0]], [MB1 as any, MB1 as any])).toEqual(["f1-inbox", "f1-sent", "f1-user", "mb1"]);
    });
});

describe("useMailLiveUpdates", () => {
    it("opens one push connection to /push and subscribes to every folder of every mailbox once it is greeted", () => {
        render(<Harness />);

        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(socket().url).toMatch(/^ws:\/\/[^/]+\/push$/);
        socket().greet();
        expect(socket().sent).toEqual([
            { id: 1, type: "SUBSCRIBE", data: ["f1-inbox", "f2-inbox", "f1-sent", "f1-user", "mb1", "mb2"] },
        ]);
    });

    it("shares one connection between components and re-mounts, and re-subscribes when the folders change", () => {
        const { rerender, unmount } = render(<Harness />);
        socket().greet();
        socket().receive({ id: 1, type: "SUBSCRIBED", data: ["f1-inbox", "f2-inbox", "f1-sent", "f1-user", "mb1", "mb2"] });

        rerender(<Harness mailboxFolders={[FOLDERS[1]]} mailboxes={[MB2]} />);
        expect(socket().sent[1]).toEqual({ id: 2, type: "UNSUBSCRIBE", data: ["f1-inbox", "f1-sent", "f1-user", "mb1"] });

        unmount();
        render(<Harness />);
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("does nothing without a signed-in user", () => {
        render(<Harness userUid={undefined} />);
        expect(FakeWebSocket.instances).toHaveLength(0);
        expect(latest.live.tick).toBe(0);
    });

    it("bumps `live` with the message's folder, once, however many events arrive together, and re-reads the unread counts", async () => {
        const fetchMock = mockFolderCounts({ "f1-inbox": 3 });
        render(<Harness />);
        socket().greet();

        act(() => {
            socket().receive({ type: "MessageMongo", action: "create", data: { uid: "m1", folderUid: "f1-inbox" } });
            socket().receive({ type: "MessageMongo", action: "update", data: { uid: "m2", folderUid: "f1-sent" } });
            socket().receive({ type: "MessageSQL", action: "delete", data: { uid: "m3", folderUid: "f1-inbox" } });
        });
        expect(latest.live.tick).toBe(0);

        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBe(1);
        expect([...latest.live.folderUids!].sort()).toEqual(["f1-inbox", "f1-sent"]);
        expect(latest.unreadCounts["f1-inbox"]).toBe(3);
        expect(latest.unreadCounts["f2-inbox"]).toBe(5);
        expect(fetchMock.mock.calls.filter(([url]) => url.startsWith("/api/mail/folders"))).toHaveLength(2);

        // A second burst is a second refresh, for its own folders.
        act(() => {
            socket().receive({ type: "MessageMongo", action: "create", data: { folderUid: "f2-inbox" } });
        });
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBe(2);
        expect([...latest.live.folderUids!]).toEqual(["f2-inbox"]);
    });

    it("takes the folder from the channel when a wrapped event's message doesn't name one, and treats none as 'anything'", async () => {
        mockFolderCounts({});
        render(<Harness />);
        socket().greet();

        act(() => {
            socket().receive({ type: "MESSAGE", channel: "f2-inbox", data: { type: "MessageMongo", action: "create", data: { uid: "m1" } } });
        });
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect([...latest.live.folderUids!]).toEqual(["f2-inbox"]);

        act(() => {
            socket().receive({ type: "MessageMongo", action: "create", data: { uid: "m2" } });
        });
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBe(2);
        expect(latest.live.folderUids).toBeNull();
    });

    it("ignores events that are not about a message, or have no recognised action", async () => {
        mockFolderCounts({});
        render(<Harness />);
        socket().greet();

        act(() => {
            socket().receive({ type: "CalendarEvent", action: "reminder", data: { folderUid: "f1-inbox" } });
            socket().receive({ type: "MessageMongo", data: { folderUid: "f1-inbox" } });
            socket().receive({ type: "MessageMongo", action: "read", data: { folderUid: "f1-inbox" } });
        });
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS * 2);
        expect(latest.live.tick).toBe(0);
    });

    it("tells the shell about a folder created elsewhere, but only one it doesn't know", () => {
        render(<Harness />);
        socket().greet();

        act(() => {
            socket().receive({ type: "FolderMongo", action: "create", data: folder("f1-new", "mb1", "user") });
            socket().receive({ type: "FolderMongo", action: "create", data: folder("f1-inbox", "mb1", "inbox") });
            socket().receive({ type: "FolderMongo", action: "create", data: { uid: "not-a-folder" } });
            socket().receive({ type: "FolderMongo", action: "create", data: null });
            socket().receive({ type: "FolderMongo", action: "update", data: folder("f1-new2", "mb1", "user") });
        });
        expect(onFolderCreated).toHaveBeenCalledTimes(1);
        expect(onFolderCreated).toHaveBeenCalledWith(expect.objectContaining({ uid: "f1-new" }));
    });

    it("keeps a count that failed to refresh and only re-renders when a count changed", async () => {
        let fail = false;
        mockFetch((url) => {
            if (fail) throw new TypeError("offline");
            const mailboxUid = new URLSearchParams(url.split("?")[1]).get("mailboxUid")!;
            return jsonResponse(200, FOLDERS.find((entry) => entry.mailbox.uid === mailboxUid)!.folders);
        });
        render(<Harness />);
        socket().greet();

        act(() => socket().receive({ type: "MessageMongo", action: "create", data: { folderUid: "f1-inbox" } }));
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        const counts = latest.unreadCounts;
        expect(counts["f1-inbox"]).toBe(2);

        // Same counts again: the state object is left alone.
        act(() => socket().receive({ type: "MessageMongo", action: "create", data: { folderUid: "f1-inbox" } }));
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.unreadCounts).toBe(counts);

        fail = true;
        act(() => socket().receive({ type: "MessageMongo", action: "create", data: { folderUid: "f1-inbox" } }));
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBe(3);
        expect(latest.unreadCounts).toBe(counts);
    });

    it("polls the safety net every interval while the tab is visible, and not while it is hidden", async () => {
        mockFolderCounts({});
        render(<Harness />);

        await flushTimers(LIVE_POLL_INTERVAL_MS);
        expect(latest.live.tick).toBe(0);
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBe(1);
        expect(latest.live.folderUids).toBeNull();

        setVisibility("hidden");
        await flushTimers(LIVE_POLL_INTERVAL_MS * 2);
        expect(latest.live.tick).toBe(1);

        setVisibility("visible");
        await flushTimers(LIVE_POLL_INTERVAL_MS);
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBe(2);
    });

    it("is the only mechanism, silently, when the socket can't connect at all", async () => {
        vi.stubGlobal("WebSocket", class {
            constructor() {
                throw new Error("blocked by the proxy");
            }
        });
        mockFolderCounts({ "f1-inbox": 9 });
        render(<Harness />);

        await flushTimers(LIVE_POLL_INTERVAL_MS + LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBeGreaterThanOrEqual(1);
        expect(latest.unreadCounts["f1-inbox"]).toBe(9);
    });

    it("refreshes, and reconnects at once, when the tab comes back to the front, the window regains focus or the browser is back online", async () => {
        mockFolderCounts({});
        render(<Harness />);
        socket().greet();
        socket().drop();
        const before = FakeWebSocket.instances.length;

        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(FakeWebSocket.instances.length).toBe(before + 1);
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBe(1);

        act(() => {
            window.dispatchEvent(new Event("focus"));
        });
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBe(2);

        socket().drop();
        const beforeOnline = FakeWebSocket.instances.length;
        act(() => {
            window.dispatchEvent(new Event("online"));
        });
        expect(FakeWebSocket.instances.length).toBe(beforeOnline + 1);
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBe(3);
    });

    it("does not refresh for a visibility change to hidden", async () => {
        mockFolderCounts({});
        render(<Harness />);
        setVisibility("hidden");
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(new Event("focus"));
        });
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS * 2);
        expect(latest.live.tick).toBe(0);
    });

    it("refreshes after a reconnect - what was published while the socket was down is gone - but not after the first connect", async () => {
        mockFolderCounts({});
        render(<Harness />);
        socket().greet();
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBe(0);

        socket().drop();
        await flushTimers(PUSH_RECONNECT_MS);
        socket().greet();
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(latest.live.tick).toBe(1);
        expect(latest.live.folderUids).toBeNull();
    });

    it("closes the socket for good, and stops refreshing, when a sign-out is announced", async () => {
        mockFolderCounts({});
        render(<Harness />);
        socket().greet();
        const connections = FakeWebSocket.instances.length;

        act(() => FakeBroadcastChannel.announce({ type: "something-else" }));
        expect(socket().readyState).toBe(1);

        act(() => FakeBroadcastChannel.announce({ type: "sign-out" }));
        expect(socket().readyState).toBe(3);

        await flushTimers(LIVE_POLL_INTERVAL_MS * 2);
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(new Event("online"));
        });
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(FakeWebSocket.instances.length).toBe(connections);
        expect(latest.live.tick).toBe(0);
    });

    it("stops everything on unmount: no more polling, no listener left behind, the broadcast channel closed", async () => {
        mockFolderCounts({});
        const { unmount } = render(<Harness />);
        socket().greet();
        const removed = vi.spyOn(window, "removeEventListener");

        unmount();
        expect(FakeBroadcastChannel.instances.every((channel) => channel.closed)).toBe(true);
        expect(removed).toHaveBeenCalledWith("focus", expect.any(Function));
        expect(removed).toHaveBeenCalledWith("online", expect.any(Function));
        await flushTimers(LIVE_POLL_INTERVAL_MS * 2);
        // An event still in flight is not acted on either.
        act(() => socket().receive({ type: "MessageMongo", action: "create", data: { folderUid: "f1-inbox" } }));
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
    });

    it("works where there is no BroadcastChannel", () => {
        vi.stubGlobal("BroadcastChannel", undefined);
        expect(() => render(<Harness />)).not.toThrow();
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("drops a count refresh that a newer one has overtaken", async () => {
        const resolvers: ((r: Response) => void)[] = [];
        mockFetch(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
        render(<Harness mailboxes={[MB1]} mailboxFolders={[FOLDERS[0]]} />);
        socket().greet();

        act(() => socket().receive({ type: "MessageMongo", action: "create", data: { folderUid: "f1-inbox" } }));
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        act(() => socket().receive({ type: "MessageMongo", action: "create", data: { folderUid: "f1-inbox" } }));
        await flushTimers(LIVE_EVENT_DEBOUNCE_MS);
        expect(resolvers).toHaveLength(2);

        // The newer refresh answers first; the older one's late answer must not overwrite it.
        await act(async () => {
            resolvers[1](jsonResponse(200, [folder("f1-inbox", "mb1", "inbox", 7)]));
        });
        await act(async () => {
            resolvers[0](jsonResponse(200, [folder("f1-inbox", "mb1", "inbox", 1)]));
        });
        expect(latest.unreadCounts["f1-inbox"]).toBe(7);
    });
});

/** A bit more than the push client's longest first reconnect delay (its ceiling, 1s). */
const PUSH_RECONNECT_MS = 1_000;
