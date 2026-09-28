// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { sanitizeMessageBodyHtml, sanitizeQuotedHtml, stripRemoteCssUrls } from "../../../lib/mail/messageBodySanitizer.js";

describe("stripRemoteCssUrls", () => {
    it("neutralizes remote url() references and keeps embedded ones", () => {
        expect(stripRemoteCssUrls("a{background:url('https://t.example/x.png')} b{background:url(data:image/png;base64,AA)}")).toBe(
            "a{background:none} b{background:url(data:image/png;base64,AA)}",
        );
    });

    it("decodes CSS escapes before checking, so an escaped url( can't hide", () => {
        expect(stripRemoteCssUrls("a{background:u\\72l(https://t.example/x.png)}")).toBe("a{background:none}");
        expect(stripRemoteCssUrls("a{content:'\\x'}")).toBe("a{content:'x'}");
    });

    it("drops @import rules", () => {
        expect(stripRemoteCssUrls("@import url(https://t.example/s.css); p{color:red}")).toBe(" p{color:red}");
    });

    it("keeps an image-set() only when every candidate is embedded", () => {
        expect(stripRemoteCssUrls("a{background:image-set('https://t.example/1x.png' 1x)}")).toBe("a{background:none}");
        expect(stripRemoteCssUrls("a{background:-webkit-image-set('cid:a@x' 1x, 'data:image/png;base64,AA' 2x)}")).toBe(
            "a{background:-webkit-image-set('cid:a@x' 1x, 'data:image/png;base64,AA' 2x)}",
        );
    });
});

describe("sanitizeMessageBodyHtml", () => {
    it("drops scripts, handlers, link/meta/base, and remote resources, keeping data: and cid: ones and link hrefs", () => {
        const html = sanitizeMessageBodyHtml(
            '<p onclick="evil()">Hi</p><meta http-equiv="refresh" content="0"><base href="https://t.example/"><link rel="stylesheet" href="https://t.example/s.css">' +
                '<style>p{background:url(https://t.example/bg.png)}</style><script>evil()</script>' +
                '<img id="a" src="https://t.example/p.gif"><img id="b" src="cid:logo@x"><img id="c" src="data:image/png;base64,AAAA">' +
                '<img srcset="cid:lo@x 1x, https://t.example/2x.png 2x"><table background="https://t.example/bg.png"><tbody><tr><td>x</td></tr></tbody></table>' +
                '<svg><image href="https://t.example/i.png"></image></svg><a href="https://example.com/page">link</a>',
        );
        expect(html).not.toMatch(/t\.example|script|onclick|<meta|<base|<link/);
        expect(html).toContain("background:none");
        expect(html).toContain('src="cid:logo@x"');
        expect(html).toContain('src="data:image/png;base64,AAAA"');
        expect(html).toContain('<a href="https://example.com/page">link</a>');
    });

    it("strips svg/math tags entirely from a received message's rendered body, matching the quote path", () => {
        // A received message body is attacker-controlled; DOMPurify's default allowlist otherwise still permits
        // svg/math, a known historical vector for mutation-XSS bypasses (asymmetric with sanitizeQuotedHtml(),
        // which already forbade both — this closes that gap).
        const html = sanitizeMessageBodyHtml(
            '<p>before</p><svg><script>evil()</script><image href="https://t.example/i.png"></image></svg>' +
                "<math><mtext>evil</mtext></math><p>after</p>",
        );
        expect(html).not.toMatch(/<svg|<math/i);
        expect(html).toContain("<p>before</p>");
        expect(html).toContain("<p>after</p>");
    });
});

describe("sanitizeQuotedHtml", () => {
    it("also drops styles, forms, frames, media and every image that isn't a data: URI, keeping only form controls' text", () => {
        const html = sanitizeQuotedHtml(
            "<style>p{color:red}</style><form><input><button>b</button><select><option>o</option></select><textarea>t</textarea></form>" +
                '<iframe src="data:text/html,x"></iframe><object data="x"></object><embed src="x"><video src="data:video/mp4,x"></video>' +
                '<p style="color:blue">Kept</p><img src="cid:logo@x"><img><img src="data:image/png;base64,AAAA">',
        );
        expect(html).toBe('bot<p style="color:blue">Kept</p><img src="data:image/png;base64,AAAA">');
    });
});
