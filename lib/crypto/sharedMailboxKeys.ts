///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Shared mailboxes' zero-access keys (restapi `specs/search.md` §3 *Shared Mailboxes*). A mailbox someone else owns, or that has no owner,
 * has no master key its members know: its zero-access private key is instead wrapped to each member's own zero-access certificate
 * (member key wraps), and a member opens it with the zero-access key of a mailbox they own - so a member unlocks it without a password,
 * once their own mailbox is unlocked. Members get the ability to read, never the master key, signing key or encryption keys.
 *
 * `unlockSharedMailbox()` opens a shared mailbox for its member. `maintainSharedMailbox()` is what the client of the owner, or of a member
 * with full access, does in the background: provisions a key for a mailbox without an owner, wraps the keys for members still waiting,
 * and - once someone who held the key has left - rotates it, so new mail is encrypted to a key they never had.
 */
import { type ApiClient, ApiRequestError } from "../util/api.js";
import { fromBase64, toBase64 } from "./encoding.js";
import {
    enrollSharedZeroAccessKey,
    getEncryptionPolicy,
    getKeyVault,
    getMyMemberKeyWraps,
    getSharedKeyStatus,
    type MemberKeyWrap,
    putMemberKeyWraps,
    removeMemberKeyWraps,
    type SharedKeyStatus,
    type ZeroAccessKey,
} from "./keyvaultApi.js";
import { exportPrivateKeyPkcs8, generateKeyPairWithCsr, importPrivateKeyPkcs8 } from "./keys.js";
import {
    getUnlockedKeys,
    installSharedSession,
    personalSessions,
    type RetainedEncryptionKey,
    sharedUnlockGeneration,
    type UnlockedKeys,
    ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE,
} from "./keySession.js";
import { buildAad, openWithKey } from "./masterKey.js";
import { decryptEnvelopedDataWithKeys, encryptForRecipients } from "./smime.js";
import { provisionZeroAccessKey } from "./zeroAccessKey.js";

/** What `unlockSharedMailbox()` found. */
export type SharedUnlockOutcome =
    /** Its keys are open in this session. */
    | "unlocked"
    /** The caller is a member but holds no wrap yet: another member's client shares the key with them shortly. */
    | "pending"
    /** The caller is a member, but none of their own mailboxes is unlocked to open their wraps with. */
    | "own_keys_locked"
    /** Not a shared mailbox of the caller's (they own it, or have no member access): its own unlock applies. */
    | "not_shared";

/** Domain-separation prefix of the secret a shared session's `masterKey` stands for. */
const SESSION_SECRET_LABEL = new TextEncoder().encode("rapidmx-shared-mailbox-session-v1:");

async function sessionSecret(pkcs8: Uint8Array): Promise<Uint8Array> {
    const input = new Uint8Array(SESSION_SECRET_LABEL.length + pkcs8.length);
    input.set(SESSION_SECRET_LABEL);
    input.set(pkcs8, SESSION_SECRET_LABEL.length);
    try {
        return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    } finally {
        input.fill(0);
    }
}

/** One of the user's own zero-access keys, with the mailbox it belongs to. */
type OwnKey = RetainedEncryptionKey & { mailboxUid: string };

/** The zero-access keys of the mailboxes this user has unlocked themselves - what their member wraps are addressed to. */
function ownZeroAccessKeys(): OwnKey[] {
    return personalSessions().flatMap(({ mailboxUid, unlocked }) => (unlocked.zeroAccessKeys ?? []).map((key) => ({ ...key, mailboxUid })));
}

/** Opens `wrap` with the user's own keys: the wrapped PKCS#8 (the caller zeroes it) and the own mailbox whose key opened it, or `undefined`
 * when no own key opens it. */
async function openWrap(wrap: MemberKeyWrap, own: OwnKey[]): Promise<{ pkcs8: Uint8Array; openedWith: string } | undefined> {
    const recipient = own.find((key) => key.fingerprint === wrap.recipientFingerprint);
    if (!recipient) {
        return undefined;
    }
    try {
        return { pkcs8: await decryptEnvelopedDataWithKeys(fromBase64(wrap.cms), [recipient]), openedWith: recipient.mailboxUid };
    } catch {
        return undefined;
    }
}

