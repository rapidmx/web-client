// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    MAX_BODY_ELEMENTS,
    MAX_BODY_HTML_LENGTH,
    declaresDarkSupport,
    prepareBodyHtml,
    sanitizeCss,
} from "../../../apps/shared/components/mail/reading/bodyHtml.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

/** The prepared fragment as a detached DOM, to assert on structure rather than on strings. */
function prepare(html: string, options?: Parameters<typeof prepareBodyHtml>[1]) {
    const prepared = prepareBodyHtml(html, options);
    const container = document.createElement("div");
    container.innerHTML = prepared.html;
    return { prepared, container };
}

describe("prepareBodyHtml", () => {
    it("wraps the message in one div.rr-msg, with the head's styles first, since DOMPurify would drop them as head content", () => {
        const { prepared, container } = prepare("<html><head><style>p{color:red}</style></head><body><p>Hi</p></body></html>");
        expect(prepared.status).toBe("ok");
        const wrapper = container.firstElementChild!;
        expect(wrapper.className).toBe("rr-msg");
        expect(wrapper.firstElementChild!.tagName).toBe("STYLE");
        expect(wrapper.firstElementChild!.textContent).toBe("p{color:red}");
        expect(wrapper.querySelector("p")!.textContent).toBe("Hi");
    });

    it("carries what the body element said onto the wrapper: colour attributes, style, classes and direction", () => {
        const { container } = prepare(
            '<body bgcolor="#ffffff" text="000000" link="#0000cc" style="margin:0" class="mail-body" dir="rtl"><p>x</p></body>',
        );
        const wrapper = container.firstElementChild as HTMLElement;
        expect(wrapper.getAttribute("style")).toBe("background-color:rgb(255, 255, 255);color:rgb(0, 0, 0);margin:0");
        expect(wrapper.className).toBe("rr-msg mail-body");
        expect(wrapper.getAttribute("dir")).toBe("rtl");
        expect(wrapper.querySelector("style")!.textContent).toBe(":where(.rr-msg a:link){color:rgb(0, 0, 204)}");
    });

    it("never copies anything but a colour it can read out of a colour attribute", () => {
        const { container } = prepare('<body bgcolor="red;background:url(https://tracker.example/x)" text="transparent" link="javascript:x"><p>x</p></body>');
        const wrapper = container.firstElementChild!;
        expect(wrapper.getAttribute("style")).toBeNull();
        expect(wrapper.querySelector("style")).toBeNull();
        expect(container.innerHTML).not.toContain("tracker.example");
    });

    it("has no wrapper attributes when the body has none", () => {
        const { container } = prepare("<p>x</p>");
        const wrapper = container.firstElementChild!;
        expect(wrapper.getAttributeNames()).toEqual(["class"]);
    });

    it("removes scripts, frames, media, forms' controls, plug-ins and the elements that could redirect or load something", () => {
        const { container } = prepare(
            "<p>keep</p>" +
                "<script>window.__pwned=1</script><iframe src='https://x.example'></iframe><object data='x'></object><embed src='x'>" +
                "<video src='x'></video><audio src='x'></audio><canvas></canvas><input value=x><select><option>a</option></select><textarea>t</textarea>" +
                "<meta http-equiv='refresh' content='0;url=https://x.example'><base href='https://x.example/'><link rel=stylesheet href='https://x.example/s.css'>" +
                "<noscript><img src=x></noscript><template><p>t</p></template><svg><use href='#a'></use><set attributeName='href' to='x'></set><animate></animate><foreignObject><p>f</p></foreignObject><circle r='4'></circle></svg><math><mi>x</mi></math>",
        );
        // svg/math are forbidden outright by the sanitizer itself (react-shared 0.14.0's
        // messageBodySanitizer.ts) - nothing under either tag survives at all any more, not even an
        // otherwise-harmless element like <circle> (this test used to assert it survived, back when only
        // svg's specific dangerous sub-elements - use/set/animate/foreignObject, still in this file's own
        // REMOVED_ELEMENTS as defense in depth in case that upstream FORBID_TAGS ever regresses - were
        // stripped and a whole <svg> was otherwise let through).
        for (const selector of [
            "script", "iframe", "object", "embed", "video", "audio", "canvas", "input", "select", "textarea",
            "meta", "base", "link", "noscript", "template", "svg", "use", "set", "animate", "foreignObject",
            "circle", "math",
        ]) {
            expect(container.querySelector(selector), selector).toBeNull();
        }
        expect(container.textContent).toContain("keep");
    });

    it("unwraps forms and buttons - a message wrapped in a form is still a message - and drops their targets", () => {
        const { container } = prepare("<form action='https://x.example' method=post><p>inside</p><button formaction='https://y.example'>Go</button></form>");
        expect(container.querySelector("form")).toBeNull();
        expect(container.querySelector("button")).toBeNull();
        expect(container.textContent).toContain("inside");
        expect(container.textContent).toContain("Go");
        expect(container.innerHTML).not.toContain("x.example");
        expect(container.innerHTML).not.toContain("y.example");
    });

    it("strips event handlers and the attributes a document could be clobbered or navigated through", () => {
        const { container } = prepare(
            '<p onclick="x()" onmouseover="x()" name="body" tabindex="0" contenteditable="true" accesskey="k" autofocus draggable="true">a</p>' +
                '<img name="documentElement" id="ok" src="data:image/png;base64,AAAA" srcset="https://x.example/a.png 1x" crossorigin="anonymous" onerror="x()">',
        );
        const p = container.querySelector("p")!;
        expect(p.getAttributeNames()).toEqual([]);
        const img = container.querySelector("img")!;
        expect(img.getAttributeNames().sort()).toEqual(["id", "src"]);
    });

    it("neutralises what a stylesheet or a style attribute could use to cover the frame or run code", () => {
        const { container } = prepare(
            '<div style="position: fixed; top:0; left:0; width:100vw; height:100vh; background: expression(alert(1))">x</div>' +
                "<style>.a{position:sticky} .b{behavior:url(x.htc); -moz-binding: url(x)} @import url(https://x.example/a.css); .c{color:red}</style>",
        );
        const div = container.querySelector(".rr-msg > div")!;
        expect(div.getAttribute("style")).toContain("position:relative");
        expect(div.getAttribute("style")).not.toContain("expression(");
        const css = container.querySelector("style")!.textContent;
        expect(css).toContain("position:relative");
        expect(css).not.toMatch(/@import|behavior:url|-moz-binding:/);
        expect(css).toContain("color:red");
    });

    it("keeps only links a reader can safely follow, each opening in a new tab without an opener", () => {
        const { container } = prepare(
            '<a href="https://example.com/a">a</a><a href="HTTP://example.com/b">b</a><a href="mailto:x@example.com">m</a><a href="tel:+15551234567">t</a>' +
                '<a href="javascript:alert(1)">j</a><a href="/api/mail/messages/x/raw">rel</a><a href="#top">hash</a><a href="data:text/html,x">d</a><a href="cid:x">c</a><a>none</a>' +
                '<map name="m"><area href="https://example.com/area" shape="rect" coords="0,0,1,1"><area href="javascript:x()"></map>',
        );
        const anchors = Array.from(container.querySelectorAll("a, area"));
        const followed = anchors.filter((a) => a.hasAttribute("href")).map((a) => a.getAttribute("href"));
        expect(followed).toEqual(["https://example.com/a", "HTTP://example.com/b", "mailto:x@example.com", "tel:+15551234567", "https://example.com/area"]);
        for (const a of anchors.filter((a) => a.hasAttribute("href"))) {
            expect(a.getAttribute("target")).toBe("_blank");
            expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
        }
        for (const a of anchors.filter((a) => !a.hasAttribute("href"))) {
            expect(a.hasAttribute("target")).toBe(false);
        }
    });

    it("shows only embedded images - never a remote one - and resolves an inline cid: image through the resolver", () => {
        const resolveCid = vi.fn((cid: string) => (cid === "logo@x" ? "data:image/png;base64,AAAA" : cid === "photo@x" ? "https://mail.example/api/mail/attachments/a1/content" : cid === "bad@x" ? "javascript:alert(1)" : undefined));
        const { prepared, container } = prepare(
            '<img id="embedded" src="data:image/png;base64,AAAA"><img id="svg" src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">' +
                '<img id="html" src="data:text/html;base64,PHNjcmlwdD4=">' +
                '<img id="remote" src="https://tracker.example/p.gif"><img id="proto" src="//tracker.example/p.gif">' +
                '<img id="cid1" src="cid:logo@x"><img id="cid2" src="cid:&lt;photo@x&gt;"><img id="cid3" src="CID:missing@x"><img id="cid4" src="cid:bad@x"><img id="none" alt="x">',
            { resolveCid },
        );
        const src = (id: string) => container.querySelector(`#${id}`)!.getAttribute("src");
        expect(src("embedded")).toBe("data:image/png;base64,AAAA");
        expect(src("svg")).toBe("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
        expect(src("html")).toBeNull();
        expect(src("remote")).toBeNull();
        expect(src("proto")).toBeNull();
        expect(src("cid1")).toBe("data:image/png;base64,AAAA");
        expect(src("cid2")).toBe("https://mail.example/api/mail/attachments/a1/content");
        expect(src("cid3")).toBeNull();
        expect(src("cid4")).toBeNull();
        expect(src("none")).toBeNull();
        expect(prepared.inlineImages).toBe(4);
        expect(container.innerHTML).not.toContain("tracker.example");
    });

    it("treats every cid: image as unresolved when there is no resolver", () => {
        const { prepared, container } = prepare('<img src="cid:a@x">');
        expect(container.querySelector("img")!.getAttribute("src")).toBeNull();
        expect(prepared.inlineImages).toBe(1);
    });

    it("says whether the message declares dark support", () => {
        expect(prepare('<meta name="color-scheme" content="light dark"><p>x</p>').prepared.declaresDarkSupport).toBe(true);
        expect(prepare("<p>x</p>").prepared.declaresDarkSupport).toBe(false);
    });

    it("refuses a body over the length limit without parsing it", () => {
        const prepared = prepareBodyHtml("x".repeat(MAX_BODY_HTML_LENGTH + 1));
        expect(prepared).toEqual({ status: "too_large", html: "", declaresDarkSupport: false, inlineImages: 0 });
    });

    it("refuses a body with more elements than the limit", { timeout: 120_000 }, () => {
        const prepared = prepareBodyHtml("<i></i>".repeat(MAX_BODY_ELEMENTS + 1));
        expect(prepared.status).toBe("too_large");
        expect(prepared.html).toBe("");
    });

    it("survives markup nested a thousand deep", () => {
        // Deeper than a browser's own parser allows (it stops nesting at 512), so nothing here is left to recurse over. Not deeper still: jsdom
        // serializes `innerHTML` recursively, and runs out of stack somewhere around 2500 levels - less when the test is called from a deeper stack -
        // which made 3000 pass or fail with what else was running.
        const depth = 1000;
        const prepared = prepareBodyHtml("<div>".repeat(depth) + "deep" + "</div>".repeat(depth));
        expect(prepared.status).toBe("ok");
        expect(prepared.html).toContain("deep");
    });

    it("answers with an empty fragment where there is no DOM to parse with (server-side rendering)", () => {
        vi.stubGlobal("DOMParser", undefined);
        expect(prepareBodyHtml("<p>x</p>")).toEqual({ status: "ok", html: "", declaresDarkSupport: false, inlineImages: 0 });
    });
});

describe("declaresDarkSupport", () => {
    function doc(html: string): Document {
        return new DOMParser().parseFromString(html, "text/html");
    }

    it.each([
        ['<meta name="color-scheme" content="light dark">', true],
        ['<meta name="COLOR-SCHEME" content="dark">', true],
        ['<meta name="color-scheme" content="light">', false],
        ['<meta name="color-scheme">', false],
        ["<style>:root{color-scheme: light dark}</style>", true],
        ["<style>body { color-scheme:dark; }</style>", true],
        ["<style>@media (prefers-color-scheme: dark) { body { background:#000 } }</style>", true],
        ["<style>@media (prefers-color-scheme:light) { body { background:#fff } }</style>", false],
        ['<p style="color-scheme: dark">x</p>', true],
        ["<style>:root{col\\6fr-scheme: dark}</style>", true],
        ["<style>p{color:red}</style><p>x</p>", false],
        ["<p>plain</p>", false],
    ])("for %s answers %s", (html, expected) => {
        expect(declaresDarkSupport(doc(html))).toBe(expected);
    });
});

describe("sanitizeCss", () => {
    it("rewrites what could cover the frame or run code, and leaves the rest", () => {
        expect(sanitizeCss("a{position : fixed} b{position:STICKY} c{color:red}")).toBe("a{position:relative} b{position:relative} c{color:red}");
        expect(sanitizeCss("a{width:expression(1)} b{behavior : url(x)} c{-moz-binding:url(x)}")).toBe("a{width:none(1)} b{x-behavior: url(x)} c{-x-binding:url(x)}");
        expect(sanitizeCss("@import 'x.css'; a{color:red}")).toBe(" a{color:red}");
    });

    it("turns lengths in viewport-height units into pixels, so a message cannot make its frame grow by growing itself", () => {
        expect(sanitizeCss("a{height:100vh;min-height: 50.5dvh;max-height:20svh;top:5lvh;width:10vmin;left:3vmax;margin:1vb}")).toBe(
            "a{height:100px;min-height: 50.5px;max-height:20px;top:5px;width:10px;left:3px;margin:1px}",
        );
        expect(sanitizeCss("a{width:100vw;height:10vhx}")).toBe("a{width:100vw;height:10vhx}");
    });
});
