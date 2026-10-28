///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `BaseDnsProviderRoute` (mounted at `system/dns-providers`): the DNS provider configs the server publishes
 * domain records through, the provider types the console's form is built from, the operations the DNS controller runs for a config, and what the
 * controller last said about itself. Reads need a trusted role; every write a trusted role and an elevated token. Credentials are write-only.
 */
import { ApiClient, withClient } from "../util/api.js";
import type { SecretMask } from "./integrationsApi.js";

export type DnsProviderType = "cloudflare" | "route53" | "rfc2136" | "google" | "azure";

export type DnsProviderOptionValue = string | number | boolean | string[];

export type DnsProviderOptionKind = "string" | "string-list" | "integer" | "boolean" | "enum";

/** One non-secret option of a provider type (restapi `DnsProviderTypeInfo["options"]`). */
export interface DnsProviderOptionSpec {
    key: string;
    label: string;
    kind: DnsProviderOptionKind;
    required: boolean;
    /** What a value left out is saved as. */
    default?: string | number | boolean;
    /** The choices of an `enum`. */
    values?: string[];
    min?: number;
    max?: number;
    maxItems?: number;
    description: string;
    format?: string;
}

/** One credential field of a provider type: saved encrypted on the config, never shown again. */
export interface DnsProviderSecretFieldSpec {
    key: string;
    label: string;
    /** Always needed. One needed only in some configurations says when in `description`. */
    required: boolean;
    /** A file's content (Google's service-account JSON) rather than a token. */
    multiLine?: boolean;
    description: string;
    format?: string;
}

/** What `GET /system/dns-providers/types` answers per type. */
export interface DnsProviderTypeInfo {
    type: DnsProviderType;
    label: string;
    externalDnsProvider: string;
    /** Whether the type has been tested against the real service; the console marks the others "not yet live-tested". */
    tested: boolean;
    options: DnsProviderOptionSpec[];
    secretFields: DnsProviderSecretFieldSpec[];
    unsupportedRecordKinds: ("MX" | "SRV")[];
    notes: string[];
}

/** What the DNS controller last reported about a config's external-dns instance; every field optional. */
export interface DnsProviderStatus {
    reportedAt?: string;
    readyReplicas?: number;
    image?: string;
    lastRolloutAt?: string;
    lastSyncAt?: string;
    registryErrors?: number;
    sourceErrors?: number;
    providerErrors?: number;
    ownerMismatchRecords?: number;
    lastError?: string;
}

/** A provider config as the server shows it (restapi `PublicDnsProvider`): its credentials only as masks, one per key saved. */
export interface DnsProvider {
    uid: string;
    name: string;
    type: DnsProviderType;
    zones: string[];
    options: Record<string, DnsProviderOptionValue>;
    credentials: Record<string, SecretMask>;
    origin?: "installer" | "console";
    enabled: boolean;
    allowTakeover: boolean;
    status?: DnsProviderStatus;
    /** The domains assigned to this config. */
    domainCount: number;
    version: number;
    dateCreated?: string;
    dateModified?: string;
}

/** What a create or an update sends. `credentials` is write-only: a string sets a field, `null` clears it, leaving it out keeps it. */
export interface DnsProviderInput {
    name?: string;
    /** Create only: a config's type never changes. */
    type?: DnsProviderType;
    zones?: string[];
    options?: Record<string, DnsProviderOptionValue>;
    credentials?: Record<string, string | null>;
    enabled?: boolean;
    allowTakeover?: boolean;
    /** Update only: the version the change was made against; a newer one is a 409. */
    version?: number;
}

export type DnsOperationType = "test" | "takeover" | "restore";

export type DnsOperationState = "queued" | "running" | "succeeded" | "failed";

/** One operation the DNS controller runs for a config (restapi `PublicDnsOperation`). */
export interface DnsOperation {
    uid: string;
    type: DnsOperationType;
    providerUid: string;
    domainUid?: string;
    state: DnsOperationState;
    /** The controller's result, or why the operation was cancelled (`Cancelled: ...`). */
    message?: string;
    requestedBy?: string;
    startedAt?: string;
    finishedAt?: string;
    dateCreated?: string;
}

/** What one status report of the controller is remembered by. */
export interface DnsControllerReport {
    controllerVersion: string;
    desiredStateVersion?: number;
    leaseHolder: boolean;
    leaseIdentity: string;
    at: string;
}

/** What `GET /system/dns-providers/controller` answers: what the DNS controller last said about itself, `null` for what it never said. */
export interface DnsControllerState {
    handshake: {
        controllerVersion: string;
        apiVersions: string[];
        compatible: boolean;
        selected?: string;
        reason?: string;
        at: string;
    } | null;
    lastReport: DnsControllerReport | null;
    lastStandbyReport: DnsControllerReport | null;
}

const BASE = "/system/dns-providers";

/** The path of the config `uid`. */
function providerPath(uid: string): string {
    return `${BASE}/${encodeURIComponent(uid)}`;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function listDnsProviders(client?: ApiClient): Promise<DnsProvider[]> {
    return withClient(client, BASE);
}

export function listDnsProviderTypes(client?: ApiClient): Promise<DnsProviderTypeInfo[]> {
    return withClient(client, `${BASE}/types`);
}

export function getDnsControllerState(client?: ApiClient): Promise<DnsControllerState> {
    return withClient(client, `${BASE}/controller`);
}

export function getDnsProvider(uid: string, client?: ApiClient): Promise<DnsProvider> {
    return withClient(client, providerPath(uid));
}

export function createDnsProvider(input: DnsProviderInput, client?: ApiClient): Promise<DnsProvider> {
    return withClient(client, BASE, { method: "POST", body: JSON.stringify(input) });
}

export function updateDnsProvider(uid: string, input: DnsProviderInput, client?: ApiClient): Promise<DnsProvider> {
    return withClient(client, providerPath(uid), { method: "PUT", body: JSON.stringify(input) });
}

/** Refused (409) while a domain is assigned to the config or a restore through it is still to run. */
export function deleteDnsProvider(uid: string, client?: ApiClient): Promise<void> {
    return withClient(client, providerPath(uid), { method: "DELETE" });
}

/** Queues a credentials test the DNS controller runs; answers the queued operation. */
export function testDnsProvider(uid: string, client?: ApiClient): Promise<DnsOperation> {
    return withClient(client, `${providerPath(uid)}/test`, { method: "POST" });
}

/** The config's latest operations, newest first. */
export function listDnsProviderOperations(uid: string, client?: ApiClient): Promise<DnsOperation[]> {
    return withClient(client, `${providerPath(uid)}/operations`);
}
