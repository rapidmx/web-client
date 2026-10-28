///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `BaseConfigKeyRoute` (mounted at `system/config-keys`): the keyring that encrypts the credentials, API keys and
 * tokens saved in the console, and the rotation of its keys. `GET` needs a trusted role; both writes a trusted role and an elevated token. Never any key
 * material: a key is its `kid`, its age and how many values it encrypts.
 */
import { ApiClient, ApiRequestError, withClient } from "../util/api.js";

/** Where a rotation is (restapi `ConfigKeyRotationPhase`). */
export type ConfigKeyRotationPhase = "adding" | "activating" | "reencrypting" | "retiring" | "done" | "failed";

/** One key of the ring (restapi `PublicConfigKey`). */
export interface ConfigKeyInfo {
    kid: string;
    /** ISO 8601. */
    createdAt: string;
    /** Whether the server copy that answered encrypts with it. */
    active: boolean;
    /** The values encrypted with it at the end of the last re-encryption pass; left out until one has counted. */
    envelopes?: number;
}

/** The current or last rotation (restapi `PublicConfigKeyRotation`). */
export interface ConfigKeyRotation {
    /** The new key, once it is in the keyring. */
    kid?: string;
    /** The keys it replaces. */
    previousKids: string[];
    compromised: boolean;
    requestedBy: string;
    requestedAt: string;
    phase: ConfigKeyRotationPhase;
    activationStartedAt?: string;
    /** The server copies (pod name and process id) that haven't yet loaded the new key while it is `activating`, and, once activated, those that don't yet
     * encrypt with it. */
    waitingFor?: string[];
    activatedAt?: string;
    /** Set by "Activate anyway", with the copies that hadn't loaded the key then. */
    activationForced?: { by: string; at: string; staleCopies: string[] };
    finishedAt?: string;
    /** What failed (a keyring write refused, for example), never a value. */
    lastError?: string;
    /** Why the new key is still not active and what resolves it, once the wait has gone on past `config_encryption:activation:warn_minutes`. */
    warning?: string;
}

/** A saved value the last re-encryption pass couldn't decrypt: named by record and field, never its value. */
export interface ConfigKeyUnreadable {
    record: string;
    uid: string;
    field: string;
    /** The key the envelope names. */
    kid: string;
}

export interface ConfigKeyReencryption {
    targetKid: string;
    /** Whether the last pass saw every row and saved every change. */
    complete: boolean;
    startedAt: string;
    finishedAt?: string;
    unreadable?: ConfigKeyUnreadable[];
}

/** The plugin secret settings' encryption (spec 5.7). */
export interface PluginSecretsState {
    /** When the first encryption run completed; until then secret settings are saved in plain text. */
    encryptedAt?: string;
    waitingForRollout?: boolean;
    checkedAt?: string;
    /** Why the run is still waiting (old pods, or the pods can't be listed). */
    reason?: string;
}

/** What `GET /system/config-keys` and both writes answer (restapi `PublicConfigKeys`). */
export interface ConfigKeys {
    /** Whether a rotation can be started: the keyring is in a store the server can write, and the server copies can be coordinated. */
    available: boolean;
    activeKid: string | null;
    keys: ConfigKeyInfo[];
    /** When the values were last counted. */
    countedAt: string | null;
    rotation: ConfigKeyRotation | null;
    reencryption: ConfigKeyReencryption | null;
    pluginSecrets: PluginSecretsState | null;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function getConfigKeys(client?: ApiClient): Promise<ConfigKeys> {
    return withClient(client, "/system/config-keys");
}

/** Starts a rotation of the configuration key. With `compromised`, it also marks a rotation already running as compromised. Needs an elevated token. A 409
 * (one is running) carries its progress: see `configKeysOfRefusal()`. */
export function rotateConfigKey(input: { compromised?: boolean } = {}, client?: ApiClient): Promise<ConfigKeys> {
    return withClient(client, "/system/config-keys/rotate", { method: "POST", body: JSON.stringify(input) });
}

/** "Activate anyway": makes the rotation's new key the one that encrypts before every server copy has loaded it. A 409 (the rotation isn't waiting to be
 * activated, or `kid` isn't its key) carries its progress. Needs an elevated token. */
export function activateConfigKey(kid: string, client?: ApiClient): Promise<ConfigKeys> {
    return withClient(client, "/system/config-keys/activate", { method: "POST", body: JSON.stringify({ kid }) });
}

/** The keyring's state a 409 carries as its body (a rotation already running, or not waiting to be activated), `undefined` for any other failure. */
export function configKeysOfRefusal(err: unknown): ConfigKeys | undefined {
    if (!(err instanceof ApiRequestError) || err.status !== 409) {
        return undefined;
    }
    const body = err.details as Partial<ConfigKeys> | null | undefined;
    return body && typeof body === "object" && Array.isArray(body.keys) ? (body as ConfigKeys) : undefined;
}
