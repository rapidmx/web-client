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
 * and - once someone who held the key has left - rotates it, so new mail is encrypted to a key they never had. A mailbox without an owner
 * has no master key for escrow to open, so when it is assigned to an escrow scope each of its keys is also wrapped to the scope's
 * certificate: with a new key in the same write, and for keys the scope is still missing (`escrowPending`) in the background.
 */
import { type ApiClient, ApiRequestError } from "../util/api.js";
import { fromBase64, toBase64 } from "./encoding.js";
import {
    enrollSharedZeroAccessKey,
    type EscrowInfo,
    getEncryptionPolicy,
    getEscrowInfo,
    getKeyVault,
    getMyMemberKeyWraps,
    getSharedKeyStatus,
    type MemberKeyWrap,
    putMemberKeyWraps,
    putZeroAccessEscrowWraps,
    removeMemberKeyWraps,
    type SharedKeyStatus,
    type ZeroAccessEscrowWrapInput,
    type ZeroAccessKey,
} from "./keyvaultApi.js";
import { certificateHoldsKey } from "./keyPairMatch.js";
import { exportPrivateKeyPkcs8, generateKeyPairWithCsr, importPrivateKeyPkcs8 } from "./keys.js";
import {
    addZeroAccessKey,
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
 *
 * `refresh`: a shared session already open is opened again when it lacks the mailbox's active key and the member now holds a wrap of it -
 * after a rotation, new mail is sealed to a key the session doesn't have. Its `masterKey` secret is kept, so the local index stays readable.
 */
export async function unlockSharedMailbox(mailboxUid: string, client?: ApiClient, refresh = false): Promise<SharedUnlockOutcome> {
    const existing: UnlockedKeys | undefined = getUnlockedKeys(mailboxUid);
    if (existing && !(refresh && existing.shared)) {
        return "unlocked";
    }
    const generation: string = sharedUnlockGeneration(mailboxUid);
    let status: SharedKeyStatus;
    try {
        status = await getSharedKeyStatus(mailboxUid, client);
    } catch (err) {
        if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) {
            return existing ? "unlocked" : "not_shared";
        }
        throw err;
    }
    const holdsActive = (keys: { fingerprint: string }[] | undefined): boolean => !!keys?.some((key) => key.fingerprint === status.activeKeyFingerprint);
    if (existing && (!status.activeKeyFingerprint || holdsActive(existing.zeroAccessKeys))) {
        return "unlocked";
    }
    if (status.role !== "member") {
        return existing ? "unlocked" : "not_shared";
    }
    const wraps: MemberKeyWrap[] = await getMyMemberKeyWraps(mailboxUid, client);
    // Nothing new to open yet: the active key's wrap is still on its way.
    if (existing && !holdsActive(wraps.map((wrap) => ({ fingerprint: wrap.zeroAccessKeyFingerprint })))) {
        return "unlocked";
    }
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
            // The certificate is the server's: one that isn't this key's must never be what this session seals to.
            if (!(await certificateHoldsKey(fromBase64(certificate.publicKey), pkcs8))) {
                continue;
            }
            secret ??= await sessionSecret(pkcs8);
            const privateKey = await importPrivateKeyPkcs8(pkcs8, { name: "ECDH", namedCurve: "P-256" }, ["deriveBits"]);
            opened.push({ fingerprint: wrap.zeroAccessKeyFingerprint, certDer: fromBase64(certificate.publicKey), privateKey });
            openedWith.add(unwrapped.openedWith);
        } catch {
            // A wrap that doesn't hold a usable key (or one its certificate doesn't match) is skipped; the others still open the mailbox.
        } finally {
            pkcs8.fill(0);
        }
    }
    if (!secret || opened.length === 0) {
        return existing ? "unlocked" : "own_keys_locked";
    }
    if (existing) {
        // Opened again: the secret the local index key is derived from stays the one the session started with.
        secret.fill(0);
        secret = new Uint8Array(existing.masterKey);
    }
    const unlocked: UnlockedKeys = { masterKey: secret, zeroAccessKeys: opened, openedWith: [...openedWith] };
    installSharedSession(mailboxUid, unlocked, generation);
    return "unlocked";
}

