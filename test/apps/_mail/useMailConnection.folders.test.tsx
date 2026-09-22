// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// A brand-new account's folders appear without a refresh: the server makes Outbox, Sent Items and the rest lazily (or all at once when the
// mailbox is made) and says so with push events; whatever the events miss, every refresh of the counts lists the folders again and files new ones.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { MAIL_FOLDER_TYPES, useMailConnection } from "../../../apps/shared/mail/useMailConnection.js";
import { LIVE_EVENT_DEBOUNCE_MS } from "../../../apps/shared/mail/useMailLiveUpdates.js";
import { badgeFor, countOfFolder } from "../../../apps/shared/mail/folderCounts.js";
import { folderRows } from "../../../apps/shared/mail/folderTree.js";
import { sendState } from "../../../apps/shared/mail/outbox/sendState.js";

class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    readyState = 1;
    sent: { id: number; type: string; data: string[] }[] = [];
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
    greet() {
        this.receive({ id: 0, type: "SUBSCRIBED", success: true, data: ["u1"] });
    }
    /** Answers the latest subscribe/unsubscribe the way the server does (the client sends the next change only after the last was answered). */
    ack() {
        const frame = this.sent[this.sent.length - 1];
        this.receive({ id: frame.id, type: frame.type === "SUBSCRIBE" ? "SUBSCRIBED" : "UNSUBSCRIBED", success: true, data: frame.data });
    }
    /** What is subscribed to now, from the frames sent so far. */
    subscribed(): string[] {
        const channels = new Set<string>();
        for (const frame of this.sent) {
            frame.data.forEach((channel) => (frame.type === "SUBSCRIBE" ? channels.add(channel) : channels.delete(channel)));
        }
        return [...channels];
    }
}
const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

const mailbox = { uid: "mb1", ownerUserUid: "u1", displayName: "Me", primarySmtpAddress: "me@example.com", aliasAddresses: [] };
const folder = (uid: string, type: string, extra: Record<string, unknown> = {}) => ({
    uid,
    version: 0,
    dateCreated: "",
    dateModified: "",
    mailboxUid: "mb1",
    name: type,
    type,
    unreadCount: 0,
    totalCount: 0,
    ...extra,
});
const FRESH = () => [folder("in", "inbox", { unreadCount: 1, totalCount: 1 }), folder("dr", "drafts"), folder("de", "deleted_items")];

let server: unknown[];
let folderListings: number;

function serve() {
    folderListings = 0;
    return mockFetch((url) => {
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) {
            folderListings++;
            return jsonResponse(200, server);
        }
        if (url.startsWith("/api/mail/messages")) return jsonResponse(200, []);
        throw new Error(`unexpected ${url}`);
    });
}

async function setUp() {
    const view = renderHook(() => useMailConnection({ userUid: "u1", enabled: true }));
    await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.result.current.mailboxFolders[0].folders).toHaveLength(3);
    act(() => {
        socket().greet();
        socket().ack();
    });
    return view;
}

const uids = (view: Awaited<ReturnType<typeof setUp>>) => view.result.current.mailboxFolders[0].folders.map((f) => f.uid);
const settle = (ms = LIVE_EVENT_DEBOUNCE_MS) =>
    act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });

beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    server = FRESH();
    serve();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetPushClient();
});

