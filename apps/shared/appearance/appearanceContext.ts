///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createContext, useContext } from "react";
import type {
    AppearanceBackground,
    AppearanceMode,
    AppearancePreferences,
    ColorKey,
} from "@rapidmx/react-shared/appearance/preferencesApi.js";
import type { ResolvedTheme } from "./resolvedTheme.js";
import type { PhotoRange } from "./theme.js";

/**
 * A change to the preferences, merged into what is there: `mode` replaces; each `colors` entry replaces that colour, and `null` clears
 * it (back to the app's own); `background` merges into the current one (or a fresh one); `background: null` removes it.
 */
export interface AppearancePatch {
    mode?: AppearanceMode;
    colors?: Partial<Record<ColorKey, string | null>>;
    background?: Partial<AppearanceBackground> | null;
}

export interface AppearanceApi {
    /** What is showing now - the user's choices including one still being saved. Never `undefined`: a user who chose nothing has the defaults. */
    prefs: AppearancePreferences;
    /** The scheme showing: the chosen mode, or for "System" the operating system's. */
    resolved: ResolvedTheme;
    /** Where the background image is loaded from - the stored image's URL, or a local preview while it uploads. */
    backgroundUrl: string | undefined;
    /** The background image's measured lightness, once known (until then the panels assume the worst case). */
    measured: PhotoRange | undefined;
    /** Nothing customised - `Reset all` has nothing to do. */
    isDefault: boolean;
    /** A save is in flight or waiting for the next quiet moment. */
    saving: boolean;
    /** Why the last save failed, in words for the user; `null` after a success or `clearError()`. The change it belonged to was rolled back. */
    error: string | null;
    clearError: () => void;
    /** Applies the change at once and saves it in the background; a failed save rolls back to what the server has and sets `error`. */
    setPrefs: (patch: AppearancePatch) => void;
    /** Shows `file` as the background at once (already checked with `validateBackgroundFile()`) while it uploads; rolls back on failure. */
    uploadBackground: (file: Blob) => Promise<void>;
    /** Removes the background image (and returns to no background). */
    removeBackground: () => Promise<void>;
    /** Back to the defaults: system scheme, the app's colours, no background. */
    reset: () => Promise<void>;
}

const NOOP_PREFS: AppearancePreferences = { version: 1, mode: "system" };

/** What `useAppearance()` returns outside an `AppearanceProvider` (a component tested alone): the defaults, and changes go nowhere. */
export const INERT_APPEARANCE: AppearanceApi = {
    prefs: NOOP_PREFS,
    resolved: "light",
    backgroundUrl: undefined,
    measured: undefined,
    isDefault: true,
    saving: false,
    error: null,
    clearError: () => undefined,
    setPrefs: () => undefined,
    uploadBackground: () => Promise.resolve(),
    removeBackground: () => Promise.resolve(),
    reset: () => Promise.resolve(),
};

export const AppearanceContext = createContext<AppearanceApi>(INERT_APPEARANCE);

/**
 * The user's appearance preferences and how to change them: `{ prefs, setPrefs, ... }` (see `AppearanceApi`). Changes apply to the
 * whole app the instant they are made and are saved in the background. Outside an `AppearanceProvider` it is inert.
 */
export function useAppearance(): AppearanceApi {
    return useContext(AppearanceContext);
}
