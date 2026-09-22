// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_TEXT_CONTRAST, Rgb, ThemeSurface, composite, contrastRatio, parseColour, rgbToHsl } from "../../../apps/shared/components/mail/reading/color.js";
import { LINK_SENTINEL, TEXT_SENTINEL } from "../../../apps/shared/components/mail/reading/frameDocument.js";
import { AdaptationResult, adaptDocument } from "../../../apps/shared/components/mail/reading/themeAdaptation.js";

const DARK: ThemeSurface = { background: { r: 27, g: 32, b: 34 }, text: { r: 238, g: 242, b: 243 }, link: { r: 45, g: 212, b: 191 }, dark: true };
const LIGHT: ThemeSurface = { background: { r: 255, g: 255, b: 255 }, text: { r: 28, g: 37, b: 38 }, link: { r: 20, g: 138, b: 128 }, dark: false };

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
    for (const frame of frames.splice(0)) frame.remove();
});

/**
 * A real (jsdom) document whose `getComputedStyle` is a small model of what a browser reports for the display frame: `color` is inherited and
 * starts at the text sentinel, links start at the link sentinel, and everything else is what the element's `data-color`, `data-bg` and
 * `data-image` attributes say (standing in for the message's stylesheet). The model is what the pass is written against; the real
 * browser's answers are checked by the harness in `.claude/NOTES.md`.
 */
function frame(bodyHtml: string): Document {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    frames.push(iframe);
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write(`<!doctype html><html><head><style>x{}</style></head><body><div id="rr-body">${bodyHtml}</div></body></html>`);
    doc.close();
    const view = iframe.contentWindow!;
    const colourOf = (element: Element | null): string => {
        if (!element) return TEXT_SENTINEL;
        const own = (element as HTMLElement).dataset?.color;
        if (own) return own;
        if (element.localName === "a" && element.hasAttribute("href")) return LINK_SENTINEL;
        return colourOf(element.parentElement);
    };
    vi.spyOn(view, "getComputedStyle").mockImplementation(
        (element: Element) =>
            ({
                color: colourOf(element),
                backgroundColor: (element as HTMLElement).dataset?.bg ?? "rgba(0, 0, 0, 0)",
                backgroundImage: (element as HTMLElement).dataset?.image ?? "none",
            }) as unknown as CSSStyleDeclaration,
    );
    return doc;
}

const inline = (doc: Document, id: string) => doc.getElementById(id)!.style.getPropertyValue("color");
const priority = (doc: Document, id: string) => doc.getElementById(id)!.style.getPropertyPriority("color");
const rgbOf = (css: string): Rgb => parseColour(css)!;
const readable = (css: string, on: Rgb) => contrastRatio(rgbOf(css), on);

