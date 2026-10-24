// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";

const { listFolders, listContacts, fetchRecipientSuggestions, openSealedRecords, getUnlockedKeys } = vi.hoisted(() => ({
    listFolders: vi.fn(),
    listContacts: vi.fn(),
    fetchRecipientSuggestions: vi.fn(),
    openSealedRecords: vi.fn(),
    getUnlockedKeys: vi.fn(() => ({ zeroAccessKeys: [{}] }) as any),
}));
vi.mock("../../../lib/mail/mailApi.js", () => ({ listFolders }));
vi.mock("../../../lib/contacts/contactsApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/contacts/contactsApi.js")>()),
    listContacts,
}));
vi.mock("../../../lib/mail/directoryApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/mail/directoryApi.js")>()),
    fetchRecipientSuggestions,
}));
vi.mock("../../../lib/zeroAccess/sealedRecords.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/zeroAccess/sealedRecords.js")>()),
    openSealedRecords,
}));
vi.mock("../../../lib/crypto/keySession.js", () => ({ getUnlockedKeys }));

const { clearProtectedContactNames, fetchSuggestionsWithProtectedContacts, PROTECTED_NAMES_TTL_MS, searchProtectedContactNames } = await import(
    "../../../apps/shared/components/mail/compose/protectedContactSuggestions.js"
);

const protectedContact = (uid: string, address: string) => ({ uid, displayName: address, emails: [{ address, type: "other" }], sealedFields: { displayName: "x" } });

function arrange() {
    listFolders.mockResolvedValue([{ uid: "f-contacts", type: "contacts" }, { uid: "f-inbox", type: "inbox" }]);
    listContacts.mockResolvedValue([protectedContact("c1", "jane@example.com"), { uid: "c2", displayName: "Plain Person", emails: [{ address: "plain@example.com" }] }]);
    openSealedRecords.mockImplementation(async (records: any[]) => records.map((record) => ({ ...record, displayName: "Jane Doe" })));
}

afterEach(() => {
    clearProtectedContactNames();
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe("protectedContactSuggestions", () => {
    it("matches protected contacts by their opened name - only their names are opened - and every address of each", async () => {
        arrange();
        expect(await searchProtectedContactNames("mb1", "jane")).toEqual([{ displayName: "Jane Doe", address: "jane@example.com", kind: "contact" }]);
        expect(openSealedRecords).toHaveBeenCalledWith([expect.objectContaining({ uid: "c1" })], ["displayName"]);
        expect(listContacts).toHaveBeenCalledTimes(1);
        expect(await searchProtectedContactNames("mb1", "nobody")).toEqual([]);
        expect(await searchProtectedContactNames("mb1", "j")).toEqual([]);
        // Read once, then from the cache.
        expect(listContacts).toHaveBeenCalledTimes(1);
    });

    it("reads again after a minute, and once the mailbox has been locked", async () => {
        vi.useFakeTimers({ now: 0 });
        arrange();
        await searchProtectedContactNames("mb1", "jane");
        vi.setSystemTime(PROTECTED_NAMES_TTL_MS + 1);
        await searchProtectedContactNames("mb1", "jane");
        expect(listContacts).toHaveBeenCalledTimes(2);
        getUnlockedKeys.mockReturnValueOnce(undefined);
        expect(await searchProtectedContactNames("mb1", "jane")).toEqual([]);
        expect(listContacts).toHaveBeenCalledTimes(2);
        await searchProtectedContactNames("mb1", "jane");
        expect(listContacts).toHaveBeenCalledTimes(3);
    });

    it("pages through a large contacts folder", async () => {
        listFolders.mockResolvedValue([{ uid: "f-contacts", type: "contacts" }]);
        listContacts.mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => protectedContact(`c${i}`, `p${i}@example.com`))).mockResolvedValueOnce([]);
        openSealedRecords.mockImplementation(async (records: any[]) => records);
        expect(await searchProtectedContactNames("mb1", "p42@")).toHaveLength(1);
        expect(listContacts).toHaveBeenCalledTimes(2);
    });

    it("puts the protected matches before the server's suggestions, and does without them when they can't be read", async () => {
        arrange();
        fetchRecipientSuggestions.mockResolvedValue([{ displayName: "Server Jane", address: "jane@example.com", kind: "correspondent" }, { displayName: "Jan", address: "jan@example.com", kind: "user" }]);
        expect(await fetchSuggestionsWithProtectedContacts("jane", { mailboxUid: "mb1", limit: 5 })).toEqual([
            { displayName: "Jane Doe", address: "jane@example.com", kind: "contact" },
            { displayName: "Jan", address: "jan@example.com", kind: "user" },
        ]);

        clearProtectedContactNames();
        listFolders.mockRejectedValue(new Error("offline"));
        expect((await fetchSuggestionsWithProtectedContacts("jane", { mailboxUid: "mb1" })).map((s) => s.displayName)).toEqual(["Server Jane", "Jan"]);
        expect(await fetchSuggestionsWithProtectedContacts("jane")).toHaveLength(2);
    });
});
