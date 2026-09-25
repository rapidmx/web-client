// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import type { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import {
    isOwnMailbox,
    isSharedMailbox,
    orderMailboxes,
    ownMailboxes,
    primaryMailbox,
    primaryMailboxUid,
} from "../../../apps/shared/mail/primaryMailbox.js";

const ME = "u-me";

function mailbox(uid: string, extra: Partial<Mailbox> = {}): Mailbox {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        ownerUserUid: ME,
        accessRole: "owner",
        primarySmtpAddress: `${uid}@example.com`,
        aliasAddresses: [],
        displayName: uid,
        timezone: "UTC",
        quotaBytes: 0,
        usedBytes: 0,
        ...extra,
    };
}
/** An ownerless (organization) mailbox the caller was granted. */
const orgMailbox = (uid: string, extra: Partial<Mailbox> = {}) => mailbox(uid, { ownerUserUid: undefined, accessRole: "delegate", ...extra });
/** Somebody else's mailbox, delegated to the caller. */
const delegated = (uid: string, extra: Partial<Mailbox> = {}) => mailbox(uid, { ownerUserUid: "u-other", accessRole: "delegate", ...extra });
const uids = (list: Mailbox[]) => list.map((mb) => mb.uid);

describe("isOwnMailbox", () => {
    it("is true only for a mailbox the signed-in user owns", () => {
        expect(isOwnMailbox(mailbox("a"), ME)).toBe(true);
        expect(isOwnMailbox(delegated("a"), ME)).toBe(false);
        expect(isOwnMailbox(orgMailbox("a"), ME)).toBe(false);
    });

    it("is false while the user isn't known - an ownerless mailbox is not 'undefined's'", () => {
        expect(isOwnMailbox(mailbox("a"), undefined)).toBe(false);
        expect(isOwnMailbox(orgMailbox("a"), undefined)).toBe(false);
    });
});

describe("isSharedMailbox", () => {
    it("is false for the user's own mailbox, whatever the server says of its access", () => {
        expect(isSharedMailbox(mailbox("a"), ME)).toBe(false);
        expect(isSharedMailbox(mailbox("a", { accessRole: "delegate" }), ME)).toBe(false);
    });

    it("is true for an ownerless mailbox and for somebody else's shared with the user", () => {
        expect(isSharedMailbox(orgMailbox("a"), ME)).toBe(true);
        expect(isSharedMailbox(delegated("a"), ME)).toBe(true);
    });

    it("trusts the server's word that the caller reaches a mailbox as its owner", () => {
        expect(isSharedMailbox(mailbox("a", { ownerUserUid: "u-other" }), ME)).toBe(false);
    });

    it("without the server's word, treats a mailbox that isn't the known user's as shared", () => {
        expect(isSharedMailbox(mailbox("a", { ownerUserUid: "u-other", accessRole: undefined }), ME)).toBe(true);
    });

    it("without the server's word or a known user, goes by whether the mailbox has an owner", () => {
        expect(isSharedMailbox(mailbox("a", { accessRole: undefined }), undefined)).toBe(false);
        expect(isSharedMailbox(mailbox("a", { ownerUserUid: undefined, accessRole: undefined }), undefined)).toBe(true);
    });
});

describe("ownMailboxes", () => {
    it("lists only the user's own, the earliest created first, keeping the given order for ones created together", () => {
        const list = [
            orgMailbox("shared"),
            mailbox("late", { dateCreated: "2026-03-01T00:00:00.000Z" }),
            mailbox("tie-1", { dateCreated: "2026-02-01T00:00:00.000Z" }),
            mailbox("early", { dateCreated: "2026-01-01T00:00:00.000Z" }),
            mailbox("tie-2", { dateCreated: "2026-02-01T00:00:00.000Z" }),
        ];
        expect(uids(ownMailboxes(list, ME))).toEqual(["early", "tie-1", "tie-2", "late"]);
    });

    it("puts a mailbox with no readable creation date after the dated ones", () => {
        const list = [mailbox("undated", { dateCreated: "" }), mailbox("dated")];
        expect(uids(ownMailboxes(list, ME))).toEqual(["dated", "undated"]);
    });

    it("does not reorder the list it is given", () => {
        const list = [mailbox("b", { dateCreated: "2026-02-01T00:00:00.000Z" }), mailbox("a")];
        ownMailboxes(list, ME);
        expect(uids(list)).toEqual(["b", "a"]);
    });
});

