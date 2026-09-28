///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `Domain` CRUD + verification routes (`BaseDomainRoute`).
 * Every route here is `@RequiresTrustedRole()` on the backend — admin-only, matching `mailApi.ts`'s other
 * admin-scoped entities.
 */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";

export type { ListParams };

export interface Domain {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    name: string;
    enabled: boolean;
    verified: boolean;
    verificationToken: string;
    verifiedAt?: string;
    lastCheckedAt?: string;
    dkimSelector?: string;
    dkimPublicKey?: string;
    dmarcPolicy?: "none" | "quarantine" | "reject";
    dmarcReportEmail?: string;
    /** When set, this domain is a pure alias of the domain named here - it has no mailboxes of its own; mail
     * addressed to it is delivered to the matching mailbox on the domain it aliases instead. */
    aliasOf?: string;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function listDomains(params: ListParams = {}, client?: ApiClient): Promise<Domain[]> {
    return withClient(client, `/mail/domains?${buildQuery(params)}`);
}

export function getDomain(uid: string, client?: ApiClient): Promise<Domain> {
    return withClient(client, `/mail/domains/${encodeURIComponent(uid)}`);
}

export interface CreateDomainInput {
    name: string;
    enabled?: boolean;
    dkimSelector?: string;
    dkimPublicKey?: string;
    dmarcPolicy?: "none" | "quarantine" | "reject";
    dmarcReportEmail?: string;
    aliasOf?: string;
}

export function createDomain(input: CreateDomainInput, client?: ApiClient): Promise<Domain> {
    return withClient(client, "/mail/domains", {
        method: "POST",
        body: JSON.stringify({ enabled: true, ...input }),
    });
}

export interface UpdateDomainInput {
    uid: string;
    version: number;
    enabled?: boolean;
    dkimSelector?: string;
    dkimPublicKey?: string;
    dmarcPolicy?: "none" | "quarantine" | "reject";
    dmarcReportEmail?: string;
    aliasOf?: string;
}

export function updateDomain(input: UpdateDomainInput, client?: ApiClient): Promise<Domain> {
    return withClient(client, `/mail/domains/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteDomain(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/domains/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}

/** Triggers an immediate DNS ownership check rather than waiting for the next scheduled background pass.
 * Idempotent on an already-verified domain; a still-unverified result is not an error (only
 * `lastCheckedAt` advances) — always returns the domain's current state either way. */
export function verifyDomain(uid: string, client?: ApiClient): Promise<Domain> {
    return withClient(client, `/mail/domains/${encodeURIComponent(uid)}/verify`, { method: "POST" });
}

export type DnsRecordType = "ownership" | "mx" | "spf" | "dkim" | "dmarc" | "autodiscover_cname" | "autodiscover_srv";

/** One mail-related DNS record this server recommends for a domain, live-checked against real DNS —
 * purely diagnostic, never mutates anything (unlike `verifyDomain`). The two `autodiscover_*` types are only
 * ever present while `@rapidmx/autodiscover-plugin` is active for this deployment. */
export interface DnsRecordCheck {
    type: DnsRecordType;
    recordKind: "TXT" | "MX" | "CNAME" | "SRV";
    recordName: string;
    /** `false` when there isn't enough information yet to know what to recommend (no DKIM
     * selector/key configured, for example) — `recommendedValue`/`found`/`matches` are meaningless then. */
    configured: boolean;
    recommendedValue?: string;
    found: boolean;
    matches: boolean;
    actualValue?: string;
}

export function getDnsSetup(uid: string, client?: ApiClient): Promise<DnsRecordCheck[]> {
    return withClient(client, `/mail/domains/${encodeURIComponent(uid)}/dns-setup`);
}
