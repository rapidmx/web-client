///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ThemeSurface } from "./color.js";
import { bodyOf, documentElementOf, viewOf } from "./safeDocument.js";
import { AdaptationResult, adaptDocument } from "./themeAdaptation.js";

/**
 * The parent's side of a message's display frame: once its document has loaded, adapt its colours to the theme, then follow its height
 * for as long as it lives. This is where the frame is read, which works because the frame is same-origin and has no script; every read
 * is made through the DOM's own accessors on the frame's document (never by a name the document could have clobbered).
 */

/** The tallest a message frame is allowed to grow, in CSS pixels: a hostile `height: 100000000px` must not build a layer the browser cannot paint. */
export const MAX_FRAME_HEIGHT = 200_000;
/** How many size changes one loaded document may report before the frame stops listening - a stylesheet that resizes itself in response to
 * its own size (`height: 200vh`) would otherwise grow the frame on every observation, up to the cap. */
export const MAX_RESIZE_REPORTS = 200;

export interface FrameHandlers {
    /** The document's content height in CSS pixels, whenever it changes (also once at load). */
    onHeight: (height: number) => void;
    /** The document is ready to show. `adaptation` is present when it was adapted to a theme. */
    onReady: (adaptation?: AdaptationResult) => void;
    /** Adapt to this surface before showing; absent for a document shown as it is. */
    surface?: ThemeSurface;
}

function pixels(value: string): number {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The height of what the document displays: the bottom of its wrapper plus the body's own trailing margin, padding and border. Not
 * `scrollHeight`, which is never less than the frame's own height, so a message could never shrink.
 */
export function measureFrameHeight(doc: Document): number {
    const view = viewOf(doc);
    const body = bodyOf(doc);
    const wrapper = body?.firstElementChild;
    if (!view || !body || !wrapper) {
        return 0;
    }
    const style = view.getComputedStyle(body);
    const trailing = pixels(style.marginBottom) + pixels(style.paddingBottom) + pixels(style.borderBottomWidth);
    const bottom = wrapper.getBoundingClientRect().bottom + view.scrollY + trailing;
    return Math.min(MAX_FRAME_HEIGHT, Math.max(0, Math.ceil(bottom)));
}

/** Re-sends a key pressed inside the frame to the app's own document, so the app's keyboard shortcuts work with focus in a message body
 * (a frame keeps its own key events); if the app handled it, the frame's default action is prevented too. */
export function forwardKeyDown(event: KeyboardEvent, target: Document): void {
    const copy = new KeyboardEvent("keydown", {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
        bubbles: true,
        cancelable: true,
    });
    if (!target.dispatchEvent(copy)) {
        event.preventDefault();
    }
}

/**
 * Starts controlling `iframe`'s freshly loaded document. Returns a function that stops everything (observers, listeners, an adaptation
 * still in progress); call it before the frame reloads and when it goes away. Returns a no-op for a frame with no readable document.
 */
export function controlFrame(iframe: HTMLIFrameElement, handlers: FrameHandlers): () => void {
    const doc = iframe.contentDocument;
    const view = doc ? viewOf(doc) : null;
    const body = doc ? bodyOf(doc) : null;
    const wrapper = body?.firstElementChild;
    if (!doc || !view || !body || !wrapper) {
        return () => undefined;
    }
    let disposed = false;
    let reports = 0;
    const measure = () => {
        if (!disposed) {
            handlers.onHeight(measureFrameHeight(doc));
        }
    };
    const onKeyDown = (event: KeyboardEvent) => forwardKeyDown(event, iframe.ownerDocument);
    doc.addEventListener("keydown", onKeyDown);

    measure();
    // The frame's own ResizeObserver where it has one (the observations then run in its own rendering steps), else this window's.
    const Observer: typeof ResizeObserver | undefined = view.ResizeObserver ?? (typeof ResizeObserver === "undefined" ? undefined : ResizeObserver);
    let observer: ResizeObserver | undefined;
    const onWindowResize = () => measure();
    if (Observer) {
        observer = new Observer(() => {
            if (++reports > MAX_RESIZE_REPORTS) {
                observer?.disconnect();
                return;
            }
            measure();
        });
        for (const element of [wrapper, body, documentElementOf(doc)]) {
            observer.observe(element);
        }
    } else {
        window.addEventListener("resize", onWindowResize);
    }

    // Paper is not a dark surface: while the page is being printed the message goes back to the colours it was written with, and is adapted
    // again afterwards.
    let revert: (() => void) | undefined;
    let reapply: (() => void) | undefined;
    const onBeforePrint = () => revert?.();
    const onAfterPrint = () => reapply?.();
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);

    if (handlers.surface) {
        void adaptDocument(doc, handlers.surface, { isCancelled: () => disposed }).then((result) => {
            if (!disposed) {
                ({ revert, reapply } = result);
                measure();
                handlers.onReady(result);
            }
        });
    } else {
        handlers.onReady();
    }

    return () => {
        disposed = true;
        window.removeEventListener("beforeprint", onBeforePrint);
        window.removeEventListener("afterprint", onAfterPrint);
        observer?.disconnect();
        window.removeEventListener("resize", onWindowResize);
        doc.removeEventListener("keydown", onKeyDown);
    };
}
