///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    MIN_TEXT_CONTRAST,
    Rgb,
    ThemeSurface,
    adaptForeground,
    blackOrWhite,
    composite,
    contrastRatio,
    ensureContrast,
    firstColourStop,
    formatColour,
    luminance,
    parseColour,
    sameColour,
} from "./color.js";
import { LINK_SENTINEL, TEXT_SENTINEL } from "./frameDocument.js";
import { documentElementOf, viewOf } from "./safeDocument.js";

/**
 * Makes a message take the app's theme wherever its author left the colours to the reader, and leaves it as authored wherever the
 * author chose them. Runs in the parent against the display frame's document (which is same-origin only because no script can run
 * there - see `frameDocument.ts`); reads with `getComputedStyle` and writes nothing but `color` on individual elements, as inline
 * `!important` declarations built from numbers, never from text of the message.
 *
 * **Authored or inherited, without parsing CSS.** The frame's base stylesheet gives the root a sentinel text colour, and unvisited/visited
 * links another, at zero specificity, so any rule of the message beats them. An element whose computed `color` still equals the sentinel
 * was never coloured by the message (its text is *unauthored*); any other value - black included - was chosen by somebody. A background
 * is authored when its computed colour is not transparent or its image is not `none`.
 *
 * **What each text becomes**, from its effective background (the nearest authored background up the tree, composited over what is beneath
 * it, else the theme's surface):
 * - unauthored text on the theme surface: the theme's text colour; an unauthored link: the theme's link colour;
 * - authored text on the theme surface: kept if it reads (4.5:1), else adapted (`adaptForeground()`: black becomes white, navy a lighter
 * navy) - the symmetric case in a light theme included;
 * - anything on an authored, opaque background (a white cell, a dark banner, a gradient): that region is shown as authored - its own text
 * colours untouched - except unauthored text, which must not inherit the theme's colour (white on white) and gets black or white by
 * contrast with that background (black when the background is a picture or a gradient with no first colour to judge by);
 * - a semi-transparent authored background is composited over what is under it and treated like the theme surface, since how it looks
 * depends on the theme.
 *
 * Every element ends with exactly its target colour: an element is written to only when inheritance would not give it that (which includes
 * one that may carry a declaration of its own). Images, SVG and everything else that is not text are untouched.
 */

export interface AdaptationResult {
    /** Elements examined. */
    elements: number;
    /** Elements given an inline colour. */
    written: number;
    /** Whether adapting makes a visible difference from the message as authored: a text colour changed a lot, or the canvas is the theme's
     * dark surface rather than the white a message is authored on. False for e.g. a bare message in a light theme. */
    material: boolean;
    /** `<html>` or `<body>` carries an authored background: the whole frame takes it. */
    authoredCanvas: boolean;
    /** Stopped because `isCancelled()` said the frame was gone. */
    cancelled: boolean;
    /** Puts every colour back as the message had it (paper is not a dark surface: the frame does this for printing). */
    revert: () => void;
    /** Puts the adapted colours back after `revert()`. */
    reapply: () => void;
}

export interface AdaptOptions {
    /** How long one slice of work may take before the pass gives the browser a turn. */
    sliceMs?: number;
    isCancelled?: () => boolean;
    /** For tests. */
    now?: () => number;
    yieldToBrowser?: () => Promise<void>;
}

/** Not examined, nor are their children. `head` and its contents never render; `svg` is left as drawn. */
const SKIPPED = new Set(["head", "script", "style", "title", "meta", "link", "template", "svg", "img"]);

/** What travels down the tree: the effective background, whether it is an authored opaque one, and the colour the parent ends up with. */
interface Context {
    background: Rgb;
    authored: boolean;
    unknown: boolean;
    parentColour: Rgb;
}

/** Classic link blue - what an unauthored link looks like in an authored region, before contrast. */
const DEFAULT_LINK: Rgb = { r: 0, g: 0, b: 238 };
/** How much lighter or darker (in luminance) an adapted text colour must be than the original for the difference to be worth an opt-out. */
const MATERIAL_LUMINANCE_SHIFT = 0.3;
/** A surface at least this luminous is close enough to the white a message is authored on that it is not, by itself, an adaptation. */
const LIGHT_SURFACE = 0.85;

/** The elements whose background is the message's canvas: `<html>`, `<body>`, and the wrapper that stands in for the message's own `<body>`. */
function standsForCanvas(element: HTMLElement, root: HTMLElement): boolean {
    return element === root || element.localName === "body" || element.parentElement?.id === "rr-body";
}

