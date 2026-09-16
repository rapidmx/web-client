// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CONVERSATION_SORTS,
    CONVERSATION_SORT_UNAVAILABLE,
    DEFAULT_MAIL_LIST_PREFERENCES,
    defaultSortOrder,
    getMailListPreferences,
    setMailListPreferences,
    sortConversations,
} from "../../../apps/shared/components/mail/listPreferences.js";

afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("listPreferences", () => {
    it("defaults a mailbox that has never been configured", () => {
        expect(getMailListPreferences("mb1")).toEqual(DEFAULT_MAIL_LIST_PREFERENCES);
    });

    it("round-trips a saved preference, per mailbox", () => {
        setMailListPreferences("mb1", {
            sortBy: "subject",
            sortOrder: "asc",
            filter: "unread",
            labelUids: ["l1", "l2"],
            showAsConversations: true,
        });

        expect(getMailListPreferences("mb1")).toEqual({
            sortBy: "subject",
            sortOrder: "asc",
            filter: "unread",
            labelUids: ["l1", "l2"],
            showAsConversations: true,
        });
        expect(getMailListPreferences("mb2")).toEqual(DEFAULT_MAIL_LIST_PREFERENCES);
    });

    it("opens a never-configured mailbox on Focused, shown as conversations", () => {
        expect(getMailListPreferences("mb1")).toMatchObject({ filter: "focused", showAsConversations: true });
    });

    it("honours a stored flat, unfiltered arrangement rather than re-applying the defaults over it", () => {
        setMailListPreferences("mb1", { ...DEFAULT_MAIL_LIST_PREFERENCES, filter: "all", showAsConversations: false });

        expect(getMailListPreferences("mb1")).toMatchObject({ filter: "all", showAsConversations: false });
    });

    it("keeps a Focused/Other filter, which the menu offers alongside the named ones", () => {
        setMailListPreferences("mb1", { ...DEFAULT_MAIL_LIST_PREFERENCES, filter: "other" });
        expect(getMailListPreferences("mb1").filter).toBe("other");
    });

    it("falls back field by field for an unknown or missing value", () => {
        localStorage.setItem(
            "rapidmx:mail-list-preferences:mb1",
            JSON.stringify({ sortBy: "size", sortOrder: "sideways", filter: "toMe" }),
        );

        expect(getMailListPreferences("mb1")).toEqual(DEFAULT_MAIL_LIST_PREFERENCES);
    });

    it("gives a stored sort key its own natural direction when the stored direction is unusable", () => {
        localStorage.setItem("rapidmx:mail-list-preferences:mb1", JSON.stringify({ sortBy: "from" }));

        expect(getMailListPreferences("mb1")).toEqual({ ...DEFAULT_MAIL_LIST_PREFERENCES, sortBy: "from", sortOrder: "asc" });
    });

    it("falls back for a corrupted, non-object or absent stored value", () => {
        localStorage.setItem("rapidmx:mail-list-preferences:mb1", "{not json");
        expect(getMailListPreferences("mb1")).toEqual(DEFAULT_MAIL_LIST_PREFERENCES);

        localStorage.setItem("rapidmx:mail-list-preferences:mb1", "42");
        expect(getMailListPreferences("mb1")).toEqual(DEFAULT_MAIL_LIST_PREFERENCES);

        localStorage.setItem("rapidmx:mail-list-preferences:mb1", "null");
        expect(getMailListPreferences("mb1")).toEqual(DEFAULT_MAIL_LIST_PREFERENCES);
    });

    it("falls back, and never throws, when storage itself is unavailable", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("storage blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("storage blocked");
        });

        expect(getMailListPreferences("mb1")).toEqual(DEFAULT_MAIL_LIST_PREFERENCES);
        expect(() => setMailListPreferences("mb1", DEFAULT_MAIL_LIST_PREFERENCES)).not.toThrow();
    });

    it("picks the direction that reads naturally for each sort key", () => {
        expect(defaultSortOrder("date")).toBe("desc");
        expect(defaultSortOrder("importance")).toBe("desc");
        expect(defaultSortOrder("from")).toBe("asc");
        expect(defaultSortOrder("subject")).toBe("asc");
    });

    describe("sortConversations", () => {
        const row = (overrides: Record<string, unknown>) =>
            ({
                conversationId: "c",
                subject: "Subject",
                messageUids: [],
                folderUids: [],
                messageCount: 1,
                unreadCount: 0,
                latestDate: "2026-01-01T00:00:00.000Z",
                participants: [],
                hasAttachments: false,
                flagged: false,
                latestMessageUid: "m",
                latestFrom: { address: "a@example.com", type: "to" },
                latestPreview: "",
                latestFolderUid: "f1",
                ...overrides,
            }) as never;
        const ids = (rows: unknown[]) => rows.map((r) => (r as { conversationId: string }).conversationId);

        it("offers every key a thread summary carries a value for, and no other", () => {
            expect(CONVERSATION_SORTS).toEqual(["date", "from", "subject", "flagged"]);
            expect(Object.keys(CONVERSATION_SORT_UNAVAILABLE)).toEqual(["sentDate", "importance"]);
        });

        it("orders by latest activity in both directions", () => {
            const older = row({ conversationId: "older", latestDate: "2026-01-01T00:00:00.000Z" });
            const newer = row({ conversationId: "newer", latestDate: "2026-02-01T00:00:00.000Z" });

            expect(ids(sortConversations([older, newer], "date", "desc"))).toEqual(["newer", "older"]);
            expect(ids(sortConversations([older, newer], "date", "asc"))).toEqual(["older", "newer"]);
        });

        it("orders by the latest sender's name, by subject and by flag, case-insensitively", () => {
            const zoe = row({ conversationId: "zoe", latestFrom: { address: "z@example.com", displayName: "zoe", type: "to" } });
            const amy = row({ conversationId: "amy", latestFrom: { address: "a@example.com", displayName: "Amy", type: "to" } });
            expect(ids(sortConversations([zoe, amy], "from", "asc"))).toEqual(["amy", "zoe"]);

            const beta = row({ conversationId: "beta", subject: "beta" });
            const alpha = row({ conversationId: "alpha", subject: "Alpha" });
            expect(ids(sortConversations([beta, alpha], "subject", "asc"))).toEqual(["alpha", "beta"]);

            const plain = row({ conversationId: "plain" });
            const flagged = row({ conversationId: "flagged", flagged: true });
            expect(ids(sortConversations([plain, flagged], "flagged", "desc"))).toEqual(["flagged", "plain"]);
        });

        it("breaks a tie newest first, whichever direction is in force", () => {
            const older = row({ conversationId: "older", subject: "Same", latestDate: "2026-01-01T00:00:00.000Z" });
            const newer = row({ conversationId: "newer", subject: "Same", latestDate: "2026-02-01T00:00:00.000Z" });

            expect(ids(sortConversations([older, newer], "subject", "asc"))).toEqual(["newer", "older"]);
            expect(ids(sortConversations([older, newer], "subject", "desc"))).toEqual(["newer", "older"]);
        });

        it("leaves the server's own order alone for a key a thread has no value for", () => {
            const first = row({ conversationId: "first", latestDate: "2026-01-01T00:00:00.000Z" });
            const second = row({ conversationId: "second", latestDate: "2026-02-01T00:00:00.000Z" });

            expect(sortConversations([first, second], "sentDate", "asc")).toEqual([first, second]);
            expect(sortConversations([first, second], "importance", "desc")).toEqual([first, second]);
        });

        it("falls back to a sender's address when the latest message has no display name", () => {
            const withName = row({ conversationId: "named", latestFrom: { address: "z@example.com", displayName: "Amy", type: "to" } });
            const withoutName = row({ conversationId: "bare", latestFrom: { address: "bob@example.com", type: "to" } });

            expect(ids(sortConversations([withoutName, withName], "from", "asc"))).toEqual(["named", "bare"]);
        });
    });
});
