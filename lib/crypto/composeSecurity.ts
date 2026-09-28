///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Compose-time decision logic for `specs/end-to-end_encryption.md`'s Digital Signatures and Encryption
 * sections — kept as pure, side-effect-free functions (no `fetch`, no crypto) precisely so the actual
 * discovery round trip (`keyvaultApi.ts`'s `lookupKeys()`) and MIME assembly (`smimeMessage.ts`) stay in
 * the caller (`ComposeWindow.tsx`), which owns the async orchestration and error handling; this module
 * only decides *what* a compose window should do once it has the facts.
 *
 * **Recipient tier classification is a client-side approximation.** The spec's three tiers
 * (`specs/end-to-end_encryption.md`'s "Terminology": same-organisation / federated peer / external) are
 * a server-side administrative concept - "the specific RapidMX server and the domains it controls" - that
 * `@rapidmx/restapi` 0.6.0 does not actually expose to the client (`KeyLookupResult`/`KeyringUpdate`
 * carry no tier field; confirmed by reading `util/KeyringUtils.ts`). `classifyRecipientTier()` below
 * approximates it as "same domain as the sender's own address" vs. "a domain discovery found keys for"
 * vs. "everything else" - the same domain-suffix heuristic used elsewhere for this class of judgment,
 * not a guarantee. A real fix would be a restapi endpoint exposing which domains a server actually
 * controls; until then this is a disclosed approximation, not a silent one.
 */
import { findActivePublicKey, type EncryptionPolicy, type KeyLookupResult, type PolicyState, type PublicKey } from "./keyvaultApi.js";

export type RecipientTier = "sameOrg" | "federated" | "external";

/** See this module's own doc comment for why this is an approximation, not an authoritative classification. */
export function classifyRecipientTier(ownAddress: string, recipientAddress: string, hasDiscoveredKeys: boolean): RecipientTier {
    const ownDomain = ownAddress.split("@")[1]?.toLowerCase();
    const recipientDomain = recipientAddress.split("@")[1]?.toLowerCase();
    if (ownDomain && recipientDomain && ownDomain === recipientDomain) {
        return "sameOrg";
    }
    return hasDiscoveredKeys ? "federated" : "external";
}

function policyStateForTier(policy: EncryptionPolicy, tier: RecipientTier): PolicyState {
    switch (tier) {
        case "sameOrg":
            return policy.encryptSameOrg;
        case "federated":
            return policy.encryptFederated;
        case "external":
            return policy.encryptExternal;
    }
}

export interface RecipientEncryptionStatus {
    address: string;
    tier: RecipientTier;
    /** The recipient's currently-active encryption certificate, if they have published (and this device
     * has discovered) one. */
    encryptCert?: PublicKey;
    /** Whether this recipient *can* be encrypted to at all right now - false when there's no usable key,
     * or the tier's policy is `prohibited`. */
    canEncrypt: boolean;
    /** Whether encryption should default ON for this recipient specifically: per spec, "MUST default to
     * on only when both parties advertise mutual" AND the tier's policy is `automatic`. */
    autoEncrypt: boolean;
    /** Set (non-undefined) exactly when policy blocks encryption outright for this recipient's tier - the
     * spec: "the client MUST explain why encryption is unavailable rather than silently omitting the
     * control." `undefined` in every other case, including "no key found," which is not a policy block. */
    prohibitedReason?: string;
}

/** Per-recipient encryption eligibility, given this device's own encryption preference and the
 * system-wide policy. One entry per (address, lookup result) pair the caller already resolved via
 * `lookupKeys()` - this function does no discovery itself. */
export function resolveRecipientEncryption(
    ownAddress: string,
    ownPrefersMutual: boolean,
    policy: EncryptionPolicy,
    recipientAddress: string,
    lookup: KeyLookupResult | undefined,
): RecipientEncryptionStatus {
    const encryptCert = lookup ? findActivePublicKey(lookup.keys, "encrypt") : undefined;
    const tier = classifyRecipientTier(ownAddress, recipientAddress, !!lookup && lookup.keys.length > 0);
    const policyState = policyStateForTier(policy, tier);

    if (policyState === "prohibited") {
        return {
            address: recipientAddress,
            tier,
            encryptCert,
            canEncrypt: false,
            autoEncrypt: false,
            prohibitedReason: "Your organization's encryption policy does not allow encrypting messages to this recipient.",
        };
    }

    if (!encryptCert) {
        return { address: recipientAddress, tier, canEncrypt: false, autoEncrypt: false };
    }

    const recipientPrefersMutual = lookup?.encryptPreference?.preferEncrypt === "mutual";
    const mutual = ownPrefersMutual && recipientPrefersMutual;
    return {
        address: recipientAddress,
        tier,
        encryptCert,
        canEncrypt: true,
        autoEncrypt: policyState === "automatic" && mutual,
    };
}

export interface MessageEncryptionDecision {
    /** Whether the compose window's encryption toggle should default to checked - true only when every
     * recipient independently defaults to encrypted. Seeds the toggle's *initial* state only; the user
     * can still turn it on manually even when this is false, subject to `canEncryptAll`. */
    autoEncrypt: boolean;
    /** Every recipient the message *could* be encrypted to right now. */
    canEncryptAll: boolean;
    /** Recipients that cannot currently be encrypted to (no key, or policy-prohibited) - the spec's
     * "Multiple Recipients" all-or-nothing case: when this is non-empty and the user still wants
     * encryption, the client MUST offer to send in plaintext or remove these recipients, never split. */
    blockedRecipients: RecipientEncryptionStatus[];
}

/** Combines every recipient's individual status into the one decision a compose window's UI actually
 * needs: whether to default the toggle on, and whether an all-or-nothing prompt is required. */
export function decideMessageEncryption(recipients: RecipientEncryptionStatus[]): MessageEncryptionDecision {
    if (recipients.length === 0) {
        return { autoEncrypt: false, canEncryptAll: false, blockedRecipients: [] };
    }
    const blockedRecipients = recipients.filter((r) => !r.canEncrypt);
    return {
        autoEncrypt: recipients.every((r) => r.autoEncrypt),
        canEncryptAll: blockedRecipients.length === 0,
        blockedRecipients,
    };
}

/** Detects list traffic per the spec's "Mailing lists" note under Digital Signatures: a footer a list
 * appends after signing invalidates the signature, so the client MAY suppress signing for it. `headers`
 * is whatever the caller already has on hand (e.g. a `Contact`'s known list-membership flag) - this
 * module has no way to inspect list membership itself, so it just applies the rule to inputs the caller
 * supplies. Currently unused by any caller (no UI surfaces distribution-list membership to compose yet -
 * a disclosed gap, not a silent one; see this module's own file-level doc comment). */
export function isLikelyMailingList(headers: { listId?: string; listUnsubscribe?: string }): boolean {
    return !!(headers.listId || headers.listUnsubscribe);
}
