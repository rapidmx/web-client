///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `EscrowAuditLogEntry` route (`BaseEscrowAuditLogRoute`) — read
 * only, same posture as `auditLogApi.ts`: `create`/`update`/`delete`/`truncate` unconditionally 403 for
 * every caller, trusted included (the only writer is restapi's own internal `recordEscrowAuditEntry()`),
 * so there is no write function here to mirror. `find`/`get` auto-scope to matters under scopes the
 * caller holds (unfiltered for a trusted admin); `verifyAuditChain()` (`GET /verify`) is
 * `@RequiresTrustedRole()`-only server-side — this wrapper applies no gating of its own, the server
 * enforces it and a non-trusted caller simply gets a 403 `ApiRequestError` back.
 */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";

export type { ListParams };

/** The lifecycle event an `EscrowAuditLogEntry` records — mirrors `@rapidmx/restapi`'s `EscrowAuditAction`
 * enum values exactly, including a Matter-scoped eDiscovery export's lifecycle (`matter_export.*`, whose
 * `requestId` is the `MatterExportRequest` uid). Deliberately excludes a denied access request (nothing was
 * ever granted or used there); that goes through the ordinary `AuditLogEntry` (`auditLogApi.ts`) instead. */
export type EscrowAuditAction =
    | "escrow_access_request.created"
    | "escrow_access_request.approved"
    | "matter_export.requested"
    | "matter_export.ready"
    | "matter_export.failed"
    | "escrow_access_request.material_read";

export interface EscrowAuditLogEntry {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    /** Monotonic, global (not per-scope) sequence number. */
    sequence: number;
    /** The immediately-preceding entry's `hash` — `undefined` only for the very first entry
     * (`sequence === 0`). */
    previousHash?: string;
    /** Hex digest over this entry's own content plus `previousHash`, computed with `hashAlgorithm`. */
    hash: string;
    /** The scheme `hash` was computed with. Absent = a legacy entry verified with plain SHA-256. */
    hashAlgorithm?: EscrowAuditHashAlgorithm;
    action: EscrowAuditAction;
    holderUserUid: string;
    matterId: string;
    mailboxUid: string;
    requestId: string;
    /** ISO 8601 timestamp. */
    occurredAt: string;
    details?: Record<string, unknown>;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function listAuditLogEntries(params: ListParams = {}, client?: ApiClient): Promise<EscrowAuditLogEntry[]> {
    return withClient(client, `/escrow/audit-log?${buildQuery(params)}`);
}

export function getAuditLogEntry(uid: string, client?: ApiClient): Promise<EscrowAuditLogEntry> {
    return withClient(client, `/escrow/audit-log/${encodeURIComponent(uid)}`);
}

/** Mirrors `@rapidmx/restapi`'s `EscrowAuditHashAlgorithm` enum values. */
export type EscrowAuditHashAlgorithm = "sha256" | "hmac-sha256";

/** Why the chain failed verification - mirrors `@rapidmx/restapi`'s `EscrowAuditVerificationFailure`
 * (`util/EscrowAuditUtils.ts`): `link_mismatch` (an entry deleted/inserted/reordered), `hash_mismatch` (an
 * entry edited), `unknown_algorithm`, `algorithm_downgrade` (an unkeyed entry after an HMAC one),
 * `hmac_key_unavailable` (server can't check HMAC entries), `truncated` (entries deleted from the tail),
 * `head_mismatch`, `head_mac_mismatch` (forged/edited head record), `head_missing`. */
export type EscrowAuditVerificationFailure =
    | "link_mismatch"
    | "hash_mismatch"
    | "unknown_algorithm"
    | "algorithm_downgrade"
    | "hmac_key_unavailable"
    | "truncated"
    | "head_mismatch"
    | "head_mac_mismatch"
    | "head_missing";

export interface EscrowAuditVerificationResult {
    valid: boolean;
    /** The lowest `sequence` at which the chain breaks, if `valid` is `false`. */
    brokenAtSequence?: number;
    /** Why the chain is invalid, when `valid` is `false`. A newer server may add values - treat an
     * unrecognized one as a generic verification failure. */
    reason?: EscrowAuditVerificationFailure | (string & {});
}

/** Walks the entire hash chain end to end. `@RequiresTrustedRole()`-only server-side, deliberately not
 * holder-accessible — the chain is global across every scope, so `brokenAtSequence` would leak the
 * existence/volume of *other* scopes' escrow activity to a holder who only has standing to know about
 * their own scope. A non-trusted caller gets a 403 `ApiRequestError`, same as any other gated endpoint. */
export function verifyAuditChain(client?: ApiClient): Promise<EscrowAuditVerificationResult> {
    return withClient(client, "/escrow/audit-log/verify");
}