/** The PKCS#8 of every zero-access key of `mailboxUid` the caller can open, by fingerprint - from the vault with the owner's unlocked master
 * key, or from the caller's own member wraps. Only keys whose certificate in `status` (the server's) is really theirs: a key is wrapped
 * for members and escrow under that certificate's fingerprint, so a mismatched one is left out. The caller zeroes them. */
async function openPrivateKeys(
    mailboxUid: string,
    status: SharedKeyStatus,
    ownerUnlocked: UnlockedKeys | undefined,
    client?: ApiClient,
): Promise<Map<string, Uint8Array>> {
    const keys = new Map<string, Uint8Array>();
    const keep = async (fingerprint: string, pkcs8: Uint8Array): Promise<void> => {
        const certificate = status.zeroAccessKeys.find((key) => key.fingerprint === fingerprint);
        if (certificate && (await certificateHoldsKey(fromBase64(certificate.publicKey), pkcs8))) {
            keys.set(fingerprint, pkcs8);
        } else {
            pkcs8.fill(0);
        }
    };
    if (ownerUnlocked) {
        const vault = await getKeyVault(mailboxUid, client);
        const aad = buildAad(mailboxUid, ZERO_ACCESS_PRIVATE_KEY_AAD_PURPOSE);
        for (const key of status.zeroAccessKeys) {
            const wrapped = vault.wrappedKeys.find((w) => w.fingerprint === key.fingerprint && w.useType === "zero-access");
            if (wrapped) {
                try {
                    await keep(key.fingerprint, await openWithKey(ownerUnlocked.masterKey, wrapped, aad));
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
            await keep(wrap.zeroAccessKeyFingerprint, unwrapped.pkcs8);
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

/** The members with a certificate of their own - the ones a key can be wrapped for. A certificate listed under the fingerprint of one of
 * this user's own opened zero-access keys must be that key's certificate (checked against its private key at unlock): one the server
 * swapped is left out, so a wrap meant for this user never goes to a key that isn't theirs. */
function wrappable(status: SharedKeyStatus): { userUid: string; certificate: ZeroAccessKey; wrapped: string[] }[] {
    const own = ownZeroAccessKeys();
    return status.members.filter((member): member is typeof member & { certificate: ZeroAccessKey } => {
        if (!member.certificate) {
            return false;
        }
        const mine = own.find((key) => key.fingerprint === member.certificate!.fingerprint);
        return !mine || sameBytes(mine.certDer, fromBase64(member.certificate.publicKey));
    });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** `pkcs8` wrapped to the certificate of the escrow scope `escrow` describes. */
async function escrowWrapFor(escrow: EscrowInfo, pkcs8: Uint8Array): Promise<Omit<ZeroAccessEscrowWrapInput, "zeroAccessKeyFingerprint">> {
    return { escrowScopeId: escrow.escrowScopeId, cms: toBase64(await encryptForRecipients(pkcs8, [fromBase64(escrow.publicKey.publicKey)])) };
}

/** A new keypair for a mailbox without an owner, enrolled together with a wrap of it for every member who can receive one, and for its
 * escrow scope when it has one. */
async function enrollNewSharedKey(mailboxUid: string, mailboxAddress: string, status: SharedKeyStatus, client?: ApiClient): Promise<SharedKeyStatus> {
    const escrow: EscrowInfo | undefined = status.escrowScopeId ? await getEscrowInfo(mailboxUid, client) : undefined;
    const { keyPair, csrPem } = await generateKeyPairWithCsr(mailboxAddress, "encrypt");
    const pkcs8 = await exportPrivateKeyPkcs8(keyPair.privateKey);
    try {
        const wraps = await Promise.all(wrappable(status).map((member) => wrapFor(member, pkcs8)));
        const escrowWrap = escrow ? await escrowWrapFor(escrow, pkcs8) : undefined;
        return await enrollSharedZeroAccessKey(mailboxUid, { csr: csrPem, wraps, ...(escrowWrap ? { escrowWrap } : {}) }, client);
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
    /** Wraps of older keys the server refused for waiting members (tried again on the next pass). */
    refused: number;
    /** Departed users whose wraps were removed. */
    removed: number;
    /** Keys wrapped for the mailbox's escrow scope. */
    escrowed: number;
}

/**
 * The background care of a shared mailbox, run by the client of its owner or of a member with full access (`status.manager`); nothing for
 * anyone else, or while the keys it needs are locked:
 *
 * A mailbox without an owner and without a key gets one (unless the administrator disallows zero-access), wrapped for every member who has a
 * certificate. Once a user who held the active key has left (`rotationPending`), a new key replaces it - enrolled by the owner with their
 * master key (`provisionZeroAccessKey()`), or for a mailbox without an owner with the members' wraps - and then the departed users' wraps
 * are removed. Members still waiting (`pending`) get wraps of every key this client can open, one write per key with the active key's
 * first (a refused older key doesn't stop the rest), and the escrow scope of a mailbox without an owner gets copies of the keys it is
 * missing (`escrowPending`).
 */
export async function maintainSharedMailbox(mailboxUid: string, mailboxAddress: string, client?: ApiClient): Promise<SharedMaintenance> {
    const result: SharedMaintenance = { provisioned: false, rotated: false, wrapped: 0, refused: 0, removed: 0, escrowed: 0 };
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
            const { key } = await provisionZeroAccessKey(mailboxUid, mailboxAddress, ownerUnlocked!.masterKey, vault.masterKeyGeneration, client);
            // The owner's open session gets the new key as its active one, as `ensureZeroAccessKey()` does: new mail is sealed to it.
            addZeroAccessKey(mailboxUid, ownerUnlocked!, key);
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
    const escrowPending: string[] = status.ownerless && status.escrowScopeId ? (status.escrowPending ?? []) : [];
    if (missing.length > 0 || escrowPending.length > 0) {
        const keys = await openPrivateKeys(mailboxUid, status, ownerUnlocked, client);
        try {
            // One write per key, the active key's first: it alone opens new mail, so a refused backfill of an older key (the server bounds
            // each key's wraps and the vault's total) never keeps a member from it. A failed older key is left for the next pass.
            const order = keyOrder(status);
            for (const [fingerprint, pkcs8] of [...keys].sort(([a], [b]) => order(a) - order(b))) {
                const wraps: MemberKeyWrap[] = [];
                for (const member of missing) {
                    if (!member.wrapped.includes(fingerprint)) {
                        wraps.push({ ...(await wrapFor(member, pkcs8)), zeroAccessKeyFingerprint: fingerprint });
                    }
                }
                if (wraps.length === 0) {
                    continue;
                }
                if (fingerprint === status.activeKeyFingerprint) {
                    await putMemberKeyWraps(mailboxUid, wraps, client);
                    result.wrapped += wraps.length;
                } else {
                    try {
                        await putMemberKeyWraps(mailboxUid, wraps, client);
                        result.wrapped += wraps.length;
                    } catch {
                        result.refused += wraps.length;
                    }
                }
            }
            const held: string[] = escrowPending.filter((fingerprint) => keys.has(fingerprint));
            if (held.length > 0) {
                const escrow: EscrowInfo = await getEscrowInfo(mailboxUid, client);
                // Assigned to another scope since the status was read: the next pass sees it.
                if (escrow.escrowScopeId === status.escrowScopeId) {
                    const escrowWraps: ZeroAccessEscrowWrapInput[] = [];
                    for (const fingerprint of held) {
                        escrowWraps.push({ ...(await escrowWrapFor(escrow, keys.get(fingerprint)!)), zeroAccessKeyFingerprint: fingerprint });
                    }
                    await putZeroAccessEscrowWraps(mailboxUid, escrowWraps, client);
                    result.escrowed = escrowWraps.length;
                }
            }
        } finally {
            for (const pkcs8 of keys.values()) {
                pkcs8.fill(0);
            }
        }
    }
    return result;
}
