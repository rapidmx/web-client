// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_MAIL_LIST_PREFERENCES,
    defaultSortOrder,
    getMailListPreferences,
    setMailListPreferences,
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
});
