// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import type { UnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import { FETCH_CONCURRENCY, buildLocalIndex } from "../../../apps/shared/search/localIndexBuilder.js";

const { listMessages, getMessageRawContent } = vi.hoisted(() => ({ listMessages: vi.fn(), getMessageRawContent: vi.fn() }));
vi.mock("@rapidmx/react-shared/mail/mailApi.js", () => ({ listMessages, getMessageRawContent }));

const { evaluateMessageSecurity } = vi.hoisted(() => ({ evaluateMessageSecurity: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));

const rpc = vi.hoisted(() => ({
    initLocalIndex: vi.fn(),
    setLocalIndexWindow: vi.fn(),
    setLocalIndexBuilding: vi.fn(),
    getIndexedVersions: vi.fn(),
    indexLocalEntities: vi.fn(),
    pruneLocalEntities: vi.fn(),
}));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => rpc);

vi.mock("../../../apps/shared/search/localIndexKey.js", () => ({ deriveLocalIndexKey: vi.fn(async () => new Uint8Array(32)) }));

const unlocked = { masterKey: new Uint8Array(32) } as UnlockedKeys;
const WINDOW = { timeFloorMonths: 12, byteBudgetBytes: 1_000_000 };

function folder(uid: string, type: string): Folder {
    return { uid, type } as Folder;
}

function message(uid: string, overrides: Partial<Message> = {}): Message {
    return {
        uid,
        version: 1,
        folderUid: "inbox",
        mailboxUid: "mb1",
        subject: "[...]",
        from: { address: "alice@example.com", displayName: "Alice" },
        recipients: [{ address: "bob@example.com" }],
        receivedDate: new Date().toISOString(),
        flags: { read: true, flagged: false },
        hasAttachments: false,
        ...overrides,
    } as Message;
}

beforeEach(() => {
    rpc.getIndexedVersions.mockResolvedValue({});
    rpc.indexLocalEntities.mockResolvedValue({ budgetReached: false });
    rpc.pruneLocalEntities.mockResolvedValue(0);
    getMessageRawContent.mockResolvedValue("raw");
    evaluateMessageSecurity.mockResolvedValue({ subject: "Secret subject", html: "<p>héllo</p>" });
    listMessages.mockResolvedValue([]);
});

