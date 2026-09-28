///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Client-side sanitizing for message bodies the server never sanitized (decrypted or verified content) and for
 * message HTML re-embedded elsewhere (a reply's quote). DOMPurify's defaults drop scripts, `on*` handlers and
 * `javascript:` URLs; on top of that every remote resource reference is removed, so rendering or quoting a body
 * can't ping a tracker. Only `data:` and `cid:` references survive.
 */
import DOMPurify from "dompurify";

const EMBEDDED_URI = /^\s*(?:data|cid):/i;
/** Attributes whose value makes the browser fetch a resource (as opposed to a user-clicked link). */
const RESOURCE_URI_ATTRIBUTES = new Set(["src", "srcset", "background", "poster", "lowsrc", "dynsrc", "xlink:href", "action", "formaction"]);

/** Decodes CSS escapes first (so an escaped `u\72l(` can't hide from the checks below), then drops every
 * `@import` and neutralizes every `url()`/`image-set()` reference that isn't a `data:`/`cid:` URI. */
export function stripRemoteCssUrls(css: string): string {
    return css
        .replace(/\\([0-9a-f]{1,6})\s?/gi, (_match, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
        .replace(/\\(.)/g, "$1")
        .replace(/@import[^;]*;?/gi, "")
        .replace(/(?:-webkit-)?image-set\((?:[^()]|\([^()]*\))*\)/gi, (match) =>
            [...match.matchAll(/(["'])(.*?)\1/g)].every(([, , uri]) => EMBEDDED_URI.test(uri)) ? match : "none",
        )
        .replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, _quote: string, uri: string) => (EMBEDDED_URI.test(uri) ? match : "none"));
}

type Purifier = ReturnType<typeof DOMPurify>;
let bodyPurifier: Purifier | undefined;

/** A dedicated DOMPurify instance (hooks registered here never leak into any other DOMPurify caller) that
 * additionally strips every remote resource reference - see `stripRemoteCssUrls()`. `undefined` without a DOM
 * (server-side rendering), where DOMPurify can't sanitize at all. */
function getBodyPurifier(): Purifier | undefined {
    if (bodyPurifier) {
        return bodyPurifier;
    }
    if (typeof window === "undefined") {
        return undefined;
    }
    const purifier = DOMPurify(window);
    if (!purifier.isSupported) {
        return undefined;
    }
    purifier.addHook("uponSanitizeElement", (node, data) => {
        if (data.tagName === "style") {
            // An element's `textContent` is always a string (only documents/doctypes yield null).
            node.textContent = stripRemoteCssUrls(node.textContent as string);
        }
    });
    purifier.addHook("uponSanitizeAttribute", (node, data) => {
        const name = data.attrName.toLowerCase();
        if (name === "style") {
            data.attrValue = stripRemoteCssUrls(data.attrValue);
            return;
        }
        const isNavigationLink = name === "href" && ["a", "area"].includes(node.nodeName.toLowerCase());
        if (RESOURCE_URI_ATTRIBUTES.has(name) || (name === "href" && !isNavigationLink)) {
            const candidates = name === "srcset" ? data.attrValue.split(/,\s+/) : [data.attrValue];
            if (!candidates.every((candidate) => EMBEDDED_URI.test(candidate))) {
                data.keepAttr = false;
            }
        }
    });
    bodyPurifier = purifier;
    return purifier;
}

/** Tags a displayed body may never carry, whatever else is allowed. `svg`/`math` are forbidden here too (not just
 * on the quote path below) because this function renders a RECEIVED message's HTML — attacker-controlled content —
 * and DOMPurify's default SVG/MathML allowlist has a history of mutation-XSS bypasses; there's no legitimate need
 * for either in a mail body display. */
const DISPLAY_FORBIDDEN_TAGS = ["link", "meta", "base", "svg", "math"];

/**
 * Sanitizes a message body for display (a sandboxed `srcDoc`, behind its own CSP): DOMPurify's defaults plus the
 * remote-resource stripping above, and no `<link>`, `<meta>` or `<base>`. Returns `""` when there is no DOM to
 * sanitize with - never the unsanitized input.
 */
export function sanitizeMessageBodyHtml(html: string): string {
    return getBodyPurifier()?.sanitize(html, { FORBID_TAGS: DISPLAY_FORBIDDEN_TAGS }) ?? "";
}

/** On top of the display policy: nothing that styles, frames or submits from inside the compose editor. */
const QUOTE_FORBIDDEN_TAGS = [
    ...DISPLAY_FORBIDDEN_TAGS,
    "style",
    "title",
    "form",
    "input",
    "button",
    "select",
    "option",
    "textarea",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "audio",
    "video",
    "source",
    "track",
    // svg/math are already in DISPLAY_FORBIDDEN_TAGS, spread above — not repeated here.
];

/**
 * Sanitizes message HTML for quoting into a compose body: the display policy (`sanitizeMessageBodyHtml()`), without
 * the tags in `QUOTE_FORBIDDEN_TAGS`, and without any image that isn't embedded as a `data:` URI - a `cid:` image
 * refers to a part of the original message the reply doesn't carry. Returns `""` when there is no DOM to sanitize
 * with.
 */
export function sanitizeQuotedHtml(html: string): string {
    const purifier = getBodyPurifier();
    if (!purifier) {
        return "";
    }
    const fragment = purifier.sanitize(html, { FORBID_TAGS: QUOTE_FORBIDDEN_TAGS, RETURN_DOM_FRAGMENT: true });
    for (const image of Array.from(fragment.querySelectorAll("img"))) {
        if (!/^\s*data:/i.test(image.getAttribute("src") ?? "")) {
            image.remove();
        }
    }
    const container = document.createElement("div");
    container.appendChild(fragment);
    return container.innerHTML;
}
