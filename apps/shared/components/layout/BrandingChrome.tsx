///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { Branding } from "@rapidmx/react-shared/brandingApi.js";

/**
 * Renders the admin-configured `Branding.headerHtml`/`footerHtml` (see `useBranding()`) — shared by every
 * chrome in this project (`AppShell`, `AdminShell`, and the public `apps/book` pages) so the setting applies
 * everywhere its own admin UI copy (`apps/admin/branding/index.tsx`) claims it does.
 */
export function BrandingHeader({ branding }: { branding: Branding | null }) {
    if (!branding?.headerHtml) {
        return null;
    }
    return <div dangerouslySetInnerHTML={{ __html: branding.headerHtml }} />;
}

export function BrandingFooter({ branding }: { branding: Branding | null }) {
    if (!branding?.footerHtml) {
        return null;
    }
    return <div dangerouslySetInnerHTML={{ __html: branding.footerHtml }} />;
}
