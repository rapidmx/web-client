///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import type { ResolvedTheme } from "../../../appearance/resolvedTheme.js";
import { Rgb, Rgba, ThemeSurface, composite, formatColour, parseColour } from "./color.js";

/** The palette used where the page's own tokens cannot be read (no DOM, or a stylesheet without them): the app's built-in schemes. */
export const DEFAULT_SURFACES: Record<ResolvedTheme, ThemeSurface> = {
    light: { background: { r: 255, g: 255, b: 255 }, text: { r: 28, g: 37, b: 38 }, link: { r: 20, g: 138, b: 128 }, dark: false },
    dark: { background: { r: 27, g: 32, b: 34 }, text: { r: 238, g: 242, b: 243 }, link: { r: 45, g: 212, b: 191 }, dark: true },
};

/** The page's own CSS variables a message is adapted to. Read from the document, so a branding palette or a user's own Appearance colours are followed. */
const TOKENS = {
    surface: "--rr-color-surface",
    page: "--rr-color-bg",
    text: "--rr-color-text",
    link: "--rr-color-primary-dark",
} as const;

/** The colour a CSS custom property resolves to, by asking the browser what a probe element painted with it comes to (which also
 * resolves `var()` chains and colour functions); `undefined` when it isn't defined or isn't a colour. */
function resolveToken(probe: HTMLElement, name: string): Rgba | undefined {
    probe.style.color = `var(${name}, transparent)`;
    const colour = parseColour(getComputedStyle(probe).color);
    return colour && colour.a > 0 ? colour : undefined;
}

/**
 * The theme a message is shown in, read from the page's own tokens: the surface behind the body composited to an opaque colour (a
 * translucent surface over a photo would make text unreadable, so the body area is always painted with this opaque one), the text
 * colour and the link colour. Falls back to the built-in scheme for anything the page doesn't define.
 */
export function readThemeSurface(theme: ResolvedTheme): ThemeSurface {
    const fallback = DEFAULT_SURFACES[theme];
    if (typeof document === "undefined" || !document.body) {
        return fallback;
    }
    const probe = document.createElement("span");
    probe.style.display = "none";
    document.body.appendChild(probe);
    try {
        const page = resolveToken(probe, TOKENS.page);
        const surface = resolveToken(probe, TOKENS.surface);
        const underlay: Rgb = page ? composite(page, fallback.background) : fallback.background;
        const text = resolveToken(probe, TOKENS.text);
        const link = resolveToken(probe, TOKENS.link);
        return {
            dark: fallback.dark,
            background: surface ? composite(surface, underlay) : underlay,
            text: text ? composite(text, underlay) : fallback.text,
            link: link ? composite(link, underlay) : fallback.link,
        };
    } finally {
        probe.remove();
    }
}

/** A string that changes exactly when the surface does - what a frame is keyed on. */
export function surfaceKey(surface: ThemeSurface): string {
    return [surface.background, surface.text, surface.link].map(formatColour).join("|") + (surface.dark ? "|dark" : "|light");
}

/**
 * The theme surface for `theme`, kept current: re-read when the scheme changes and when the page's own colours are changed at runtime
 * (Appearance sets `data-theme` on `<html>` and writes the user's colours into a `<style>` in the head). The identity only changes when a colour does.
 */
export function useThemeSurface(theme: ResolvedTheme): ThemeSurface {
    const [surface, setSurface] = useState(() => readThemeSurface(theme));
    useEffect(() => {
        const update = () =>
            setSurface((previous) => {
                const next = readThemeSurface(theme);
                return surfaceKey(previous) === surfaceKey(next) ? previous : next;
            });
        update();
        if (typeof MutationObserver === "undefined") {
            return;
        }
        const observer = new MutationObserver(update);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
        // The Appearance provider writes the user's own colours into a `<style>` element in the head, whose text is replaced when they change.
        observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
        return () => observer.disconnect();
    }, [theme]);
    // The render that first sees a new scheme must not use the previous one's colours (the effect above corrects the state after it).
    return surface.dark === (theme === "dark") ? surface : readThemeSurface(theme);
}