/** The active key first, then the others newest first - the order `UnlockedKeys.zeroAccessKeys` keeps. */
function keyOrder(status: Pick<SharedKeyStatus, "activeKeyFingerprint" | "zeroAccessKeys">): (fingerprint: string) => number {
    const rank = new Map<string, number>(
        [...status.zeroAccessKeys]
            .sort((a, b) => Number(a.fingerprint !== status.activeKeyFingerprint) - Number(b.fingerprint !== status.activeKeyFingerprint) || b.notBefore - a.notBefore)
            .map((key, index) => [key.fingerprint, index]),
    );
    return (fingerprint) => rank.get(fingerprint) ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Opens shared mailbox `mailboxUid` for its member, with no password: their member wraps, opened with the zero-access keys of a mailbox they
 * own and have unlocked, become this session's keys for it (`installSharedSession()`). See `SharedUnlockOutcome` for when it can't.
 */
export async function unlockSharedMailbox(mailboxUid: string, client?: ApiClient): Promise<SharedUnlockOutcome> {
    if (getUnlockedKeys(mailboxUid)) {
        return "unlocked";
    }
    const generation: string = sharedUnlockGeneration(mailboxUid);
    let status: SharedKeyStatus;
    try {
        status = await getSharedKeyStatus(mailboxUid, client);
    } catch (err) {
        if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) {
            return "not_shared";
        }
        throw err;
    }
    if (status.role !== "member") {
        return "not_shared";
    }
    const wraps: MemberKeyWrap[] = await getMyMemberKeyWraps(mailboxUid, client);
    if (wraps.length === 0) {
        return "pending";
    }
    const own = ownZeroAccessKeys();
    const rank = keyOrder(status);
    const opened: RetainedEncryptionKey[] = [];
    const openedWith: Set<string> = new Set();
    let secret: Uint8Array | undefined;
    for (const wrap of [...wraps].sort((a, b) => rank(a.zeroAccessKeyFingerprint) - rank(b.zeroAccessKeyFingerprint))) {
        const certificate: ZeroAccessKey | undefined = status.zeroAccessKeys.find((key) => key.fingerprint === wrap.zeroAccessKeyFingerprint);
        const unwrapped = certificate ? await openWrap(wrap, own) : undefined;
        if (!certificate || !unwrapped) {
            continue;
        }
        const pkcs8 = unwrapped.pkcs8;
        try {
            secret ??= await sessionSecret(pkcs8);
            const privateKey = await importPrivateKeyPkcs8(pkcs8, { name: "ECDH", namedCurve: "P-256" }, ["deriveBits"]);
            opened.push({ fingerprint: wrap.zeroAccessKeyFingerprint, certDer: fromBase64(certificate.publicKey), privateKey });
            openedWith.add(unwrapped.openedWith);
        } catch {
            // A wrap that doesn't hold a usable key is skipped; the others still open the mailbox.
        } finally {
            pkcs8.fill(0);
        }
    }
    if (!secret || opened.length === 0) {
        return "own_keys_locked";
    }
    const unlocked: UnlockedKeys = { masterKey: secret, zeroAccessKeys: opened, openedWith: [...openedWith] };
    installSharedSession(mailboxUid, unlocked, generation);
    return "unlocked";
}

/** The PKCS#8 of every zero-access key of `mailboxUid` the caller can open, by fingerprint - from the vault with the owner's unlocked master
 * key, or from the caller's own member wraps. The caller zeroes them. */
async function openPrivateKeys(
    mailboxUid: string,
    status: SharedKeyStatus,
    ownerUnlocked: UnlockedKeys | undefined,
    client?: ApiClient,
): Promise<Map<string, Uint8Array>> {
    const keys = new Map<string, Uint8Array>();
    if (ownerUnlocked) {
        const vault = await getKeyVault(mailboxUid, client);
        const aad = buildAad(mailboxUid, ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE);
        for (const key of status.zeroAccessKeys) {
            const wrapped = vault.wrappedKeys.find((w) => w.fingerprint === key.fingerprint && w.useType === "zero-access");
            if (wrapped) {
                try {
                    keys.set(key.fingerprint, await openWithKey(ownerUnlocked.masterKey, wrapped, aad));
                } catch {
                    // Sealed under a master key since replaced: not this device's to share.
                }
            }
        }
        return keys;
    }
    const own = ownZeroAccessKeys();
    for (const wrap of await getMyMemberKeyWraps(mailboxUid, client)) {
        const unwrapped = await openWrap(wrap, own);
        if (unwrapped) {
            keys.set(wrap.zeroAccessKeyFingerprint, unwrapped.pkcs8);
        }
    }
    return keys;
}

async function wrapFor(member: { userUid: string; certificate: ZeroAccessKey }, pkcs8: Uint8Array): Promise<Omit<MemberKeyWrap, "zeroAccessKeyFingerprint">> {
    return {
        memberUserUid: member.userUid,
        recipientFingerprint: member.certificate.fingerprint,
        cms: toBase64(await encryptForRecipients(pkcs8, [fromBase64(member.certificate.publicKey)])),
    };
}

