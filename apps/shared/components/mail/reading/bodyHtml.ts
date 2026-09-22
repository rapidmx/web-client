///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { sanitizeMessageBodyHtml } from "@rapidmx/react-shared/mail/messageBodySanitizer.js";
import { parseColour } from "./color.js";

/**
 * Turning a message's HTML - which is hostile until proven otherwise - into the fragment that goes into its display frame.
 *
 * Four independent layers stand between a mail and script execution, and this file is two of them:
 *
 * 1. the server's own allow-list sanitizer (restapi's `ScanPipeline`), before the body is stored;
 * 2. **this file**: DOMPurify (react-shared's `sanitizeMessageBodyHtml()` - scripts, `on*` handlers, `javascript:` URLs, and every
 * remote resource reference removed) followed by a second, structural pass of our own that removes what DOMPurify's defaults
 * allow but a mail body never needs (forms, frames, media, SVG's active elements, every non-`http(s)`/`mailto`/`tel` link);
 * 3. the frame's Content-Security-Policy (`frameDocument.ts`): no script, no object, no frame, no form, nothing fetched;
 * 4. the frame's `sandbox` attribute, which never has `allow-scripts`, so nothing executes even if all of the above failed.
 *
 * Nothing here parses into the app's own document: every parse is a `DOMParser` document, which has no browsing context, runs no
 * script and fetches nothing.
 */

/** A body longer than this many characters is not sanitized or shown inline - DOMPurify on megabytes of markup would freeze the tab. */
export const MAX_BODY_HTML_LENGTH = 1_500_000;
/** A body with more elements than this is not shown inline either: it cannot be laid out and adapted in a reasonable time. */
export const MAX_BODY_ELEMENTS = 20_000;

export interface PreparedBody {
    /** `too_large` means `html` is empty and the caller should offer the message on its own page instead. */
    status: "ok" | "too_large";
    /** The sanitized fragment: one wrapper `div.rr-msg` holding the message's own `<style>` elements and body. */
    html: string;
    /** The mail carries its own dark styles: a `color-scheme` meta or property, or a `prefers-color-scheme: dark` block. */
    declaresDarkSupport: boolean;
    /** How many `<img>`s point at an inline part (`cid:`) - the frame's CSP only needs an image source for the attachments then. */
    inlineImages: number;
}

export interface PrepareOptions {
    /** The URL an inline image's `cid:` reference stands for, or `undefined` when there is no such part. Only `data:` URIs of an
     * image type and `http(s)` URLs are accepted; anything else is treated as unresolved. */
    resolveCid?: (contentId: string) => string | undefined;
}

/** What a stylesheet or a `style` attribute may not contain, whatever the sanitizers before it did. */
const STYLE_HAZARDS: [RegExp, string][] = [
    // Fixed and sticky positioning could cover the frame (or, with a viewport-sized box, all of it) with a fake dialog.
    [/position\s*:\s*(?:fixed|sticky)/gi, "position:relative"],
    // A length in viewport-height units is the frame's own height, which is the message's height: `min-height: 100vh` would make the frame grow
    // by what its content adds on every measurement. As plain pixels, nothing in the message depends on the size of the frame it is in.
    [/(\d(?:\.\d+)?)\s*(?:[sld]?v(?:h|min|max|b))\b/gi, "$1px"],
    [/expression\s*\(/gi, "none("],
    [/-moz-binding\s*:/gi, "-x-binding:"],
    [/behavior\s*:/gi, "x-behavior:"],
    [/@import[^;]*;?/gi, ""],
];

/** CSS with the constructs above neutralised. */
export function sanitizeCss(css: string): string {
    return STYLE_HAZARDS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), css);
}

/** Elements removed together with everything inside them. */
const REMOVED_ELEMENTS = new Set([
    "script",
    "noscript",
    "object",
    "embed",
    "applet",
    "iframe",
    "frame",
    "frameset",
    "noembed",
    "noframes",
    "audio",
    "video",
    "source",
    "track",
    "canvas",
    "dialog",
    "template",
    "slot",
    "portal",
    "bgsound",
    "xml",
    "base",
    "meta",
    "link",
    "title",
    "head",
    "input",
    "select",
    "textarea",
    "datalist",
    "option",
    "optgroup",
    "math",
    // SVG's active or reference-following elements: a script, a foreign document, a use of another element, and animation
    // (which can set an `href` or an event handler's target).
    "foreignobject",
    "use",
    "set",
    "animate",
    "animatemotion",
    "animatetransform",
]);

