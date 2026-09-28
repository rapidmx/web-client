///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed client for the signed-in user's appearance preferences - their colour scheme, theme colours and app background
 * (`@rapidmx/restapi`'s `/mail/preferences/appearance` routes):
 *
 * - `GET  /mail/preferences/appearance` reads the `AppearancePreferences` object (never a 404: a user with none gets the defaults). `PUT`
 * the same path **merges** a partial `AppearanceUpdate` into it (each colour and each background field on its own; `null` clears a
 * colour) and answers with the saved object - so a client sends what changed (`diffAppearance()`), never the whole thing.
 * - `POST /mail/preferences/appearance/background` stores the request body (a raw image, `Content-Type` = the file's own) as the
 * background and answers with the updated preferences; `DELETE` the same path removes it.
 * - `GET  /mail/preferences/appearance/background/:version` is the image itself - immutable per version, so an `<img>`/CSS `url()`
 * pointing at `appearanceBackgroundUrl()` is cached for good.
 * - A change is also pushed to the user's other tabs and devices as `{ type: /^AppearancePreferences/, action: "update", data }` on
 * the user's own uid channel - `parseAppearanceEvent()` reads it.
 *
 * Everything that comes from outside - the response, a push event, the page's server-rendered props, `localStorage` - goes through
 * `normalizeAppearance()`, which keeps only well-formed values (so a stale or hostile value can never reach a CSS declaration).
 */
import { ApiClient, ApiRequestError, apiUrl, withClient, withCsrfHeader } from "../util/api.js";

export type AppearanceMode = "system" | "light" | "dark";
export type BackgroundKind = "none" | "color" | "image";
export type BackgroundFit = "cover" | "contain" | "tile";

/** Theme colours, each `#rrggbb` and each optional: an unset one keeps the app's (or the deployment's branding's) own. */
export interface AppearanceColors {
    primary?: string;
    accent?: string;
    surface?: string;
    text?: string;
}

export interface AppearanceBackground {
    kind: BackgroundKind;
    /** `kind: "color"`: the colour. `kind: "image"`: the colour shown behind the image (letterboxing, while it loads). `#rrggbb`. */
    color?: string;
    /** Which stored image `kind: "image"` shows - part of its URL (`appearanceBackgroundUrl()`), so a new upload is a new URL. */
    imageVersion?: string | number;
    /** How much of the scheme's surface colour is laid over the image, `0` to `BACKGROUND_DIM_MAX`. */
    dim: number;
    /** Blur radius in CSS pixels, `0` to `BACKGROUND_BLUR_MAX`. */
    blur: number;
    fit: BackgroundFit;
}

export interface AppearancePreferences {
    version: 1;
    mode: AppearanceMode;
    colors?: AppearanceColors;
    background?: AppearanceBackground;
    /** When the server last stored these. Opaque to the client (compared for equality, never parsed). */
    updatedAt?: string | number;
}

/** Preferences without the server's own timestamp. */
export type AppearanceInput = Omit<AppearancePreferences, "updatedAt">;

/**
 * What `PUT` takes, a partial that the server merges into what is stored: `mode`; `colors` (a colour is set by its `#rrggbb` and cleared by
 * `null`, and `colors: null` clears all four); `background` (any of its fields, merged one by one - `color: null` clears the colour). It cannot
 * name an `imageVersion` (uploading is what makes one), and `kind: "image"` needs an image already uploaded.
 */
export interface AppearanceUpdate {
    version?: 1;
    mode?: AppearanceMode;
    colors?: Partial<Record<ColorKey, string | null>> | null;
    background?: Partial<Omit<AppearanceBackground, "color" | "imageVersion">> & { color?: string | null };
}

export const APPEARANCE_MODES: readonly AppearanceMode[] = ["system", "light", "dark"];
export const BACKGROUND_KINDS: readonly BackgroundKind[] = ["none", "color", "image"];
export const BACKGROUND_FITS: readonly BackgroundFit[] = ["cover", "contain", "tile"];
export const COLOR_KEYS = ["primary", "accent", "surface", "text"] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

/** The largest dim the server accepts - beyond it the picture is not worth having. */
export const BACKGROUND_DIM_MAX = 0.8;
/** The largest blur, in CSS pixels. */
export const BACKGROUND_BLUR_MAX = 20;

/** The image types a background may be - raster only: an SVG is a document that can carry script. */
export const BACKGROUND_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/avif"];
/** The largest background image, in bytes. */
export const BACKGROUND_MAX_BYTES = 8 * 1024 * 1024;

/** The preferences a user who never chose anything has. */
export const DEFAULT_APPEARANCE: AppearanceInput = { version: 1, mode: "system" };

/** The starting background when the user first picks a kind: a light dim and no blur, covering the whole app. */
export const DEFAULT_BACKGROUND: AppearanceBackground = { kind: "none", dim: 0.2, blur: 0, fit: "cover" };

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** An image version becomes part of a URL path: only characters that need no escaping. */
const IMAGE_VERSION = /^[A-Za-z0-9._-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hexOrUndefined(value: unknown): string | undefined {
    return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : undefined;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function normalizeBackground(value: unknown): AppearanceBackground | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const color = hexOrUndefined(value.color);
    const rawVersion = value.imageVersion;
    const imageVersion =
        typeof rawVersion === "number" && Number.isFinite(rawVersion) && rawVersion >= 0
            ? rawVersion
            : typeof rawVersion === "string" && IMAGE_VERSION.test(rawVersion)
              ? rawVersion
              : undefined;
    let kind: BackgroundKind = BACKGROUND_KINDS.includes(value.kind as BackgroundKind) ? (value.kind as BackgroundKind) : "none";
    // A kind without what it shows is nothing: an "image" that has no stored image, a "color" with no colour.
    if ((kind === "image" && imageVersion === undefined) || (kind === "color" && color === undefined)) {
        kind = "none";
    }
    const background: AppearanceBackground = {
        kind,
        dim: clampNumber(value.dim, 0, BACKGROUND_DIM_MAX, DEFAULT_BACKGROUND.dim),
        blur: clampNumber(value.blur, 0, BACKGROUND_BLUR_MAX, DEFAULT_BACKGROUND.blur),
        fit: BACKGROUND_FITS.includes(value.fit as BackgroundFit) ? (value.fit as BackgroundFit) : DEFAULT_BACKGROUND.fit,
    };
    if (color !== undefined) {
        background.color = color;
    }
    if (imageVersion !== undefined) {
        background.imageVersion = imageVersion;
    }
    return background;
}

/**
 * The well-formed part of `value` as `AppearancePreferences`, or `undefined` when it is not preferences at all (not an object, or not
 * `version: 1`). Unknown keys are dropped, colours must be `#rrggbb` (lower-cased), numbers are clamped into their range, and an enum
 * that isn't one of its values falls back to the default - so what comes out is always safe to turn into CSS.
 */
export function normalizeAppearance(value: unknown): AppearancePreferences | undefined {
    if (!isRecord(value) || value.version !== 1) {
        return undefined;
    }
    const prefs: AppearancePreferences = {
        version: 1,
        mode: APPEARANCE_MODES.includes(value.mode as AppearanceMode) ? (value.mode as AppearanceMode) : "system",
    };
    if (isRecord(value.colors)) {
        const colors: AppearanceColors = {};
        for (const key of COLOR_KEYS) {
            const hex = hexOrUndefined(value.colors[key]);
            if (hex !== undefined) {
                colors[key] = hex;
            }
        }
        if (Object.keys(colors).length > 0) {
            prefs.colors = colors;
        }
    }
    const background = normalizeBackground(value.background);
    if (background) {
        prefs.background = background;
    }
    if (typeof value.updatedAt === "string" || (typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt))) {
        prefs.updatedAt = value.updatedAt;
    }
    return prefs;
}

/**
 * The reason `file` can't be a background, worded for the person choosing it, or `undefined` when it can. Checked before anything is
 * uploaded (the server checks again). Takes anything with a `type` and a `size`, so it is testable without a real `File`.
 */
export function validateBackgroundFile(file: { type: string; size: number }): string | undefined {
    if (!BACKGROUND_IMAGE_TYPES.includes(file.type)) {
        return "Choose a PNG, JPEG, WebP or AVIF image.";
    }
    if (file.size > BACKGROUND_MAX_BYTES) {
        return `That image is ${(file.size / (1024 * 1024)).toFixed(1)} MB; the limit is ${BACKGROUND_MAX_BYTES / (1024 * 1024)} MB.`;
    }
    if (file.size === 0) {
        return "That file is empty.";
    }
    return undefined;
}

const PATH = "/mail/preferences/appearance";

/** What a background is until the user sets anything, as the server has it. */
const SERVER_DEFAULT_BACKGROUND: AppearanceBackground = { kind: "none", dim: 0, blur: 0, fit: "cover" };

/**
 * The `PUT` that takes what the server has (`server`, `undefined` for nothing yet) to `next`: only what differs, in the merge form the
 * server takes - a colour that is gone is `null`, all of them gone is `colors: null`, and a background that is gone is `kind: "none"`
 * (the server refuses `background: null`). `undefined` when there is nothing to send. The image is never named: its `imageVersion` is
 * the server's to choose, and `kind: "image"` is only sent once `next` shows the very image the server holds - an image that is still
 * uploading (a version the server doesn't know) can't be switched to yet.
 */
export function diffAppearance(server: AppearancePreferences | undefined, next: AppearanceInput): AppearanceUpdate | undefined {
    const update: AppearanceUpdate = {};
    if (next.mode !== (server?.mode ?? "system")) {
        update.mode = next.mode;
    }
    const colors: Partial<Record<ColorKey, string | null>> = {};
    for (const key of COLOR_KEYS) {
        if (next.colors?.[key] !== server?.colors?.[key]) {
            colors[key] = next.colors?.[key] ?? null;
        }
    }
    if (Object.keys(colors).length > 0) {
        update.colors = !next.colors ? null : colors;
    }
    const base = server?.background ?? SERVER_DEFAULT_BACKGROUND;
    const wanted = next.background;
    if (!wanted) {
        if (base.kind !== "none") {
            update.background = { kind: "none" };
        }
    } else {
        const changes: NonNullable<AppearanceUpdate["background"]> = {};
        const heldImage = wanted.imageVersion !== undefined && wanted.imageVersion === base.imageVersion;
        if (wanted.kind !== base.kind && (wanted.kind !== "image" || heldImage)) {
            changes.kind = wanted.kind;
        }
        if (wanted.color !== base.color) {
            changes.color = wanted.color ?? null;
        }
        for (const key of ["dim", "blur", "fit"] as const) {
            if (wanted[key] !== base[key]) {
                (changes as Record<string, unknown>)[key] = wanted[key];
            }
        }
        if (Object.keys(changes).length > 0) {
            update.background = changes;
        }
    }
    return Object.keys(update).length > 0 ? { version: 1, ...update } : undefined;
}

/** `true` when nothing meaningful is set - a user who has changed nothing, or reset everything. */
export function isDefaultAppearance(prefs: AppearanceInput | undefined): boolean {
    return (
        !prefs ||
        (prefs.mode === "system" &&
            !prefs.colors &&
            (!prefs.background || prefs.background.kind === "none"))
    );
}

/** `client`, given by every function below that isn't a raw-bytes upload, is an explicit `ApiClient` from
 * `createApiClient()` (e.g. one account of a multi-account app) to call instead of the default global
 * `apiFetch()` - see `withClient()`'s own doc comment in `util/api.ts`. Omitted (the default), every
 * function here behaves exactly as before. */

/** The user's stored preferences, or `undefined` when there are none to read (a `404`, or a body that isn't preferences). */
export async function getAppearance(client?: ApiClient): Promise<AppearancePreferences | undefined> {
    try {
        return normalizeAppearance(await withClient(client, PATH));
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
            return undefined;
        }
        throw err;
    }
}

/** Merges `update` into the user's preferences and returns what the server stored. */
export async function saveAppearance(update: AppearanceUpdate, client?: ApiClient): Promise<AppearancePreferences> {
    const stored = normalizeAppearance(await withClient(client, PATH, { method: "PUT", body: JSON.stringify(update) }));
    if (!stored) {
        throw new ApiRequestError("The server did not return the saved appearance.", 502);
    }
    return stored;
}

/** Stores `file` (already checked with `validateBackgroundFile()`) as the background: its raw bytes, with its own content type - which
 * bypasses `apiFetch()`, as it always sends JSON. Answers with the updated preferences. */
export async function uploadAppearanceBackground(file: Blob): Promise<AppearancePreferences> {
    const res = await fetch(apiUrl(`${PATH}/background`), {
        method: "POST",
        credentials: "include",
        headers: withCsrfHeader({ "Content-Type": file.type || "application/octet-stream" }),
        body: file,
    });
    const contentType = res.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await res.json().catch(() => undefined) : undefined;
    if (!res.ok) {
        const message = (body && (body.message || body.error)) || res.statusText || "Upload failed.";
        throw new ApiRequestError(message, res.status, body?.code);
    }
    const stored = normalizeAppearance(body);
    if (!stored) {
        throw new ApiRequestError("The server did not return the saved appearance.", 502);
    }
    return stored;
}

/** Removes the stored background image. Answers with the updated preferences when the server sends them, else `undefined`. */
export async function deleteAppearanceBackground(client?: ApiClient): Promise<AppearancePreferences | undefined> {
    return normalizeAppearance(await withClient(client, `${PATH}/background`, { method: "DELETE" }));
}

/** The URL of the stored background image `version` - what CSS `url()` and `<img src>` use. Immutable per version. */
export function appearanceBackgroundUrl(version: string | number): string {
    return apiUrl(`${PATH}/background/${encodeURIComponent(String(version))}`);
}

/**
 * What a push event says about the appearance: the new preferences for a `create`/`update` of an `AppearancePreferences...` model
 * (whose `data` normalises), `null` for its `delete` (the user's back to the defaults), and `undefined` for any other event.
 */
export function parseAppearanceEvent(event: {
    type: string;
    action?: string;
    data?: unknown;
}): AppearancePreferences | null | undefined {
    if (!/^AppearancePreferences/.test(event.type)) {
        return undefined;
    }
    if (event.action === "delete") {
        return null;
    }
    if (event.action === "update" || event.action === "create") {
        return normalizeAppearance(event.data);
    }
    return undefined;
}
