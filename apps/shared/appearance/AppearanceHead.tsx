///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { appearanceBackgroundUrl, normalizeAppearance } from "@rapidmx/react-shared/appearance/preferencesApi.js";
import { APPEARANCE_BOOT_SCRIPT } from "./bootScript.js";
import { cacheKeyOf, timeOf } from "./appearanceCache.js";
import { APPEARANCE_STYLE_ID, appearanceCss } from "./theme.js";

/** What a page layout puts on `<html>` for the server-rendered appearance: the explicit scheme (never for "System", which the stylesheet's own media query follows) and the signed-in user. */
export function appearanceHtmlAttributes(appearance: unknown, userUid?: string): { "data-theme"?: "light" | "dark"; "data-uid"?: string } {
    const prefs = normalizeAppearance(appearance);
    const attributes: { "data-theme"?: "light" | "dark"; "data-uid"?: string } = {};
    if (prefs && prefs.mode !== "system") {
        attributes["data-theme"] = prefs.mode;
    }
    if (userUid) {
        attributes["data-uid"] = userUid;
    }
    return attributes;
}

/**
 * The `<head>` part of the user's appearance, for every page layout (`_layout.tsx` of www, admin and escrow): the stylesheet the server
 * built from the preferences it was given (`appearance`, a page prop - only the www pages get one), so the first byte of the page is
 * already themed, and the boot script (`APPEARANCE_BOOT_SCRIPT`), which applies the browser's cached copy before the first paint on pages
 * that weren't given any. Nothing user-controlled reaches the CSS but validated colours, numbers and an image version made of safe characters.
 */
export function AppearanceHead({ appearance }: { appearance?: unknown }) {
    const prefs = normalizeAppearance(appearance);
    const version = prefs?.background?.imageVersion;
    const css = appearanceCss(prefs, { imageUrl: version === undefined ? undefined : appearanceBackgroundUrl(version) });
    return (
        <>
            {prefs && (
                <style
                    id={APPEARANCE_STYLE_ID}
                    data-key={cacheKeyOf(prefs)}
                    // When the server stored these: the boot script keeps a browser copy that is newer (this page can be a minute old).
                    data-t={timeOf(prefs.updatedAt)}
                    // Present even when it is empty, for its time: the boot script keeps a browser copy that is newer than this page's idea of nothing. Cannot contain a closing tag: nothing in the CSS is free text.
                    dangerouslySetInnerHTML={{ __html: css.replace(/</g, "\\3c ") }}
                />
            )}
            <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOT_SCRIPT }} />
        </>
    );
}
