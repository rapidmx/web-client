// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    FRAME_SANDBOX,
    LINK_SENTINEL,
    TEXT_SENTINEL,
    buildFrameDocument,
    frameCsp,
    rewriteColourSchemeQueries,
} from "../../../apps/shared/components/mail/reading/frameDocument.js";

const OPTIONS = { scheme: "dark" as const, surface: "rgb(27, 32, 34)", text: "rgb(238, 242, 243)" };

describe("FRAME_SANDBOX", () => {
    it("never lets the document run script, submit a form, navigate the app or open a modal", () => {
        const flags = FRAME_SANDBOX.split(" ");
        expect(flags).toEqual(["allow-same-origin", "allow-popups", "allow-popups-to-escape-sandbox"]);
        for (const forbidden of ["allow-scripts", "allow-forms", "allow-top-navigation", "allow-top-navigation-by-user-activation", "allow-modals", "allow-downloads", "allow-pointer-lock", "allow-presentation", "allow-orientation-lock"]) {
            expect(flags).not.toContain(forbidden);
        }
    });
});

describe("frameCsp", () => {
    it("denies everything by default and grants images only as data: URIs", () => {
        const directives = Object.fromEntries(frameCsp().split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));
        expect(directives).toEqual({
            "default-src": "'none'",
            "script-src": "'none'",
            "object-src": "'none'",
            "frame-src": "'none'",
            "form-action": "'none'",
            "base-uri": "'none'",
            "style-src": "'unsafe-inline'",
            "img-src": "data:",
            "font-src": "data:",
        });
    });

    it("adds this server's attachment URLs as an image source, and only a well-formed URL prefix", () => {
        expect(frameCsp("https://mail.example.com/api/mail/attachments/")).toContain("img-src data: https://mail.example.com/api/mail/attachments/;");
        expect(frameCsp("http://localhost:3000/api/mail/attachments/")).toContain("img-src data: http://localhost:3000/api/mail/attachments/;");
        for (const bad of ['https://x.example/"><script>', "javascript:alert(1)", "https://x.example/a b", "data:", "*", "'self'"]) {
            expect(frameCsp(bad)).toContain("img-src data:;");
        }
    });
});

describe("rewriteColourSchemeQueries", () => {
    const css = "<style>@media (prefers-color-scheme: dark){a{color:red}}@media ( prefers-color-scheme:light ){a{color:blue}}@media screen and (prefers-color-scheme:DARK) and (min-width:1px){b{}}</style>";

    it("makes the app's scheme's queries always true and the other's always false", () => {
        expect(rewriteColourSchemeQueries(css, "dark")).toBe(
            "<style>@media (min-width: 0px){a{color:red}}@media (max-width: -1px){a{color:blue}}@media screen and (min-width: 0px) and (min-width:1px){b{}}</style>",
        );
        expect(rewriteColourSchemeQueries(css, "light")).toBe(
            "<style>@media (max-width: -1px){a{color:red}}@media (min-width: 0px){a{color:blue}}@media screen and (max-width: -1px) and (min-width:1px){b{}}</style>",
        );
    });

    it("leaves everything outside <style> alone, and several style elements each get rewritten", () => {
        const html = "<p>(prefers-color-scheme: dark)</p><style media=all>@media (prefers-color-scheme: dark){}</style><style>@media (prefers-color-scheme: dark){}</style>";
        expect(rewriteColourSchemeQueries(html, "dark")).toBe(
            "<p>(prefers-color-scheme: dark)</p><style media=all>@media (min-width: 0px){}</style><style>@media (min-width: 0px){}</style>",
        );
    });
});

describe("buildFrameDocument", () => {
    it("puts the CSP first in the head, then the layout rules, and the fragment inside #rr-body", () => {
        const doc = new DOMParser().parseFromString(buildFrameDocument('<div class="rr-msg"><p>Hi</p></div>', { ...OPTIONS, mode: "adapt" }), "text/html");
        const head = Array.from(doc.head.children).map((element) => element.localName);
        expect(head).toEqual(["meta", "meta", "style"]);
        expect(doc.head.children[1].getAttribute("http-equiv")).toBe("Content-Security-Policy");
        expect(doc.head.children[1].getAttribute("content")).toBe(frameCsp());
        expect(doc.body.firstElementChild!.id).toBe("rr-body");
        expect(doc.body.children).toHaveLength(1);
        expect(doc.querySelector("#rr-body .rr-msg p")!.textContent).toBe("Hi");
        const css = doc.querySelector("style")!.textContent;
        // A document exactly as tall as its content that never scrolls itself; a wide table scrolls inside the message.
        expect(css).toContain("overflow:hidden!important");
        expect(css).toContain("#rr-body{box-sizing:border-box;position:relative;overflow-x:auto;overflow-y:hidden");
        expect(css).toContain("#rr-body img{max-width:100%;height:auto}");
    });

    it("gives an adapted message the sentinels its colours are told apart by, at zero specificity, in the app's scheme", () => {
        const css = new DOMParser().parseFromString(buildFrameDocument("<p>x</p>", { ...OPTIONS, mode: "adapt" }), "text/html").querySelector("style")!.textContent;
        expect(css).toContain(`:where(:root){color:${TEXT_SENTINEL}}`);
        expect(css).toContain(`:where(a:link,a:visited){color:${LINK_SENTINEL}}`);
        expect(css).toContain(":where(html){color-scheme:dark}");
        expect(css).toContain(":where(body){margin:0}");
    });

    it("shows a message with its own dark styles on the theme's surface in the app's scheme, with its own rules winning", () => {
        const css = new DOMParser().parseFromString(buildFrameDocument("<p>x</p>", { ...OPTIONS, mode: "native" }), "text/html").querySelector("style")!.textContent;
        expect(css).toContain(":where(html){color-scheme:dark;background-color:rgb(27, 32, 34);color:rgb(238, 242, 243)}");
        expect(css).not.toContain(TEXT_SENTINEL);
    });

    it("shows a message as authored as a light document with the browser's own margin, and answers prefers-color-scheme as light", () => {
        const html = buildFrameDocument("<style>@media (prefers-color-scheme: dark){p{color:red}}</style>", { ...OPTIONS, mode: "original" });
        const css = new DOMParser().parseFromString(html, "text/html").querySelector("style")!.textContent;
        expect(css).toContain(":where(html){color-scheme:light}:where(body){margin:8px}");
        expect(css).not.toContain(TEXT_SENTINEL);
        expect(html).toContain("@media (max-width: -1px)");
    });

    it("answers prefers-color-scheme with the app's scheme for an adapted or native message", () => {
        expect(buildFrameDocument("<style>@media (prefers-color-scheme: dark){p{color:red}}</style>", { ...OPTIONS, mode: "native" })).toContain("@media (min-width: 0px)");
        expect(buildFrameDocument("<style>@media (prefers-color-scheme: dark){p{color:red}}</style>", { ...OPTIONS, scheme: "light", mode: "native" })).toContain("@media (max-width: -1px)");
    });

    it("allows the attachment source only when it is given", () => {
        expect(buildFrameDocument("", { ...OPTIONS, mode: "adapt", attachmentSource: "https://mail.example.com/api/mail/attachments/" })).toContain(
            "img-src data: https://mail.example.com/api/mail/attachments/",
        );
        expect(buildFrameDocument("", { ...OPTIONS, mode: "adapt" })).toContain("img-src data:;");
    });
});