/** The members with a certificate of their own - the ones a key can be wrapped for. */
function wrappable(status: SharedKeyStatus): { userUid: string; certificate: ZeroAccessKey; wrapped: string[] }[] {
    return status.members.filter((member): member is typeof member & { certificate: ZeroAccessKey } => !!member.certificate);
}

/** A new keypair for a mailbox without an owner, enrolled together with a wrap of it for every member who can receive one. */
async function enrollNewSharedKey(mailboxUid: string, mailboxAddress: string, status: SharedKeyStatus, client?: ApiClient): Promise<SharedKeyStatus> {
    const { keyPair, csrPem } = await generateKeyPairWithCsr(mailboxAddress, "encrypt");
    const pkcs8 = await exportPrivateKeyPkcs8(keyPair.privateKey);
    try {
        const wraps = await Promise.all(wrappable(status).map((member) => wrapFor(member, pkcs8)));
        return await enrollSharedZeroAccessKey(mailboxUid, { csr: csrPem, wraps }, client);
    } finally {
        pkcs8.fill(0);
    }
}

/** What `maintainSharedMailbox()` did. */
export interface SharedMaintenance {
    provisioned: boolean;
    rotated: boolean;
    /** Wraps added for waiting members. */
    wrapped: number;
    /** Departed users whose wraps were removed. */
    removed: number;
}

/**
 * The background care of a shared mailbox, run by the client of its owner or of a member with full access (`status.manager`); nothing for
 * anyone else, or while the keys it needs are locked:
 *
 * A mailbox without an owner and without a key gets one (unless the administrator disallows zero-access), wrapped for every member who has a
 * certificate. Once a user who held the active key has left (`rotationPending`), a new key replaces it - enrolled by the owner with their
 * master key (`provisionZeroAccessKey()`), or for a mailbox without an owner with the members' wraps - and then the departed users' wraps
 * are removed. Members still waiting (`pending`) get wraps of every key this client can open.
 */
export async function maintainSharedMailbox(mailboxUid: string, mailboxAddress: string, client?: ApiClient): Promise<SharedMaintenance> {
    const result: SharedMaintenance = { provisioned: false, rotated: false, wrapped: 0, removed: 0 };
    let status: SharedKeyStatus = await getSharedKeyStatus(mailboxUid, client);
    if (!status.manager || (status.members.length === 0 && status.departed.length === 0)) {
        return result;
    }
    const ownerUnlocked = status.role === "owner" ? getUnlockedKeys(mailboxUid) : undefined;
    if (status.role === "owner" && (!ownerUnlocked || ownerUnlocked.shared)) {
        return result;
    }

    if (status.ownerless && !status.activeKeyFingerprint) {
        const policy = await getEncryptionPolicy(client).catch(() => undefined);
        if (policy?.allowZeroAccess === false || ownZeroAccessKeys().length === 0) {
            return result;
        }
        status = await enrollNewSharedKey(mailboxUid, mailboxAddress, status, client);
        result.provisioned = true;
    } else if (status.rotationPending) {
        if (status.ownerless) {
            status = await enrollNewSharedKey(mailboxUid, mailboxAddress, status, client);
        } else {
            const vault = await getKeyVault(mailboxUid, client);
            await provisionZeroAccessKey(mailboxUid, mailboxAddress, ownerUnlocked!.masterKey, vault.masterKeyGeneration, client);
            status = await getSharedKeyStatus(mailboxUid, client);
        }
        result.rotated = true;
    }
    // The departed hold no wrap of the active key any more (or never did): their old wraps go.
    if (!status.rotationPending) {
        for (const departed of status.departed) {
            status = await removeMemberKeyWraps(mailboxUid, departed, client);
            result.removed++;
        }
    }

    const missing = wrappable(status).filter((member) => status.zeroAccessKeys.some((key) => !member.wrapped.includes(key.fingerprint)));
    if (missing.length > 0) {
        const keys = await openPrivateKeys(mailboxUid, status, ownerUnlocked, client);
        try {
            const wraps: MemberKeyWrap[] = [];
            for (const member of missing) {
                for (const [fingerprint, pkcs8] of keys) {
                    if (!member.wrapped.includes(fingerprint)) {
                        wraps.push({ ...(await wrapFor(member, pkcs8)), zeroAccessKeyFingerprint: fingerprint });
                    }
                }
            }
            if (wraps.length > 0) {
                await putMemberKeyWraps(mailboxUid, wraps, client);
                result.wrapped = wraps.length;
            }
        } finally {
            for (const pkcs8 of keys.values()) {
                pkcs8.fill(0);
            }
        }
    }
    return result;
}
