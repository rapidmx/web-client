///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * An event's description as a client handles it. `@rapidmx/restapi` stores the rich text as HTML it has sanitized to a handful of tags
 * (`b`/`strong`, `i`/`em`, `u`, `br`, `p`, `ul`/`ol`/`li`, and `a` with an `http`, `https` or `mailto` `href`), and a client must still never trust it: a
 * description can also arrive in an invitation from anyone. So the HTML is never put in the page as it is. `parseEventDescription()` reads it into a small
 * tree of only those elements - built from what the browser's own parser found, by copying text and one attribute across, so nothing else can survive - and
 * everything a client shows or sends is made from that tree: `renderable` by React elements (no `dangerouslySetInnerHTML`), written back out as canonical
 * HTML (`sanitizeEventDescriptionHtml()`) or as plain text (`htmlToPlainText()`, the same text the server derives).
 *
 * Reading needs a DOM (`DOMParser`); without one (server-side rendering) the tree is empty, never the input.
 */

/** The longest plain-text description the server takes, in characters (it allows a little more; this is the bound the dialog holds itself to). */
export const MAX_EVENT_DESCRIPTION_LENGTH = 32_000;
/** The longest description HTML the server takes, in characters. */
export const MAX_EVENT_DESCRIPTION_HTML_LENGTH = 64_000;

/** The elements a description may hold (`b`/`i` are kept as `strong`/`em`). */
export type DescriptionTag = "strong" | "em" | "u" | "br" | "p" | "ul" | "ol" | "li" | "a";

export type DescriptionNode = { text: string } | { tag: DescriptionTag; href?: string; children: DescriptionNode[] };

const TAG_OF: Record<string, DescriptionTag> = {
    b: "strong",
    strong: "strong",
    i: "em",
    em: "em",
    u: "u",
    br: "br",
    p: "p",
    ul: "ul",
    ol: "ol",
    li: "li",
    a: "a",
};

/** Elements that run or embed something: dropped with everything in them (any other element outside the list keeps its text but not its tags). */
const DROPPED = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "template", "noscript", "noembed", "noframes", "textarea", "select", "option", "title", "head", "xmp"]);

/**
 * `href` as a link a description may carry - an absolute `http`, `https` or `mailto` URL, in its canonical form - or `undefined` for anything else
 * (`javascript:`, `data:`, a relative link, a URL with a control character in it). Whitespace and control characters are removed first, since a browser
 * ignores them inside a scheme (`java\tscript:`).
 */
export function safeDescriptionHref(href: string | null | undefined): string | undefined {
    const compact = (href ?? "").replace(/[\p{Cc}\s]+/gu, "");
    let url: URL;
    try {
        url = new URL(compact);
    } catch {
        return undefined;
    }
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
}

function convert(node: Node): DescriptionNode[] {
    if (node.nodeType === 3) {
        return [{ text: node.textContent as string }];
    }
    if (node.nodeType !== 1) {
        return [];
    }
    const element = node as Element;
    const name = element.tagName.toLowerCase();
    if (DROPPED.has(name)) {
        return [];
    }
    const tag = TAG_OF[name];
    if (tag === "br") {
        return [{ tag, children: [] }];
    }
    const children = Array.from(element.childNodes).flatMap(convert);
    if (!tag) {
        return children;
    }
    if (tag === "a") {
        const href = safeDescriptionHref(element.getAttribute("href"));
        return href ? [{ tag, href, children }] : children;
    }
    if (tag === "p" && element.parentElement?.tagName.toLowerCase() === "li") {
        // A list item written `<li><p>text</p></li>` (what a rich-text editor writes) is `<li>text</li>`: a paragraph inside an item would otherwise
        // break the line after its bullet. A second paragraph in the same item stays on its own line.
        return element.previousElementSibling ? [{ tag: "br", children: [] }, ...children] : children;
    }
    return [{ tag, children }];
}

