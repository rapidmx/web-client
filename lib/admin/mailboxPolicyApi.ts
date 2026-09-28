///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s deployment-wide `MailboxPolicy` singleton (`BaseMailboxPolicyRoute`,
 * mounted at `system/mailbox-policy`). `GET` is readable by any authenticated user and always returns the values in
 * effect (server config fills anything never saved), along with the server's current config values for the same
 * fields as `defaults`; `PUT` is trusted-admin-only.
 */
import { ApiClient, withClient } from "../util/api.js";

/** Mirrors `@rapidmx/restapi`'s `PublicMailboxPolicy`. */
export interface MailboxPolicy {
    /** The quota a newly created mailbox starts with, in bytes. */
    defaultQuotaBytes: number;
    /** Whether a signed-in user without a mailbox may create their own on first sign-in. */
    autoProvisionEnabled: boolean;
    /** The quota of a mailbox a user creates for themselves, in bytes. */
    autoProvisionQuotaBytes: number;
    /**
     * What the server's config says for each field right now - what a "reset" puts it back to. Absent from a server
     * that predates it, in which case there is nothing to reset to.
     */
    defaults?: Omit<MailboxPolicy, "defaults">;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function getMailboxPolicy(client?: ApiClient): Promise<MailboxPolicy> {
    return withClient(client, "/system/mailbox-policy");
}

/** Partial patch - only supplied fields change. */
export function updateMailboxPolicy(patch: Partial<Omit<MailboxPolicy, "defaults">>, client?: ApiClient): Promise<MailboxPolicy> {
    return withClient(client, "/system/mailbox-policy", { method: "PUT", body: JSON.stringify(patch) });
}
