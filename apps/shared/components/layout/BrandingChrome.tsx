///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DOMPurify from "dompurify";
import type { Branding } from "@rapidmx/react-shared/branding/brandingApi.js";
import { useHeaderHeightRef } from "../../notifications/headerOffset.js";

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

/** The attribute that marks the elements React fills in (`{USER_MENU}`, `{APP_TITLE}`). Stripped from the author's own HTML, so only
 * this module's placeholders can carry it. */
export const SLOT_ATTRIBUTE = "data-rr-slot";

/** The variables a branding header or footer may contain, written in the HTML's text. */
export const USER_MENU_VARIABLE = "{USER_MENU}";
export const APP_TITLE_VARIABLE = "{APP_TITLE}";

const VARIABLE = /\{(USER_MENU|APP_TITLE)\}/g;

/** Elements whose text is not markup a placeholder element could live in (raw text and RCDATA), and the ones a menu must not sit inside. */
const RAW_TEXT_PARENTS = new Set(["TITLE", "TEXTAREA", "OPTION", "STYLE", "SCRIPT", "NOSCRIPT", "XMP", "IFRAME", "NOEMBED", "NOFRAMES", "PLAINTEXT"]);

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

/** Branding HTML ready to render: sanitized, with its variables replaced by placeholder elements for React to fill. */
export interface ParsedBrandingHtml {
    html: string;
    /** It contains a `{USER_MENU}` where the account menu can be rendered. */
    hasUserMenu: boolean;
}

function slotElement(name: "user-menu" | "app-title"): HTMLSpanElement {
    const span = document.createElement("span");
    span.setAttribute(SLOT_ATTRIBUTE, name);
    return span;
}

/**
 * Sanitizes `html` (the same rules as `sanitizeBrandingHtml()`) and swaps the variables in its **text** for placeholder elements:
 * `{USER_MENU}` becomes the slot the account menu is rendered into, `{APP_TITLE}` a slot holding the current app's name.
 *
 * - Only text is searched, after sanitizing - a variable in an attribute (`title="{USER_MENU}"`), a comment, or a `<script>` (which
 * is gone) is never touched, and the author cannot write a placeholder themselves (`data-rr-slot` is stripped).
 * - `{USER_MENU}` is replaced **once**, at its first place in the document; a second (or third) one is removed, so there is never
 * more than one account menu (two would give two sets of duplicate ids and focus targets). One inside a link, or in text that
 * can't hold an element (`<title>`, `<textarea>`), is removed too: a menu inside an `<a>` would navigate when clicked.
 * - `{APP_TITLE}` is replaced everywhere it appears. Inside `<title>`-like raw text it stays as written.
 * - Nothing is matched loosely: the names are upper-case, in braces, with no spaces.
 *
 * `null` when there is nothing to show (no DOM to sanitize with - server-side rendering - or the HTML is empty once sanitized).
 */
export function parseBrandingHtml(html: string): ParsedBrandingHtml | null {
    if (!DOMPurify.isSupported) {
        return null;
    }
    const fragment = DOMPurify.sanitize(html, {
        FORBID_TAGS: FORBIDDEN_TAGS,
        FORBID_ATTR: [...FORBIDDEN_ATTRS, SLOT_ATTRIBUTE],
        RETURN_DOM_FRAGMENT: true,
    });
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        texts.push(node as Text);
    }
    let hasUserMenu = false;
    for (const text of texts) {
        const parent = text.parentElement;
        if (parent && RAW_TEXT_PARENTS.has(parent.tagName)) {
            continue;
        }
        const inLink = !!parent?.closest("a");
        // `split` with a capturing group alternates text and variable names: [text, name, text, name, ..., text].
        const pieces = text.data.split(VARIABLE);
        if (pieces.length === 1) {
            continue;
        }
        const replacement = document.createDocumentFragment();
        pieces.forEach((piece, index) => {
            if (index % 2 === 0) {
                if (piece) {
                    replacement.appendChild(document.createTextNode(piece));
                }
            } else if (piece === "APP_TITLE") {
                replacement.appendChild(slotElement("app-title"));
            } else if (!hasUserMenu && !inLink) {
                hasUserMenu = true;
                replacement.appendChild(slotElement("user-menu"));
            }
        });
        text.replaceWith(replacement);
    }
    const holder = document.createElement("div");
    holder.appendChild(fragment);
    const result = holder.innerHTML;
    return result.trim() ? { html: result, hasUserMenu } : null;
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * `parseBrandingHtml()` of `html`, done once the component is on the page (never while rendering: the server has no DOM to sanitize
 * with, and rendering different HTML there than the hydrating client would leave the page without it). `null` when there is no HTML,
 * or nothing is left of it; `undefined` while it has not been parsed yet - the frame reserves the header's place meanwhile.
 */
export function useBrandingHtml(html: string | undefined): ParsedBrandingHtml | null | undefined {
    const source = html?.trim() ? html : undefined;
    const [parsed, setParsed] = useState<{ source: string; value: ParsedBrandingHtml | null } | undefined>(undefined);
    useIsomorphicLayoutEffect(() => {
        setParsed(source === undefined ? undefined : { source, value: parseBrandingHtml(source) });
    }, [source]);
    if (source === undefined) {
        return null;
    }
    return parsed?.source === source ? parsed.value : undefined;
}