describe("buildLocalIndex", () => {
    it("indexes only changed encrypted messages, skipping ones already indexed at the same version and folder", async () => {
        listMessages.mockImplementation(async (folderUid: string) =>
            folderUid === "inbox"
                ? [message("same"), message("newer", { version: 2 }), message("moved", { folderUid: "inbox" }), message("plain", { subject: "Hi" })]
                : [],
        );
        rpc.getIndexedVersions.mockResolvedValue({ same: "1:inbox", newer: "1:inbox", moved: "1:sent" });

        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);

        expect(rpc.getIndexedVersions).toHaveBeenCalledWith("mb1", ["same", "newer", "moved"]);
        expect(getMessageRawContent.mock.calls.map(([uid]) => uid)).toEqual(["newer", "moved"]);
        const [, entities] = rpc.indexLocalEntities.mock.calls[0];
        expect(entities.map((e: { entityUid: string; entityVersion: string }) => [e.entityUid, e.entityVersion])).toEqual([
            ["newer", "2:inbox"],
            ["moved", "1:inbox"],
        ]);
        // UTF-8 bytes, not UTF-16 code units: "é" is 2 bytes.
        expect(entities[0].byteSize).toBe(new TextEncoder().encode("Secret subject<p>héllo</p>alice@example.com Alice bob@example.com").length + 512);
    });

    it("never runs more than FETCH_CONCURRENCY fetch/decrypts at once", async () => {
        listMessages.mockImplementation(async (folderUid: string) =>
            folderUid === "inbox" ? Array.from({ length: 40 }, (_, i) => message(`m${i}`)) : [],
        );
        let inFlight = 0;
        let peak = 0;
        getMessageRawContent.mockImplementation(async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 1));
            inFlight -= 1;
            return "raw";
        });

        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);

        expect(getMessageRawContent).toHaveBeenCalledTimes(40);
        expect(peak).toBe(FETCH_CONCURRENCY);
    });

    it("walks Archive too, prunes unseen rows within the time floor, and records a complete pass", async () => {
        listMessages.mockImplementation(async (folderUid: string) => (folderUid === "archive" ? [message("a1", { folderUid: "archive" })] : [message("i1")]));

        await buildLocalIndex("mb1", unlocked, [folder("archive", "archive"), folder("inbox", "inbox"), folder("cal", "calendar")], WINDOW);

        expect(listMessages.mock.calls.map(([uid]) => uid)).toEqual(["inbox", "archive"]);
        expect(rpc.pruneLocalEntities).toHaveBeenCalledWith("mb1", ["i1", "a1"], expect.any(String));
        const [, cutoff] = rpc.pruneLocalEntities.mock.calls[0].slice(1);
        expect(rpc.setLocalIndexBuilding).toHaveBeenNthCalledWith(1, "mb1", true);
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, { complete: true, coveredFrom: cutoff });
    });

    it("walks Inbox and Sent Items first, then every other mail folder in its original order", async () => {
        listMessages.mockResolvedValue([]);

        await buildLocalIndex("mb1", unlocked, [folder("trash", "deleted_items"), folder("archive", "archive"), folder("sent", "sent_items")], WINDOW);

        expect(listMessages.mock.calls.map(([uid]) => uid)).toEqual(["sent", "trash", "archive"]);
    });

    it("with no time floor, prunes without a date bound", async () => {
        listMessages.mockResolvedValueOnce([message("i1")]);
        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], { timeFloorMonths: 0, byteBudgetBytes: 0 });
        expect(rpc.pruneLocalEntities).toHaveBeenCalledWith("mb1", ["i1"], undefined);
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, { complete: true, coveredFrom: undefined });
    });

    it("stops walking a folder once the byte budget starts evicting, and records the pass as incomplete without pruning", async () => {
        listMessages.mockImplementation(async (folderUid: string, { page }: { page: number }) =>
            folderUid === "inbox" && page < 3 ? Array.from({ length: 100 }, (_, i) => message(`p${page}-${i}`)) : [],
        );
        rpc.indexLocalEntities.mockResolvedValue({ budgetReached: true });

        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox"), folder("sent", "sent_items")], WINDOW);

        expect(listMessages.mock.calls.filter(([uid]) => uid === "inbox")).toHaveLength(1);
        expect(listMessages.mock.calls.some(([uid]) => uid === "sent")).toBe(true);
        expect(rpc.pruneLocalEntities).not.toHaveBeenCalled();
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));
    });

    it("records an incomplete pass when a folder listing or a message fetch fails, but a decrypt failure alone doesn't count", async () => {
        listMessages.mockRejectedValueOnce(new Error("listing down"));
        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));

        listMessages.mockResolvedValueOnce([message("m1"), message("m2")]);
        getMessageRawContent.mockRejectedValueOnce(new Error("fetch failed"));
        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));

        listMessages.mockResolvedValueOnce([message("m1"), message("m2")]);
        evaluateMessageSecurity.mockRejectedValueOnce(new Error("bad key")).mockResolvedValueOnce({});
        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
        // Only the second pass's one fetchable message was ever indexed; this pass had nothing usable.
        expect(rpc.indexLocalEntities).toHaveBeenCalledTimes(1);
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: true }));
    });

    it("pages back until a page reaches past the time floor", async () => {
        const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
        listMessages.mockImplementation(async (_folderUid: string, { page }: { page: number }) =>
            Array.from({ length: 100 }, (_, i) => message(`p${page}-${i}`, { subject: "plain", receivedDate: page === 1 && i === 99 ? old : new Date().toISOString() })),
        );
        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
        expect(listMessages).toHaveBeenCalledTimes(2);
        expect(rpc.getIndexedVersions).not.toHaveBeenCalled();
    });

    it("marks the pass incomplete and rethrows when the index itself fails mid-build", async () => {
        listMessages.mockResolvedValueOnce([message("m1")]);
        rpc.indexLocalEntities.mockRejectedValueOnce(new Error("worker gone"));
        await expect(buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW)).rejects.toThrow("worker gone");
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));
    });
});
