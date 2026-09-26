///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Attachment } from "@rapidmx/react-shared/mail/mailApi.js";
import type { MimeAttachment } from "@rapidmx/react-shared/crypto/mime.js";
import { BodyContent, attachmentSource, makeCidResolver } from "./bodyContent.js";
import { prepareBodyHtml } from "./bodyHtml.js";
import { frameCsp } from "./frameDocument.js";

/**
 * Printing one message: a document of its own - the message's header lines, and under them the same sanitized body the reading pane draws -
 * shown in a frame that nobody sees and printed from there, so the print is the message and not the app around it.
 *
 * The frame is as isolated as the reading pane's own (`frameDocument.ts`): the body has been through `prepareBodyHtml()`, the document
 * carries the same Content-Security-Policy (no script, nothing fetched from anywhere but this server's own attachment URLs), and the
 * sandbox runs no code. `allow-same-origin` only lets the app call `print()` on it, and `allow-modals` is what a browser asks of a
 * sandboxed document for the print dialog to open at all. Paper is white, so the message is drawn as its author wrote it.
 */

export interface PrintableMessage {
    subject: string;
    /** The header lines above the body - `From`, `To`, `Cc`, `Date` - in the order shown; a line with no value is left out. */
    headers: { name: string; value: string }[];
    content: BodyContent;
    attachments?: Attachment[];
    inlineParts?: MimeAttachment[];
}

const PRINT_CSS = `
html{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#000;background:#fff}
body{margin:0;padding:24px}
h1{font-size:20px;margin:0 0 12px}
dl{margin:0 0 12px;display:grid;grid-template-columns:max-content 1fr;gap:2px 12px}
dt{font-weight:600;color:#444}
dd{margin:0;overflow-wrap:anywhere}
hr{border:0;border-top:1px solid #999;margin:0 0 16px}
#rr-body{overflow-wrap:break-word}
#rr-body img{max-width:100%;height:auto}
#rr-body pre,pre.rr-text{white-space:pre-wrap;font:inherit;margin:0}
`;

export function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * The document to print, or `undefined` for a body too large to prepare (the pane does not draw it either).
 */
export function buildPrintDocument(message: PrintableMessage): string | undefined {
    let body: string;
    let imageSource: string | undefined;
    if (message.content.kind === "html") {
        const prepared = prepareBodyHtml(message.content.html, { resolveCid: makeCidResolver(message.attachments, message.inlineParts) });
        if (prepared.status === "too_large") {
            return undefined;
        }
        const source = prepared.inlineImages > 0 ? attachmentSource() : undefined;
        imageSource = source && prepared.html.includes(source) ? source : undefined;
        body = `<div id="rr-body">${prepared.html}</div>`;
    } else {
        body = `<pre class="rr-text">${escapeHtml(message.content.text)}</pre>`;
    }
    const lines = message.headers
        .filter((header) => header.value !== "")
        .map((header) => `<dt>${escapeHtml(header.name)}</dt><dd>${escapeHtml(header.value)}</dd>`)
        .join("");
    return [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8">',
        `<meta http-equiv="Content-Security-Policy" content="${frameCsp(imageSource)}">`,
        `<title>${escapeHtml(message.subject)}</title>`,
        `<style>${PRINT_CSS}</style></head>`,
        `<body><h1>${escapeHtml(message.subject)}</h1><dl>${lines}</dl><hr>${body}</body></html>`,
    ].join("");
}

/** How long a print frame is kept when the browser never says it has finished with it (`afterprint`). */
const FRAME_LIFETIME_MS = 60_000;

/** Prints `html` (from `buildPrintDocument()`) from a frame nobody sees, and removes the frame when the print is over. */
export function printDocument(html: string): void {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin allow-modals");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.title = "Message to print";
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    const cleanup = () => frame.remove();
    frame.addEventListener("load", () => {
        const view = frame.contentWindow!;
        view.addEventListener("afterprint", cleanup);
        view.focus();
        view.print();
        setTimeout(cleanup, FRAME_LIFETIME_MS);
    });
    frame.srcdoc = html;
    document.body.appendChild(frame);
}
