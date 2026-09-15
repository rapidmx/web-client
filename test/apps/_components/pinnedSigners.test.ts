///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    CONTACTS_CACHE_TTL_MS,
    clearPinnedSignerCache,
    getPinnedSignerFingerprints,
    getSignerKeyState,
} from "../../../apps/shared/components/mail/pinnedSigners.js";

const { listContacts, listFolders } = vi.hoisted(() => ({ listContacts: vi.fn(), listFolders: vi.fn() }));
vi.mock("@rapidmx/react-shared/contacts/contactsApi.js", async (importOriginal) => ({
    // pinnedSigningFingerprintsFor() and the page constants stay real.
    ...(await importOriginal<typeof import("@rapidmx/react-shared/contacts/contactsApi.js")>()),
    listContacts,
}));
vi.mock("@rapidmx/react-shared/mail/mailApi.js", () => ({ listFolders }));
const { keySessionListeners } = vi.hoisted(() => ({
    keySessionListeners: new Set<(event: { mailboxUid: string; state: "locked" | "unlocked" }) => void>(),
}));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({
    subscribeKeySession: (listener: (event: { mailboxUid: string; state: "locked" | "unlocked" }) => void) => {
        keySessionListeners.add(listener);
        return () => keySessionListeners.delete(listener);
    },
}));

function contact(address: string, fingerprints: string[]) {
    return {
        emails: [{ address }],
        keys: fingerprints.map((fingerprint) => ({ useType: "sign", fingerprint })),
    };
}

const filler = (count: number) => Array.from({ length: count }, (_, i) => contact(`other${i}@example.com`, []));

afterEach(() => {
    clearPinnedSignerCache();
    listContacts.mockReset();
    listFolders.mockReset();
    vi.restoreAllMocks();
});

describe("getPinnedSignerFingerprints", () => {
    it("reads pinned signing keys from every contacts folder of the mailbox, paging until a short page", async () => {
        listFolders.mockResolvedValue([
            { uid: "f-inbox", type: "inbox" },
            { uid: "f-c1", type: "contacts" },
            { uid: "f-c2", type: "contacts" },
        ]);
        listContacts.mockImplementation(async (folderUid: string, { page }: { page: number }) => {
            if (folderUid === "f-c1") return page === 0 ? filler(500) : [contact("Sender@Example.com", ["AA11"])];
            return [contact("sender@example.com", ["bb22", "aa11"])];
        });

        expect(await getPinnedSignerFingerprints("mb1", "sender@example.com")).toEqual(["aa11", "bb22"]);
        expect(listFolders).toHaveBeenCalledWith("mb1");
        expect(listContacts.mock.calls).toEqual([
            ["f-c1", { limit: 500, page: 0 }],
            ["f-c1", { limit: 500, page: 1 }],
            ["f-c2", { limit: 500, page: 0 }],
        ]);
    });

    it("stops at the page cap", async () => {
        listFolders.mockResolvedValue([{ uid: "f-c1", type: "contacts" }]);
        listContacts.mockResolvedValue(filler(500));

        expect(await getPinnedSignerFingerprints("mb1", "sender@example.com")).toEqual([]);
        expect(listContacts).toHaveBeenCalledTimes(20);
    });

    it("reuses a mailbox's contacts until the cache expires", async () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
        listFolders.mockResolvedValue([{ uid: "f-c1", type: "contacts" }]);
        listContacts.mockResolvedValue([contact("a@example.com", ["a1"]), contact("b@example.com", ["b1"])]);

        expect(await getPinnedSignerFingerprints("mb1", "a@example.com")).toEqual(["a1"]);
        now.mockReturnValue(1_000 + CONTACTS_CACHE_TTL_MS);
        expect(await getPinnedSignerFingerprints("mb1", "b@example.com")).toEqual(["b1"]);
        expect(listFolders).toHaveBeenCalledTimes(1);

        now.mockReturnValue(1_001 + CONTACTS_CACHE_TTL_MS);
        await getPinnedSignerFingerprints("mb1", "a@example.com");
        expect(listFolders).toHaveBeenCalledTimes(2);
    });

    it("doesn't cache a failed load", async () => {
        listFolders.mockRejectedValueOnce(new Error("down")).mockResolvedValue([]);

        await expect(getPinnedSignerFingerprints("mb1", "a@example.com")).rejects.toThrow("down");
        expect(await getPinnedSignerFingerprints("mb1", "a@example.com")).toEqual([]);
        expect(listFolders).toHaveBeenCalledTimes(2);
    });

    it("a late failure doesn't evict a newer cache entry", async () => {
        let failFirst!: (err: Error) => void;
        listFolders.mockReturnValueOnce(new Promise((_resolve, reject) => (failFirst = reject))).mockResolvedValue([]);

        const first = getPinnedSignerFingerprints("mb1", "a@example.com");
        clearPinnedSignerCache();
        expect(await getPinnedSignerFingerprints("mb1", "a@example.com")).toEqual([]);
        failFirst(new Error("down"));
        await expect(first).rejects.toThrow("down");

        await getPinnedSignerFingerprints("mb1", "a@example.com");
        expect(listFolders).toHaveBeenCalledTimes(2);
    });

    it("drops the cache when any key session locks, subscribing only once", async () => {
        listFolders.mockResolvedValue([{ uid: "f-c1", type: "contacts" }]);
        listContacts.mockResolvedValue([contact("a@example.com", ["a1"])]);

        await getPinnedSignerFingerprints("mb1", "a@example.com");
        await getPinnedSignerFingerprints("mb1", "a@example.com");
        expect(listFolders).toHaveBeenCalledTimes(1);
        expect(keySessionListeners.size).toBe(1);

        // An unlock keeps the cache; a lock (of any mailbox) drops it.
        for (const listener of keySessionListeners) listener({ mailboxUid: "mb2", state: "unlocked" });
        await getPinnedSignerFingerprints("mb1", "a@example.com");
        expect(listFolders).toHaveBeenCalledTimes(1);

        for (const listener of keySessionListeners) listener({ mailboxUid: "mb2", state: "locked" });
        listContacts.mockResolvedValue([]);
        expect(await getPinnedSignerFingerprints("mb1", "a@example.com")).toEqual([]);
        expect(listFolders).toHaveBeenCalledTimes(2);
        expect(keySessionListeners.size).toBe(1);
    });
});

