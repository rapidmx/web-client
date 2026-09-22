// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeSurface } from "../../../apps/shared/components/mail/reading/color.js";

const { adaptDocument } = vi.hoisted(() => ({ adaptDocument: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/reading/themeAdaptation.js", () => ({ adaptDocument }));

import {
    MAX_FRAME_HEIGHT,
    MAX_RESIZE_REPORTS,
    controlFrame,
    forwardKeyDown,
    measureFrameHeight,
} from "../../../apps/shared/components/mail/reading/frameControl.js";

const SURFACE: ThemeSurface = { background: { r: 27, g: 32, b: 34 }, text: { r: 238, g: 242, b: 243 }, link: { r: 45, g: 212, b: 191 }, dark: true };

const iframes: HTMLIFrameElement[] = [];
afterEach(() => {
    for (const iframe of iframes.splice(0)) iframe.remove();
    vi.unstubAllGlobals();
    adaptDocument.mockReset();
});

/** A frame with a loaded document whose wrapper reports `bottom`, and whose body has `bodyStyle`. */
function loadedFrame(options: { bottom?: number; scrollY?: number; bodyStyle?: Record<string, string>; observer?: boolean } = {}) {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    iframes.push(iframe);
    const doc = iframe.contentDocument!;
    doc.open();
    doc.write('<!doctype html><html><body><div id="rr-body"><p>x</p></div></body></html>');
    doc.close();
    const view = iframe.contentWindow!;
    const wrapper = doc.getElementById("rr-body")!;
    const state = { bottom: options.bottom ?? 120, scrollY: options.scrollY ?? 0 };
    vi.spyOn(wrapper, "getBoundingClientRect").mockImplementation(() => ({ bottom: state.bottom }) as DOMRect);
    Object.defineProperty(view, "scrollY", { get: () => state.scrollY, configurable: true });
    const bodyStyle = { marginBottom: "0px", paddingBottom: "0px", borderBottomWidth: "0px", ...options.bodyStyle };
    vi.spyOn(view, "getComputedStyle").mockImplementation(() => bodyStyle as unknown as CSSStyleDeclaration);
    return { iframe, doc, view, wrapper, state };
}

class FakeObserver {
    static instances: FakeObserver[] = [];
    observed: Element[] = [];
    disconnected = false;
    constructor(public callback: () => void) {
        FakeObserver.instances.push(this);
    }
    observe(element: Element) {
        this.observed.push(element);
    }
    disconnect() {
        this.disconnected = true;
    }
    fire() {
        this.callback();
    }
}

beforeEach(() => {
    FakeObserver.instances = [];
});

describe("measureFrameHeight", () => {
    it("is the bottom of the wrapper plus the body's trailing margin, padding and border, rounded up", () => {
        const { doc } = loadedFrame({ bottom: 100.2, scrollY: 4, bodyStyle: { marginBottom: "8px", paddingBottom: "2px", borderBottomWidth: "1px" } });
        expect(measureFrameHeight(doc)).toBe(116);
    });

    it("counts nothing it cannot read as a size", () => {
        const { doc } = loadedFrame({ bottom: 50, bodyStyle: { marginBottom: "auto", paddingBottom: "", borderBottomWidth: "medium" } });
        expect(measureFrameHeight(doc)).toBe(50);
    });

    it("never goes below nothing, nor above the cap a hostile height could push it to", () => {
        expect(measureFrameHeight(loadedFrame({ bottom: -30 }).doc)).toBe(0);
        expect(measureFrameHeight(loadedFrame({ bottom: 100_000_000 }).doc)).toBe(MAX_FRAME_HEIGHT);
    });

    it("is nothing for a document with no window or no wrapper", () => {
        expect(measureFrameHeight(document.implementation.createHTMLDocument("x"))).toBe(0);
        const { doc } = loadedFrame();
        doc.body.innerHTML = "";
        expect(measureFrameHeight(doc)).toBe(0);
    });
});

describe("forwardKeyDown", () => {
    it("re-sends a key to the app's document with its modifiers, and prevents the frame's own action when the app took it", () => {
        const received: KeyboardEvent[] = [];
        const listener = (event: KeyboardEvent) => {
            received.push(event);
            event.preventDefault();
        };
        document.addEventListener("keydown", listener);
        const original = new KeyboardEvent("keydown", { key: "r", code: "KeyR", ctrlKey: true, shiftKey: true, altKey: true, metaKey: true, repeat: true, cancelable: true });
        forwardKeyDown(original, document);
        document.removeEventListener("keydown", listener);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ key: "r", code: "KeyR", ctrlKey: true, shiftKey: true, altKey: true, metaKey: true, repeat: true });
        expect(received[0].bubbles).toBe(true);
        expect(original.defaultPrevented).toBe(true);
    });

    it("leaves the key alone when nothing in the app wanted it", () => {
        const original = new KeyboardEvent("keydown", { key: "x", cancelable: true });
        forwardKeyDown(original, document);
        expect(original.defaultPrevented).toBe(false);
    });
});

describe("controlFrame", () => {
    it("reports the height at once, follows the document with a ResizeObserver of the frame's own, and stops when told", () => {
        const { iframe, view, wrapper, doc, state } = loadedFrame({ bottom: 90 });
        (view as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeObserver;
        const onHeight = vi.fn();
        const onReady = vi.fn();
        const stop = controlFrame(iframe, { onHeight, onReady });
        expect(onHeight).toHaveBeenLastCalledWith(90);
        // With nothing to adapt to, the document is ready straight away, with no adaptation to report.
        expect(onReady).toHaveBeenCalledWith();
        const [observer] = FakeObserver.instances;
        expect(observer.observed).toEqual([wrapper, doc.body, doc.documentElement]);
        state.bottom = 250;
        observer.fire();
        expect(onHeight).toHaveBeenLastCalledWith(250);
        stop();
        expect(observer.disconnected).toBe(true);
        state.bottom = 400;
        observer.fire();
        expect(onHeight).toHaveBeenLastCalledWith(250);
    });

    it("falls back to this window's ResizeObserver, and to the window's resize event without one", () => {
        const first = loadedFrame({ bottom: 40 });
        vi.stubGlobal("ResizeObserver", FakeObserver);
        controlFrame(first.iframe, { onHeight: vi.fn(), onReady: vi.fn() });
        expect(FakeObserver.instances).toHaveLength(1);

        vi.stubGlobal("ResizeObserver", undefined);
        const second = loadedFrame({ bottom: 60 });
        const onHeight = vi.fn();
        const stop = controlFrame(second.iframe, { onHeight, onReady: vi.fn() });
        second.state.bottom = 80;
        window.dispatchEvent(new Event("resize"));
        expect(onHeight).toHaveBeenLastCalledWith(80);
        stop();
        second.state.bottom = 99;
        window.dispatchEvent(new Event("resize"));
        expect(onHeight).toHaveBeenLastCalledWith(80);
    });

    it("stops listening to a document that keeps resizing itself", () => {
        const { iframe, view } = loadedFrame();
        (view as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeObserver;
        const onHeight = vi.fn();
        controlFrame(iframe, { onHeight, onReady: vi.fn() });
        const [observer] = FakeObserver.instances;
        for (let i = 0; i < MAX_RESIZE_REPORTS; i++) observer.fire();
        expect(observer.disconnected).toBe(false);
        onHeight.mockClear();
        observer.fire();
        expect(observer.disconnected).toBe(true);
        expect(onHeight).not.toHaveBeenCalled();
    });

    it("adapts to the surface before it says the document is ready, then measures again", async () => {
        const { iframe, state } = loadedFrame({ bottom: 70 });
        vi.stubGlobal("ResizeObserver", FakeObserver);
        const result = { elements: 3, written: 1, material: true, authoredCanvas: false, cancelled: false, revert: vi.fn(), reapply: vi.fn() };
        let finish!: (value: typeof result) => void;
        adaptDocument.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const onHeight = vi.fn();
        const onReady = vi.fn();
        controlFrame(iframe, { surface: SURFACE, onHeight, onReady });
        expect(adaptDocument).toHaveBeenCalledWith(iframe.contentDocument, SURFACE, expect.objectContaining({ isCancelled: expect.any(Function) }));
        expect(onReady).not.toHaveBeenCalled();
        state.bottom = 75;
        finish(result);
        await vi.waitFor(() => expect(onReady).toHaveBeenCalledWith(result));
        expect(onHeight).toHaveBeenLastCalledWith(75);
    });

    it("puts the message's own colours back while the page is printed, and the adapted ones after, and stops listening when stopped", async () => {
        const { iframe } = loadedFrame();
        vi.stubGlobal("ResizeObserver", FakeObserver);
        const revert = vi.fn();
        const reapply = vi.fn();
        adaptDocument.mockResolvedValue({ elements: 1, written: 1, material: true, authoredCanvas: false, cancelled: false, revert, reapply });
        const onReady = vi.fn();
        const stop = controlFrame(iframe, { surface: SURFACE, onHeight: vi.fn(), onReady });
        // Printing before the adaptation has finished has nothing to put back yet.
        window.dispatchEvent(new Event("beforeprint"));
        window.dispatchEvent(new Event("afterprint"));
        expect(revert).not.toHaveBeenCalled();
        expect(reapply).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(onReady).toHaveBeenCalled());

        window.dispatchEvent(new Event("beforeprint"));
        expect(revert).toHaveBeenCalledTimes(1);
        expect(reapply).not.toHaveBeenCalled();
        window.dispatchEvent(new Event("afterprint"));
        expect(reapply).toHaveBeenCalledTimes(1);

        stop();
        window.dispatchEvent(new Event("beforeprint"));
        expect(revert).toHaveBeenCalledTimes(1);
    });

    it("says nothing when it was stopped while the adaptation ran", async () => {
        const { iframe } = loadedFrame();
        vi.stubGlobal("ResizeObserver", FakeObserver);
        let finish!: (value: unknown) => void;
        adaptDocument.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const onReady = vi.fn();
        const stop = controlFrame(iframe, { surface: SURFACE, onHeight: vi.fn(), onReady });
        const { isCancelled } = adaptDocument.mock.calls[0][2];
        expect(isCancelled()).toBe(false);
        stop();
        expect(isCancelled()).toBe(true);
        finish({ cancelled: true });
        await Promise.resolve();
        await Promise.resolve();
        expect(onReady).not.toHaveBeenCalled();
    });

    it("hands a key pressed inside the frame to the app", () => {
        const { iframe, doc } = loadedFrame();
        vi.stubGlobal("ResizeObserver", FakeObserver);
        const stop = controlFrame(iframe, { onHeight: vi.fn(), onReady: vi.fn() });
        const seen: string[] = [];
        const listener = (event: KeyboardEvent) => seen.push(event.key);
        document.addEventListener("keydown", listener);
        doc.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
        stop();
        doc.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
        document.removeEventListener("keydown", listener);
        expect(seen).toEqual(["j"]);
    });

    it("does nothing for a frame with no readable document", () => {
        const detached = document.createElement("iframe");
        const onHeight = vi.fn();
        const stop = controlFrame(detached, { onHeight, onReady: vi.fn() });
        expect(onHeight).not.toHaveBeenCalled();
        expect(() => stop()).not.toThrow();

        const { iframe, doc } = loadedFrame();
        doc.body.innerHTML = "";
        controlFrame(iframe, { onHeight, onReady: vi.fn() });
        expect(onHeight).not.toHaveBeenCalled();
    });
});
