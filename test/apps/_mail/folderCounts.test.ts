// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    COUNT_QUIET_MS,
    COUNT_REFRESH_DELAY_MS,
    badgeFor,
    badgeLabel,
    countDeltas,
    countOfFolder,
    inboxUnreadTotal,
    useFolderCounts,
} from "../../../apps/shared/mail/folderCounts.js";

const folder = (uid: string, mailboxUid: string, type: string, unreadCount = 0, totalCount = 0) =>
    ({ uid, mailboxUid, type, name: type, unreadCount, totalCount, version: 0, dateCreated: "", dateModified: "" }) as any;
const message = (uid: string, folderUid: string, read: boolean | undefined) =>
    ({ uid, folderUid, mailboxUid: "mb1", flags: read === undefined ? {} : { read } }) as any;

describe("countDeltas", () => {
    it("counts a new unread message in its folder, and a read one only in the total", () => {
        expect(countDeltas(null, message("m", "f1", false))).toEqual([{ folderUid: "f1", unread: 1, total: 1 }]);
        expect(countDeltas(undefined, message("m", "f1", true))).toEqual([{ folderUid: "f1", unread: 0, total: 1 }]);
    });

    it("treats a message with no read flag as unread", () => {
        expect(countDeltas(null, message("m", "f1", undefined))).toEqual([{ folderUid: "f1", unread: 1, total: 1 }]);
    });

    it("takes a deleted message out of its folder", () => {
        expect(countDeltas(message("m", "f1", false), null)).toEqual([{ folderUid: "f1", unread: -1, total: -1 }]);
        expect(countDeltas(message("m", "f1", true), undefined)).toEqual([{ folderUid: "f1", unread: 0, total: -1 }]);
    });

    it("moves the unread count with an unread message, and only the total with a read one", () => {
        expect(countDeltas(message("m", "f1", false), message("m", "f2", false))).toEqual([
            { folderUid: "f1", unread: -1, total: -1 },
            { folderUid: "f2", unread: 1, total: 1 },
        ]);
        expect(countDeltas(message("m", "f1", true), message("m", "f2", true))).toEqual([
            { folderUid: "f1", unread: 0, total: -1 },
            { folderUid: "f2", unread: 0, total: 1 },
        ]);
    });

    it("reading a message in place changes only its folder's unread count; nothing changed is nothing", () => {
        expect(countDeltas(message("m", "f1", false), message("m", "f1", true))).toEqual([{ folderUid: "f1", unread: -1, total: 0 }]);
        expect(countDeltas(message("m", "f1", true), message("m", "f1", false))).toEqual([{ folderUid: "f1", unread: 1, total: 0 }]);
        expect(countDeltas(message("m", "f1", true), message("m", "f1", true))).toEqual([]);
        expect(countDeltas(null, null)).toEqual([]);
    });
});

describe("countOfFolder", () => {
    it("prefers what this page worked out over what the folder was loaded with", () => {
        const f = folder("f1", "mb1", "inbox", 4, 9);
        expect(countOfFolder(f, {})).toEqual({ unread: 4, total: 9 });
        expect(countOfFolder(f, { f1: { unread: 1, total: 9 } })).toEqual({ unread: 1, total: 9 });
    });
});

describe("badgeFor", () => {
    const count = { unread: 3, total: 8 };
    const none = { unread: 0, total: 0 };

    it("shows the unread count of an Inbox, Archive and user folder, only when above zero", () => {
        for (const type of ["inbox", "archive", "user"] as const) {
            expect(badgeFor(type, count)).toEqual({ kind: "unread", value: 3 });
            expect(badgeFor(type, { unread: 0, total: 8 })).toBeUndefined();
        }
    });

    it("shows how many messages Drafts and Outbox hold, whether or not any are unread", () => {
        for (const type of ["drafts", "outbox"] as const) {
            expect(badgeFor(type, count)).toEqual({ kind: "total", value: 8 });
            expect(badgeFor(type, none)).toBeUndefined();
        }
    });

    it("shows nothing on Sent Items, Deleted Items and Junk Email", () => {
        for (const type of ["sent_items", "deleted_items", "junk"] as const) {
            expect(badgeFor(type, count)).toBeUndefined();
        }
    });
});

