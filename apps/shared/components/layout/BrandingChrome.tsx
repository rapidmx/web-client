///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import DOMPurify from "dompurify";
import { Branding } from "@rapidmx/react-shared/branding/brandingApi.js";

/** Elements that could run script, restyle the whole page, collect input, or embed another page - stripped on
 * top of DOMPurify's defaults (which already drop `<script>`, `on*` handlers, and `javascript:` URLs). */
const FORBIDDEN_TAGS = [
    "script",
    "style",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "link",
    "meta",
    "base",
    "svg",
    "math",
];
const FORBIDDEN_ATTRS = ["action", "formaction", "srcdoc"];

/**
 * Sanitizes admin-configured branding HTML before it's rendered. The server sanitizes on save too; this also
 * covers anything stored before that. Returns `""` where there's no DOM to sanitize with (server-side
 * rendering), so unsanitized HTML is never emitted.
 */
export function sanitizeBrandingHtml(html: string): string {
    if (!DOMPurify.isSupported) {
        return "";
    }
    return DOMPurify.sanitize(html, { FORBID_TAGS: FORBIDDEN_TAGS, FORBID_ATTR: FORBIDDEN_ATTRS });
}

function BrandingHtml({ html }: { html: string | undefined }) {
    const clean = html ? sanitizeBrandingHtml(html) : "";
    if (!clean) {
        return null;
    }
    return <div dangerouslySetInnerHTML={{ __html: clean }} />;
}

/**
 * Renders the admin-configured `Branding.headerHtml`/`footerHtml` (see `useBranding()`), sanitized - shared by
 * the webmail and admin chromes. The escrow console deliberately renders no branding HTML at all.
 */
export function BrandingHeader({ branding }: { branding: Branding | null }) {
    return <BrandingHtml html={branding?.headerHtml} />;
}

export function BrandingFooter({ branding }: { branding: Branding | null }) {
    return <BrandingHtml html={branding?.footerHtml} />;
}
