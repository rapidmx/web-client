///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s deployment-wide `RetentionPolicy` singleton
 * (`BaseRetentionPolicyRoute`, mounted at `system/retention-policy`). `GET` is readable by any
 * authenticated user; `PUT` is trusted-admin-only server-side. Enforcement itself (actually purging
 * expired messages/audit-log entries) lives entirely in restapi's own `RetentionEnforcementJob` — this
 * file only reads/writes the configuration.
 */
import { ApiClient, withClient } from "../util/api.js";

/** Mirrors `@rapidmx/restapi`'s `PublicRetentionPolicy` exactly. Both fields `undefined` means "no
 * automatic purge configured" — `GET` returns `{}` rather than 404 when nothing has been set yet. */
export interface RetentionPolicy {
    /** Max age (days) for any `Message`, any folder. `undefined` = no automatic purge. */
    messageRetentionDays?: number;
    /** Max age (days) for `AuditLogEntry` rows. `undefined` = keep forever. Never applies to the
     * separate, hash-chained `EscrowAuditLogEntry` ledger — deleting from that would break its own
     * tamper-evident chain, by design. */
    auditLogRetentionDays?: number;
}

/** The server-enforced floor for `auditLogRetentionDays` (2190 days, ~6 years — a HIPAA-approximation
 * minimum) — mirrored here only so client-side validation can give the same message before a round trip;
 * the server enforces this regardless. */
export const MIN_AUDIT_LOG_RETENTION_DAYS = 2190;

/** The server-enforced floor for `messageRetentionDays` (30 days) - `MIN_MESSAGE_RETENTION_DAYS` in `@rapidmx/restapi`, mirrored here for the same reason as
 * `MIN_AUDIT_LOG_RETENTION_DAYS`. A shorter period is refused with a 400. */
export const MIN_MESSAGE_RETENTION_DAYS = 30;

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function getRetentionPolicy(client?: ApiClient): Promise<RetentionPolicy> {
    return withClient(client, `/system/retention-policy`);
}

/** A retention policy change: a field left out is left alone, and `null` clears it back to "no automatic purge". */
export type RetentionPolicyUpdate = { [K in keyof RetentionPolicy]?: RetentionPolicy[K] | null };

/** Partial patch — only supplied fields are changed, and a `null` field is cleared. */
export function updateRetentionPolicy(patch: RetentionPolicyUpdate, client?: ApiClient): Promise<RetentionPolicy> {
    return withClient(client, `/system/retention-policy`, {
        method: "PUT",
        body: JSON.stringify(patch),
    });
}
