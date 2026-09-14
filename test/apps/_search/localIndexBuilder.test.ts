// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import type { UnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import {
    CLOCK_SKEW_MARGIN_MS,
    FETCH_CONCURRENCY,
    MAX_WALK_ATTEMPTS,
    buildLocalIndex,
    cancelLocalIndexBuild,
} from "../../../apps/shared/search/localIndexBuilder.js";

const { listMessages, listFolders, getMessageRawContent } = vi.hoisted(() => ({
    listMessages: vi.fn(),
    listFolders: vi.fn(),
    getMessageRawContent: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/mail/mailApi.js", () => ({ listMessages, listFolders, getMessageRawContent }));

const { evaluateMessageSecurity } = vi.hoisted(() => ({ evaluateMessageSecurity: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));

const rpc = vi.hoisted(() => ({
    initLocalIndex: vi.fn(),
    setLocalIndexWindow: vi.fn(),
    setLocalIndexBuilding: vi.fn(),
    getIndexedVersions: vi.fn(),
    indexLocalEntities: vi.fn(),
    pruneLocalEntities: vi.fn(),
    nextLocalIndexGeneration: vi.fn(),
}));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => rpc);

vi.mock("../../../apps/shared/search/localIndexKey.js", () => ({ deriveLocalIndexKey: vi.fn(async () => new Uint8Array(32)) }));

const unlocked = { masterKey: new Uint8Array(32) } as UnlockedKeys;
const WINDOW = { timeFloorMonths: 12, byteBudgetBytes: 1_000_000 };
const DAY = 24 * 60 * 60 * 1000;

function folder(uid: string, type: string): Folder {
    return { uid, type, totalCount: 0 } as Folder;
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

function daysAgo(days: number): string {
    return new Date(Date.now() - days * DAY).toISOString();
}

let generation: number;

beforeEach(() => {
    generation = 0;
    rpc.nextLocalIndexGeneration.mockImplementation(() => ++generation);
    rpc.setLocalIndexWindow.mockResolvedValue({});
    rpc.setLocalIndexBuilding.mockResolvedValue(undefined);
    rpc.getIndexedVersions.mockResolvedValue({});
    rpc.indexLocalEntities.mockResolvedValue({ budgetReached: false });
    rpc.pruneLocalEntities.mockResolvedValue(0);
    getMessageRawContent.mockResolvedValue("raw");
    evaluateMessageSecurity.mockResolvedValue({ subject: "Secret subject", html: "<p>héllo</p>" });
    listMessages.mockResolvedValue([]);
    listFolders.mockResolvedValue([]);
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
        const [, entities, passGeneration] = rpc.indexLocalEntities.mock.calls[0];
        expect(passGeneration).toBe(1);
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

    it("walks Archive and custom folders too, prunes unseen rows within the time floor, and records a complete pass with its coverage end", async () => {
        listMessages.mockImplementation(async (folderUid: string) => [message(`${folderUid}-1`, { folderUid })]);
        const before = Date.now();

        await buildLocalIndex(
            "mb1",
            unlocked,
            [folder("archive", "archive"), folder("projects", "user"), folder("inbox", "inbox"), folder("cal", "calendar")],
            WINDOW,
        );

        expect(listMessages.mock.calls.map(([uid]) => uid)).toEqual(["inbox", "archive", "projects"]);
        expect(rpc.initLocalIndex).toHaveBeenCalledWith({ mailboxUid: "mb1", indexKey: expect.any(Uint8Array), generation: 1 });
        expect(rpc.setLocalIndexWindow).toHaveBeenCalledWith("mb1", 12, 1_000_000, 1);
        expect(rpc.setLocalIndexBuilding).toHaveBeenNthCalledWith(1, "mb1", true, { complete: false, generation: 1 });
        expect(rpc.pruneLocalEntities).toHaveBeenCalledWith("mb1", ["inbox-1", "archive-1", "projects-1"], expect.any(String), {
            folderUids: ["inbox", "archive", "projects"],
            generation: 1,
        });
        const cutoff = rpc.pruneLocalEntities.mock.calls[0][2];
        const [, , completion] = rpc.setLocalIndexBuilding.mock.calls.at(-1)!;
        expect(completion).toEqual({ complete: true, coveredFrom: cutoff, coveredUntil: expect.any(String), generation: 1 });
        const coveredUntil = new Date(completion.coveredUntil).getTime();
        expect(coveredUntil).toBeGreaterThanOrEqual(before - CLOCK_SKEW_MARGIN_MS);
        expect(coveredUntil).toBeLessThanOrEqual(Date.now() - CLOCK_SKEW_MARGIN_MS);
    });

    it("walks Inbox and Sent Items first, then every other mail folder in its original order", async () => {
        await buildLocalIndex("mb1", unlocked, [folder("trash", "deleted_items"), folder("archive", "archive"), folder("sent", "sent_items")], WINDOW);

        expect(listMessages.mock.calls.map(([uid]) => uid)).toEqual(["sent", "trash", "archive"]);
    });

    it("records an incomplete pass when it has to skip a folder of a type it doesn't know", async () => {
        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox"), folder("mystery", "something-new")], WINDOW);

        expect(listMessages.mock.calls.map(([uid]) => uid)).toEqual(["inbox"]);
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));
    });

    it("with no time floor, prunes without a date bound", async () => {
        listMessages.mockResolvedValueOnce([message("i1")]);
        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], { timeFloorMonths: 0, byteBudgetBytes: 0 });
        expect(rpc.pruneLocalEntities).toHaveBeenCalledWith("mb1", ["i1"], undefined, { folderUids: ["inbox"], generation: 1 });
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: true, coveredFrom: undefined }));
    });

    describe("folder counts changing mid-walk", () => {
        it("re-walks a folder whose count changed, and trusts it once a walk sees a steady count", async () => {
            let totals = [{ ...folder("inbox", "inbox"), totalCount: 5 }];
            listFolders.mockImplementation(async () => totals);
            listMessages.mockImplementation(async () => {
                // New mail lands during the first walk only.
                const result = [message("i1")];
                totals = [{ ...folder("inbox", "inbox"), totalCount: 6 }];
                return result;
            });
            listMessages.mockImplementationOnce(async () => {
                totals = [{ ...folder("inbox", "inbox"), totalCount: 6 }];
                return [message("i1")];
            });

            await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);

            expect(listMessages).toHaveBeenCalledTimes(2);
            expect(rpc.pruneLocalEntities).toHaveBeenCalledWith("mb1", ["i1"], expect.any(String), { folderUids: ["inbox"], generation: 1 });
            expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: true }));
        });

        it("gives up after MAX_WALK_ATTEMPTS, neither pruning that folder nor claiming completeness, while still pruning the steady ones", async () => {
            let inboxTotal = 0;
            listFolders.mockImplementation(async () => [
                { ...folder("inbox", "inbox"), totalCount: inboxTotal++ },
                { ...folder("sent", "sent_items"), totalCount: 3 },
            ]);
            listMessages.mockImplementation(async (folderUid: string) => [message(`${folderUid}-1`, { folderUid })]);

            await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox"), folder("sent", "sent_items")], WINDOW);

            expect(listMessages.mock.calls.filter(([uid]) => uid === "inbox")).toHaveLength(MAX_WALK_ATTEMPTS);
            expect(listMessages.mock.calls.filter(([uid]) => uid === "sent")).toHaveLength(1);
            expect(rpc.pruneLocalEntities).toHaveBeenCalledWith("mb1", ["inbox-1", "sent-1"], expect.any(String), { folderUids: ["sent"], generation: 1 });
            expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));
        });

        it.each([
            ["before", () => listFolders.mockRejectedValueOnce(new Error("down"))],
            ["after", () => listFolders.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("down"))],
        ])("still indexes, but neither prunes nor claims completeness, when folder counts can't be read %s the walk", async (_when, arrange) => {
            arrange();
            listMessages.mockResolvedValueOnce([message("i1")]);

            await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);

            expect(rpc.indexLocalEntities).toHaveBeenCalledTimes(1);
            expect(listMessages).toHaveBeenCalledTimes(1);
            expect(rpc.pruneLocalEntities).not.toHaveBeenCalled();
            expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));
        });
    });

    describe("eviction watermark", () => {
        it("neither fetches messages older than the watermark nor walks past it, records the pass as incomplete, and prunes only above it", async () => {
            const watermark = daysAgo(30);
            rpc.setLocalIndexWindow.mockResolvedValue({ evictedBefore: watermark });
            // The Worker reports its current watermark with every insert.
            rpc.indexLocalEntities.mockResolvedValue({ budgetReached: true, evictedBefore: watermark });
            listMessages.mockImplementation(async (folderUid: string, { page }: { page: number }) =>
                folderUid === "inbox" && page < 3
                    ? Array.from({ length: 100 }, (_, i) => message(`p${page}-${i}`, { receivedDate: daysAgo(page === 0 ? 1 : i < 50 ? 20 : 40) }))
                    : [],
            );

            await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox"), folder("sent", "sent_items")], WINDOW);

            expect(listMessages.mock.calls.filter(([uid]) => uid === "inbox")).toHaveLength(2);
            expect(getMessageRawContent).toHaveBeenCalledTimes(150);
            expect(listMessages.mock.calls.some(([uid]) => uid === "sent")).toBe(true);
            expect(rpc.pruneLocalEntities).toHaveBeenCalledWith("mb1", expect.any(Array), watermark, { folderUids: ["inbox", "sent"], generation: 1 });
            expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));
        });

        it("picks up a watermark raised mid-walk by an insert", async () => {
            const watermark = daysAgo(30);
            rpc.indexLocalEntities.mockResolvedValue({ budgetReached: true, evictedBefore: watermark });
            listMessages.mockImplementation(async (_folderUid: string, { page }: { page: number }) =>
                page < 3 ? Array.from({ length: 100 }, (_, i) => message(`p${page}-${i}`, { receivedDate: daysAgo(page === 0 ? 1 : 40) })) : [],
            );

            await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);

            // Page 1 is listed, but none of it is fetched and the walk stops there.
            expect(listMessages).toHaveBeenCalledTimes(2);
            expect(getMessageRawContent).toHaveBeenCalledTimes(100);
            expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));
        });

        it("ignores a watermark already older than the time floor", async () => {
            rpc.setLocalIndexWindow.mockResolvedValue({ evictedBefore: daysAgo(800) });
            listMessages.mockImplementation(async (_folderUid: string, { page }: { page: number }) =>
                Array.from({ length: 100 }, (_, i) => message(`p${page}-${i}`, { subject: "plain", receivedDate: daysAgo(page === 1 && i === 99 ? 900 : 1) })),
            );

            await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);

            expect(listMessages).toHaveBeenCalledTimes(2);
            const [, , since] = rpc.pruneLocalEntities.mock.calls[0];
            expect(new Date(since).getTime()).toBeGreaterThan(Date.now() - 400 * DAY);
            expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: true }));
        });
    });

    it("records an incomplete pass when a folder listing or a message fetch fails, but a decrypt failure alone doesn't count", async () => {
        listMessages.mockRejectedValueOnce(new Error("listing down"));
        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));
        expect(rpc.pruneLocalEntities).not.toHaveBeenCalled();

        listMessages.mockResolvedValueOnce([message("m1"), message("m2")]);
        getMessageRawContent.mockRejectedValueOnce(new Error("fetch failed"));
        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));
        // The folder's listing itself was reliable, so its unseen rows can still be pruned.
        expect(rpc.pruneLocalEntities).toHaveBeenCalledTimes(1);

        listMessages.mockResolvedValueOnce([message("m1"), message("m2")]);
        evaluateMessageSecurity.mockRejectedValueOnce(new Error("bad key")).mockResolvedValueOnce({});
        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
        // Only the second pass's one fetchable message was ever indexed; this pass had nothing usable.
        expect(rpc.indexLocalEntities).toHaveBeenCalledTimes(1);
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: true }));
    });

    it("pages back until a page reaches past the time floor", async () => {
        const old = new Date(Date.now() - 400 * DAY).toISOString();
        listMessages.mockImplementation(async (_folderUid: string, { page }: { page: number }) =>
            Array.from({ length: 100 }, (_, i) => message(`p${page}-${i}`, { subject: "plain", receivedDate: page === 1 && i === 99 ? old : new Date().toISOString() })),
        );
        await buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
        expect(listMessages).toHaveBeenCalledTimes(2);
        expect(rpc.getIndexedVersions).not.toHaveBeenCalled();
    });

    it("marks the pass incomplete and rethrows when the index itself fails mid-build, even if recording that fails too", async () => {
        listMessages.mockResolvedValueOnce([message("m1")]);
        rpc.indexLocalEntities.mockRejectedValueOnce(new Error("worker gone"));
        rpc.setLocalIndexBuilding.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("stale"));
        await expect(buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW)).rejects.toThrow("worker gone");
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));
    });

    describe("cancellation", () => {
        function deferred<T>() {
            let resolve!: (value: T) => void;
            const promise = new Promise<T>((res) => {
                resolve = res;
            });
            return { promise, resolve };
        }

        it("a newer pass for the same mailbox cancels the running one and waits for it to stop before starting", async () => {
            const firstPage = deferred<Message[]>();
            listMessages.mockReturnValueOnce(firstPage.promise);
            const first = buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
            await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(1));

            const second = buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
            // Still waiting on the first pass.
            expect(rpc.initLocalIndex).toHaveBeenCalledTimes(1);
            firstPage.resolve(Array.from({ length: 100 }, (_, i) => message(`m${i}`)));

            await expect(first).rejects.toThrow();
            await second;
            // The cancelled pass stopped right after its in-flight fetches, without indexing them.
            expect(rpc.indexLocalEntities).not.toHaveBeenCalled();
            expect(rpc.initLocalIndex).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 2 }));
        });

        it("cancelLocalIndexBuild stops a running pass before its next page, and is a no-op with nothing running", async () => {
            await expect(cancelLocalIndexBuild("mb1")).resolves.toBeUndefined();

            // An endless folder - only cancellation stops this walk. Each page yields to timers.
            listMessages.mockImplementation(async (_folderUid: string, { page }: { page: number }) => {
                await new Promise((resolve) => setTimeout(resolve, 1));
                return Array.from({ length: 100 }, (_, i) => message(`p${page}-${i}`, { subject: "plain" }));
            });
            const running = buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
            await vi.waitFor(() => expect(listMessages).toHaveBeenCalled());
            await cancelLocalIndexBuild("mb1");

            await expect(running).rejects.toThrow();
            const pages = listMessages.mock.calls.length;
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(listMessages).toHaveBeenCalledTimes(pages);
            expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: false }));
        });

        it("stops before opening the index when cancelled while deriving its key", async () => {
            const running = buildLocalIndex("mb1", unlocked, [folder("inbox", "inbox")], WINDOW);
            const cancelled = cancelLocalIndexBuild("mb1");
            await expect(running).rejects.toThrow();
            await cancelled;
            expect(rpc.initLocalIndex).not.toHaveBeenCalled();
        });
    });
});
