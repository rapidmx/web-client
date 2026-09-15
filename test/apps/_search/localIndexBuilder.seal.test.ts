// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Verification sealing during a local index build pass: which messages are evaluated with seal options, the pins used,
// and the bounds on seal writes (concurrency, per-pass cap, locks, aborts, errors). The rest of the pass is covered in
// localIndexBuilder.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import type { UnlockedKeys } from "@rapidmx/react-shared/crypto/keySession.js";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    MAX_SEAL_WRITES_PER_PASS,
    SEAL_WRITE_CONCURRENCY,
    buildLocalIndex,
    cancelLocalIndexBuild,
} from "../../../apps/shared/search/localIndexBuilder.js";
import { clearVerificationSealCache } from "../../../apps/shared/components/mail/verificationSeals.js";

const { listMessages, listFolders, getMessageRawContent, setMessageVerificationSeal } = vi.hoisted(() => ({
    listMessages: vi.fn(),
    listFolders: vi.fn(),
    getMessageRawContent: vi.fn(),
    setMessageVerificationSeal: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/mail/mailApi.js", () => ({ listMessages, listFolders, getMessageRawContent, setMessageVerificationSeal }));

const { evaluateMessageSecurity, evaluateMessageSecurityWithSeal } = vi.hoisted(() => ({
    evaluateMessageSecurity: vi.fn(),
    evaluateMessageSecurityWithSeal: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity, evaluateMessageSecurityWithSeal }));

const { getKeyVault, getPinnedSignerFingerprints } = vi.hoisted(() => ({ getKeyVault: vi.fn(), getPinnedSignerFingerprints: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", () => ({ getKeyVault }));
vi.mock("../../../apps/shared/components/mail/pinnedSigners.js", () => ({ getPinnedSignerFingerprints }));

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

const WINDOW = { timeFloorMonths: 12, byteBudgetBytes: 1_000_000 };
const INBOX = { uid: "inbox", type: "inbox", totalCount: 0 } as Folder;
let unlocked: UnlockedKeys;

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
        flags: { read: true },
        hasAttachments: false,
        ...overrides,
    } as Message;
}

/** A single-folder mailbox holding `messages`, listed 100 per page. */
function mailbox(messages: Message[]) {
    listMessages.mockImplementation(async (_folderUid: string, { page }: { page: number }) => messages.slice(page * 100, (page + 1) * 100));
}

const decrypted = { state: "encrypted_verified", subject: "Secret", html: "<p>secret</p>" };

beforeEach(() => {
    unlocked = { masterKey: new Uint8Array(32) };
    let generation = 0;
    rpc.nextLocalIndexGeneration.mockImplementation(() => ++generation);
    rpc.setLocalIndexWindow.mockResolvedValue({});
    rpc.setLocalIndexBuilding.mockResolvedValue(undefined);
    rpc.getIndexedVersions.mockResolvedValue({});
    rpc.indexLocalEntities.mockResolvedValue({});
    rpc.pruneLocalEntities.mockResolvedValue(0);
    listFolders.mockResolvedValue([]);
    getMessageRawContent.mockImplementation(async (uid: string) => `raw ${uid}`);
    getKeyVault.mockResolvedValue({ masterKeyGeneration: 2 });
    getPinnedSignerFingerprints.mockResolvedValue(["pin-alice"]);
    evaluateMessageSecurity.mockResolvedValue(decrypted);
    evaluateMessageSecurityWithSeal.mockImplementation(async (_raw: string, _keys: unknown, _pins: unknown, _reader: unknown, options: { messageUid: string }) => ({
        ...decrypted,
        sealToWrite: { seal: `seal-${options.messageUid}`, masterKeyGeneration: 2 },
    }));
    setMessageVerificationSeal.mockResolvedValue({});
});

afterEach(() => {
    clearVerificationSealCache();
    vi.resetAllMocks();
});

function indexedUids(): string[] {
    return rpc.indexLocalEntities.mock.calls.flatMap(([, entities]) => entities.map((e: { entityUid: string }) => e.entityUid));
}

describe("buildLocalIndex: verification seals", () => {
    it("seals decrypted messages without a current-generation seal, with the sender's pins looked up once per pass", async () => {
        mailbox([
            message("none"),
            message("older", { verificationSeal: "seal-old", verificationSealGeneration: 1 }),
            message("current", { verificationSeal: "seal-current", verificationSealGeneration: 2 }),
            message("carol", { from: { address: "Carol@example.com" } as Message["from"] }),
            message("carol2", { from: { address: "carol@example.com" } as Message["from"] }),
            message("plain", { subject: "Not encrypted", hasAttachments: true }),
        ]);
        getPinnedSignerFingerprints.mockImplementation(async (_mailboxUid: string, address: string) => (address.toLowerCase().startsWith("carol") ? [] : ["pin-alice"]));

        await buildLocalIndex("mb1", unlocked, [INBOX], WINDOW);

        const byUid = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]));
        expect(evaluateMessageSecurityWithSeal.mock.calls.map((call) => [call[0], call[1], call[2], call[3], call[4]]).sort(byUid)).toEqual([
            ["raw carol", unlocked, undefined, undefined, { mailboxUid: "mb1", messageUid: "carol", seal: undefined, sealGeneration: undefined, masterKeyGeneration: 2 }],
            ["raw carol2", unlocked, undefined, undefined, { mailboxUid: "mb1", messageUid: "carol2", seal: undefined, sealGeneration: undefined, masterKeyGeneration: 2 }],
            ["raw none", unlocked, ["pin-alice"], undefined, { mailboxUid: "mb1", messageUid: "none", seal: undefined, sealGeneration: undefined, masterKeyGeneration: 2 }],
            ["raw older", unlocked, ["pin-alice"], undefined, { mailboxUid: "mb1", messageUid: "older", seal: "seal-old", sealGeneration: 1, masterKeyGeneration: 2 }],
        ]);
        expect(evaluateMessageSecurity).toHaveBeenCalledWith("raw current", unlocked);
        expect(getPinnedSignerFingerprints).toHaveBeenCalledTimes(2);
        expect(getPinnedSignerFingerprints).toHaveBeenCalledWith("mb1", "alice@example.com");
        expect(getPinnedSignerFingerprints).toHaveBeenCalledWith("mb1", "Carol@example.com");
        expect(getKeyVault).toHaveBeenCalledTimes(1);
        expect(setMessageVerificationSeal.mock.calls.sort(byUid)).toEqual([
            ["carol", "seal-carol", 2],
            ["carol2", "seal-carol2", 2],
            ["none", "seal-none", 2],
            ["older", "seal-older", 2],
        ]);
        // Sealing never changes what is indexed.
        expect(indexedUids()).toEqual(["none", "older", "current", "carol", "carol2"]);
    });

    it("seals with no pins when the sender's can't be loaded, and writes nothing without a seal to write", async () => {
        mailbox([message("a"), message("b")]);
        getPinnedSignerFingerprints.mockRejectedValue(new Error("contacts down"));
        evaluateMessageSecurityWithSeal.mockResolvedValueOnce(decrypted);

        await buildLocalIndex("mb1", unlocked, [INBOX], WINDOW);

        expect(evaluateMessageSecurityWithSeal.mock.calls.map((call) => call[2])).toEqual([undefined, undefined]);
        expect(setMessageVerificationSeal).toHaveBeenCalledTimes(1);
        expect(indexedUids()).toEqual(["a", "b"]);
    });

    it.each([
        ["can't be read", () => getKeyVault.mockRejectedValue(new Error("down"))],
        ["reports no generation", () => getKeyVault.mockResolvedValue({})],
    ])("seals nothing when the vault %s", async (_label, arrange) => {
        arrange();
        mailbox([message("a"), message("b")]);

        await buildLocalIndex("mb1", unlocked, [INBOX], WINDOW);

        expect(evaluateMessageSecurityWithSeal).not.toHaveBeenCalled();
        expect(evaluateMessageSecurity).toHaveBeenCalledTimes(2);
        expect(getPinnedSignerFingerprints).not.toHaveBeenCalled();
        expect(setMessageVerificationSeal).not.toHaveBeenCalled();
        expect(indexedUids()).toEqual(["a", "b"]);
    });

    it(`runs at most ${SEAL_WRITE_CONCURRENCY} writes at once and ${MAX_SEAL_WRITES_PER_PASS} per pass, finishing them before the pass resolves`, async () => {
        mailbox(Array.from({ length: 250 }, (_, i) => message(`m${i}`)));
        let inFlight = 0;
        let peak = 0;
        let finished = 0;
        setMessageVerificationSeal.mockImplementation(async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 1));
            inFlight--;
            finished++;
            return {};
        });

        await buildLocalIndex("mb1", unlocked, [INBOX], WINDOW);

        expect(setMessageVerificationSeal).toHaveBeenCalledTimes(MAX_SEAL_WRITES_PER_PASS);
        expect(finished).toBe(MAX_SEAL_WRITES_PER_PASS);
        expect(peak).toBe(SEAL_WRITE_CONCURRENCY);
        // Past the cap, messages are evaluated without seals.
        expect(evaluateMessageSecurity.mock.calls.length).toBeGreaterThanOrEqual(250 - MAX_SEAL_WRITES_PER_PASS - 10);
        expect(indexedUids()).toHaveLength(250);
    });

    it("ignores failed writes and seal evaluations, and doesn't re-seal a message whose write was refused in a later pass", async () => {
        mailbox([message("a"), message("b"), message("c")]);
        setMessageVerificationSeal.mockImplementation(async (uid: string) => {
            throw uid === "a" ? new ApiRequestError("conflict", 409) : new Error("network");
        });
        evaluateMessageSecurityWithSeal.mockImplementation(async (_raw: string, _keys: unknown, _pins: unknown, _reader: unknown, options: { messageUid: string }) => {
            if (options.messageUid === "c") {
                throw new Error("locked");
            }
            return { ...decrypted, sealToWrite: { seal: `seal-${options.messageUid}`, masterKeyGeneration: 2 } };
        });

        await buildLocalIndex("mb1", unlocked, [INBOX], WINDOW);
        expect(setMessageVerificationSeal).toHaveBeenCalledTimes(2);
        expect(indexedUids()).toEqual(["a", "b"]);
        expect(rpc.setLocalIndexBuilding).toHaveBeenLastCalledWith("mb1", false, expect.objectContaining({ complete: true }));

        evaluateMessageSecurityWithSeal.mockClear();
        await buildLocalIndex("mb1", unlocked, [INBOX], WINDOW);
        // "a" was refused (final); "b" failed transiently and "c" never got a seal, so both are tried again.
        expect(evaluateMessageSecurityWithSeal.mock.calls.map((call) => call[4].messageUid).sort()).toEqual(["b", "c"]);
        expect(evaluateMessageSecurity).toHaveBeenCalledWith("raw a", unlocked);
    });

    it("stops sealing once the keys are destroyed, dropping queued writes", async () => {
        mailbox(Array.from({ length: 20 }, (_, i) => message(`m${i}`)));
        setMessageVerificationSeal.mockImplementation(async () => {
            unlocked.destroyed = true;
            return {};
        });

        await buildLocalIndex("mb1", unlocked, [INBOX], WINDOW);

        expect(setMessageVerificationSeal).toHaveBeenCalledTimes(1);
        // Evaluations that started after the lock ran without seals.
        expect(evaluateMessageSecurity).toHaveBeenCalled();
    });

    it("stops starting writes once the pass is cancelled", async () => {
        mailbox(Array.from({ length: 20 }, (_, i) => message(`m${i}`)));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        setMessageVerificationSeal.mockImplementation(async () => {
            await gate;
            return {};
        });

        const running = buildLocalIndex("mb1", unlocked, [INBOX], WINDOW);
        await vi.waitFor(() => expect(setMessageVerificationSeal).toHaveBeenCalledTimes(SEAL_WRITE_CONCURRENCY));
        const cancelled = cancelLocalIndexBuild("mb1");
        release();

        // The walk may already be over (the pass then resolves) or not (it rejects); either way no queued write starts.
        await running.catch(() => undefined);
        await cancelled;
        expect(setMessageVerificationSeal).toHaveBeenCalledTimes(SEAL_WRITE_CONCURRENCY);
    });
});