describe("adaptDocument", () => {
    it("(a) flips authored black text with no background to the theme's text colour in a dark theme", async () => {
        const doc = frame('<p id="p" data-color="rgb(0, 0, 0)">Hello</p>');
        const result = await adaptDocument(doc, DARK);
        expect(rgbOf(inline(doc, "p"))).toEqual({ r: 238, g: 242, b: 243, a: 1 });
        expect(priority(doc, "p")).toBe("important");
        expect(readable(inline(doc, "p"), DARK.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(result.material).toBe(true);
    });

    it("(b) flips authored white text with no background to dark text in a light theme", async () => {
        const doc = frame('<p id="p" data-color="rgb(255, 255, 255)">Hello</p><p id="q" data-color="rgb(253, 253, 253)">Hi</p>');
        const result = await adaptDocument(doc, LIGHT);
        expect(rgbOf(inline(doc, "p"))).toEqual({ ...LIGHT.text, a: 1 });
        expect(readable(inline(doc, "q"), LIGHT.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(result.material).toBe(true);
    });

    it("(c) shows authored black text on an authored white body exactly as authored - nothing on it is written", async () => {
        const doc = frame('<div id="wrap" data-bg="rgb(255, 255, 255)" data-color="rgb(0, 0, 0)"><p id="p">Hello <a id="a" href="https://x.example" data-color="rgb(0, 0, 204)">link</a></p></div>');
        const result = await adaptDocument(doc, DARK);
        // The paragraph inherits the wrapper's authored black; the authored link colour is re-stated (it differs from what the parent ends
        // with) but is exactly what the author wrote.
        expect(inline(doc, "p")).toBe("");
        expect(inline(doc, "a")).toBe("rgb(0, 0, 204)");
        // Likewise the wrapper's own black, which its parent (the theme's text) would not give it.
        expect(inline(doc, "wrap")).toBe("rgb(0, 0, 0)");
        expect(result.authoredCanvas).toBe(true);
    });

    it("(d) leaves a newsletter's white table as authored while what is outside it takes the theme", async () => {
        const doc = frame(
            '<p id="margin">Outside the table</p>' +
                '<table id="t" data-bg="rgb(255, 255, 255)"><tr><td id="c1" data-color="rgb(17, 17, 17)">Headline</td></tr><tr><td id="c2" data-bg="rgb(11, 42, 91)"><span id="banner" data-color="rgb(255, 255, 255)">Banner</span></td></tr></table>' +
                '<p id="after">After</p>',
        );
        await adaptDocument(doc, DARK);
        expect(inline(doc, "margin")).toBe("");
        expect(inline(doc, "after")).toBe("");
        // Authored text on the authored table: as authored (re-stated only so it does not inherit the theme's colour).
        expect(inline(doc, "c1")).toBe("rgb(17, 17, 17)");
        // The banner cell's unauthored text is white by contrast with its dark blue, and the authored white span inside it already is that.
        expect(inline(doc, "c2")).toBe("rgb(255, 255, 255)");
        expect(inline(doc, "banner")).toBe("");
    });

    it("(e) gives unauthored text inside an authored white cell black, never the theme's white", async () => {
        const doc = frame('<table><tr><td id="cell" data-bg="rgb(255, 255, 255)"><p id="p">Text</p><a id="a" href="https://x.example">link</a></td></tr></table>');
        await adaptDocument(doc, DARK);
        expect(inline(doc, "cell")).toBe("rgb(0, 0, 0)");
        // The paragraph inherits the cell's black; the link is drawn classic blue on white.
        expect(inline(doc, "p")).toBe("");
        expect(readable(inline(doc, "a"), { r: 255, g: 255, b: 255 })).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(rgbOf(inline(doc, "a")).b).toBeGreaterThan(rgbOf(inline(doc, "a")).r);
    });

    it("(f) gives unauthored text inside an authored dark-blue banner white", async () => {
        const doc = frame('<div id="banner" data-bg="rgb(11, 42, 91)"><p id="p">Welcome</p><a id="a" href="https://x.example">link</a></div>');
        await adaptDocument(doc, LIGHT);
        expect(inline(doc, "banner")).toBe("rgb(255, 255, 255)");
        // A link on the dark banner is lightened from classic blue until it reads.
        expect(readable(inline(doc, "a"), { r: 11, g: 42, b: 91 })).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    });

    it("(g) lightens low-contrast authored navy text just enough, and it stays a blue", async () => {
        const doc = frame('<p id="p" data-color="rgb(0, 31, 92)">Navy</p>');
        await adaptDocument(doc, DARK);
        const navy = rgbOf(inline(doc, "p"));
        expect(contrastRatio(navy, DARK.background)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(contrastRatio(navy, DARK.background)).toBeLessThan(MIN_TEXT_CONTRAST + 0.5);
        expect(Math.round(rgbToHsl(navy).h)).toBeGreaterThanOrEqual(215);
        expect(Math.round(rgbToHsl(navy).h)).toBeLessThanOrEqual(225);
    });

    it("(h) keeps a brand-red link that already reads on the dark theme, as authored", async () => {
        const doc = frame('<a id="a" href="https://x.example" data-color="rgb(248, 113, 113)">brand</a>');
        await adaptDocument(doc, DARK);
        expect(inline(doc, "a")).toBe("rgb(248, 113, 113)");
    });

    it("(i) gives a link nobody coloured the theme's link colour", async () => {
        const doc = frame('<p id="p">See <a id="a" href="https://x.example">this</a></p><a id="named">no href</a>');
        await adaptDocument(doc, DARK);
        expect(rgbOf(inline(doc, "a"))).toEqual({ r: 45, g: 212, b: 191, a: 1 });
        // An anchor with no href is not a link: it inherits the theme's text.
        expect(inline(doc, "named")).toBe("");
    });

    it("(j) themes a bare message completely with one colour on the root and nothing else", async () => {
        const doc = frame("<div dir='ltr'>Hi<br><br><blockquote>quoted</blockquote></div>");
        const result = await adaptDocument(doc, DARK);
        expect(doc.documentElement.style.getPropertyValue("color")).toBe("rgb(238, 242, 243)");
        expect(result.written).toBe(1);
        expect(result.authoredCanvas).toBe(false);
        expect(result.material).toBe(true);
    });

    it("(j) a bare message in a light theme makes no material difference - there is nothing for 'view original' to show", async () => {
        const doc = frame("<div>Hi</div>");
        const result = await adaptDocument(doc, LIGHT);
        expect(result.material).toBe(false);
    });

    it("(l) treats a semi-transparent authored background as part of the theme: composited, and text on it adapted", async () => {
        const doc = frame('<div id="panel" data-bg="rgba(0, 0, 0, 0.08)"><p id="p" data-color="rgb(17, 17, 17)">Note</p><p id="q">plain</p></div>');
        await adaptDocument(doc, DARK);
        const surface = composite({ r: 0, g: 0, b: 0, a: 0.08 }, DARK.background);
        expect(readable(inline(doc, "p"), surface)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        expect(luminanceOf(inline(doc, "p"))).toBeGreaterThan(0.5);
        expect(inline(doc, "q")).toBe("");
    });

    it("(l) keeps a semi-transparent panel over an authored one authored", async () => {
        const doc = frame('<div id="a" data-bg="rgb(255, 255, 255)"><div id="b" data-bg="rgba(0, 0, 0, 0.05)"><p id="p" data-color="rgb(20, 20, 20)">x</p></div></div>');
        await adaptDocument(doc, DARK);
        expect(inline(doc, "p")).toBe("rgb(20, 20, 20)");
    });

    it("(m) judges unauthored text over a gradient by its first colour, and over a picture by black", async () => {
        const doc = frame(
            '<div id="grad" data-image="linear-gradient(90deg, rgb(255, 126, 95), rgb(254, 180, 123))">Sale</div>' +
                '<div id="dark" data-image="linear-gradient(rgb(10, 10, 40), rgb(30, 30, 90))">Night</div>' +
                '<div id="pic" data-image=\'url("data:image/png;base64,AAAA")\'>Picture</div>' +
                '<div id="picbg" data-image=\'url("data:image/png;base64,AAAA")\' data-bg="rgb(10, 10, 10)">Picture with a colour</div>',
        );
        await adaptDocument(doc, DARK);
        expect(inline(doc, "grad")).toBe("rgb(0, 0, 0)");
        expect(inline(doc, "dark")).toBe("rgb(255, 255, 255)");
        expect(inline(doc, "pic")).toBe("rgb(0, 0, 0)");
        expect(inline(doc, "picbg")).toBe("rgb(255, 255, 255)");
    });

    it("(m) draws an unauthored link over a picture in classic blue, as a browser would", async () => {
        const doc = frame('<div id="pic" data-image=\'url("data:image/png;base64,AAAA")\'><a id="a" href="https://x.example">link</a></div>');
        await adaptDocument(doc, DARK);
        expect(inline(doc, "a")).toBe("rgb(0, 0, 238)");
    });

    it("(m) leaves authored text over an authored image or gradient as it is", async () => {
        const doc = frame('<div id="grad" data-image="linear-gradient(rgb(255, 255, 255), rgb(250, 250, 250))"><p id="p" data-color="rgb(10, 10, 10)">x</p></div>');
        await adaptDocument(doc, DARK);
        expect(inline(doc, "p")).toBe("rgb(10, 10, 10)");
    });

    it("(p) writes only colour, and only as an important inline declaration - never anything else", async () => {
        const doc = frame('<p id="p" data-color="rgb(0, 0, 0)" style="margin: 4px">x</p><div id="d" data-bg="rgb(255, 255, 255)">y</div>');
        await adaptDocument(doc, DARK);
        expect(doc.getElementById("p")!.getAttribute("style")).toBe("margin: 4px; color: rgb(238, 242, 243) !important;");
        expect(doc.getElementById("d")!.style.length).toBe(1);
        expect(doc.getElementById("d")!.style.getPropertyValue("background-color")).toBe("");
    });

    it("takes its colours back, as the message had them inline or not at all, and puts them again - what a printed page needs", async () => {
        const doc = frame('<p id="p" data-color="rgb(0, 0, 0)" style="color: rgb(9, 9, 9)">x</p><p id="q" data-color="rgb(0, 0, 0)">y</p><p id="r" data-color="rgb(1, 1, 1)" style="color: red !important">z</p>');
        const result = await adaptDocument(doc, DARK);
        const adapted = ["p", "q", "r", "html"].map((id) => (id === "html" ? doc.documentElement.style.getPropertyValue("color") : inline(doc, id)));
        expect(adapted.every(Boolean)).toBe(true);

        result.revert();
        expect(inline(doc, "p")).toBe("rgb(9, 9, 9)");
        expect(priority(doc, "p")).toBe("");
        expect(inline(doc, "q")).toBe("");
        expect(inline(doc, "r")).toBe("red");
        expect(priority(doc, "r")).toBe("important");
        expect(doc.documentElement.style.getPropertyValue("color")).toBe("");

        result.reapply();
        expect(["p", "q", "r", "html"].map((id) => (id === "html" ? doc.documentElement.style.getPropertyValue("color") : inline(doc, id)))).toEqual(adapted);
        expect(priority(doc, "p")).toBe("important");
    });

    it("gives an authored colour it cannot read (a colour function, say) no colour of ours and lets it inherit", async () => {
        const doc = frame('<p id="p" data-color="oklch(50% 0.2 200)">x</p><p id="q">y</p>');
        await adaptDocument(doc, DARK);
        expect(inline(doc, "p")).toBe("");
        expect(inline(doc, "q")).toBe("");
    });

    it("composites a translucent authored text colour over its background before judging it, and keeps it when it reads", async () => {
        const doc = frame('<p id="p" data-color="rgba(255, 255, 255, 0.9)">x</p>');
        await adaptDocument(doc, DARK);
        expect(inline(doc, "p")).toBe("rgba(255, 255, 255, 0.9)");
    });

    it("does not examine what cannot carry text: head, styles, scripts, SVG and images, or anything inside them", async () => {
        const doc = frame('<svg id="s" data-color="rgb(0, 0, 0)"><text id="t" data-color="rgb(0, 0, 0)">x</text></svg><img id="i" data-color="rgb(0, 0, 0)"><p id="p">y</p>');
        const result = await adaptDocument(doc, DARK);
        expect(inline(doc, "s")).toBe("");
        expect(inline(doc, "t")).toBe("");
        expect(inline(doc, "i")).toBe("");
        // html, body, #rr-body and the paragraph.
        expect(result.elements).toBe(4);
    });

    it("counts a wrapper standing in for the message's <body> as the canvas", async () => {
        const doc = frame('<div class="rr-msg" data-bg="rgb(246, 246, 246)"><p>x</p></div>');
        expect((await adaptDocument(doc, DARK)).authoredCanvas).toBe(true);
        const gradient = frame('<div class="rr-msg" data-image="linear-gradient(rgb(1, 1, 1), rgb(9, 9, 9))"><p>x</p></div>');
        expect((await adaptDocument(gradient, DARK)).authoredCanvas).toBe(true);
        const translucent = frame('<div class="rr-msg" data-bg="rgba(0, 0, 0, 0.5)"><p>x</p></div>');
        expect((await adaptDocument(translucent, DARK)).authoredCanvas).toBe(false);
    });

    it("counts a message that is only ever authored dark on the dark surface as no material change from the surface alone", async () => {
        const doc = frame('<p id="p" data-color="rgb(240, 240, 240)">x</p><div data-bg="rgb(30, 30, 30)"></div>');
        const result = await adaptDocument(doc, DARK);
        // Text that already reads is kept; the frame is the dark surface, though, so 'view original' would show the white authored canvas.
        expect(inline(doc, "p")).toBe("rgb(240, 240, 240)");
        expect(result.material).toBe(true);
    });

    it("returns at once for a document with no window", async () => {
        const doc = document.implementation.createHTMLDocument("x");
        const result = await adaptDocument(doc, DARK);
        expect(result).toEqual({ elements: 0, written: 0, material: false, authoredCanvas: false, cancelled: false, revert: expect.any(Function), reapply: expect.any(Function) });
        // Nothing was written, so taking it back and putting it again are no-ops that must still be callable.
        expect(() => {
            result.revert();
            result.reapply();
        }).not.toThrow();
    });

    describe("time slicing", () => {
        it("gives the browser a turn between slices and finishes the work", async () => {
            const doc = frame("<p id='a'>1</p><p id='b' data-color='rgb(0, 0, 0)'>2</p>");
            let clock = 0;
            const yieldToBrowser = vi.fn(async () => undefined);
            const result = await adaptDocument(doc, DARK, { sliceMs: 5, now: () => (clock += 10), yieldToBrowser });
            expect(yieldToBrowser).toHaveBeenCalled();
            expect(result.cancelled).toBe(false);
            expect(inline(doc, "b")).toBe("rgb(238, 242, 243)");
        });

        it("stops, writing nothing, when the frame is gone while it waits", async () => {
            const doc = frame("<p id='b' data-color='rgb(0, 0, 0)'>2</p>");
            let clock = 0;
            const result: AdaptationResult = await adaptDocument(doc, DARK, { sliceMs: 5, now: () => (clock += 10), yieldToBrowser: async () => undefined, isCancelled: () => true });
            expect(result.cancelled).toBe(true);
            expect(inline(doc, "b")).toBe("");
            expect(doc.documentElement.style.getPropertyValue("color")).toBe("");
        });

        it("yields to the real event loop by default", async () => {
            const doc = frame("<p>x</p>");
            const now = vi.spyOn(performance, "now");
            let clock = 0;
            now.mockImplementation(() => (clock += 20));
            const result = await adaptDocument(doc, DARK, { sliceMs: 1 });
            now.mockRestore();
            expect(result.cancelled).toBe(false);
        });
    });
});

function luminanceOf(css: string): number {
    const { r, g, b } = rgbOf(css);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
