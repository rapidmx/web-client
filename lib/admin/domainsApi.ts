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
import { ListParams, buildQuery, sortQuery } from "../util/apiQuery.js";

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
    /** The DNS provider config (`system/dns-providers`) that publishes this domain's records, `null` or unset for "manual": the administrator adds
     * them by hand. Changes only through `assignDnsProvider()`. */
    dnsProviderUid?: string | null;
    /** Whether RapidMX owns the domain's root TXT records (to publish SPF there) and which other values it keeps in them. Unset means not managed;
     * `keep` and `spf` stay after an opt-out. Changes only through `updateApexTxt()`. */
    apexTxt?: ApexTxtSettings | null;
}

export interface ApexTxtSettings {
    managed: boolean;
    keep: string[];
    spf?: string;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function listDomains(params: ListParams = {}, client?: ApiClient): Promise<Domain[]> {
    return withClient(client, `/mail/domains?${buildQuery(params, sortQuery({ uid: "ASC" }))}`);
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

export type DnsRecordType =
    | "ownership"
    | "mx"
    | "spf"
    | "dkim"
    | "dkim_next"
    | "dkim_previous"
    | "dmarc"
    | "openpgpkey_cname"
    | "autodiscover_cname"
    | "autodiscover_srv";

/** How a record is published: `published` (the DNS controller applied it and the live lookup sees it), `pending`, `conflict` (a record this deployment
 * doesn't own is there) or `manual` (the administrator adds it, see `DnsManualReason`). */
export type DnsPublicationState = "published" | "pending" | "conflict" | "manual";

/** Why a record is `manual`: no provider is assigned, the provider can't hold the record's kind, the name lies outside the provider's zones, or the
 * record belongs to the root TXT set, which RapidMX manages only on the administrator's opt-in. */
export type DnsManualReason = "no_provider" | "kind_unsupported" | "outside_zones" | "apex_txt_unmanaged";

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
    /** Whether, and how, the DNS controller publishes this record. Present only on a server that publishes, and only for a configured record. */
    publication?: DnsPublicationState;
    manualReason?: DnsManualReason;
    /** `ownership` only: the token is (still) at the domain's root, where it lived before `_rapidmx-verify.<domain>`. */
    legacyApex?: boolean;
}

export function getDnsSetup(uid: string, client?: ApiClient): Promise<DnsRecordCheck[]> {
    return withClient(client, `/mail/domains/${encodeURIComponent(uid)}/dns-setup`);
}

/** Assigns the domain to a DNS provider config, or back to manual (`null`). Needs an elevated token; the provider must cover the domain more specifically
 * than any other (a 400 otherwise). Answers the domain. */
export function assignDnsProvider(uid: string, dnsProviderUid: string | null, client?: ApiClient): Promise<Domain> {
    return withClient(client, `/mail/domains/${encodeURIComponent(uid)}/dns-provider`, {
        method: "PUT",
        body: JSON.stringify({ dnsProviderUid }),
    });
}

/** What `GET /:id/apex-txt` answers: the managed state and what the opt-in form starts from. */
export interface ApexTxtView {
    managed: boolean;
    keep: string[];
    spf?: string;
    /** The values at the domain's root now, as a live lookup sees them. */
    current: string[];
    /** `current` without SPF records and RapidMX ownership tokens: what the list of values to keep starts as. */
    suggestedKeep: string[];
    /** The lookup couldn't be answered, so `current` and `suggestedKeep` say nothing about what is there: the opt-in must not be offered. */
    lookupFailed?: true;
}

export function getApexTxt(uid: string, client?: ApiClient): Promise<ApexTxtView> {
    return withClient(client, `/mail/domains/${encodeURIComponent(uid)}/apex-txt`);
}

/** Opts the domain's root TXT records into RapidMX's management (`managed: true` with the values to keep), edits the kept values while managed, or
 * opts out (`managed: false`). Needs an elevated token. Answers the domain. */
export function updateApexTxt(uid: string, input: { managed: boolean; keep?: string[] }, client?: ApiClient): Promise<Domain> {
    return withClient(client, `/mail/domains/${encodeURIComponent(uid)}/apex-txt`, { method: "PUT", body: JSON.stringify(input) });
}