describe("primaryMailbox", () => {
    it("is the user's own mailbox, even when a shared one is listed (or sorts) first", () => {
        const list = [orgMailbox("hello", { displayName: "Hello" }), mailbox("jp", { displayName: "Jean-Philippe" })];
        expect(primaryMailbox(list, ME)?.uid).toBe("jp");
        expect(primaryMailboxUid(list, ME)).toBe("jp");
    });

    it("is the earliest created when the user owns several", () => {
        const list = [mailbox("second", { dateCreated: "2026-05-01T00:00:00.000Z" }), delegated("d"), mailbox("first", { dateCreated: "2026-01-01T00:00:00.000Z" })];
        expect(primaryMailboxUid(list, ME)).toBe("first");
    });

    it("is the first mailbox that isn't shared when the user owns none they can be matched to", () => {
        const list = [orgMailbox("org"), mailbox("theirs", { ownerUserUid: "u-x" }), mailbox("also", { ownerUserUid: "u-y" })];
        // The user isn't known yet, so nothing is 'own'; both non-ownerless ones say they are reached as the owner.
        expect(primaryMailboxUid(list, undefined)).toBe("theirs");
    });

    it("is the first mailbox there is when every one is shared", () => {
        const list = [orgMailbox("org-1"), delegated("d"), orgMailbox("org-2")];
        expect(primaryMailboxUid(list, ME)).toBe("org-1");
    });

    it("is undefined without any mailbox", () => {
        expect(primaryMailbox([], ME)).toBeUndefined();
        expect(primaryMailboxUid([], ME)).toBeUndefined();
    });
});

describe("orderMailboxes", () => {
    it("puts the primary mailbox first, the user's other mailboxes next and the shared ones last, each group by name", () => {
        const list = [
            orgMailbox("hello", { displayName: "Hello" }),
            delegated("boss", { displayName: "Boss" }),
            mailbox("zed", { displayName: "Zed", dateCreated: "2026-06-01T00:00:00.000Z" }),
            mailbox("alpha", { displayName: "alpha", dateCreated: "2026-05-01T00:00:00.000Z" }),
            mailbox("jp", { displayName: "Jean-Philippe", dateCreated: "2025-01-01T00:00:00.000Z" }),
            orgMailbox("accounting", { displayName: "Accounting" }),
        ];
        expect(uids(orderMailboxes(list, ME))).toEqual(["jp", "alpha", "zed", "accounting", "boss", "hello"]);
    });

    it("is the same whatever order the server lists them in", () => {
        const list = [mailbox("jp", { displayName: "Jean-Philippe" }), orgMailbox("hello", { displayName: "Hello" }), orgMailbox("info", { displayName: "Info" })];
        const expected = ["jp", "hello", "info"];
        expect(uids(orderMailboxes(list, ME))).toEqual(expected);
        expect(uids(orderMailboxes([...list].reverse(), ME))).toEqual(expected);
    });

    it("breaks a tie on name by address, and copes with a mailbox that gives neither", () => {
        const list = [
            mailbox("me"),
            orgMailbox("b", { displayName: "Team", primarySmtpAddress: "b@example.com" }),
            orgMailbox("a", { displayName: "Team", primarySmtpAddress: "a@example.com" }),
            orgMailbox("n2", { displayName: undefined, primarySmtpAddress: undefined }),
            orgMailbox("n1", { displayName: undefined, primarySmtpAddress: undefined }),
        ];
        // The nameless ones sort first (empty name) and keep their order between them.
        expect(uids(orderMailboxes(list, ME))).toEqual(["me", "n2", "n1", "a", "b"]);
    });

    it("does not change the list it is given, and gives one back for none", () => {
        const list = [orgMailbox("hello"), mailbox("jp")];
        expect(uids(orderMailboxes(list, ME))).toEqual(["jp", "hello"]);
        expect(uids(list)).toEqual(["hello", "jp"]);
        expect(orderMailboxes([], ME)).toEqual([]);
    });
});