describe("a folder the server creates while the page is open", () => {
    it("appears the moment its create event arrives - once, however often it is delivered - and is subscribed to at once", async () => {
        const view = await setUp();
        const outbox = folder("ou", "outbox", { totalCount: 1 });
        server = [...FRESH(), outbox];

        act(() => {
            // Published on the mailbox's channel and on the new folder's own: the same event twice.
            socket().receive({ type: "FolderMongo", action: "create", data: outbox });
            socket().receive({ type: "FolderMongo", action: "create", data: outbox });
        });
        expect(uids(view)).toEqual(["in", "dr", "de", "ou"]);
        expect(view.result.current.mailboxFolders[0].folders.filter((f) => f.type === "outbox")).toHaveLength(1);
        expect(socket().subscribed()).toContain("ou");
        expect(socket().subscribed()).toEqual(expect.arrayContaining(["in", "dr", "de", "mb1"]));

        // The listing that follows (the counts' read-back) does not add it again.
        await settle(0);
        expect(uids(view)).toEqual(["in", "dr", "de", "ou"]);
        await settle();
        expect(uids(view).filter((uid) => uid === "ou")).toHaveLength(1);
    });

    it("counts a folder that has just appeared correctly: its own numbers at once, the server's after the read-back", async () => {
        const view = await setUp();
        act(() => {
            socket().receive({ type: "FolderMongo", action: "create", data: folder("ou", "outbox", { totalCount: 1 }) });
        });
        const outbox = view.result.current.mailboxFolders[0].folders.find((f) => f.uid === "ou")!;
        expect(badgeFor("outbox", countOfFolder(outbox, view.result.current.folderCounts.counts))).toEqual({ kind: "total", value: 1 });

        server = [...FRESH(), folder("ou", "outbox", { totalCount: 2 })];
        act(() => {
            socket().receive({ type: "MessageMongo", action: "update", data: { uid: "m1", folderUid: "ou", mailboxUid: "mb1", flags: { read: true } } });
        });
        await settle();
        expect(badgeFor("outbox", countOfFolder(outbox, view.result.current.folderCounts.counts))).toEqual({ kind: "total", value: 2 });
    });

    it("is found by the refresh a message event for a folder the page does not know causes - once for a burst", async () => {
        const view = await setUp();
        server = [...FRESH(), folder("se", "sent_items"), folder("ou", "outbox")];
        const before = folderListings;

        act(() => {
            for (const uid of ["m1", "m2", "m3"]) {
                socket().receive({ type: "MessageMongo", action: "create", data: { uid, folderUid: "se", mailboxUid: "mb1", flags: { read: true } } });
            }
        });
        expect(uids(view)).toEqual(["in", "dr", "de"]);
        await settle();
        expect(uids(view)).toEqual(["in", "dr", "de", "se", "ou"]);
        expect(socket().subscribed()).toEqual(expect.arrayContaining(["se", "ou"]));
        // One read of the mailbox's folders for the whole burst.
        expect(folderListings - before).toBe(1);
    });

    it("is found when a send is reported, when the window gets focus, when the browser comes back online and on the safety-net poll", async () => {
        const view = await setUp();
        server = [...FRESH(), folder("se", "sent_items")];
        act(() => {
            socket().receive({ type: "MessageMongo", action: "send-succeeded", data: { uid: "m1", mailboxUid: "mb1", subject: "S", recipients: ["a@b.c"], attempt: 1 } });
        });
        await settle();
        expect(uids(view)).toContain("se");

        server = [...server, folder("ou", "outbox")];
        act(() => {
            window.dispatchEvent(new Event("focus"));
        });
        await settle();
        expect(uids(view)).toContain("ou");

        server = [...server, folder("ju", "junk")];
        act(() => {
            window.dispatchEvent(new Event("online"));
        });
        await settle();
        expect(uids(view)).toContain("ju");

        server = [...server, folder("ar", "archive")];
        await settle(60_000);
        expect(uids(view)).toContain("ar");
    });

    it("is found when the server accepted a message this tab sent - the first send makes the Outbox and the rest", async () => {
        const view = await setUp();
        server = [...FRESH(), folder("ou", "outbox"), folder("se", "sent_items"), folder("ju", "junk"), folder("cal", "calendar")];
        await act(async () => {
            sendState.queuedListener!("mb1");
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(uids(view)).toEqual(["in", "dr", "de", "ou", "se", "ju"]);
        expect(MAIL_FOLDER_TYPES.has("calendar")).toBe(false);
    });

    it("keeps the sidebar in its fixed order however the folders arrive", async () => {
        const view = await setUp();
        act(() => {
            socket().receive({ type: "FolderMongo", action: "create", data: folder("ar", "archive") });
            socket().receive({ type: "FolderMongo", action: "create", data: folder("mine", "user", { name: "Projects" }) });
            socket().receive({ type: "FolderMongo", action: "create", data: folder("ju", "junk") });
            socket().receive({ type: "FolderMongo", action: "create", data: folder("se", "sent_items") });
            socket().receive({ type: "FolderMongo", action: "create", data: folder("ou", "outbox") });
        });
        const rows = folderRows(view.result.current.mailboxFolders[0].folders, 0).map((row) => (row.kind === "folder" ? row.folder.uid : row.type));
        expect(rows).toEqual(["in", "dr", "ou", "se", "de", "ju", "ar", "mine"]);
    });

    it("ignores a folder of another mailbox or of an app Mail does not list", async () => {
        const view = await setUp();
        const before = view.result.current.mailboxFolders;
        act(() => {
            socket().receive({ type: "FolderMongo", action: "create", data: folder("cal", "calendar") });
            socket().receive({ type: "FolderMongo", action: "create", data: { ...folder("x", "outbox"), mailboxUid: "someone-elses" } });
        });
        expect(view.result.current.mailboxFolders).toBe(before);
    });
});

describe("a folder renamed or deleted elsewhere", () => {
    it("takes the new name and type, but not from an event that only carries counts", async () => {
        const view = await setUp();
        server = [folder("in", "inbox"), folder("dr", "drafts", { name: "Old" }), folder("de", "deleted_items")];
        act(() => {
            socket().receive({ type: "FolderMongo", action: "update", data: { uid: "dr", mailboxUid: "mb1", name: "Renamed" } });
        });
        expect(view.result.current.mailboxFolders[0].folders.find((f) => f.uid === "dr")?.name).toBe("Renamed");

        const before = view.result.current.mailboxFolders;
        act(() => {
            socket().receive({ type: "FolderMongo", action: "update", data: { uid: "dr", mailboxUid: "mb1", unreadCount: 0, totalCount: 4 } });
            socket().receive({ type: "FolderMongo", action: "update", data: { uid: "unknown", name: "Nobody" } });
            socket().receive({ type: "FolderMongo", action: "update", data: null });
        });
        expect(view.result.current.mailboxFolders).toBe(before);
        expect(view.result.current.folderCounts.counts["dr"]).toEqual({ unread: 0, total: 4 });
    });

    it("drops a deleted folder, given the folder or just its uid, and stops listening to it", async () => {
        const view = await setUp();
        act(() => {
            socket().receive({ type: "FolderMongo", action: "delete", data: { uid: "dr" } });
            socket().receive({ type: "FolderMongo", action: "delete", data: null });
            socket().receive({ type: "FolderMongo", action: "delete", data: { name: "no uid" } });
        });
        expect(uids(view)).toEqual(["in", "de"]);
        expect(socket().subscribed()).not.toContain("dr");
        act(() => {
            socket().ack();
            socket().receive({ type: "FolderMongo", action: "delete", data: folder("in", "inbox") });
        });
        expect(uids(view)).toEqual(["de"]);
        expect(socket().subscribed()).not.toContain("in");
    });
});
