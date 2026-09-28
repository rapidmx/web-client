///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s signing-certificate backend endpoints:
 *
 * - `getSigningEnrollmentInfo()` — `GET /system/signing-enrollment` (any signed-in user): which backend issues
 * signing certificates in this deployment (`manual`, `rfc8823` or `none`), whether it's automatic, the
 * certificate authority's host, a typical duration, whether an administrator can upload a certificate by hand,
 * and how the background job's last contacts with the CA went. `@rapidmx/web-client`'s Encryption settings page
 * uses this to word a request's status truthfully instead of assuming automatic issuance.
 * - The administrator functions — `BaseSigningEnrollmentAdminRoute` (mounted at `admin/signing-enrollments`,
 * trusted role AND an elevated token): list pending requests, download a request's CSR, upload the certificate a
 * CA issued, or reject a request with a reason its owner sees. This is the manual-issuance workflow, and an
 * escape hatch to inspect an automatic (`rfc8823`) request that has stalled.
 */
import { ApiClient, apiUrl, withClient } from "../util/api.js";

/** Mirrors `@rapidmx/restapi`'s `SigningProviderKind`. */
export type SigningProviderKind = "manual" | "rfc8823";

/** Mirrors `@rapidmx/restapi`'s `SigningBackendKind`. */
export type SigningBackendKind = SigningProviderKind | "none";

/** The code a stale enrollment id (left over from a backend this deployment no longer runs) answers with - a client
 * that sees this on a status check or a "check now" should clear the id and let the user request again. */
export const SIGNING_ENROLLMENT_UNKNOWN = "signing-enrollment-unknown";

/** How the background job's last contacts with the certificate authority went. Absent fields mean "never contacted yet". */
export interface SigningEnrollmentHealth {
    ok: boolean;
    checkedAt?: string;
    lastSuccessAt?: string;
    /** Sanitized (no URLs, tokens or key material) and length-capped - safe to show as-is. */
    lastError?: string;
}

/** Mirrors `@rapidmx/restapi`'s `SigningBackendInfo` - what `GET /system/signing-enrollment` answers. */
export interface SigningEnrollmentInfo {
    backend: SigningBackendKind;
    automatic: boolean;
    ca?: { host: string };
    contactEmail?: string;
    typicalDurationMinutes?: number;
    adminUpload: boolean;
    health?: SigningEnrollmentHealth;
}

/** Mirrors `@rapidmx/restapi`'s `AdminEnrollmentSummary` - one row of `GET /admin/signing-enrollments`. Never a CSR, key or certificate. */
export interface AdminSigningEnrollment {
    enrollmentId: string;
    identity: string;
    mailboxUid?: string;
    requestedAt: string;
    status: "pending" | "issued" | "failed";
    provider: SigningProviderKind;
    stage?: string;
    lastError?: string;
    /** Whether an administrator can upload a certificate for this request right now. */
    canUpload: boolean;
    /** When `canUpload` is `false`: why (e.g. the automatic provider issues this one itself, or it predates the mailbox's key being kept with it). */
    uploadBlockedReason?: string;
}

/** What `POST /admin/signing-enrollments/:id/certificate` answers once the upload is accepted. */
export interface CertificateUploadResult {
    enrollmentId: string;
    identity: string;
    status: "issued";
    chainLength: number;
    subject: string;
    issuer: string;
    serialNumber: string;
    notBefore: string;
    notAfter: string;
    message: string;
}

/** What `POST /admin/signing-enrollments/:id/reject` answers. */
export interface RejectEnrollmentResult {
    enrollmentId: string;
    status: "failed";
    error: string;
}

const ADMIN_BASE = "/admin/signing-enrollments";

/** `client`, given by every function below that calls the network, is an explicit `ApiClient` from `createApiClient()`
 * (e.g. one account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function getSigningEnrollmentInfo(client?: ApiClient): Promise<SigningEnrollmentInfo> {
    return withClient(client, `/system/signing-enrollment`);
}

/** The pending (and issued-but-not-yet-installed) signing-certificate requests, metadata only. Trusted role + elevated token required server-side. */
export function listSigningEnrollments(client?: ApiClient): Promise<AdminSigningEnrollment[]> {
    return withClient(client, ADMIN_BASE);
}

/** A plain URL, not a fetch wrapper — the server streams the CSR back as a PEM file with its own `content-disposition:
 * attachment` header, so a caller renders this directly as `<a href={...}>` (the browser's own native download) —
 * same pattern `dataExportApi.ts`'s `exportRequestDownloadUrl()` already establishes. */
export function signingEnrollmentCsrUrl(enrollmentId: string): string {
    return apiUrl(`${ADMIN_BASE}/${encodeURIComponent(enrollmentId)}/csr`);
}

/** Uploads the certificate (or PEM chain, leaf first) a certificate authority issued for a request. Refused (400) with a message to act
 * on when it doesn't fit the request (wrong key, not for e-mail, wrong address, expired); (409) when the request can no longer be
 * completed (already issued/failed, or made before its mailbox's key was kept with it). */
export function uploadSigningEnrollmentCertificate(
    enrollmentId: string,
    certificate: string,
    client?: ApiClient,
): Promise<CertificateUploadResult> {
    return withClient(client, `${ADMIN_BASE}/${encodeURIComponent(enrollmentId)}/certificate`, {
        method: "POST",
        body: JSON.stringify({ certificate }),
    });
}

/** Refuses a pending request; `reason` is shown to the mailbox's owner. */
export function rejectSigningEnrollment(enrollmentId: string, reason: string, client?: ApiClient): Promise<RejectEnrollmentResult> {
    return withClient(client, `${ADMIN_BASE}/${encodeURIComponent(enrollmentId)}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
    });
}

/** A quick client-side sanity check of pasted/uploaded certificate text before it is sent to the server: at least one PEM certificate
 * block. The server does the real validation (key match, e-mail usage, address, expiry) - this only catches an empty paste or an
 * obviously wrong file (e.g. a private key) before a round trip. */
export function looksLikePemCertificate(text: string): boolean {
    return /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(text);
}