function noop(): void {
    // Nothing was written, so there is nothing to put back.
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The colour a `color` value comes to over a background: opaque, alpha composited. */
function opaque(css: string, over: Rgb): Rgb | undefined {
    const colour = parseColour(css);
    return colour ? composite(colour, over) : undefined;
}

/**
 * Adapts `doc` to `surface` - see the file's header. Time-sliced (`sliceMs`, then a turn for the browser) so a very large message never
 * blocks the page; the frame stays hidden until this resolves, so nothing unreadable is ever shown.
 */
export async function adaptDocument(doc: Document, surface: ThemeSurface, options: AdaptOptions = {}): Promise<AdaptationResult> {
    const { sliceMs = 12, isCancelled = () => false, now = () => performance.now(), yieldToBrowser = nextTurn } = options;
    const view = viewOf(doc);
    const result: AdaptationResult = { elements: 0, written: 0, material: false, authoredCanvas: false, cancelled: false, revert: noop, reapply: noop };
    if (!view) {
        return result;
    }
    const root = documentElementOf(doc);
    // Every read happens before the first write: a write changes what its descendants inherit, which would make every child of an element
    // we coloured look authored.
    const writes: { element: HTMLElement; colour: string }[] = [];
    const stack: { element: HTMLElement; context: Context }[] = [
        { element: root, context: { background: surface.background, authored: false, unknown: false, parentColour: surface.text } },
    ];
    let sliceStart = now();
    while (stack.length > 0) {
        if (now() - sliceStart > sliceMs) {
            await yieldToBrowser();
            if (isCancelled()) {
                result.cancelled = true;
                return result;
            }
            sliceStart = now();
        }
        const { element, context } = stack.pop()!;
        if (SKIPPED.has(element.localName.toLowerCase())) {
            continue;
        }
        result.elements++;
        const style = view.getComputedStyle(element);
        let { background, authored, unknown } = context;
        const own = parseColour(style.backgroundColor);
        const image = style.backgroundImage;
        if (image && image !== "none") {
            const stop = firstColourStop(image) ?? (own && own.a > 0 ? own : undefined);
            authored = true;
            unknown = !stop;
            background = stop ? composite(stop, background) : background;
            result.authoredCanvas ||= standsForCanvas(element, root);
        } else if (own && own.a >= 0.98) {
            authored = true;
            unknown = false;
            background = composite(own, background);
            result.authoredCanvas ||= standsForCanvas(element, root);
        } else if (own && own.a > 0) {
            background = composite(own, background);
        }

        const declared = style.color;
        const original = opaque(declared, background);
        let target: { rgb: Rgb; css: string } | undefined;
        if (declared === TEXT_SENTINEL) {
            const rgb = authored ? (unknown ? { r: 0, g: 0, b: 0 } : blackOrWhite(background)) : ensureContrast(surface.text, background);
            target = { rgb, css: formatColour(rgb) };
        } else if (declared === LINK_SENTINEL) {
            const rgb = authored ? (unknown ? DEFAULT_LINK : ensureContrast(DEFAULT_LINK, background)) : ensureContrast(surface.link, background);
            target = { rgb, css: formatColour(rgb) };
        } else if (original && !authored) {
            // Authored text on the theme's surface: it stays if it reads, else it is adapted.
            const readable = contrastRatio(original, background) >= MIN_TEXT_CONTRAST;
            const rgb = readable ? original : adaptForeground(original, { ...surface, background });
            target = { rgb, css: readable ? declared : formatColour(rgb) };
        } else if (original) {
            // Authored text on an authored background: as its author had it.
            target = { rgb: original, css: declared };
        }
        let parentColour = context.parentColour;
        if (target) {
            // An element is written to unless inheritance already gives it its target: the parent must end with that colour, and an element
            // that may carry a declaration of its own (an authored colour, a link - the sentinel is a rule on it - and the root) must not
            // be declaring a different one. Text nobody coloured inherits and has nothing of its own to override.
            const ownDeclaration = declared !== TEXT_SENTINEL || element === root;
            if (!sameColour(target.rgb, context.parentColour) || (ownDeclaration && !sameColour(target.rgb, original ?? target.rgb))) {
                writes.push({ element, colour: target.css });
            }
            if (original && Math.abs(luminance(target.rgb) - luminance(original)) > MATERIAL_LUMINANCE_SHIFT) {
                result.material = true;
            }
            parentColour = target.rgb;
        }
        for (const child of Array.from(element.children).reverse()) {
            stack.push({ element: child as HTMLElement, context: { background, authored, unknown, parentColour } });
        }
    }
    // What each element had inline before, so the writes can be taken back (a message may carry its own inline colour).
    const before = writes.map(({ element }) => ({ value: element.style.getPropertyValue("color"), priority: element.style.getPropertyPriority("color") }));
    result.reapply = () => {
        for (const { element, colour } of writes) {
            element.style.setProperty("color", colour, "important");
        }
    };
    result.revert = () => {
        writes.forEach(({ element }, index) => {
            if (before[index].value) {
                element.style.setProperty("color", before[index].value, before[index].priority);
            } else {
                element.style.removeProperty("color");
            }
        });
    };
    result.reapply();
    result.written = writes.length;
    result.material ||= !result.authoredCanvas && luminance(surface.background) < LIGHT_SURFACE;
    return result;
}
