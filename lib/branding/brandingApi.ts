///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrapper over `@rapidmx/restapi`'s `Branding` route (`BaseBrandingRoute`) — a single, admin-managed,
 * publicly-readable row of product chrome (logo, title/company name, custom stylesheet, header/footer HTML).
 * `GET /system/branding` needs no auth (every viewer, including an anonymous booking-page visitor, can read
 * it); every write is `@RequiresTrustedRole()` on the backend.
 */

import { ApiClient, withClient, withClientRaw } from "../util/api.js";

export interface Branding {
    companyName: string;
    title: string;
    /** Already a directly-usable `<img src>` value — either an admin-set external URL, or (once uploaded via
     * `uploadBrandingLogo()`) this server's own resolved asset URL. Never a bare blob key. */
    logoUrl?: string;
    /** The compact mark for navigation headers, independently configurable from `logoUrl`'s full logo -
     * same directly-usable shape as `logoUrl`. Falls back to `logoUrl`, then a built-in default, when unset
     * (see `useBranding()`'s `iconSrc`) - no fallback is applied here. */
    iconUrl?: string;
    /** Same shape as `logoUrl`, directly usable as a `<link href>`. */
    stylesheetUrl?: string;
    headerHtml?: string;
    footerHtml?: string;
}

/** `client`, given by every function below that isn't a raw-bytes upload, is an explicit `ApiClient` from
 * `createApiClient()` (e.g. one account of a multi-account app) to call instead of the default global
 * `apiFetch()` - see `withClient()`'s own doc comment in `util/api.ts`. Omitted (the default), every
 * function here behaves exactly as before. */
export function getBranding(client?: ApiClient): Promise<Branding> {
    return withClient(client, "/system/branding");
}

export interface UpdateBrandingInput {
    companyName?: string;
    title?: string;
    logoUrl?: string;
    iconUrl?: string;
    stylesheetUrl?: string;
    headerHtml?: string;
    footerHtml?: string;
}

export function updateBranding(input: UpdateBrandingInput, client?: ApiClient): Promise<Branding> {
    return withClient(client, "/system/branding", {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

function uploadBrandingAsset(path: string, file: File, client?: ApiClient): Promise<Branding> {
    return withClientRaw(client, path, "POST", file, file.type || "application/octet-stream");
}

/** Uploads `file` as the logo, self-hosted via `BlobStore` — bypasses `apiFetch` (which always forces
 * `Content-Type: application/json`) the same way `mailApi.ts`'s `uploadAttachment()` does, since
 * `BaseBrandingRoute.uploadLogo()` reads the raw request body directly. */
export function uploadBrandingLogo(file: File, client?: ApiClient): Promise<Branding> {
    return uploadBrandingAsset("/system/branding/logo", file, client);
}

/** Uploads `file` as the compact nav-header icon, independently of `uploadBrandingLogo()`'s full logo. */
export function uploadBrandingIcon(file: File, client?: ApiClient): Promise<Branding> {
    return uploadBrandingAsset("/system/branding/icon", file, client);
}

export function uploadBrandingStylesheet(file: File, client?: ApiClient): Promise<Branding> {
    return uploadBrandingAsset("/system/branding/stylesheet", file, client);
}

export function deleteBrandingLogo(client?: ApiClient): Promise<void> {
    return withClient(client, "/system/branding/logo", { method: "DELETE" });
}

export function deleteBrandingIcon(client?: ApiClient): Promise<void> {
    return withClient(client, "/system/branding/icon", { method: "DELETE" });
}

export function deleteBrandingStylesheet(client?: ApiClient): Promise<void> {
    return withClient(client, "/system/branding/stylesheet", { method: "DELETE" });
}