describe("getSignerKeyState", () => {
    const signKey = (fingerprint: string, notBefore = 100) => ({ useType: "sign", fingerprint, notBefore });

    it("merges the sender's contacts, pointing at the contact holding the first pinned key and dating it", async () => {
        listFolders.mockResolvedValue([{ uid: "f-c1", type: "contacts" }]);
        const conflict = { useType: "sign", observedKey: signKey("new"), observedAt: 5, source: "header" };
        listContacts.mockResolvedValue([
            { uid: "c-other", emails: [{ address: "other@example.com" }], keys: [signKey("zz")] },
            { uid: "c-nokeys", emails: [{ address: "Sender@example.com" }] },
            {
                uid: "c-holder",
                emails: [{ address: "sender@example.com" }],
                keys: [{ useType: "encrypt", fingerprint: "enc" }, signKey("old")],
                keysFirstSeen: 42,
                keyConflicts: [conflict],
            },
        ]);

        const state = await getSignerKeyState("mb1", " SENDER@example.com ");

        expect(state.pinned.map((key) => key.fingerprint)).toEqual(["old"]);
        expect(state.conflict).toEqual(conflict);
        expect(state.contactUid).toBe("c-holder");
        expect(state.pinnedSince).toBe(42);
    });

    it("points at the contact with a conflict when nothing is pinned, else the first match, else none", async () => {
        listFolders.mockResolvedValue([{ uid: "f-c1", type: "contacts" }]);
        listContacts.mockResolvedValue([
            { uid: "c-first", emails: [{ address: "a@example.com" }], keys: [{ useType: "encrypt", fingerprint: "enc" }] },
            {
                uid: "c-conflict",
                emails: [{ address: "a@example.com" }],
                keyConflicts: [{ useType: "encrypt", observedKey: {}, observedAt: 1, source: "discovery" }, { useType: "sign", observedKey: signKey("n"), observedAt: 1, source: "discovery" }],
            },
            { uid: "c-b", emails: [{ address: "b@example.com" }], keyConflicts: [{ useType: "encrypt", observedKey: {}, observedAt: 1, source: "discovery" }] },
        ]);

        const withConflict = await getSignerKeyState("mb1", "a@example.com");
        expect(withConflict.contactUid).toBe("c-conflict");
        expect(withConflict).not.toHaveProperty("pinnedSince");

        expect((await getSignerKeyState("mb1", "b@example.com")).contactUid).toBe("c-b");
        expect(await getSignerKeyState("mb1", "nobody@example.com")).toEqual({ pinned: [], previous: [] });
        expect(listFolders).toHaveBeenCalledTimes(1);
    });

    it("rejects when the contacts can't be loaded", async () => {
        listFolders.mockRejectedValue(new Error("down"));
        await expect(getSignerKeyState("mb1", "a@example.com")).rejects.toThrow("down");
    });
});
