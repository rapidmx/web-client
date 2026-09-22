///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    AppearanceInput,
    AppearancePreferences,
    DEFAULT_BACKGROUND,
    appearanceBackgroundUrl,
    deleteAppearanceBackground,
    diffAppearance,
    getAppearance,
    isDefaultAppearance,
    normalizeAppearance,
    parseAppearanceEvent,
    saveAppearance,
    uploadAppearanceBackground,
} from "@rapidmx/react-shared/appearance/preferencesApi.js";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { getPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import { AppearanceApi, AppearanceContext, AppearancePatch } from "./appearanceContext.js";
import { cacheKeyOf, readAppearanceCache, timeOf, writeAppearanceCache } from "./appearanceCache.js";
import { measureImage, rangeFromLevels } from "./photo.js";
import { useSystemPrefersDark } from "./resolvedTheme.js";
import { APPEARANCE_STYLE_ID, PhotoRange, appearanceCss } from "./theme.js";

/** How long a change waits for a further one before it is saved - a slider being dragged is one save, not sixty. */
export const APPEARANCE_SAVE_DELAY_MS = 400;

/** The `imageVersion` the preview of a just-chosen file has until the server names the stored one. */
const LOCAL_VERSION = "local";

const DEFAULTS: AppearancePreferences = { version: 1, mode: "system" };

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** `prefs` with `patch` merged in, normalised (so an out-of-range number or bad colour can't get through). See `AppearancePatch`. */
export function mergeAppearance(prefs: AppearancePreferences, patch: AppearancePatch): AppearancePreferences {
    const next: Record<string, unknown> = { version: 1, mode: patch.mode ?? prefs.mode };
    const colors: Record<string, string> = { ...prefs.colors };
    for (const [key, value] of Object.entries(patch.colors ?? {})) {
        if (value === null || value === undefined) {
            delete colors[key];
        } else {
            colors[key] = value;
        }
    }
    if (Object.keys(colors).length > 0) {
        next.colors = colors;
    }
    if (patch.background !== null) {
        const background = patch.background ? { ...(prefs.background ?? DEFAULT_BACKGROUND), ...patch.background } : prefs.background;
        if (background) {
            next.background = background;
        }
    }
    if (prefs.updatedAt !== undefined) {
        next.updatedAt = prefs.updatedAt;
    }
    return normalizeAppearance(next) as AppearancePreferences;
}

function toInput(prefs: AppearancePreferences): AppearanceInput {
    const { updatedAt: _updatedAt, ...input } = prefs;
    return input;
}

/** Whether two preference objects say the same thing, ignoring the server's timestamp. */
function sameContent(a: AppearancePreferences | undefined, b: AppearancePreferences | undefined): boolean {
    return JSON.stringify(a && toInput(a)) === JSON.stringify(b && toInput(b));
}

function messageOf(err: unknown, fallback: string): string {
    return err instanceof ApiRequestError && err.message ? err.message : fallback;
}

export interface AppearanceProviderProps {
    /** The signed-in user - what the cache is filed under. */
    userUid?: string;
    /** The user's stored preferences as the server rendered the page (its `appearance` prop), so the first paint is already themed. Absent when the
     * page wasn't given them (or the user has none). The server caches a page for up to a minute, so this can be older than what this browser last
     * applied: the browser's own copy is used instead when it is newer (see `appearanceCache.ts`). */
    initial?: unknown;
    /** Whether to ask the server for the preferences once mounted (the default), which corrects a page that was cached. The admin and escrow
     * consoles pass `false`: they use what the last webmail page cached in this browser. */
    lookUp?: boolean;
}

/**
 * Owns the user's appearance for the whole app: keeps the theme applied to the page and everything Settings > Appearance needs.
 *
 * - **Applies it.** One `<style id="rr-appearance">` in `<head>` (`appearanceCss()`) holds the user's colour tokens and the background
 * layer, and `<html data-theme>` says which scheme is showing - the chosen one, or for "System" the operating system's, live.
 * - **Instantly.** `setPrefs()`, `uploadBackground()`, `removeBackground()` and `reset()` change the page in the same frame; the save
 * happens after (`APPEARANCE_SAVE_DELAY_MS` of quiet, coalesced), sending only what changed - the server merges - and a failed one
 * rolls back to what the server has and sets `error`.
 * - **No flash.** It starts from the server's `initial` preferences, or the browser's newer cached copy (which the inline boot script has
 * already put in place before anything painted), and then asks the server what is true now.
 * - **Stays current.** Another tab or device's change arrives as a push event and is applied unless this tab has changes of its own
 * still in flight.
 */
export default function AppearanceProvider({ userUid, initial, lookUp = true, children }: PropsWithChildren<AppearanceProviderProps>) {
    const initialPrefs = useMemo(() => normalizeAppearance(initial), [initial]);
    const [prefs, setPrefsState] = useState<AppearancePreferences | undefined>(initialPrefs);
    // The server (or the user) has spoken: until then the page shows whatever the boot script applied from the cache.
    const [authoritative, setAuthoritative] = useState(initialPrefs !== undefined);
    const [local, setLocal] = useState<string | undefined>(undefined);
    const [measured, setMeasured] = useState<{ version: string; range: PhotoRange } | undefined>(() => {
        // Read here, not in an effect, so the first stylesheet the provider writes already has the measured panel opacity the boot script used.
        const cache = typeof window === "undefined" ? undefined : readAppearanceCache();
        const range = rangeFromLevels(cache?.measured?.levels);
        return cache?.measured && range ? { version: cache.measured.version, range } : undefined;
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const systemDark = useSystemPrefersDark();

    const prefsRef = useRef(prefs);
    prefsRef.current = prefs;
    /** What the server last acknowledged - what a failed save rolls back to, and what a save is a difference from. */
    const serverRef = useRef<AppearancePreferences | undefined>(initialPrefs);
    /** When this tab last changed the preferences itself (milliseconds), for the cache's time - see `appearanceCache.ts`. */
    const changedAtRef = useRef(0);
    const pendingRef = useRef<AppearancePreferences | undefined>(undefined);
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const flightRef = useRef<Promise<void> | undefined>(undefined);
    const localRef = useRef(local);
    localRef.current = local;

    const resolved = (prefs?.mode ?? "system") === "system" ? (systemDark ? "dark" : "light") : (prefs?.mode as "light" | "dark");

    const apply = useCallback((next: AppearancePreferences | undefined) => {
        prefsRef.current = next;
        setPrefsState(next);
        setAuthoritative(true);
    }, []);

    /** `apply()` for a change the user made here: it is newer than anything the server has said so far. */
    const applyLocal = useCallback(
        (next: AppearancePreferences | undefined) => {
            changedAtRef.current = Date.now();
            apply(next);
        },
        [apply],
    );

    /** Puts the server's last acknowledged preferences back and says why. */
    const rollback = useCallback(
        (err: unknown, fallback: string) => {
            pendingRef.current = undefined;
            apply(serverRef.current);
            setError(messageOf(err, fallback));
        },
        [apply],
    );

    /** Saves whatever is pending, and whatever arrives while that is in flight, one request at a time. */
    const flush = useCallback((): Promise<void> => {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
        if (flightRef.current) {
            return flightRef.current;
        }
        if (!pendingRef.current) {
            return Promise.resolve();
        }
        const flight = (async () => {
            try {
                while (pendingRef.current) {
                    const toSave = pendingRef.current;
                    pendingRef.current = undefined;
                    // Only what differs from what the server has: it merges, and refuses a body that names the image or a kind it can't yet show.
                    const update = diffAppearance(serverRef.current, toInput(toSave));
                    if (!update) {
                        continue;
                    }
                    const stored = await saveAppearance(update);
                    serverRef.current = stored;
                    if (!pendingRef.current && prefsRef.current) {
                        // Nothing newer waiting: take the server's timestamp (the values are the ones sent).
                        apply({ ...prefsRef.current, updatedAt: stored.updatedAt });
                    }
                }
            } catch (err) {
                rollback(err, "Your appearance could not be saved. It has been put back.");
            } finally {
                flightRef.current = undefined;
                setSaving(pendingRef.current !== undefined);
            }
        })();
        flightRef.current = flight;
        return flight;
    }, [apply, rollback]);

    /** Queues `next` to be saved after a quiet moment. */
    const scheduleSave = useCallback(
        (next: AppearancePreferences) => {
            pendingRef.current = next;
            setSaving(true);
            clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => void flush(), APPEARANCE_SAVE_DELAY_MS);
        },
        [flush],
    );

    // A change still waiting when the provider goes away (the page is closing) is sent now rather than lost.
    useEffect(() => {
        function flushWhenHidden() {
            if (document.visibilityState === "hidden") {
                void flush();
            }
        }
        document.addEventListener("visibilitychange", flushWhenHidden);
        return () => {
            document.removeEventListener("visibilitychange", flushWhenHidden);
            void flush();
        };
    }, [flush]);

    const setPrefs = useCallback(
        (patch: AppearancePatch) => {
            setError(null);
            const next = mergeAppearance(prefsRef.current ?? DEFAULTS, patch);
            applyLocal(next);
            scheduleSave(next);
        },
        [applyLocal, scheduleSave],
    );

    const releaseLocal = useCallback(() => {
        if (localRef.current) {
            URL.revokeObjectURL(localRef.current);
            localRef.current = undefined;
        }
        setLocal(undefined);
    }, []);

    const uploadBackground = useCallback(
        async (file: Blob) => {
            setError(null);
            releaseLocal();
            const url = URL.createObjectURL(file);
            localRef.current = url;
            setLocal(url);
            applyLocal(mergeAppearance(prefsRef.current ?? DEFAULTS, { background: { kind: "image", imageVersion: LOCAL_VERSION } }));
            try {
                // Whatever was changed a moment ago is stored first, so its (older) save can't land after the picture.
                await flush();
                const stored = await uploadAppearanceBackground(file);
                if (stored.background?.imageVersion === undefined) {
                    throw new ApiRequestError("The server did not keep the image.", 502);
                }
                serverRef.current = stored;
                const version = String(stored.background.imageVersion);
                const merged = mergeAppearance(prefsRef.current ?? DEFAULTS, {
                    background: { kind: "image", imageVersion: stored.background.imageVersion },
                });
                apply({ ...merged, updatedAt: stored.updatedAt });
                if (!sameContent(merged, stored)) {
                    // The user moved a slider while the image was uploading: the server has the older values.
                    scheduleSave(merged);
                }
                // The local preview stays until the stored image has loaded, so swapping to it doesn't blink.
                const preload = new Image();
                const swap = () => {
                    setMeasured((current) => (current?.version === LOCAL_VERSION ? { ...current, version } : current));
                    if (localRef.current === url) {
                        releaseLocal();
                    }
                };
                preload.onload = swap;
                preload.onerror = swap;
                preload.src = appearanceBackgroundUrl(version);
            } catch (err) {
                releaseLocal();
                rollback(err, "That image could not be uploaded.");
            }
        },
        [apply, applyLocal, flush, releaseLocal, rollback, scheduleSave],
    );

    const removeBackground = useCallback(async () => {
        setError(null);
        const next = mergeAppearance(prefsRef.current ?? DEFAULTS, { background: { kind: "none", imageVersion: undefined } });
        applyLocal(next);
        releaseLocal();
        try {
            await flush();
            serverRef.current = (await deleteAppearanceBackground()) ?? serverRef.current;
            scheduleSave(next);
        } catch (err) {
            rollback(err, "The background could not be removed.");
        }
    }, [applyLocal, flush, releaseLocal, rollback, scheduleSave]);

    const reset = useCallback(async () => {
        setError(null);
        const hadImage = prefsRef.current?.background?.imageVersion !== undefined;
        applyLocal(DEFAULTS);
        releaseLocal();
        pendingRef.current = undefined;
        try {
            await flush();
            if (hadImage) {
                serverRef.current = (await deleteAppearanceBackground()) ?? serverRef.current;
            }
            const update = diffAppearance(serverRef.current, toInput(DEFAULTS));
            if (update) {
                serverRef.current = await saveAppearance(update);
            }
        } catch (err) {
            rollback(err, "Your appearance could not be reset.");
        }
    }, [applyLocal, flush, releaseLocal, rollback]);

    // The page's copy can be a minute old (the server caches a rendered page), and this browser may have changed the preferences since: the
    // browser's own copy, when it is newer, is what to show - before the first paint, so nothing flips.
    useIsomorphicLayoutEffect(() => {
        if (initialPrefs === undefined) {
            return;
        }
        const cache = readAppearanceCache();
        if (cache && (!cache.uid || cache.uid === userUid) && cache.t > timeOf(initialPrefs.updatedAt)) {
            apply(cache.prefs);
        }
        // Once, for the page as it was rendered.
    }, []);

    // Without the page's copy, the cache is what to show until the server answers; then the server's answer is, unless the user changed something
    // meanwhile. With it, the server is asked too, to correct a page that was cached.
    useEffect(() => {
        if (!userUid) {
            return;
        }
        if (initialPrefs === undefined) {
            const cache = readAppearanceCache();
            if (cache && (!cache.uid || cache.uid === userUid)) {
                setPrefsState((current) => current ?? cache.prefs);
            }
        }
        if (!lookUp) {
            return;
        }
        let cancelled = false;
        getAppearance().then(
            (stored) => {
                if (cancelled || pendingRef.current || flightRef.current || timerRef.current) {
                    return;
                }
                serverRef.current = stored;
                if (!sameContent(stored, prefsRef.current)) {
                    apply(stored);
                }
            },
            () => undefined,
        );
        return () => {
            cancelled = true;
        };
    }, [initialPrefs, userUid, lookUp, apply]);

    // Another tab or device changed it.
    useEffect(() => {
        if (!userUid) {
            return;
        }
        return getPushClient().onEvent((event) => {
            const pushed = parseAppearanceEvent(event);
            if (pushed === undefined) {
                return;
            }
            // Our own change still travelling (or its echo, which says what is already on screen) must not undo what is on screen.
            if (pendingRef.current || flightRef.current || timerRef.current || sameContent(pushed ?? undefined, prefsRef.current)) {
                return;
            }
            serverRef.current = pushed ?? undefined;
            apply(pushed ?? undefined);
        });
    }, [userUid, apply]);

    const version = prefs?.background?.imageVersion;
    const imageUrl = local ?? (version === undefined || version === LOCAL_VERSION ? undefined : appearanceBackgroundUrl(version));
    const measureKey = local ? LOCAL_VERSION : version === undefined ? undefined : String(version);
    const isImage = prefs?.background?.kind === "image";

    // Measure the picture (once per image) so the panels over it are only as opaque as it needs.
    useEffect(() => {
        if (!isImage || !imageUrl || !measureKey || measured?.version === measureKey) {
            return;
        }
        let cancelled = false;
        void measureImage(imageUrl).then((range) => {
            if (!cancelled && range) {
                setMeasured({ version: measureKey, range });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [isImage, imageUrl, measureKey, measured?.version]);

    const range = measured && measured.version === measureKey ? measured.range : undefined;

    // Apply: the stylesheet, then the scheme.
    useIsomorphicLayoutEffect(() => {
        if (!authoritative && !prefs) {
            // Nothing known yet: leave what the boot script applied from the cache.
            return;
        }
        const css = appearanceCss(prefs, { measured: range, imageUrl });
        let element = document.getElementById(APPEARANCE_STYLE_ID);
        if (!css) {
            element?.remove();
        } else {
            if (!element) {
                element = document.createElement("style");
                element.id = APPEARANCE_STYLE_ID;
                document.head.appendChild(element);
            }
            element.textContent = css;
            element.setAttribute("data-key", cacheKeyOf(prefs as AppearancePreferences));
        }
        // What the next page load starts from: never a blob: preview, and "nothing chosen" is remembered too (an empty stylesheet), so a page
        // cached by the server from before a reset doesn't bring the old background back.
        if (!local) {
            writeAppearanceCache(
                prefs ?? DEFAULTS,
                css,
                Math.max(timeOf(prefs?.updatedAt), changedAtRef.current),
                userUid,
                range && measureKey ? { version: measureKey, range } : undefined,
            );
        }
    }, [authoritative, prefs, range, imageUrl, local, userUid, measureKey]);

    useIsomorphicLayoutEffect(() => {
        document.documentElement.setAttribute("data-theme", resolved);
    }, [resolved]);

    // A blob: URL that outlives the provider leaks the picture's memory.
    useEffect(
        () => () => {
            if (localRef.current) {
                URL.revokeObjectURL(localRef.current);
            }
        },
        [],
    );

    const value = useMemo<AppearanceApi>(
        () => ({
            prefs: prefs ?? DEFAULTS,
            resolved,
            backgroundUrl: imageUrl,
            measured: range,
            isDefault: isDefaultAppearance(prefs),
            saving,
            error,
            clearError: () => setError(null),
            setPrefs,
            uploadBackground,
            removeBackground,
            reset,
        }),
        [prefs, resolved, imageUrl, range, saving, error, setPrefs, uploadBackground, removeBackground, reset],
    );

    return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
