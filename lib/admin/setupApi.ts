///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s first-run setup state (`BaseSetupRoute`, mounted at `system/setup`).
 * Trusted-admin-only: a non-admin gets a `403`, which is how the web apps know not to send them to the wizard.
 */
import { ApiClient, withClient } from "../util/api.js";

/** Mirrors `@rapidmx/restapi`'s `SetupStatus`. Dates arrive as ISO strings. */
export interface SetupStatus {
    /** Whether an administrator should be taken to the setup wizard. */
    required: boolean;
    startedAt?: string;
    completedAt?: string;
    /** The wizard step last saved with `saveSetupStep()`. */
    currentStep?: string;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
export function getSetupStatus(client?: ApiClient): Promise<SetupStatus> {
    return withClient(client, "/system/setup");
}

/** Records the step the administrator is on, so leaving and coming back resumes there. */
export function saveSetupStep(currentStep: string, client?: ApiClient): Promise<SetupStatus> {
    return withClient(client, "/system/setup", { method: "PUT", body: JSON.stringify({ currentStep }) });
}

export function completeSetup(client?: ApiClient): Promise<SetupStatus> {
    return withClient(client, "/system/setup/complete", { method: "POST" });
}

/** Sends administrators back through the wizard from its first step. */
export function reopenSetup(client?: ApiClient): Promise<SetupStatus> {
    return withClient(client, "/system/setup/reopen", { method: "POST" });
}
