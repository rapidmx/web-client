///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * The document a message's body is displayed in: the `srcdoc` of a sandboxed iframe.
 *
 * **Why an iframe, and why `allow-same-origin`.** The body is untrusted HTML. It must never be inserted into the app's own DOM
 * (a sanitizer bug there is script in the app's origin, next to the unlocked mail keys), so it lives in a frame. A frame with
 * `sandbox=""` has an opaque origin and cannot be measured from outside, which is what made every message a full-height scrolling
 * box. `allow-same-origin` (and nothing else that runs code - never `allow-scripts`) lets the *app* read the document's height and
 * adapt its colours, and is safe because a document with no script can neither use the origin nor reach the app: there is no code in
 * the frame to do it. That claim rests on four layers, each enough to stop a script on its own (server sanitizer, `bodyHtml.ts`,
 * the CSP below, the missing `allow-scripts`), and is proven against a corpus of hostile mail in a real browser
 * (`.claude/NOTES.md`, 2026-09-21).
 *
 * The rest of the sandbox: `allow-popups` and `allow-popups-to-escape-sandbox` only so a link the reader clicks can open in a new tab
 * (every link is `target=_blank rel="noopener noreferrer nofollow"`, and no script can open one uninvited); no `allow-forms`,
 * `allow-top-navigation`, `allow-modals`, `allow-downloads`, `allow-pointer-lock` or `allow-presentation`.
 */
export const FRAME_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/**
 * The frame's Content-Security-Policy. Nothing is loaded from anywhere: images are `data:` URIs and, for a message's inline parts,
 * this server's own attachment URLs (`attachmentSource`); remote images, fonts, stylesheets, frames and every other fetch are
 * refused, as they are today by the server's own header for `/content` (`default-src 'none'; img-src data: cid:; style-src
 * 'unsafe-inline'; sandbox`). Inline styles are allowed because mail is styled that way; nothing else inline is (no script at all).
 */
export function frameCsp(attachmentSource?: string): string {
    // A source is a URL prefix (`https://host/api/mail/attachments/`); anything that is not one is left out rather than trusted, as this
    // string is written into an attribute.
    const source = attachmentSource && /^https?:\/\/[\w.:@-]+(?:\/[\w./%~-]*)?$/.test(attachmentSource) ? attachmentSource : undefined;
    return [
        "default-src 'none'",
        "script-src 'none'",
        "object-src 'none'",
        "frame-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "style-src 'unsafe-inline'",
        `img-src data:${source ? ` ${source}` : ""}`,
        "font-src data:",
    ].join("; ");
}

/** How a message is being shown: as the theme dictates (`adapt`), as its author wrote it (`original`), or - a message that carries its
 * own dark styles - as those styles say (`native`). */
export type FrameMode = "adapt" | "original" | "native";

export interface FrameOptions {
    mode: FrameMode;
    /** The app's scheme: what `prefers-color-scheme` means inside the frame (it would otherwise be the operating system's). */
    scheme: "light" | "dark";
    /** The theme's opaque body surface and text colour, as `rgb()` - the defaults a native-dark message starts from. */
    surface: string;
    text: string;
    /** The CSP `img-src` source for this server's attachment URLs, when the message has inline images that point there. */
    attachmentSource?: string;
}

/** The colour the adaptation pass reads to tell text nobody coloured from text somebody did (`themeAdaptation.ts`). */
export const TEXT_SENTINEL = "rgb(1, 2, 3)";
/** The same for a link nobody coloured. */
export const LINK_SENTINEL = "rgb(1, 2, 4)";

const ALWAYS_TRUE = "(min-width: 0px)";
const ALWAYS_FALSE = "(max-width: -1px)";

/**
 * Makes `prefers-color-scheme` mean the app's scheme inside a message's stylesheets. A browser answers it with the operating
 * system's preference, which is not what the reader chose in Appearance; each occurrence becomes a media condition that is always
 * true or always false. Only `<style>` contents are rewritten.
 */
export function rewriteColourSchemeQueries(html: string, scheme: "light" | "dark"): string {
    return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_match, open: string, css: string, close: string) => {
        const rewritten = css.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_condition, wanted: string) =>
            wanted.toLowerCase() === scheme ? ALWAYS_TRUE : ALWAYS_FALSE,
        );
        return open + rewritten + close;
    });
}

/** Layout rules every mode shares: the document is exactly as tall as its content, never scrolls itself, and a wide table scrolls
 * inside the message instead of widening the pane. */
const LAYOUT_CSS = `
html{height:auto!important;min-height:0!important;overflow:hidden!important;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
body{height:auto!important;min-height:0!important}
#rr-body{box-sizing:border-box;position:relative;overflow-x:auto;overflow-y:hidden;overflow-wrap:break-word}
#rr-body img{max-width:100%;height:auto}
#rr-body pre{white-space:pre-wrap}
@media print{html{overflow:visible!important}}
`;

function modeCss(options: FrameOptions): string {
    const { mode, scheme, surface, text } = options;
    if (mode === "adapt") {
        // The sentinels are what the adaptation pass reads to tell what a message's author coloured from what it inherited; the pass
        // then replaces them, so they never show. Zero specificity: any rule of the message beats them.
        return `:where(html){color-scheme:${scheme}}:where(body){margin:0}:where(:root){color:${TEXT_SENTINEL}}:where(a:link,a:visited){color:${LINK_SENTINEL}}`;
    }
    if (mode === "native") {
        return `:where(html){color-scheme:${scheme};background-color:${surface};color:${text}}:where(body){margin:0}`;
    }
    // As its author wrote it: a light document, as a browser in a light scheme shows it - with the browser's own 8px page margin. Zero
    // specificity, so the message's own rules win.
    return ":where(html){color-scheme:light}:where(body){margin:8px}";
}

/**
 * The complete document for a message: the CSP as the very first element of the head, the layout rules, the mode's defaults and the
 * sanitized fragment inside `#rr-body`. `fragment` must come out of `prepareBodyHtml()`.
 */
export function buildFrameDocument(fragment: string, options: FrameOptions): string {
    const body = rewriteColourSchemeQueries(fragment, options.mode === "original" ? "light" : options.scheme);
    return [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8">',
        `<meta http-equiv="Content-Security-Policy" content="${frameCsp(options.attachmentSource)}">`,
        `<style>${LAYOUT_CSS}${modeCss(options)}</style></head>`,
        `<body><div id="rr-body">${body}</div></body></html>`,
    ].join("");
}
