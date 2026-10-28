///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `BaseIntegrationsRoute` (mounted at `system/integrations`): the third-party services an administrator
 * chooses (Giphy, STUN, the S/MIME signing CA, the DNS resolver, the plugin registry), each section overriding some of the deployment's configuration.
 * `GET` needs a trusted role; every write a trusted role and an elevated token. Secrets are write-only: the server answers them only as the mask.
 */
import { ApiClient, withClient } from "../util/api.js";

/** What the server shows in place of a secret that is set (restapi `SecretMask`); sent back, it means "keep the saved value". `unreadable` is the
 * server saying that this copy can't decrypt it (a key missing from its keyring, after a restore with an older one): never sent back. */
export interface SecretMask {
    secret: true;
    unreadable?: boolean;
}

/** Whether `value` is the mask: an object whose keys are `secret`, set to `true`, and at most `unreadable`, a flag. */
export function isSecretMask(value: unknown): value is SecretMask {
    if (typeof value !== "object" || value === null || (value as SecretMask).secret !== true) {
        return false;
    }
    const unreadable: unknown = (value as SecretMask).unreadable;
    return Object.keys(value).length === (unreadable === undefined ? 1 : 2) && (unreadable === undefined || typeof unreadable === "boolean");
}

/** Whether `value` is the mask of a secret that is set but that the server can't read: it must be entered again. */
export function isUnreadableSecret(value: unknown): boolean {
    return isSecretMask(value) && value.unreadable === true;
}

export type IntegrationSectionName = "giphy" | "stun" | "signingCa" | "dnsResolver" | "pluginRegistry";

/** Where a field's value comes from: saved by an administrator here, or the deployment's configuration. */
export type IntegrationSource = "admin" | "deployment";

/** One section as the server shows it (restapi `IntegrationSectionView`): the values in effect, the deployment's own values (what a reset puts a field
 * back to) and where each value comes from. A secret is the mask when set, else `null`. */
export interface IntegrationSectionView<V> {
    values: V;
    defaults: V;
    source: Record<keyof V, IntegrationSource>;
}

export interface GiphyIntegration {
    enabled: boolean;
    apiKey: SecretMask | null;
}

export interface StunIntegration {
    /** `null`: the meet plugin's built-in list. */
    urls: string[] | null;
}

export type SigningCaBackend = "rfc8823" | "manual" | "none";

export interface SigningCaIntegration {
    backend: SigningCaBackend;
    directoryUrl: string;
    contactEmail: string | null;
}

export type DnsResolverMode = "node" | "doh-dnssec";

export interface DnsResolverIntegration {
    mode: DnsResolverMode;
    dohEndpoint: string;
}

/** A plugin namespace as the view shows it: its token only as the mask. Sent back, `token` is the mask (keep), a new value, or left out (none). */
export interface IntegrationPluginNamespace {
    name: string;
    registry?: string;
    token?: SecretMask | string;
}

export interface PluginRegistryIntegration {
    url: string;
    token: SecretMask | null;
    namespaces: IntegrationPluginNamespace[];
}

/** What `GET /system/integrations` and every write answer (restapi `IntegrationSettingsResponse`). */
export interface IntegrationSettings {
    giphy: IntegrationSectionView<GiphyIntegration>;
    stun: IntegrationSectionView<StunIntegration>;
    signingCa: IntegrationSectionView<SigningCaIntegration>;
    dnsResolver: IntegrationSectionView<DnsResolverIntegration>;
    pluginRegistry: IntegrationSectionView<PluginRegistryIntegration>;
    /** The saved settings' version (0 before anything was saved), sent back with a change so one made against an older version is refused (409). */
    version: number;
}

/** A section's change: a field left out is unchanged, `null` puts it back to the deployment's value, a secret sent back as the mask is kept. */
export type IntegrationSectionPatch = Record<string, unknown> & { version?: number };

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function getIntegrations(client?: ApiClient): Promise<IntegrationSettings> {
    return withClient(client, "/system/integrations");
}

export function updateIntegrationSection(section: IntegrationSectionName, patch: IntegrationSectionPatch, client?: ApiClient): Promise<IntegrationSettings> {
    return withClient(client, `/system/integrations/${section}`, { method: "PUT", body: JSON.stringify(patch) });
}
