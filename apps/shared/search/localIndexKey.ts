///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Derives the page-encryption key for one mailbox's Tier 2 local index (`specs/search.md` §11
 * "Persistence and protection... MUST be encrypted at rest under the mailbox master key (MK)... using
 * the same AEAD construction"). Reuses `crypto/masterKey.ts`'s existing `hkdfDerive()` - the same HKDF
 * primitive every other MK-derived key in this codebase already goes through.
 *
 * No persisted per-install salt: MK is already 32 bytes of uniform random key material (see
 * `masterKey.ts`'s own `generateMasterKey()`), so a fixed, non-secret salt is standard HKDF practice
 * here (RFC 5869 - a salt matters for stretching low-entropy input, not for re-randomizing input that's
 * already uniformly random) and avoids needing to persist, transmit, or ever lose a random salt just to
 * re-derive the same key on the next unlock.
 */
import { hkdfDerive } from "@rapidmx/react-shared/crypto/masterKey.js";

/** Fixed, non-secret HKDF salt - see this module's own doc comment for why a fixed salt is fine here. */
const FIXED_SALT = new TextEncoder().encode("rapidmx-local-search-index-v1");

/** Derives this mailbox's local-index page-encryption key from its already-unlocked master key. Every
 * call with the same `(masterKey, mailboxUid)` pair returns the identical key - callers never need to
 * persist it themselves. */
export async function deriveLocalIndexKey(masterKey: Uint8Array, mailboxUid: string): Promise<Uint8Array> {
    return hkdfDerive(masterKey, FIXED_SALT, `local-search-index:${mailboxUid}`);
}
