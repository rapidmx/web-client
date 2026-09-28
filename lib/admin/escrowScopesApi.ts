///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `EscrowScope` CRUD route (`BaseEscrowScopeRoute`) —
 * trusted-role-only for every action (create/update/delete/find/count/findById). Configuring *who counts
 * as a holder*, the dual-control threshold, and the scope's own public key is an administrative act,
 * deliberately separate from actually holding the eDiscovery/compliance role (see `mattersApi.ts`,
 * `specs/end-to-end_encryption.md`'s "Separation of duties") — this file is consumed only by
 * `apps/admin/escrow-scopes/*`, never by the holder-facing `apps/escrow` area.
 */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";
import type { ResolvedPrincipal } from "../mail/mailboxAccessApi.js";

export type { ListParams };
export type { ResolvedPrincipal };

/** A scope's own public key — mirrors `@rapidmx/restapi`'s `EscrowScopePublicKey` exactly. An admin
 * pastes in the fields of an already-issued certificate here; nothing in this app generates a keypair. */
export interface EscrowScopePublicKey {
    /** Base64-encoded public key (DER-encoded X.509 certificate, or raw key material). */
    publicKey: string;
    type: string;
    /** SHA-256 fingerprint of the key, hex encoded. */
    fingerprint: string;
    /** UTC timestamp (epoch ms) at which this key becomes valid. */
    notBefore: number;
    /** UTC timestamp (epoch ms) at which this key expires. */
    notAfter: number;
    /** UTC timestamp (epoch ms) at which this key was revoked, if applicable. */
    revokedAt?: number;
}

export interface EscrowScope {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    name: string;
    description?: string;
    publicKey: EscrowScopePublicKey;
    /** Uids of every user in the eDiscovery/compliance role for this scope. At least one required. */
    holderUserUids: string[];
    /** M in "M-of-N dual control" — must be between 1 and `holderUserUids.length` inclusive. */
    requiredHolders: number;
    notifySubjectOnAccess: boolean;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function listEscrowScopes(params: ListParams = {}, client?: ApiClient): Promise<EscrowScope[]> {
    return withClient(client, `/escrow/scopes?${buildQuery(params)}`);
}

/**
 * Who a typed principal - a mailbox address, an auth-server username or e-mail alias, or a user uid - is, for the
 * escrow-scope admin screen to confirm before adding them to `holderUserUids`. Rejects with a 404 `ApiRequestError`
 * ("No user found for ...") for nobody. Trusted-role-only (`BaseEscrowScopeRoute.resolveHolder()` in
 * `@rapidmx/restapi`) - never weaker than `createEscrowScope()`/`updateEscrowScope()`'s own gate on this same field.
 */
export function resolveEscrowScopeHolder(principal: string, client?: ApiClient): Promise<ResolvedPrincipal> {
    return withClient(client, `/escrow/scopes/resolve-holder?principal=${encodeURIComponent(principal)}`);
}

export function getEscrowScope(uid: string, client?: ApiClient): Promise<EscrowScope> {
    return withClient(client, `/escrow/scopes/${encodeURIComponent(uid)}`);
}

export interface CreateEscrowScopeInput {
    name: string;
    description?: string;
    publicKey: EscrowScopePublicKey;
    holderUserUids: string[];
    requiredHolders: number;
    notifySubjectOnAccess?: boolean;
}

export function createEscrowScope(input: CreateEscrowScopeInput, client?: ApiClient): Promise<EscrowScope> {
    return withClient(client, "/escrow/scopes", {
        method: "POST",
        body: JSON.stringify({ notifySubjectOnAccess: false, ...input }),
    });
}

export interface UpdateEscrowScopeInput {
    uid: string;
    version: number;
    name?: string;
    description?: string;
    publicKey?: EscrowScopePublicKey;
    holderUserUids?: string[];
    requiredHolders?: number;
    notifySubjectOnAccess?: boolean;
}

export function updateEscrowScope(input: UpdateEscrowScopeInput, client?: ApiClient): Promise<EscrowScope> {
    return withClient(client, `/escrow/scopes/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

/** 409s if a `Matter` still references this scope (`BaseEscrowScopeRoute.delete()`'s own referencing-Matter
 * guard) — the caller is expected to surface that `ApiRequestError` as-is, same as every other CRUD wrapper
 * in this package. */
export function deleteEscrowScope(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/escrow/scopes/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}
