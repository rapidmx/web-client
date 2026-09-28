///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import { Branding, getBranding } from "./brandingApi.js";

const DEFAULT_LOGO_SRC = "/images/logo.svg";

/** `id` of the `<link>` for an uploaded/referenced custom stylesheet — server-rendered directly by
 * `apps/*​/_layout.tsx` (with this exact id) when one is configured, and kept live by this hook's
 * background refresh thereafter (matched by this id, rather than always appending a duplicate). */
export const CUSTOM_STYLESHEET_LINK_ID = "branding-stylesheet";

export interface UseBrandingResult {
    branding: Branding | null;
    /** `branding.logoUrl` once loaded, else the built-in default — always a usable `<img src>`. */
    logoSrc: string;
    /** `branding.iconUrl` once loaded, falling back to the full logo and then the built-in default — the
     * compact mark for nav headers (see `Branding.iconUrl`'s doc comment). Always a usable `<img src>`. */
    iconSrc: string;
}

/**
 * Fetches the admin-configured `Branding` singleton once on mount and applies its cosmetic side effects
 * (browser-tab title, injected custom stylesheet `<link>`) directly to `document` — the same "resolve real
 * client state once mounted, no SSR prop threading" convention `useIsMobile`/`MailShell`'s query-param reads
 * already use. `GET /system/branding` needs no auth and never `404`s (see `BaseBrandingRoute.get()`), so a
 * fetch failure here can only be a real network/server problem — swallowed rather than surfaced, since
 * branding is purely decorative and every other part of the shell already depends on the same API being
 * reachable.
 */
export default function useBranding(): UseBrandingResult {
    const [branding, setBranding] = useState<Branding | null>(null);

    useEffect(() => {
        let cancelled = false;
        getBranding()
            .then((result) => {
                if (!cancelled) {
                    setBranding(result);
                }
            })
            .catch(() => {
                // Decorative only — leave `branding` at null, which every consumer already treats as
                // "use the defaults".
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (branding?.title) {
            document.title = branding.title;
        }
    }, [branding?.title]);

    useEffect(() => {
        // Reuses an existing `<link>` (server-rendered by `apps/*​/_layout.tsx` when a stylesheet is already
        // configured) rather than always appending a duplicate — see `CUSTOM_STYLESHEET_LINK_ID`'s doc comment.
        let link = document.getElementById(CUSTOM_STYLESHEET_LINK_ID) as HTMLLinkElement | null;
        if (!branding?.stylesheetUrl) {
            link?.remove();
            return;
        }
        if (!link) {
            link = document.createElement("link");
            link.id = CUSTOM_STYLESHEET_LINK_ID;
            link.rel = "stylesheet";
            document.head.appendChild(link);
        }
        link.href = branding.stylesheetUrl;
    }, [branding?.stylesheetUrl]);

    return {
        branding,
        logoSrc: branding?.logoUrl || DEFAULT_LOGO_SRC,
        iconSrc: branding?.iconUrl || branding?.logoUrl || DEFAULT_LOGO_SRC,
    };
}