/** The elements and text of `html` a description may hold, and nothing else. `[]` without a DOM. */
export function parseEventDescription(html: string | null | undefined): DescriptionNode[] {
    if (!html || typeof DOMParser === "undefined") {
        return [];
    }
    const document = new DOMParser().parseFromString(html, "text/html");
    return Array.from(document.body.childNodes).flatMap(convert);
}

function escapeText(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
    return escapeText(text).replace(/"/g, "&quot;");
}

function serialize(nodes: DescriptionNode[]): string {
    return nodes
        .map((node) => {
            if ("text" in node) {
                return escapeText(node.text);
            }
            if (node.tag === "br") {
                return "<br>";
            }
            const open = node.tag === "a" ? `<a href="${escapeAttribute(node.href as string)}" rel="noopener noreferrer">` : `<${node.tag}>`;
            return `${open}${serialize(node.children)}</${node.tag}>`;
        })
        .join("");
}

/** Nothing but white space: text of spaces, a line break, or a paragraph or line break holding only such (what an editor writes for an empty line). */
function isBlank(node: DescriptionNode): boolean {
    return "text" in node ? node.text.trim() === "" : (node.tag === "p" || node.tag === "br") && node.children.every(isBlank);
}

/**
 * `html` reduced to what a description may hold, written as canonical HTML (a link with `rel="noopener noreferrer"`, text and attribute values escaped,
 * every tag closed) and without the empty paragraphs an editor leaves before and after the text - a description with no text in it is `""`. Idempotent.
 * This is what the dialog sends; the server sanitizes it again. `""` without a DOM.
 */
export function sanitizeEventDescriptionHtml(html: string | null | undefined): string {
    const nodes = parseEventDescription(html);
    let first = 0;
    let last = nodes.length;
    while (first < last && isBlank(nodes[first])) {
        first++;
    }
    while (last > first && isBlank(nodes[last - 1])) {
        last--;
    }
    return serialize(nodes.slice(first, last));
}

interface TextState {
    text: string;
    lists: { ordered: boolean; count: number }[];
}

function startLine(state: TextState): void {
    if (state.text !== "" && !state.text.endsWith("\n")) {
        state.text += "\n";
    }
}

function writeText(nodes: DescriptionNode[], state: TextState): void {
    for (const node of nodes) {
        if ("text" in node) {
            const collapsed = node.text.replace(/(?![\t\n\r])\p{Cc}/gu, "").replace(/[ \t\r\n]+/g, " ");
            state.text += state.text === "" || state.text.endsWith("\n") ? collapsed.replace(/^ /, "") : collapsed;
        } else if (node.tag === "br") {
            state.text += "\n";
        } else if (node.tag === "p") {
            startLine(state);
            writeText(node.children, state);
            startLine(state);
        } else if (node.tag === "ul" || node.tag === "ol") {
            startLine(state);
            state.lists.push({ ordered: node.tag === "ol", count: 0 });
            writeText(node.children, state);
            state.lists.pop();
            startLine(state);
        } else if (node.tag === "li") {
            startLine(state);
            const list = state.lists[state.lists.length - 1];
            if (list?.ordered) {
                list.count++;
                state.text += `${list.count}. `;
            } else {
                state.text += "- ";
            }
            writeText(node.children, state);
            startLine(state);
        } else if (node.tag === "a") {
            const start = state.text.length;
            writeText(node.children, state);
            const shown = state.text.slice(start).trim();
            const href = node.href as string;
            if (shown !== href && shown !== href.replace(/^mailto:/i, "")) {
                state.text += ` (${href})`;
            }
        } else {
            writeText(node.children, state);
        }
    }
}

/**
 * The plain text of `html`, as the server derives it: a line break for each `<br>`, paragraph and list item (`- ` before a bulleted item, `1. ` before a
 * numbered one), a link's URL in parentheses after its text when the text is not the URL already, every other tag dropped, whitespace collapsed and runs of
 * blank lines shortened. `""` for a description with no text in it, and without a DOM.
 */
export function htmlToPlainText(html: string | null | undefined): string {
    const state: TextState = { text: "", lists: [] };
    writeText(parseEventDescription(html), state);
    return state.text
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