describe("badgeLabel", () => {
    it("reads the badge out", () => {
        expect(badgeLabel({ kind: "unread", value: 3 })).toBe("3 unread");
        expect(badgeLabel({ kind: "total", value: 1 })).toBe("1 message");
        expect(badgeLabel({ kind: "total", value: 2 })).toBe("2 messages");
    });
});

describe("inboxUnreadTotal", () => {
    it("sums the unread of every mailbox's Inbox, using the overlay where there is one", () => {
        const entries = [
            { folders: [folder("a-inbox", "a", "inbox", 2), folder("a-sent", "a", "sent_items", 7)] },
            { folders: [folder("b-inbox", "b", "inbox", 5), folder("b-junk", "b", "junk", 9)] },
        ];
        expect(inboxUnreadTotal(entries, {})).toBe(7);
        expect(inboxUnreadTotal(entries, { "b-inbox": { unread: 0, total: 3 } })).toBe(2);
        expect(inboxUnreadTotal([], {})).toBe(0);
    });
});

const MB1 = { uid: "mb1" } as any;
const MB2 = { uid: "mb2" } as any;
const INBOX = folder("inbox", "mb1", "inbox", 5, 10);
const DRAFTS = folder("drafts", "mb1", "drafts", 0, 2);
const OTHER_INBOX = folder("inbox2", "mb2", "inbox", 1, 1);

/** A server whose folder listing is whatever `server` currently holds, and counts what it was asked. */
function serverWith(server: Record<string, { unreadCount: number; totalCount: number }>) {
    return mockFetch((url) => {
        if (!url.startsWith("/api/mail/folders")) throw new Error(`unexpected ${url}`);
        const mailboxUid = new URLSearchParams(url.split("?")[1]).get("mailboxUid");
        const all = [INBOX, DRAFTS, OTHER_INBOX].filter((f) => f.mailboxUid === mailboxUid);
        return jsonResponse(
            200,
            all.map((f) => ({ ...f, ...(server[f.uid] ?? {}) })),
        );
    });
}

function setup(mailboxes = [MB1], folders = [INBOX, DRAFTS]) {
    return renderHook((props: { mailboxes: any[]; folders: any[] }) => useFolderCounts(props.mailboxes, props.folders), {
        initialProps: { mailboxes, folders },
    });
}