/** Elements dropped but not their content: a message wrapped in an old ASP.NET `<form>` is still a message. */
const UNWRAPPED_ELEMENTS = new Set(["form", "fieldset", "legend", "label", "button", "output", "marquee", "blink"]);

/** Attributes no element of a mail may keep, on top of every `on*` handler. */
const REMOVED_ATTRIBUTES = new Set([
    "name",
    "srcdoc",
    "formaction",
    "form",
    "ping",
    "nonce",
    "is",
    "slot",
    "contenteditable",
    "accesskey",
    "tabindex",
    "autofocus",
    "draggable",
    "srcset",
    "crossorigin",
    "integrity",
    "referrerpolicy",
    "http-equiv",
    "xlink:href",
]);

/** The `href`s of a link a reader can follow: nothing that runs, nothing relative to this app, nothing that reads a local file. */
const LINK_URL = /^(?:https?:\/\/|mailto:|tel:)/i;
/** Inline images: raster types and SVG (an image context cannot run script or load anything), embedded as data. */
const IMAGE_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i;
const CSS_ESCAPE = /\\([0-9a-f]{1,6})\s?|\\(.)/gi;

/** Decodes CSS escapes, so a check for `color-scheme` cannot be dodged with `col\6fr-scheme`. */
function unescapeCss(css: string): string {
    return css.replace(CSS_ESCAPE, (_match, hex: string | undefined, other: string | undefined) =>
        hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : (other as string),
    );
}

/**
 * Whether a mail's own markup declares that it supports a dark scheme: `<meta name="color-scheme">` naming dark,
 * a `color-scheme` property naming dark in a stylesheet or a `style` attribute, or an `@media (prefers-color-scheme: dark)` block. Such a mail
 * brings its own dark styles, which the display honours instead of adapting the mail's colours.
 */
export function declaresDarkSupport(doc: Document): boolean {
    const meta = doc.querySelector('meta[name="color-scheme" i]');
    if (/\bdark\b/i.test(meta?.getAttribute("content") ?? "")) {
        return true;
    }
    // An element's text is never null, and a `[style]` element always has the attribute.
    const sheets = Array.from(doc.querySelectorAll("style"), (style) => style.textContent);
    const inline = Array.from(doc.querySelectorAll("[style]"), (element) => element.getAttribute("style")!);
    return [...sheets, ...inline].some((css) => {
        const text = unescapeCss(css);
        return /color-scheme\s*:[^;}]*\bdark\b/i.test(text) || /prefers-color-scheme\s*:\s*dark/i.test(text);
    });
}

/** A `bgcolor`/`text`/`link` attribute's value as an `rgb()` colour if we can read it - nothing else is ever copied into a style.
 * `bgcolor="ffffff"` (no hash) is what old templates write and what a browser accepts. */
function attributeColour(value: string | null): string | undefined {
    const text = (value ?? "").trim();
    const colour = parseColour(/^[0-9a-f]{6}$/i.test(text) ? `#${text}` : text);
    return colour && colour.a > 0 ? `rgb(${Math.round(colour.r)}, ${Math.round(colour.g)}, ${Math.round(colour.b)})` : undefined;
}

/** The wrapper `div.rr-msg`: the message's head `<style>`s first (DOMPurify drops a leading one as head content), then its body, with
 * what a `<body bgcolor text link>` said carried over as the styles those attributes stand for. */
function wrapMessage(doc: Document): string {
    const wrapper = doc.createElement("div");
    wrapper.className = "rr-msg";
    for (const style of Array.from(doc.head.querySelectorAll("style"))) {
        wrapper.appendChild(style.cloneNode(true));
    }
    const [background, text, link] = ["bgcolor", "text", "link"].map((name) => attributeColour(doc.body.getAttribute(name)));
    // What the `<body>` said about itself moves to the wrapper, which stands in for it: its presentational colours first (a `style` beats
    // them), then its own `style`, its classes (a template's stylesheet may select on them) and its direction.
    const declarations = [background && `background-color:${background}`, text && `color:${text}`, doc.body.getAttribute("style")].filter(Boolean);
    if (declarations.length > 0) {
        wrapper.setAttribute("style", declarations.join(";"));
    }
    const bodyClass = doc.body.getAttribute("class");
    if (bodyClass) {
        wrapper.className += ` ${bodyClass}`;
    }
    const direction = doc.body.getAttribute("dir");
    if (direction) {
        wrapper.setAttribute("dir", direction);
    }
    if (link) {
        const rule = doc.createElement("style");
        rule.textContent = `:where(.rr-msg a:link){color:${link}}`;
        wrapper.appendChild(rule);
    }
    wrapper.append(...Array.from(doc.body.childNodes));
    return wrapper.outerHTML;
}

