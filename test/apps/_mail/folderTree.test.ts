// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import type { Folder } from "@rapidmx/react-shared/mail/mailApi.js";
import {
    FOLDER_ORDER,
    MAIL_FOLDER_TYPES,
    folderRows,
    isMailFolder,
    knownFolderUids,
    reconcileFolders,
    removeFolder,
    sortFolders,
    upsertFolder,
} from "../../../apps/shared/mail/folderTree.js";

const mailbox = (uid: string) => ({ uid, ownerUserUid: "u1", displayName: uid, primarySmtpAddress: `${uid}@example.com` }) as never;
const folder = (uid: string, type: string, name = type, mailboxUid = "mb1"): Folder =>
    ({ uid, version: 0, dateCreated: "", dateModified: "", mailboxUid, name, type, unreadCount: 0, totalCount: 0 }) as Folder;

const tree = () => [
    { mailbox: mailbox("mb1"), folders: [folder("in", "inbox"), folder("dr", "drafts")] },
    { mailbox: mailbox("mb2"), folders: [folder("in2", "inbox", "Inbox", "mb2")] },
];

describe("the sidebar's order", () => {
    it("is Inbox, Drafts, Outbox, Sent Items, Deleted Items, Junk, Archive, then custom folders by name", () => {
        expect(FOLDER_ORDER).toEqual(["inbox", "drafts", "outbox", "sent_items", "deleted_items", "junk", "archive"]);
        const shuffled = [
            folder("z", "user", "Zed"),
            folder("ar", "archive"),
            folder("ju", "junk"),
            folder("a", "user", "Alpha"),
            folder("se", "sent_items"),
            folder("de", "deleted_items"),
            folder("ou", "outbox"),
            folder("dr", "drafts"),
            folder("in", "inbox"),
        ];
        expect(sortFolders(shuffled).map((f) => f.uid)).toEqual(["in", "dr", "ou", "se", "de", "ju", "ar", "a", "z"]);
        expect(shuffled[0].uid).toBe("z");
    });

    it("lists the well-known mail types plus user folders, and not another app's", () => {
        for (const type of [...FOLDER_ORDER, "user"]) {
            expect(isMailFolder({ type })).toBe(true);
            expect(MAIL_FOLDER_TYPES.has(type)).toBe(true);
        }
        for (const type of ["calendar", "contacts", "tasks", "notes"]) {
            expect(isMailFolder({ type })).toBe(false);
        }
    });
});

describe("folderRows", () => {
    const base = [folder("in", "inbox"), folder("dr", "drafts"), folder("de", "deleted_items")];
    const describeRows = (rows: ReturnType<typeof folderRows>) => rows.map((row) => (row.kind === "folder" ? row.folder.uid : `~${row.type}`));

    it("is just the sorted folders while nothing is being sent", () => {
        expect(describeRows(folderRows([base[2], base[0], base[1]], 0))).toEqual(["in", "dr", "de"]);
    });

    it("adds a placeholder for the Outbox and for Sent Items while a message is on its way, each where it belongs", () => {
        expect(describeRows(folderRows(base, 1))).toEqual(["in", "dr", "~outbox", "~sent_items", "de"]);
        expect(describeRows(folderRows([...base, folder("ju", "junk"), folder("ar", "archive"), folder("p", "user", "Projects")], 2))).toEqual([
            "in",
            "dr",
            "~outbox",
            "~sent_items",
            "de",
            "ju",
            "ar",
            "p",
        ]);
    });

    it("never draws a folder twice: a folder that exists has no placeholder, however many messages are on their way", () => {
        expect(describeRows(folderRows([...base, folder("ou", "outbox")], 3))).toEqual(["in", "dr", "ou", "~sent_items", "de"]);
        expect(describeRows(folderRows([...base, folder("ou", "outbox"), folder("se", "sent_items")], 3))).toEqual(["in", "dr", "ou", "se", "de"]);
        expect(describeRows(folderRows([...base, folder("se", "sent_items")], 1))).toEqual(["in", "dr", "~outbox", "se", "de"]);
    });
});

describe("upsertFolder", () => {
    it("files a folder the tree lacks under its own mailbox and leaves the others alone", () => {
        const before = tree();
        const after = upsertFolder(before, folder("ou", "outbox"));
        expect(after).not.toBe(before);
        expect(after[0].folders.map((f) => f.uid)).toEqual(["in", "dr", "ou"]);
        expect(after[1]).toBe(before[1]);
    });

    it("returns the very same array when the folder is already there unchanged - so nothing on screen starts over", () => {
        const before = tree();
        expect(upsertFolder(before, folder("in", "inbox"))).toBe(before);
        // Counts are not the tree's business: a folder listed with other counts is not a change.
        expect(upsertFolder(before, { ...folder("in", "inbox"), unreadCount: 9, totalCount: 40 })).toBe(before);
    });

    it("ignores a folder Mail does not list, one of a mailbox it does not have, and an update for a folder it does not know", () => {
        const before = tree();
        expect(upsertFolder(before, folder("cal", "calendar"))).toBe(before);
        expect(upsertFolder(before, folder("x", "outbox", "Outbox", "other-mailbox"))).toBe(before);
        expect(upsertFolder(before, { uid: "nobody", name: "New name" })).toBe(before);
        expect(upsertFolder(before, { uid: "nobody", mailboxUid: "mb1", name: "New name" })).toBe(before);
    });

    it("takes a new name, type, parent and colour for a folder it has", () => {
        const before = tree();
        const renamed = upsertFolder(before, { uid: "dr", name: "Drafts (old)" });
        expect(renamed[0].folders[1]).toMatchObject({ uid: "dr", name: "Drafts (old)", type: "drafts" });
        const retyped = upsertFolder(before, { uid: "dr", type: "user", parentFolderUid: "in", color: "#fff" });
        expect(retyped[0].folders[1]).toMatchObject({ type: "user", parentFolderUid: "in", color: "#fff" });
        // Fields left out are not changes.
        expect(upsertFolder(before, { uid: "dr", name: undefined })).toBe(before);
    });

    it("takes a folder out of the tree when it became a type Mail does not list", () => {
        const after = upsertFolder(tree(), { uid: "dr", type: "calendar" });
        expect(after[0].folders.map((f) => f.uid)).toEqual(["in"]);
    });
});