async function advance(ms: number) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("useFolderCounts", () => {
    describe("track", () => {
        it("applies a change at once, from the count the folder was loaded with", () => {
            serverWith({});
            const { result } = setup();
            expect(result.current.counts).toEqual({});

            act(() => {
                result.current.track(message("m", "inbox", false), message("m", "inbox", true));
            });
            expect(result.current.counts.inbox).toEqual({ unread: 4, total: 10 });

            act(() => {
                result.current.track(message("n", "inbox", false), message("n", "inbox", true));
            });
            expect(result.current.counts.inbox).toEqual({ unread: 3, total: 10 });
        });

        it("adjusts both folders of a move, and never goes below zero", () => {
            serverWith({});
            const { result } = setup();
            act(() => {
                result.current.track(message("m", "inbox", false), message("m", "drafts", false));
            });
            expect(result.current.counts).toEqual({ inbox: { unread: 4, total: 9 }, drafts: { unread: 1, total: 3 } });

            act(() => {
                result.current.track(message("m", "drafts", true), null);
                result.current.track(message("m", "drafts", true), null);
                result.current.track(message("m", "drafts", true), null);
                result.current.track(message("m", "drafts", true), null);
            });
            expect(result.current.counts.drafts.total).toBe(0);
        });

        it("ignores a folder the sidebar does not list", () => {
            serverWith({});
            const { result } = setup();
            act(() => {
                result.current.track(message("m", "somewhere-else", false), null);
            });
            expect(result.current.counts).toEqual({});
        });

        it("keeps the change when settled, and reads the real counts back after a moment", async () => {
            const fetchMock = serverWith({ inbox: { unreadCount: 4, totalCount: 10 } });
            const { result } = setup();
            let tracker!: ReturnType<typeof result.current.track>;
            act(() => {
                tracker = result.current.track(message("m", "inbox", false), message("m", "inbox", true));
            });
            act(() => tracker.settle());
            expect(fetchMock).not.toHaveBeenCalled();
            expect(result.current.counts.inbox.unread).toBe(4);

            await advance(COUNT_REFRESH_DELAY_MS);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(result.current.counts.inbox).toEqual({ unread: 4, total: 10 });
        });

        it("puts the counts back as they were when reverted, and settling or reverting twice does nothing more", async () => {
            serverWith({});
            const { result } = setup();
            let tracker!: ReturnType<typeof result.current.track>;
            act(() => {
                tracker = result.current.track(message("m", "inbox", false), message("m", "drafts", false));
            });
            act(() => tracker.revert());
            expect(result.current.counts).toEqual({ inbox: { unread: 5, total: 10 }, drafts: { unread: 0, total: 2 } });

            act(() => {
                tracker.revert();
                tracker.settle();
            });
            expect(result.current.counts).toEqual({ inbox: { unread: 5, total: 10 }, drafts: { unread: 0, total: 2 } });
            await advance(COUNT_REFRESH_DELAY_MS);
        });

        it("is not overwritten by a read of the server that began before the change ended, but by the next one", async () => {
            // The server's answer to the first read is the old count - it was asked before the change landed.
            const server: Record<string, { unreadCount: number; totalCount: number }> = { inbox: { unreadCount: 5, totalCount: 10 } };
            const resolvers: (() => void)[] = [];
            mockFetch(async () => {
                const snapshot = { ...server.inbox };
                await new Promise<void>((resolve) => resolvers.push(resolve));
                return jsonResponse(200, [{ ...INBOX, ...snapshot }]);
            });
            const { result } = setup();
            let tracker!: ReturnType<typeof result.current.track>;
            act(() => {
                tracker = result.current.track(message("m", "inbox", false), message("m", "inbox", true));
            });
            // A read starts while the change is still in flight...
            act(() => result.current.refresh(0));
            await advance(0);
            expect(resolvers).toHaveLength(1);
            // ...the change lands on the server and settles, then the stale answer arrives.
            server.inbox = { unreadCount: 4, totalCount: 10 };
            act(() => tracker.settle());
            await act(async () => resolvers[0]());
            expect(result.current.counts.inbox.unread).toBe(4);

            // The answer was thrown away and another read asked for, which the server answers correctly.
            await advance(COUNT_REFRESH_DELAY_MS);
            expect(resolvers).toHaveLength(2);
            await act(async () => resolvers[1]());
            expect(result.current.counts.inbox.unread).toBe(4);
        });
    });

    describe("refresh", () => {
        it("shows the server's counts, from every mailbox, and leaves the state alone when nothing changed", async () => {
            const fetchMock = serverWith({ inbox: { unreadCount: 7, totalCount: 12 }, inbox2: { unreadCount: 0, totalCount: 1 } });
            const { result } = setup([MB1, MB2], [INBOX, DRAFTS, OTHER_INBOX]);
            act(() => result.current.refresh(0));
            await advance(0);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(result.current.counts.inbox).toEqual({ unread: 7, total: 12 });
            expect(result.current.counts.inbox2).toEqual({ unread: 0, total: 1 });

            const before = result.current.counts;
            act(() => result.current.refresh(0));
            await advance(0);
            expect(result.current.counts).toBe(before);
        });

        it("notices a change in only the total, or only the unread count", async () => {
            const server = { inbox: { unreadCount: 5, totalCount: 10 } };
            serverWith(server);
            const { result } = setup();
            act(() => result.current.refresh(0));
            await advance(0);
            server.inbox = { unreadCount: 5, totalCount: 11 };
            act(() => result.current.refresh(0));
            await advance(0);
            expect(result.current.counts.inbox).toEqual({ unread: 5, total: 11 });
            server.inbox = { unreadCount: 6, totalCount: 11 };
            act(() => result.current.refresh(0));
            await advance(0);
            expect(result.current.counts.inbox).toEqual({ unread: 6, total: 11 });
        });

        it("keeps what it had for a mailbox whose folders could not be read", async () => {
            mockFetch((url) => {
                const mailboxUid = new URLSearchParams(url.split("?")[1]).get("mailboxUid");
                if (mailboxUid === "mb2") throw new TypeError("offline");
                return jsonResponse(200, [{ ...INBOX, unreadCount: 9 }]);
            });
            const { result } = setup([MB1, MB2], [INBOX, OTHER_INBOX]);
            act(() => result.current.refresh(0));
            await advance(0);
            expect(result.current.counts).toEqual({ inbox: { unread: 9, total: 10 } });
        });

        it("waits out the delay, and a later request replaces an earlier one", async () => {
            const fetchMock = serverWith({});
            const { result } = setup();
            act(() => result.current.refresh());
            await advance(COUNT_REFRESH_DELAY_MS - 1);
            act(() => result.current.refresh());
            await advance(COUNT_REFRESH_DELAY_MS - 1);
            expect(fetchMock).not.toHaveBeenCalled();
            await advance(1);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("drops an answer another read has overtaken", async () => {
            const resolvers: ((value: Response) => void)[] = [];
            mockFetch(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
            const { result } = setup();
            act(() => result.current.refresh(0));
            await advance(0);
            act(() => result.current.refresh(0));
            await advance(0);
            expect(resolvers).toHaveLength(2);
            await act(async () => resolvers[1](jsonResponse(200, [{ ...INBOX, unreadCount: 2 }])));
            await act(async () => resolvers[0](jsonResponse(200, [{ ...INBOX, unreadCount: 8 }])));
            expect(result.current.counts.inbox.unread).toBe(2);
        });

        it("does nothing once unmounted", async () => {
            const fetchMock = serverWith({});
            const { result, unmount } = setup();
            act(() => result.current.refresh(100));
            unmount();
            await advance(1_000);
            expect(fetchMock).not.toHaveBeenCalled();
            result.current.refresh(0);
            await advance(1_000);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("drops the answer of a read that was in flight when it unmounted", async () => {
            let release!: (value: Response) => void;
            mockFetch(() => new Promise<Response>((resolve) => (release = resolve)));
            const { result, unmount } = setup();
            act(() => result.current.refresh(0));
            await advance(0);
            unmount();
            await act(async () => release(jsonResponse(200, [{ ...INBOX, unreadCount: 1 }])));
            expect(result.current.counts).toEqual({});
        });
    });

    describe("noteCreated", () => {
        it("counts a new message once, then reconciles", async () => {
            const fetchMock = serverWith({ inbox: { unreadCount: 6, totalCount: 11 } });
            const { result } = setup();
            let first = false;
            let again = true;
            act(() => {
                first = result.current.noteCreated(message("m1", "inbox", false));
                again = result.current.noteCreated(message("m1", "inbox", false));
            });
            expect(first).toBe(true);
            expect(again).toBe(false);
            expect(result.current.counts.inbox).toEqual({ unread: 6, total: 11 });

            await advance(COUNT_REFRESH_DELAY_MS);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("only remembers so many messages, forgetting the oldest first", () => {
            serverWith({});
            const { result } = setup();
            act(() => {
                for (let i = 0; i < 502; i++) {
                    result.current.noteCreated(message(`m${i}`, "inbox", true));
                }
            });
            expect(result.current.noteCreated(message("m0", "inbox", true))).toBe(true);
            expect(result.current.noteCreated(message("m501", "inbox", true))).toBe(false);
        });
    });

    describe("applyFolderEvent", () => {
        it("shows the counts the server published, when nothing of this page's own is in flight", () => {
            serverWith({});
            const { result } = setup();
            act(() => result.current.applyFolderEvent({ uid: "inbox", mailboxUid: "mb1", unreadCount: 2, totalCount: 12 }));
            expect(result.current.counts.inbox).toEqual({ unread: 2, total: 12 });

            const before = result.current.counts;
            act(() => result.current.applyFolderEvent({ uid: "inbox", unreadCount: 2, totalCount: 12 }));
            expect(result.current.counts).toBe(before);
        });

        it("takes what is valid of an event that is only partly so, and the folder's current value for the rest", () => {
            serverWith({});
            const { result } = setup();
            act(() => result.current.applyFolderEvent({ uid: "inbox", unreadCount: 1 }));
            expect(result.current.counts.inbox).toEqual({ unread: 1, total: 10 });
            act(() => result.current.applyFolderEvent({ uid: "inbox", unreadCount: -3, totalCount: 4 }));
            expect(result.current.counts.inbox).toEqual({ unread: 1, total: 4 });
            act(() => result.current.applyFolderEvent({ uid: "inbox", unreadCount: "many", totalCount: Number.NaN }));
            expect(result.current.counts.inbox).toEqual({ unread: 1, total: 4 });
        });

        it("records the loaded counts when an event says nothing new about a folder it hasn't touched", () => {
            serverWith({});
            const { result } = setup();
            act(() => result.current.applyFolderEvent({ uid: "inbox", unreadCount: 5, totalCount: 10 }));
            expect(result.current.counts.inbox).toEqual({ unread: 5, total: 10 });
        });

        it("ignores events that are not about a folder it lists", () => {
            serverWith({});
            const { result } = setup();
            act(() => {
                result.current.applyFolderEvent({ uid: "elsewhere", unreadCount: 2, totalCount: 3 });
                result.current.applyFolderEvent({ uid: 7 });
                result.current.applyFolderEvent(null);
                result.current.applyFolderEvent("nope");
            });
            expect(result.current.counts).toEqual({});
        });

        it("leaves a change of this page's own alone, and reads the real counts instead - while it is in flight and just after", async () => {
            const fetchMock = serverWith({ inbox: { unreadCount: 4, totalCount: 10 } });
            const { result } = setup();
            let tracker!: ReturnType<typeof result.current.track>;
            act(() => {
                tracker = result.current.track(message("m", "inbox", false), message("m", "inbox", true));
            });
            // An event about the state before this change: not applied.
            act(() => result.current.applyFolderEvent({ uid: "inbox", unreadCount: 5, totalCount: 10 }));
            expect(result.current.counts.inbox.unread).toBe(4);

            act(() => tracker.settle());
            act(() => result.current.applyFolderEvent({ uid: "inbox", unreadCount: 5, totalCount: 10 }));
            expect(result.current.counts.inbox.unread).toBe(4);
            await advance(COUNT_REFRESH_DELAY_MS);
            expect(fetchMock).toHaveBeenCalled();

            await advance(COUNT_QUIET_MS);
            act(() => result.current.applyFolderEvent({ uid: "inbox", unreadCount: 3, totalCount: 10 }));
            expect(result.current.counts.inbox.unread).toBe(3);
        });
    });

    it("starts again when the mailboxes are loaded again, and not otherwise", () => {
        serverWith({});
        const { result, rerender } = setup();
        act(() => {
            result.current.track(message("m", "inbox", false), message("m", "inbox", true));
        });
        expect(result.current.counts.inbox.unread).toBe(4);

        // A new array of the same mailboxes is not a new load.
        rerender({ mailboxes: [{ uid: "mb1" } as any], folders: [INBOX, DRAFTS] });
        expect(result.current.counts.inbox.unread).toBe(4);

        rerender({ mailboxes: [MB1, MB2], folders: [INBOX, DRAFTS, OTHER_INBOX] });
        expect(result.current.counts).toEqual({});
    });
});
