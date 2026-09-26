// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY_HTML_LENGTH } from "../../../apps/shared/components/mail/reading/bodyHtml.js";
import { buildPrintDocument, escapeHtml, printDocument } from "../../../apps/shared/components/mail/reading/printMessage.js";

const HEADERS = [
    { name: "From", value: "Ann <ann@x.com>" },
    { name: "To", value: "Me <me@x.com>" },
    { name: "Cc", value: "" },
    { name: "Date", value: "1/1/2026, 12:30:00 PM" },
];

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.querySelectorAll("iframe").forEach((frame) => frame.remove());
});

describe("escapeHtml", () => {
    it("escapes what would be markup", () => {
        expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
    });
});

describe("buildPrintDocument", () => {
    it("is the subject, the header lines that have a value, a rule and the sanitized body, under the frame's own policy", () => {
        const html = buildPrintDocument({
            subject: "Q3 <plan>",
            headers: HEADERS,
            content: { kind: "html", html: '<p>Hello <b>there</b></p><script>alert(1)</script><img src="https://evil.example/x.png">' },
        })!;
        expect(html).toContain("<title>Q3 &lt;plan&gt;</title>");
        expect(html).toContain("<h1>Q3 &lt;plan&gt;</h1>");
        expect(html).toContain("<dt>From</dt><dd>Ann &lt;ann@x.com&gt;</dd>");
        expect(html).toContain("<dt>Date</dt>");
        // A header line with nothing to say is left out.
        expect(html).not.toContain("<dt>Cc</dt>");
        expect(html).toContain("<b>there</b>");
        expect(html).not.toContain("<script");
        expect(html).not.toContain("evil.example");
        const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("script-src 'none'");
        expect(csp).toContain("img-src data:");
        expect(csp).not.toContain("http");
    });

    it("draws a text body as text, never as markup", () => {
        const html = buildPrintDocument({ subject: "S", headers: [], content: { kind: "text", text: "1 < 2 & <b>not bold</b>" } })!;
        expect(html).toContain('<pre class="rr-text">1 &lt; 2 &amp; &lt;b&gt;not bold&lt;/b&gt;</pre>');
        expect(html).not.toContain("<b>not bold</b>");
    });

    it("lets the document load this server's attachment URLs only when an inline image was resolved to one", () => {
        const attachments = [{ uid: "a1", filename: "logo.png", sizeBytes: 1, contentId: "logo" }] as never;
        const withImage = buildPrintDocument({ subject: "S", headers: [], content: { kind: "html", html: '<p><img src="cid:logo"></p>' }, attachments })!;
        expect(withImage).toContain("/api/mail/attachments/a1");
        expect(/Content-Security-Policy" content="([^"]+)"/.exec(withImage)![1]).toMatch(/img-src data: https?:\/\/[^ ;]+\/api\/mail\/attachments\//);
        // An inline image nothing can resolve is not shown, so nothing is allowed for it.
        const unresolved = buildPrintDocument({ subject: "S", headers: [], content: { kind: "html", html: '<p><img src="cid:missing"></p>' }, attachments })!;
        expect(/Content-Security-Policy" content="([^"]+)"/.exec(unresolved)![1]).toContain("img-src data:;");
    });

    it("resolves an inline image of a decrypted message to a data URI from the part inside it", () => {
        const png = new Uint8Array([137, 80, 78, 71]);
        const inlineParts = [{ contentId: "pic", contentType: "image/png", filename: "pic.png", decode: () => png }] as never;
        const html = buildPrintDocument({ subject: "S", headers: [], content: { kind: "html", html: '<img src="cid:pic">' }, inlineParts })!;
        expect(html).toContain("data:image/png;base64,");
    });

    it("gives nothing for a body too large to prepare, as the pane does not draw it either", () => {
        expect(buildPrintDocument({ subject: "S", headers: [], content: { kind: "html", html: "x".repeat(MAX_BODY_HTML_LENGTH + 1) } })).toBeUndefined();
    });
});

describe("printDocument", () => {
    /** A frame's window, as far as printing needs one. */
    function stubFrameWindow() {
        const view = { focus: vi.fn(), print: vi.fn(), listeners: new Map<string, () => void>(), addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); } };
        vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(view as never);
        return view;
    }

    it("puts the document in a hidden, sandboxed frame and prints it once it has loaded", () => {
        const view = stubFrameWindow();
        printDocument("<!doctype html><p>Hi</p>");
        const frame = document.querySelector("iframe")!;
        expect(frame.getAttribute("sandbox")).toBe("allow-same-origin allow-modals");
        expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
        expect(frame.getAttribute("aria-hidden")).toBe("true");
        expect(frame.srcdoc).toBe("<!doctype html><p>Hi</p>");
        expect(view.print).not.toHaveBeenCalled();
        frame.dispatchEvent(new Event("load"));
        expect(view.focus).toHaveBeenCalled();
        expect(view.print).toHaveBeenCalledTimes(1);
    });

    it("takes the frame away when the print is over", () => {
        const view = stubFrameWindow();
        printDocument("<p>Hi</p>");
        document.querySelector("iframe")!.dispatchEvent(new Event("load"));
        expect(document.querySelector("iframe")).not.toBeNull();
        view.listeners.get("afterprint")!();
        expect(document.querySelector("iframe")).toBeNull();
    });

    it("takes the frame away after a while when the browser never says the print is over", () => {
        vi.useFakeTimers();
        stubFrameWindow();
        printDocument("<p>Hi</p>");
        document.querySelector("iframe")!.dispatchEvent(new Event("load"));
        vi.advanceTimersByTime(60_000);
        expect(document.querySelector("iframe")).toBeNull();
    });
});