/** Replaces `element` with its children. */
function unwrap(element: Element): void {
    element.replaceWith(...Array.from(element.childNodes));
}

function hardenLink(element: Element): void {
    const href = element.getAttribute("href")?.trim() ?? "";
    if (LINK_URL.test(href)) {
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer nofollow");
    } else {
        // A link that goes nowhere a reader could safely follow stays as text, without the address it hid.
        element.removeAttribute("href");
        element.removeAttribute("target");
    }
}

function hardenImage(element: Element, options: PrepareOptions): void {
    const src = (element.getAttribute("src") ?? "").trim();
    const inline = /^cid:/i.test(src);
    const target = inline ? options.resolveCid?.(src.slice(4).replace(/^<|>$/g, "")) : src;
    // Remote images are never fetched (they would tell the sender the message was read); an inline image resolves to an embedded
    // image or to this server's own attachment URL, and one that doesn't resolve has nothing to show.
    if (target !== undefined && (IMAGE_DATA_URI.test(target) || (inline && /^https?:\/\//i.test(target)))) {
        element.setAttribute("src", target);
    } else {
        element.removeAttribute("src");
    }
}

/**
 * The second, structural pass over already-sanitized markup: everything a mail body has no use for is removed or unwrapped, every
 * link is forced to open in a new tab without an opener, and hazards in stylesheets are neutralised. Runs on a detached document.
 */
function harden(body: HTMLElement, options: PrepareOptions): { elements: number; inlineImages: number } {
    let inlineImages = 0;
    const all = Array.from(body.querySelectorAll("*"));
    for (const element of all) {
        const tag = element.localName.toLowerCase();
        if (REMOVED_ELEMENTS.has(tag)) {
            element.remove();
            continue;
        }
        if (UNWRAPPED_ELEMENTS.has(tag)) {
            unwrap(element);
            continue;
        }
        for (const attribute of Array.from(element.attributes)) {
            const name = attribute.name.toLowerCase();
            if (name.startsWith("on") || REMOVED_ATTRIBUTES.has(name)) {
                element.removeAttribute(attribute.name);
            } else if (name === "style") {
                element.setAttribute("style", sanitizeCss(attribute.value));
            }
        }
        if (tag === "style") {
            element.textContent = sanitizeCss(element.textContent);
        } else if (tag === "a" || tag === "area") {
            hardenLink(element);
        } else if (tag === "img") {
            if (/^cid:/i.test(element.getAttribute("src") ?? "")) {
                inlineImages++;
            }
            hardenImage(element, options);
        }
    }
    return { elements: all.length, inlineImages };
}

/**
 * The display fragment for a message's HTML - see the file's header. `too_large` (and an empty `html`) for a body over
 * `MAX_BODY_HTML_LENGTH` characters or `MAX_BODY_ELEMENTS` elements; an empty fragment where there is no DOM to parse with.
 */
export function prepareBodyHtml(raw: string, options: PrepareOptions = {}): PreparedBody {
    const empty = { html: "", declaresDarkSupport: false, inlineImages: 0 };
    if (raw.length > MAX_BODY_HTML_LENGTH) {
        return { status: "too_large", ...empty };
    }
    if (typeof DOMParser === "undefined") {
        return { status: "ok", ...empty };
    }
    const parsed = new DOMParser().parseFromString(raw, "text/html");
    const darkSupport = declaresDarkSupport(parsed);
    const sanitized = sanitizeMessageBodyHtml(wrapMessage(parsed));
    const cleaned = new DOMParser().parseFromString(`<!doctype html><body>${sanitized}`, "text/html").body;
    const { elements, inlineImages } = harden(cleaned, options);
    if (elements > MAX_BODY_ELEMENTS) {
        return { status: "too_large", ...empty };
    }
    return { status: "ok", html: cleaned.innerHTML, declaresDarkSupport: darkSupport, inlineImages };
}
