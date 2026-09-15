///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The web client's side of verification seals (`@rapidmx/react-shared`'s `crypto/verificationSeal.ts`): the vault's
 * current `masterKeyGeneration` a seal is checked and written under, and best-effort seal writes.
 *
 * **Vault generation.** `getVaultGeneration()` reads `KeyVault.masterKeyGeneration` once per mailbox and reuses it for
 * `VAULT_GENERATION_TTL_MS`; a failed read isn't cached. A vault that doesn't report a non-negative integer generation
 * (a server predating it) counts as unavailable, and callers then evaluate without seals at all. The cache is dropped
 * whenever a key session locks (subscribed on first use), so a rekey followed by a re-unlock is picked up.
 *
 * **Writes.** `sendVerificationSeal()` stores `sealToWrite` with `setMessageVerificationSeal()` and never rejects. Each
 * message is written at most once per master key generation per page session - a seal carries the time it was built,
 * so every evaluation of the same message produces a different one, and sending each would only draw 409s. A `409`
 * (the server kept its seal), `400`, `403` or `404` is final; any other failure (a network error) lets a later
 * evaluation try again, never a retry loop. A stored seal is remembered (`currentVerificationSeal()`) so a message
 * reopened before its list copy is refreshed opens that seal instead of building another.
 */
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { getKeyVault } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { subscribeKeySession } from "@rapidmx/react-shared/crypto/keySession.js";
import { type Message, setMessageVerificationSeal } from "@rapidmx/react-shared/mail/mailApi.js";
import type { SealToWrite } from "@rapidmx/react-shared/crypto/messageSecurity.js";

/** How long one mailbox's vault generation is reused before it is read again. */
export const VAULT_GENERATION_TTL_MS = 60_000;

/** Statuses after which a seal write is never attempted again for that message and generation. */
const FINAL_WRITE_STATUSES = new Set([400, 403, 404, 409]);

const generationCache = new Map<string, { loadedAt: number; generation: Promise<number | undefined> }>();
/** `messageUid:generation` for every write sent (or in flight) this session. */
const attemptedWrites = new Set<string>();
/** Seals this session stored, by message uid. */
const storedSeals = new Map<string, SealToWrite>();

let lockSubscribed = false;

/** Forgets the cached vault generations and this session's seal writes - in tests. */
export function clearVerificationSealCache(): void {
    generationCache.clear();
    attemptedWrites.clear();
    storedSeals.clear();
}

function subscribeToLocksOnce(): void {
    if (lockSubscribed) {
        return;
    }
    lockSubscribed = true;
    subscribeKeySession((event) => {
        if (event.state === "locked") {
            generationCache.clear();
        }
    });
}

/** Reads `mailboxUid`'s current vault `masterKeyGeneration`, uncached: `undefined` when the vault can't be read or
 * reports none. Never rejects. */
export async function readVaultGeneration(mailboxUid: string): Promise<number | undefined> {
    try {
        const { masterKeyGeneration } = await getKeyVault(mailboxUid);
        return Number.isSafeInteger(masterKeyGeneration) && masterKeyGeneration! >= 0 ? masterKeyGeneration : undefined;
    } catch {
        return undefined;
    }
}

/** `mailboxUid`'s current vault `masterKeyGeneration`, or `undefined` when it can't be read. Never rejects. */
export function getVaultGeneration(mailboxUid: string): Promise<number | undefined> {
    subscribeToLocksOnce();
    const entry = generationCache.get(mailboxUid);
    if (entry && Date.now() - entry.loadedAt <= VAULT_GENERATION_TTL_MS) {
        return entry.generation;
    }
    const created = { loadedAt: Date.now(), generation: readVaultGeneration(mailboxUid) };
    generationCache.set(mailboxUid, created);
    void created.generation.then((generation) => {
        // Only a readable generation is reused; an unavailable one is read again next time.
        if (generation === undefined && generationCache.get(mailboxUid) === created) {
            generationCache.delete(mailboxUid);
        }
    });
    return created.generation;
}

/** The seal to check `message` against: the one this session stored for it when that is newer than the message's own
 * copy (which may predate the write), else the message's `verificationSeal`/`verificationSealGeneration`. */
export function currentVerificationSeal(message: Pick<Message, "uid" | "verificationSeal" | "verificationSealGeneration">): {
    seal?: string;
    sealGeneration?: number;
} {
    const stored = storedSeals.get(message.uid);
    if (stored && (message.verificationSealGeneration === undefined || stored.masterKeyGeneration > message.verificationSealGeneration)) {
        return { seal: stored.seal, sealGeneration: stored.masterKeyGeneration };
    }
    return { seal: message.verificationSeal, sealGeneration: message.verificationSealGeneration };
}

/** Whether `sendVerificationSeal()` would still send a seal for `messageUid` at `generation`. */
export function verificationSealPending(messageUid: string, generation: number): boolean {
    return !attemptedWrites.has(`${messageUid}:${generation}`);
}

/** Stores `sealToWrite` on `messageUid`, best effort - see this module's doc comment. Resolves `true` when a request was
 * sent, `false` when the write was skipped as already attempted. Never rejects. */
export async function sendVerificationSeal(messageUid: string, sealToWrite: SealToWrite): Promise<boolean> {
    const key = `${messageUid}:${sealToWrite.masterKeyGeneration}`;
    if (attemptedWrites.has(key)) {
        return false;
    }
    attemptedWrites.add(key);
    try {
        await setMessageVerificationSeal(messageUid, sealToWrite.seal, sealToWrite.masterKeyGeneration);
        storedSeals.set(messageUid, sealToWrite);
    } catch (err) {
        // `VerificationSealConflictError` is an `ApiRequestError` with status 409.
        if (!(err instanceof ApiRequestError && FINAL_WRITE_STATUSES.has(err.status))) {
            attemptedWrites.delete(key);
        }
    }
    return true;
}
