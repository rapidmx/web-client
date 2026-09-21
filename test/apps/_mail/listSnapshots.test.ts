// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import {
    LIST_SNAPSHOT_MAX,
    LIST_SNAPSHOT_TTL_MS,
    clearListSnapshots,
    listSnapshotKey,
    readListSnapshot,
    saveListScroll,
    writeListSnapshot,
} from "../../../apps/shared/mail/listSnapshots.js";

const message = (uid: string) => ({ uid }) as Message;
const listing = (uids: string[], selectedUid: string | null = null) => ({
    messages: uids.map(message),
    conversations: [],
    hasMore: false,
    selectedUid,
});

afterEach(() => clearListSnapshots());

describe("listSnapshotKey", () => {
    it("differs by everything that makes one listing different from another", () => {
        const base = { mailboxUid: "m", folderUid: "f", conversations: false, filter: "all", labels: "", sort: "date:desc" };
        const key = listSnapshotKey(base);
        expect(listSnapshotKey({ ...base })).toBe(key);
        for (const changed of [
            { mailboxUid: "m2" },
            { folderUid: "f2" },
            { conversations: true },
            { filter: "unread" },
            { labels: "l1" },
            { sort: "subject:asc" },
        ]) {
            expect(listSnapshotKey({ ...base, ...changed })).not.toBe(key);
        }
    });
});

describe("listing snapshots", () => {
    it("remembers a listing as written and gives it back", () => {
        writeListSnapshot("k", listing(["a", "b"], "b"), 1000);
        expect(readListSnapshot("k", 1000)).toMatchObject({ messages: [{ uid: "a" }, { uid: "b" }], selectedUid: "b", scrollTop: 0, at: 1000 });
    });

    it("has nothing for a listing that was never written", () => {
        expect(readListSnapshot("nothing")).toBeUndefined();
    });

    it("stops giving a snapshot back once it is older than the TTL, and forgets it", () => {
        writeListSnapshot("k", listing(["a"]), 1000);
        expect(readListSnapshot("k", 1000 + LIST_SNAPSHOT_TTL_MS)).toBeDefined();
        expect(readListSnapshot("k", 1000 + LIST_SNAPSHOT_TTL_MS + 1)).toBeUndefined();
        expect(readListSnapshot("k", 1000)).toBeUndefined();
    });

    it("uses the current time by default", () => {
        writeListSnapshot("k", listing(["a"]));
        expect(readListSnapshot("k")).toBeDefined();
    });

    it("keeps the saved scroll position when the listing is written again", () => {
        writeListSnapshot("k", listing(["a"]), 1000);
        saveListScroll("k", 240);
        writeListSnapshot("k", listing(["a", "b"]), 2000);
        expect(readListSnapshot("k", 2000)).toMatchObject({ scrollTop: 240, at: 2000 });
    });

    it("ignores a scroll position for a listing that was never remembered", () => {
        saveListScroll("nothing", 10);
        expect(readListSnapshot("nothing")).toBeUndefined();
    });

    it("drops the least recently written listing beyond the limit", () => {
        for (let i = 0; i < LIST_SNAPSHOT_MAX; i++) {
            writeListSnapshot(`k${i}`, listing([`m${i}`]), 1000);
        }
        // Writing k0 again makes k1 the oldest.
        writeListSnapshot("k0", listing(["m0"]), 1000);
        writeListSnapshot("extra", listing(["x"]), 1000);
        expect(readListSnapshot("k1", 1000)).toBeUndefined();
        expect(readListSnapshot("k0", 1000)).toBeDefined();
        expect(readListSnapshot("extra", 1000)).toBeDefined();
    });

    it("can forget everything", () => {
        writeListSnapshot("k", listing(["a"]));
        clearListSnapshots();
        expect(readListSnapshot("k")).toBeUndefined();
    });
});