interface BrandingHtmlProps {
    parsed: ParsedBrandingHtml | null | undefined;
    /** Rendered into the `{USER_MENU}` slot - only where `hostMenu` says this HTML is where the menu lives. */
    userMenu?: ReactNode;
    hostMenu?: boolean;
    /** The current app's name, rendered into every `{APP_TITLE}` slot. */
    appTitle?: string;
    className?: string;
}

function BrandingHtml({ parsed, userMenu, hostMenu, appTitle, className }: BrandingHtmlProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [targets, setTargets] = useState<{ menu: Element | null; titles: Element[] }>({ menu: null, titles: [] });
    const html = parsed?.html ?? "";
    // The placeholders exist once React has set the HTML: find them here, before the browser paints, and portal into them.
    useIsomorphicLayoutEffect(() => {
        const root = ref.current;
        setTargets({
            menu: root?.querySelector(`[${SLOT_ATTRIBUTE}="user-menu"]`) ?? null,
            titles: root ? Array.from(root.querySelectorAll(`[${SLOT_ATTRIBUTE}="app-title"]`)) : [],
        });
    }, [html]);
    if (parsed === null) {
        return null;
    }
    return (
        <>
            <div ref={ref} className={className} dangerouslySetInnerHTML={{ __html: html }} />
            {hostMenu && targets.menu && createPortal(userMenu, targets.menu)}
            {targets.titles.map((element, index) => createPortal(appTitle, element, `app-title-${index}`))}
        </>
    );
}

export interface FrameBrandingHeaderProps {
    /** `useBrandingHtml(branding.headerHtml)`. `null` renders nothing. */
    parsed: ParsedBrandingHtml | null | undefined;
    /** The account menu, rendered into the header's `{USER_MENU}` (when it has one). */
    userMenu?: ReactNode;
    /** Rendered at the right end of the header when it has no `{USER_MENU}` and the footer doesn't host the menu either - the account menu is never lost. */
    fallbackMenu?: ReactNode;
    appTitle?: string;
}

/**
 * The frame's version of the admin-configured `Branding.headerHtml` (see `useBranding()`), sanitized, in a `<header>` that stays at the top of the window as the
 * page scrolls. When it is there the app has no title bar of its own (`AppChrome`): the header is the top of the app, and the account
 * menu lives in it - where the HTML writes `{USER_MENU}`, else in a small cell at its right end. The webmail chrome (`AppShell`) shows
 * it; the admin console has no custom header (its header is the console's own) and the escrow console renders no branding HTML at all.
 */
export function FrameBrandingHeader({ parsed, userMenu, fallbackMenu, appTitle }: FrameBrandingHeaderProps) {
    // Publishes the header's height (`--rr-header-h`) for the pop-up stack, which sticks just below it.
    const headerRef = useHeaderHeightRef();
    if (parsed === null) {
        return null;
    }
    return (
        <header ref={headerRef} className="sticky top-0 z-30 shrink-0 flex items-stretch bg-surface-alt" data-branding-header="">
            <BrandingHtml parsed={parsed} userMenu={userMenu} hostMenu={parsed?.hasUserMenu} appTitle={appTitle} className="flex-1 min-w-0" />
            {parsed && !parsed.hasUserMenu && fallbackMenu ? (
                <div className="shrink-0 flex items-center px-3 bg-surface border-l border-border" data-branding-menu-cell="">
                    {fallbackMenu}
                </div>
            ) : null}
        </header>
    );
}

export interface FrameBrandingFooterProps {
    /** `useBrandingHtml(branding.footerHtml)`. */
    parsed: ParsedBrandingHtml | null | undefined;
    /** Rendered into the footer's `{USER_MENU}` - passed only when the header has none. */
    userMenu?: ReactNode;
    appTitle?: string;
}

/** The frame's version of the admin-configured `Branding.footerHtml`, sanitized. Its variables work as in the header; a `{USER_MENU}` here only takes the menu when the header has none. */
export function FrameBrandingFooter({ parsed, userMenu, appTitle }: FrameBrandingFooterProps) {
    return <BrandingHtml parsed={parsed} userMenu={userMenu} hostMenu={userMenu !== undefined} appTitle={appTitle} />;
}

export interface BrandingChromeProps {
    branding: Branding | null;
    /** What `{APP_TITLE}` is replaced with - the page's own name. Nothing when absent. */
    appTitle?: string;
}

/**
 * The admin-configured `Branding.headerHtml`, sanitized, for pages that don't use a shell, such as public pages (the booking pages). There is no
 * account menu there, so a `{USER_MENU}` in the HTML renders nothing. Renders nothing without branding or HTML.
 */
export function BrandingHeader({ branding, appTitle }: BrandingChromeProps) {
    return <BrandingHtml parsed={useBrandingHtml(branding?.headerHtml)} appTitle={appTitle} />;
}

/** The admin-configured `Branding.footerHtml`, sanitized, for pages that don't use a shell - see `BrandingHeader`. */
export function BrandingFooter({ branding, appTitle }: BrandingChromeProps) {
    return <BrandingHtml parsed={useBrandingHtml(branding?.footerHtml)} appTitle={appTitle} />;
}
