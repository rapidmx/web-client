// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Shared mailboxes' zero-access keys, with real CMS wrapping and the API and session store mocked.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromBase64, toBase64 } from "../../../lib/crypto/encoding.js";
import { buildAad, generateMasterKey, sealWithKey } from "../../../lib/crypto/masterKey.js";
import { decryptEnvelopedDataWithKeys, encryptForRecipients } from "../../../lib/crypto/smime.js";
import { ApiRequestError } from "../../../lib/util/api.js";

x509.cryptoProvider.set(crypto);

const api = vi.hoisted(() => ({
    getSharedKeyStatus: vi.fn(),
    getMyMemberKeyWraps: vi.fn(),
    putMemberKeyWraps: vi.fn(),
    removeMemberKeyWraps: vi.fn(),
    enrollSharedZeroAccessKey: vi.fn(),
    getEncryptionPolicy: vi.fn(),
    getKeyVault: vi.fn(),
    getEscrowInfo: vi.fn(),
    putZeroAccessEscrowWraps: vi.fn(),
}));
vi.mock("../../../lib/crypto/keyvaultApi.js", async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
const session = vi.hoisted(() => ({
    getUnlockedKeys: vi.fn(),
    installSharedSession: vi.fn(),
    personalSessions: vi.fn(),
    sharedUnlockGeneration: vi.fn(),
    addZeroAccessKey: vi.fn(),
}));
vi.mock("../../../lib/crypto/keySession.js", async (importOriginal) => ({ ...(await importOriginal<object>()), ...session }));
const { provisionZeroAccessKey } = vi.hoisted(() => ({ provisionZeroAccessKey: vi.fn() }));
vi.mock("../../../lib/crypto/zeroAccessKey.js", () => ({ provisionZeroAccessKey }));

const { maintainSharedMailbox, unlockSharedMailbox } = await import("../../../lib/crypto/sharedMailboxKeys.js");
const { ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE } = await import("../../../lib/crypto/keySession.js");

/** A zero-access keypair: its certificate (as restapi lists it), its PKCS#8 and its private key ready for ECDH. */
async function identity(fingerprint: string, notBefore = 1) {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: Math.floor(Math.random() * 1e9).toString(16),
        name: `CN=${fingerprint}`,
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const certDer = new Uint8Array(cert.rawData);
    return {
        fingerprint,
        certDer,
        pkcs8,
        privateKey,
        key: { publicKey: toBase64(certDer), type: "x509", useType: "zero-access", fingerprint, notBefore, notAfter: 2 } as any,
    };
}

const wrap = async (member: string, recipient: Awaited<ReturnType<typeof identity>>, shared: Awaited<ReturnType<typeof identity>>) => ({
    memberUserUid: member,
    recipientFingerprint: recipient.fingerprint,
    zeroAccessKeyFingerprint: shared.fingerprint,
    cms: toBase64(await encryptForRecipients(shared.pkcs8.slice(), [recipient.certDer])),
});

const status = (fields: object = {}) => ({
    ownerless: false,
    role: "member",
    zeroAccessKeys: [],
    members: [],
    pending: [],
    departed: [],
    rotationPending: false,
    manager: false,
    ...fields,
});

let me: Awaited<ReturnType<typeof identity>>;
let active: Awaited<ReturnType<typeof identity>>;
let older: Awaited<ReturnType<typeof identity>>;

beforeEach(async () => {
    me ??= await identity("fp-me");
    active ??= await identity("fp-active", 5);
    older ??= await identity("fp-older", 1);
    session.getUnlockedKeys.mockReturnValue(undefined);
    session.sharedUnlockGeneration.mockReturnValue("g1");
    session.personalSessions.mockReturnValue([{ mailboxUid: "own", unlocked: { masterKey: new Uint8Array(32), zeroAccessKeys: [me] } }]);
    api.putMemberKeyWraps.mockImplementation(async () => status());
    api.removeMemberKeyWraps.mockImplementation(async () => status());
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("unlockSharedMailbox", () => {
    it("opens a shared mailbox with the member's own key, the active key first, and installs it as a shared session", async () => {
        const oldest = await identity("fp-oldest", 0);
        api.getSharedKeyStatus.mockResolvedValue(status({ activeKeyFingerprint: "fp-active", zeroAccessKeys: [oldest.key, older.key, active.key] }));
        api.getMyMemberKeyWraps.mockResolvedValue([await wrap("u", me, oldest), await wrap("u", me, older), await wrap("u", me, active)]);

        expect(await unlockSharedMailbox("shared")).toBe("unlocked");

        const [uid, unlocked, generation] = session.installSharedSession.mock.calls[0];
        expect([uid, generation]).toEqual(["shared", "g1"]);
        expect(unlocked.zeroAccessKeys.map((k: any) => k.fingerprint)).toEqual(["fp-active", "fp-older", "fp-oldest"]);
        expect(unlocked.openedWith).toEqual(["own"]);
        expect(unlocked.masterKey).toHaveLength(32);
        // The opened key really opens what is sealed to the shared mailbox's key.
        const sealed = await encryptForRecipients(new TextEncoder().encode("hello"), [active.certDer]);
        expect(new TextDecoder().decode(await decryptEnvelopedDataWithKeys(sealed, unlocked.zeroAccessKeys))).toBe("hello");
    });

    it("answers from the session when it is open already, and says when it isn't the member's to open", async () => {
        session.getUnlockedKeys.mockReturnValueOnce({ masterKey: new Uint8Array(1) });
        expect(await unlockSharedMailbox("shared")).toBe("unlocked");

        api.getSharedKeyStatus.mockResolvedValueOnce(status({ role: "owner" }));
        expect(await unlockSharedMailbox("owned")).toBe("not_shared");
        api.getSharedKeyStatus.mockRejectedValueOnce(new ApiRequestError("no", 403));
        expect(await unlockSharedMailbox("other")).toBe("not_shared");
        api.getSharedKeyStatus.mockRejectedValueOnce(new ApiRequestError("gone", 404));
        expect(await unlockSharedMailbox("other")).toBe("not_shared");
        api.getSharedKeyStatus.mockRejectedValueOnce(new ApiRequestError("boom", 500));
        await expect(unlockSharedMailbox("other")).rejects.toThrow("boom");
    });

    it("is pending without a wrap, and can't open with the member's own mailbox locked or a wrap that holds nothing usable", async () => {
        api.getSharedKeyStatus.mockResolvedValue(status({ activeKeyFingerprint: "fp-active", zeroAccessKeys: [active.key] }));
        api.getMyMemberKeyWraps.mockResolvedValueOnce([]);
        expect(await unlockSharedMailbox("shared")).toBe("pending");

        session.personalSessions.mockReturnValueOnce([{ mailboxUid: "own", unlocked: { masterKey: new Uint8Array(32) } }]);
        api.getMyMemberKeyWraps.mockResolvedValueOnce([await wrap("u", me, active)]);
        expect(await unlockSharedMailbox("shared")).toBe("own_keys_locked");

        const garbage = { ...(await wrap("u", me, active)), cms: toBase64(await encryptForRecipients(new Uint8Array([1, 2, 3]), [me.certDer])) };
        const unreadable = { ...(await wrap("u", me, active)), cms: "AAAA" };
        const unknownKey = { ...(await wrap("u", me, active)), zeroAccessKeyFingerprint: "fp-unknown" };
        api.getMyMemberKeyWraps.mockResolvedValueOnce([garbage, unreadable, unknownKey]);
        expect(await unlockSharedMailbox("shared")).toBe("own_keys_locked");
        expect(session.installSharedSession).not.toHaveBeenCalled();
    });

    it("skips a wrap whose key the server lists with another key's certificate", async () => {
        api.getSharedKeyStatus.mockResolvedValue(status({ activeKeyFingerprint: "fp-active", zeroAccessKeys: [{ ...active.key, publicKey: older.key.publicKey }, older.key] }));
        api.getMyMemberKeyWraps.mockResolvedValue([await wrap("u", me, active), await wrap("u", me, older)]);

        expect(await unlockSharedMailbox("shared")).toBe("unlocked");
        const [, unlocked] = session.installSharedSession.mock.calls[0];
        expect(unlocked.zeroAccessKeys.map((k: any) => k.fingerprint)).toEqual(["fp-older"]);
    });

    it("opens an open shared session again, keeping its secret, once it lacks the active key and the member holds a wrap of it", async () => {
        const open = { masterKey: new Uint8Array(32).fill(7), zeroAccessKeys: [older], shared: true };
        session.getUnlockedKeys.mockReturnValue(open);
        api.getSharedKeyStatus.mockResolvedValue(status({ activeKeyFingerprint: "fp-active", zeroAccessKeys: [older.key, active.key] }));
        api.getMyMemberKeyWraps.mockResolvedValue([await wrap("u", me, older), await wrap("u", me, active)]);

        expect(await unlockSharedMailbox("shared", undefined, true)).toBe("unlocked");

        const [, unlocked] = session.installSharedSession.mock.calls[0];
        expect(unlocked.zeroAccessKeys.map((k: any) => k.fingerprint)).toEqual(["fp-active", "fp-older"]);
        expect(unlocked.masterKey).toEqual(open.masterKey);
        expect(unlocked.masterKey).not.toBe(open.masterKey);
    });

    it("leaves an open shared session as it is when nothing newer can be opened, or it isn't asked to refresh", async () => {
        const open = { masterKey: new Uint8Array(32), zeroAccessKeys: [older], shared: true };
        session.getUnlockedKeys.mockReturnValue(open);
        // Not asked to refresh; or a session opened with the mailbox's own keys.
        expect(await unlockSharedMailbox("shared")).toBe("unlocked");
        session.getUnlockedKeys.mockReturnValueOnce({ ...open, shared: undefined });
        expect(await unlockSharedMailbox("shared", undefined, true)).toBe("unlocked");
        expect(api.getSharedKeyStatus).not.toHaveBeenCalled();
        // It holds the active key already, or there is none.
        api.getSharedKeyStatus.mockResolvedValueOnce(status({ activeKeyFingerprint: "fp-older", zeroAccessKeys: [older.key] }));
        expect(await unlockSharedMailbox("shared", undefined, true)).toBe("unlocked");
        api.getSharedKeyStatus.mockResolvedValueOnce(status({ zeroAccessKeys: [] }));
        expect(await unlockSharedMailbox("shared", undefined, true)).toBe("unlocked");
        // No longer the member's to open, or not readable just now.
        api.getSharedKeyStatus.mockResolvedValueOnce(status({ role: "owner", activeKeyFingerprint: "fp-active", zeroAccessKeys: [active.key] }));
        expect(await unlockSharedMailbox("shared", undefined, true)).toBe("unlocked");
        api.getSharedKeyStatus.mockRejectedValueOnce(new ApiRequestError("no", 403));
        expect(await unlockSharedMailbox("shared", undefined, true)).toBe("unlocked");
        // The active key's wrap isn't there yet; or it is, but won't open with the member's own keys (locked).
        api.getSharedKeyStatus.mockResolvedValue(status({ activeKeyFingerprint: "fp-active", zeroAccessKeys: [older.key, active.key] }));
        api.getMyMemberKeyWraps.mockResolvedValueOnce([await wrap("u", me, older)]);
        expect(await unlockSharedMailbox("shared", undefined, true)).toBe("unlocked");
        session.personalSessions.mockReturnValueOnce([]);
        api.getMyMemberKeyWraps.mockResolvedValueOnce([await wrap("u", me, active)]);
        expect(await unlockSharedMailbox("shared", undefined, true)).toBe("unlocked");
        expect(session.installSharedSession).not.toHaveBeenCalled();
    });
});

describe("maintainSharedMailbox", () => {
    const member = (userUid: string, id: Awaited<ReturnType<typeof identity>> | undefined, wrapped: string[] = [], full = false) => ({
        userUid,
        full,
        wrapped,
        ...(id ? { certificate: id.key } : {}),
    });

    it("does nothing for someone who can't manage, a mailbox with no members, or an owner whose mailbox is locked", async () => {
        api.getSharedKeyStatus.mockResolvedValueOnce(status({ manager: false, members: [member("a", me)] }));
        expect(await maintainSharedMailbox("mb", "mb@example.com")).toMatchObject({ wrapped: 0 });
        api.getSharedKeyStatus.mockResolvedValueOnce(status({ manager: true }));
        expect(await maintainSharedMailbox("mb", "mb@example.com")).toMatchObject({ wrapped: 0 });
        api.getSharedKeyStatus.mockResolvedValueOnce(status({ manager: true, role: "owner", members: [member("a", me)] }));
        expect(await maintainSharedMailbox("mb", "mb@example.com")).toMatchObject({ wrapped: 0 });
        session.getUnlockedKeys.mockReturnValueOnce({ masterKey: new Uint8Array(32), shared: true });
        api.getSharedKeyStatus.mockResolvedValueOnce(status({ manager: true, role: "owner", members: [member("a", me)] }));
        expect(await maintainSharedMailbox("mb", "mb@example.com")).toMatchObject({ wrapped: 0 });
        expect(api.putMemberKeyWraps).not.toHaveBeenCalled();
    });

    it("provisions a key for a mailbox without an owner, wrapped for every member with a certificate - unless zero-access is disallowed", async () => {
        const reader = await identity("fp-reader");
        const unprovisioned = status({ ownerless: true, manager: true, members: [member("me", me, [], true), member("reader", reader), member("newbie", undefined)] });
        api.getSharedKeyStatus.mockResolvedValue(unprovisioned);
        api.getEncryptionPolicy.mockResolvedValueOnce({ allowZeroAccess: false });
        expect((await maintainSharedMailbox("support", "support@example.com")).provisioned).toBe(false);

        session.personalSessions.mockReturnValueOnce([{ mailboxUid: "own", unlocked: { masterKey: new Uint8Array(32) } }]);
        api.getEncryptionPolicy.mockRejectedValueOnce(new Error("offline"));
        expect((await maintainSharedMailbox("support", "support@example.com")).provisioned).toBe(false);

        api.getEncryptionPolicy.mockResolvedValue({ allowZeroAccess: true });
        api.enrollSharedZeroAccessKey.mockResolvedValue(status({ ownerless: true, manager: true, members: [], zeroAccessKeys: [] }));
        const result = await maintainSharedMailbox("support", "support@example.com");

        expect(result.provisioned).toBe(true);
        const [uid, input] = api.enrollSharedZeroAccessKey.mock.calls[0];
        expect(uid).toBe("support");
        expect(input.csr).toContain("CERTIFICATE REQUEST");
        expect(input.wraps.map((w: any) => [w.memberUserUid, w.recipientFingerprint])).toEqual([
            ["me", "fp-me"],
            ["reader", "fp-reader"],
        ]);
        // Each wrap opens, for its member, to the same new private key.
        const mine = await decryptEnvelopedDataWithKeys(fromBase64(input.wraps[0].cms), [me]);
        const theirs = await decryptEnvelopedDataWithKeys(fromBase64(input.wraps[1].cms), [reader]);
        expect(mine).toEqual(theirs);
    });

    it("wraps every key it holds for members still waiting, as a member with full access", async () => {
        const reader = await identity("fp-reader");
        api.getSharedKeyStatus.mockResolvedValue(
            status({
                manager: true,
                activeKeyFingerprint: "fp-active",
                zeroAccessKeys: [active.key, older.key],
                members: [member("me", me, ["fp-active", "fp-older"], true), member("reader", reader, ["fp-older"]), member("newbie", undefined)],
            }),
        );
        api.getMyMemberKeyWraps.mockResolvedValue([await wrap("me", me, active), await wrap("me", me, older), { ...(await wrap("me", me, older)), recipientFingerprint: "other" }]);

        const result = await maintainSharedMailbox("shared", "shared@example.com", { baseUrl: "x" } as any);

        expect(result.wrapped).toBe(1);
        const [uid, wraps, client] = api.putMemberKeyWraps.mock.calls[0];
        expect([uid, client]).toEqual(["shared", { baseUrl: "x" }]);
        expect(wraps.map((w: any) => [w.memberUserUid, w.zeroAccessKeyFingerprint])).toEqual([["reader", "fp-active"]]);
        expect(await decryptEnvelopedDataWithKeys(fromBase64(wraps[0].cms), [reader])).toEqual(active.pkcs8);
    });

    it("sends the active key's wraps in their own write first, and a refused older key neither stops the rest nor fails the pass", async () => {
        const reader = await identity("fp-reader");
        const newbie = await identity("fp-newbie");
        const oldest = await identity("fp-oldest", 0);
        api.getSharedKeyStatus.mockResolvedValue(
            status({
                manager: true,
                activeKeyFingerprint: "fp-active",
                zeroAccessKeys: [oldest.key, older.key, active.key],
                members: [member("me", me, ["fp-active", "fp-older", "fp-oldest"], true), member("reader", reader, ["fp-oldest"]), member("newbie", newbie)],
            }),
        );
        api.getMyMemberKeyWraps.mockResolvedValue([await wrap("me", me, oldest), await wrap("me", me, older), await wrap("me", me, active)]);
        api.putMemberKeyWraps.mockImplementation(async (_uid: string, wraps: any[]) => {
            if (wraps[0].zeroAccessKeyFingerprint === "fp-older") {
                throw new ApiRequestError("cannot hold more than 2000 member key wraps", 400);
            }
            return status();
        });

        const result = await maintainSharedMailbox("shared", "shared@example.com");

        const calls = api.putMemberKeyWraps.mock.calls.map(([, wraps]) => wraps.map((w: any) => [w.memberUserUid, w.zeroAccessKeyFingerprint]));
        expect(calls).toEqual([
            [
                ["reader", "fp-active"],
                ["newbie", "fp-active"],
            ],
            [
                ["reader", "fp-older"],
                ["newbie", "fp-older"],
            ],
            [["newbie", "fp-oldest"]],
        ]);
        expect(result).toMatchObject({ wrapped: 3, refused: 2 });
    });

    it("fails the pass when the active key's wraps are refused, sending no older key", async () => {
        const reader = await identity("fp-reader");
        api.getSharedKeyStatus.mockResolvedValue(
            status({ manager: true, activeKeyFingerprint: "fp-active", zeroAccessKeys: [older.key, active.key], members: [member("me", me, ["fp-active", "fp-older"], true), member("reader", reader)] }),
        );
        api.getMyMemberKeyWraps.mockResolvedValue([await wrap("me", me, older), await wrap("me", me, active)]);
        api.putMemberKeyWraps.mockRejectedValue(new ApiRequestError("too many", 400));

        await expect(maintainSharedMailbox("shared", "shared@example.com")).rejects.toThrow();
        expect(api.putMemberKeyWraps).toHaveBeenCalledTimes(1);
        expect(api.putMemberKeyWraps.mock.calls[0][1].map((w: any) => w.zeroAccessKeyFingerprint)).toEqual(["fp-active"]);
    });

    it("never wraps a key the server lists with another key's certificate, from a member wrap or the owner's vault", async () => {
        const reader = await identity("fp-reader");
        const swapped = status({
            manager: true,
            activeKeyFingerprint: "fp-active",
            zeroAccessKeys: [{ ...active.key, publicKey: older.key.publicKey }, older.key],
            members: [member("me", me, ["fp-active", "fp-older"], true), member("reader", reader)],
        });
        api.getSharedKeyStatus.mockResolvedValue(swapped);
        api.getMyMemberKeyWraps.mockResolvedValue([await wrap("me", me, active), await wrap("me", me, older)]);

        expect((await maintainSharedMailbox("shared", "shared@example.com")).wrapped).toBe(1);
        expect(api.putMemberKeyWraps.mock.calls[0][1].map((w: any) => w.zeroAccessKeyFingerprint)).toEqual(["fp-older"]);

        api.putMemberKeyWraps.mockClear();
        const mk = generateMasterKey();
        const aad = buildAad("owned", ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE);
        session.getUnlockedKeys.mockReturnValue({ masterKey: mk });
        api.getKeyVault.mockResolvedValue({
            wrappedKeys: [{ ...(await sealWithKey(mk, active.pkcs8.slice(), aad)), algorithm: "AES-256-GCM", fingerprint: "fp-active", useType: "zero-access" }],
            masterKeyWraps: [],
        });
        api.getSharedKeyStatus.mockResolvedValue({ ...swapped, role: "owner" });
        expect((await maintainSharedMailbox("owned", "owned@example.com")).wrapped).toBe(0);
        expect(api.putMemberKeyWraps).not.toHaveBeenCalled();
    });

    it("wraps nothing for this user's own certificate when the server lists another key's under its fingerprint", async () => {
        const server = await identity("fp-server");
        api.getSharedKeyStatus.mockResolvedValue(
            status({
                manager: true,
                activeKeyFingerprint: "fp-active",
                zeroAccessKeys: [active.key],
                members: [member("me", { ...me, key: { ...me.key, publicKey: server.key.publicKey } }), member("other", server)],
            }),
        );
        api.getMyMemberKeyWraps.mockResolvedValue([await wrap("me", me, active)]);

        expect((await maintainSharedMailbox("shared", "shared@example.com")).wrapped).toBe(1);
        expect(api.putMemberKeyWraps.mock.calls[0][1].map((w: any) => w.memberUserUid)).toEqual(["other"]);
    });

    it("opens the keys from the vault with the owner's master key, skipping what won't open, and wraps nothing it doesn't hold", async () => {
        const reader = await identity("fp-reader");
        const mk = generateMasterKey();
        const aad = buildAad("owned", ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE);
        const sealedActive = await sealWithKey(mk, active.pkcs8.slice(), aad);
        const sealedWrongly = await sealWithKey(generateMasterKey(), older.pkcs8.slice(), aad);
        session.getUnlockedKeys.mockReturnValue({ masterKey: mk });
        api.getKeyVault.mockResolvedValue({
            wrappedKeys: [
                { ...sealedActive, algorithm: "AES-256-GCM", fingerprint: "fp-active", useType: "zero-access" },
                { ...sealedWrongly, algorithm: "AES-256-GCM", fingerprint: "fp-older", useType: "zero-access" },
            ],
            masterKeyWraps: [],
        });
        api.getSharedKeyStatus.mockResolvedValue(
            status({
                role: "owner",
                manager: true,
                activeKeyFingerprint: "fp-active",
                zeroAccessKeys: [active.key, older.key, (await identity("fp-nowrap")).key],
                members: [member("reader", reader)],
            }),
        );

        const result = await maintainSharedMailbox("owned", "owned@example.com");

        expect(result.wrapped).toBe(1);
        expect(api.putMemberKeyWraps.mock.calls[0][1].map((w: any) => w.zeroAccessKeyFingerprint)).toEqual(["fp-active"]);

        // Nothing it can open: nothing is sent.
        api.putMemberKeyWraps.mockClear();
        api.getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        expect((await maintainSharedMailbox("owned", "owned@example.com")).wrapped).toBe(0);
        expect(api.putMemberKeyWraps).not.toHaveBeenCalled();
    });

    it("rotates a mailbox without an owner after someone left, then removes the departed user's wraps", async () => {
        const reader = await identity("fp-reader");
        api.getSharedKeyStatus.mockResolvedValue(
            status({ ownerless: true, manager: true, activeKeyFingerprint: "fp-active", zeroAccessKeys: [active.key], rotationPending: true, departed: ["gone"], members: [member("me", me, ["fp-active"], true), member("reader", reader, ["fp-active"])] }),
        );
        api.enrollSharedZeroAccessKey.mockResolvedValue(
            status({ ownerless: true, manager: true, zeroAccessKeys: [], departed: ["gone"], rotationPending: false, members: [] }),
        );

        const result = await maintainSharedMailbox("support", "support@example.com");

        expect(result).toMatchObject({ rotated: true, removed: 1 });
        expect(api.enrollSharedZeroAccessKey.mock.calls[0][1].wraps).toHaveLength(2);
        expect(api.removeMemberKeyWraps).toHaveBeenCalledWith("support", "gone", undefined);

        // Still flagged (another departure raced it): the departed keep their wraps until the next pass rotates again.
        api.removeMemberKeyWraps.mockClear();
        api.enrollSharedZeroAccessKey.mockResolvedValue(status({ ownerless: true, manager: true, zeroAccessKeys: [], departed: ["gone"], rotationPending: true, members: [] }));
        expect((await maintainSharedMailbox("support", "support@example.com")).removed).toBe(0);
        expect(api.removeMemberKeyWraps).not.toHaveBeenCalled();
    });

    it("escrows a new key of a mailbox without an owner to its escrow scope in the same write", async () => {
        const scope = await identity("fp-scope");
        api.getSharedKeyStatus.mockResolvedValue(status({ ownerless: true, manager: true, escrowScopeId: "scope", members: [member("me", me, [], true)] }));
        api.getEncryptionPolicy.mockResolvedValue({ allowZeroAccess: true });
        api.getEscrowInfo.mockResolvedValue({ escrowScopeId: "scope", publicKey: { publicKey: toBase64(scope.certDer) } });
        api.enrollSharedZeroAccessKey.mockResolvedValue(status({ ownerless: true, manager: true, escrowScopeId: "scope", escrowPending: [] }));

        expect((await maintainSharedMailbox("support", "support@example.com")).provisioned).toBe(true);

        const [, input] = api.enrollSharedZeroAccessKey.mock.calls[0];
        expect(input.escrowWrap.escrowScopeId).toBe("scope");
        expect(await decryptEnvelopedDataWithKeys(fromBase64(input.escrowWrap.cms), [scope])).toEqual(
            await decryptEnvelopedDataWithKeys(fromBase64(input.wraps[0].cms), [me]),
        );
        expect(api.putZeroAccessEscrowWraps).not.toHaveBeenCalled();
    });

    it("wraps the keys its escrow scope is missing, only those it holds, and none after the mailbox moved to another scope", async () => {
        const scope = await identity("fp-scope");
        const pendingStatus = status({
            ownerless: true,
            manager: true,
            activeKeyFingerprint: "fp-active",
            zeroAccessKeys: [active.key, older.key],
            members: [member("me", me, ["fp-active", "fp-older"], true)],
            escrowScopeId: "scope",
            escrowPending: ["fp-active", "fp-older", "fp-gone"],
        });
        api.getSharedKeyStatus.mockResolvedValue(pendingStatus);
        api.getMyMemberKeyWraps.mockResolvedValue([await wrap("me", me, active), await wrap("me", me, older)]);
        api.getEscrowInfo.mockResolvedValue({ escrowScopeId: "scope", publicKey: { publicKey: toBase64(scope.certDer) } });

        const result = await maintainSharedMailbox("support", "support@example.com");

        expect(result).toMatchObject({ escrowed: 2, wrapped: 0 });
        const [uid, wraps] = api.putZeroAccessEscrowWraps.mock.calls[0];
        expect(uid).toBe("support");
        expect(wraps.map((w: any) => [w.escrowScopeId, w.zeroAccessKeyFingerprint])).toEqual([
            ["scope", "fp-active"],
            ["scope", "fp-older"],
        ]);
        expect(await decryptEnvelopedDataWithKeys(fromBase64(wraps[0].cms), [scope])).toEqual(active.pkcs8);

        api.putZeroAccessEscrowWraps.mockClear();
        api.getEscrowInfo.mockResolvedValue({ escrowScopeId: "elsewhere", publicKey: { publicKey: toBase64(scope.certDer) } });
        expect((await maintainSharedMailbox("support", "support@example.com")).escrowed).toBe(0);
        // An owned mailbox is escrowed through its master key; an older server reports nothing.
        api.getSharedKeyStatus.mockResolvedValue({ ...pendingStatus, ownerless: false });
        expect((await maintainSharedMailbox("support", "support@example.com")).escrowed).toBe(0);
        api.getSharedKeyStatus.mockResolvedValue({ ...pendingStatus, escrowPending: undefined });
        expect((await maintainSharedMailbox("support", "support@example.com")).escrowed).toBe(0);
        expect(api.putZeroAccessEscrowWraps).not.toHaveBeenCalled();
    });

    it("rotates an owned mailbox with the owner's master key, then wraps the new key for the members", async () => {
        const reader = await identity("fp-reader");
        const mk = generateMasterKey();
        const ownerSession = { masterKey: mk };
        session.getUnlockedKeys.mockReturnValue(ownerSession);
        provisionZeroAccessKey.mockResolvedValueOnce({ key: active });
        api.getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [], masterKeyGeneration: 3 });
        api.getSharedKeyStatus
            .mockResolvedValueOnce(status({ role: "owner", manager: true, activeKeyFingerprint: "fp-older", zeroAccessKeys: [older.key], rotationPending: true, departed: ["gone"], members: [member("reader", reader, ["fp-older"])] }))
            .mockResolvedValue(status({ role: "owner", manager: true, activeKeyFingerprint: "fp-active", zeroAccessKeys: [older.key], departed: ["gone"], members: [member("reader", reader, ["fp-older"])] }));

        const result = await maintainSharedMailbox("owned", "owned@example.com");

        expect(result.rotated).toBe(true);
        expect(provisionZeroAccessKey).toHaveBeenCalledWith("owned", "owned@example.com", mk, 3, undefined);
        // The owner's open session reads mail sealed to the new key at once.
        expect(session.addZeroAccessKey).toHaveBeenCalledWith("owned", ownerSession, active);
        expect(api.removeMemberKeyWraps).toHaveBeenCalledWith("owned", "gone", undefined);
    });
});