describe("one folder per well-known type", () => {
    const dated = (uid: string, type: string, dateCreated?: string) => ({ ...folder(uid, type), dateCreated }) as Folder;
    const withOutbox = (outbox: Folder) => [{ mailbox: mailbox("mb1"), folders: [folder("in", "inbox"), outbox] }];

    it("does not show a second folder of a well-known type: the older of the two is the one kept (the server answers with the oldest)", () => {
        const older = dated("ou-old", "outbox", "2026-09-01T00:00:00Z");
        const newer = dated("ou-new", "outbox", "2026-09-02T00:00:00Z");
        const tree = withOutbox(older);
        // A newer duplicate is ignored - the very same array, nothing to redraw.
        expect(upsertFolder(tree, newer)).toBe(tree);
        // An older one - the server's real folder, announced after a client made its own - takes its place.
        const replaced = upsertFolder(withOutbox(newer), older);
        expect(replaced[0].folders.map((f) => f.uid)).toEqual(["in", "ou-old"]);
        expect(replaced[0].folders.filter((f) => f.type === "outbox")).toHaveLength(1);
    });

    it("keeps what it has when it cannot tell which is older, and however a listing orders the two", () => {
        const tree = withOutbox(dated("ou-a", "outbox", undefined));
        expect(upsertFolder(tree, dated("ou-b", "outbox", "2026-09-01T00:00:00Z"))).toBe(tree);
        expect(upsertFolder(withOutbox(dated("ou-a", "outbox", "2026-09-01T00:00:00Z")), dated("ou-b", "outbox", "not a date"))[0].folders).toHaveLength(2);
        const older = dated("ou-old", "outbox", "2026-09-01T00:00:00Z");
        const newer = dated("ou-new", "outbox", "2026-09-02T00:00:00Z");
        const start = [{ mailbox: mailbox("mb1"), folders: [folder("in", "inbox")] }];
        expect(reconcileFolders(start, [older, newer])[0].folders.map((f) => f.uid)).toEqual(["in", "ou-old"]);
        expect(reconcileFolders(start, [newer, older])[0].folders.map((f) => f.uid)).toEqual(["in", "ou-old"]);
    });

    it("lets a mailbox have as many of the user's own folders as it likes", () => {
        const tree = upsertFolder(upsertFolder(tree0(), folder("u1", "user", "Projects")), folder("u2", "user", "Travel"));
        expect(tree[0].folders.filter((f) => f.type === "user")).toHaveLength(2);
    });

    function tree0() {
        return [{ mailbox: mailbox("mb1"), folders: [folder("in", "inbox")] }];
    }
});

describe("removeFolder, reconcileFolders and knownFolderUids", () => {
    it("removes a deleted folder from whichever mailbox has it, and is the same array when it has none", () => {
        const before = tree();
        const after = removeFolder(before, "dr");
        expect(after[0].folders.map((f) => f.uid)).toEqual(["in"]);
        expect(after[1]).toBe(before[1]);
        expect(removeFolder(before, "nobody")).toBe(before);
    });

    it("files every folder a listing has that the tree lacks and takes changed names, without removing anything", () => {
        const before = tree();
        const after = reconcileFolders(before, [
            folder("in", "inbox"),
            folder("ou", "outbox"),
            folder("se", "sent_items"),
            folder("ju", "junk", "Junk Email"),
            folder("cal", "calendar"),
            folder("dr", "drafts", "Renamed"),
        ]);
        expect(after[0].folders.map((f) => f.uid)).toEqual(["in", "dr", "ou", "se", "ju"]);
        expect(after[0].folders.find((f) => f.uid === "dr")?.name).toBe("Renamed");
        // A listing that lacks a folder (it began before that folder was made) takes nothing out.
        expect(reconcileFolders(after, [folder("in", "inbox")])).toBe(after);
        expect(reconcileFolders(before, [])).toBe(before);
    });

    it("knows every uid in the tree", () => {
        expect([...knownFolderUids(tree())].sort()).toEqual(["dr", "in", "in2"]);
        expect(knownFolderUids([]).size).toBe(0);
    });
});
