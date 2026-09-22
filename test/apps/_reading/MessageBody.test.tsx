// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";

const { adaptDocument } = vi.hoisted(() => ({ adaptDocument: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/reading/themeAdaptation.js", () => ({ adaptDocument }));

import MessageBody, { BodySkeleton } from "../../../apps/shared/components/mail/reading/MessageBody.js";
import { clearBodyContentCache } from "../../../apps/shared/components/mail/reading/bodyContent.js";
import { FRAME_SANDBOX } from "../../../apps/shared/components/mail/reading/frameDocument.js";

class FakeObserver {
    static instances: FakeObserver[] = [];
    disconnected = false;
    constructor(public callback: () => void) {
        FakeObserver.instances.push(this);
    }
    observe() {
        // Nothing to watch: the tests call the callback themselves.
    }
    disconnect() {
        this.disconnected = true;
    }
}

const RESULT = { elements: 4, written: 1, material: true, authoredCanvas: false, cancelled: false, revert: () => undefined, reapply: () => undefined };
let wrapperBottom = 240;

beforeEach(() => {
    FakeObserver.instances = [];
    wrapperBottom = 240;
    adaptDocument.mockResolvedValue(RESULT);
    vi.stubGlobal("ResizeObserver", FakeObserver);
});

afterEach(() => {
    clearBodyContentCache();
    adaptDocument.mockReset();
    document.documentElement.removeAttribute("data-theme");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const html = (body: string, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }) => new Response(body, { status: 200, headers });

/**
 * jsdom does not load a `srcdoc`: write what the browser would have loaded into the frame - which makes jsdom fire the frame's own `load` -
 * and lay it out as `wrapperBottom` says, since jsdom lays nothing out (the frame is another realm, so its elements are spied on
 * one by one).
 */
async function loadFrame(iframe: HTMLIFrameElement) {
    const doc = iframe.contentDocument!;
    const loaded = new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
    doc.open();
    doc.write(iframe.getAttribute("srcdoc")!);
    doc.close();
    vi.spyOn(doc.getElementById("rr-body")!, "getBoundingClientRect").mockImplementation(() => ({ bottom: wrapperBottom }) as DOMRect);
    vi.spyOn(iframe.contentWindow!, "getComputedStyle").mockImplementation(() => ({ marginBottom: "0px", paddingBottom: "0px", borderBottomWidth: "0px" }) as CSSStyleDeclaration);
    await act(async () => {
        await loaded;
    });
}

describe("BodySkeleton", () => {
    it("is a live region that says the message is loading", () => {
        render(<BodySkeleton />);
        expect(screen.getByRole("status")).toHaveTextContent("Loading the message");
    });
});

describe("MessageBody loading", () => {
    it("shows the skeleton at once, asks the server for the sanitized content with the reader's credentials, then the message", async () => {
        let respond!: (response: Response) => void;
        const fetchMock = mockFetch(() => new Promise((resolve) => (respond = resolve)));
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" />);
        expect(screen.getByRole("status")).toHaveTextContent("Loading the message");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1/content", expect.objectContaining({ credentials: "include" }));
        respond(html("<p>Body</p>"));
        const frame = await screen.findByTitle("Hello");
        expect(frame).toHaveAttribute("srcdoc", expect.stringContaining("<p>Body</p>"));
    });

    it("renders a plain-text body as text - escaped, never as markup - in the theme's own colours", async () => {
        mockFetch(() => new Response("<b>hi</b>\nsecond line", { headers: { "content-type": "text/plain; charset=utf-8" } }));
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" />);
        const body = await screen.findByLabelText("Hello");
        expect(body.tagName).toBe("PRE");
        expect(body.textContent).toBe("<b>hi</b>\nsecond line");
        expect(body.querySelector("b")).toBeNull();
        expect(body).toHaveClass("text-text");
        expect(screen.queryByTitle("Hello")).not.toBeInTheDocument();
    });

    it("says why it could not load the message and tries again on request", async () => {
        const user = userEvent.setup();
        const fetchMock = mockFetch(() =>
            fetchMock.mock.calls.length === 1 ? jsonResponse(500, { message: "The mail store is down." }) : html("<p>Second try</p>"),
        );
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" />);
        expect(await screen.findByText("The mail store is down.")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByTitle("Hello")).toHaveAttribute("srcdoc", expect.stringContaining("Second try"));
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("falls back to the status text, then to a generic message, when the server gives none - and for a network failure", async () => {
        mockFetch(() => new Response("nope", { status: 502, statusText: "Bad Gateway", headers: { "content-type": "text/plain" } }));
        const first = render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" />);
        expect(await screen.findByText("Bad Gateway")).toBeInTheDocument();
        first.unmount();

        mockFetch(() => jsonResponse(404, { error: "No such message." }));
        const second = render(<MessageBody messageUid="m2" messageVersion={1} title="Hello" />);
        expect(await screen.findByText("No such message.")).toBeInTheDocument();
        second.unmount();

        mockFetch(() => new Response("x", { status: 500, statusText: "", headers: { "content-type": "application/json" } }));
        const third = render(<MessageBody messageUid="m3" messageVersion={1} title="Hello" />);
        expect(await screen.findByText("Could not load this message.")).toBeInTheDocument();
        third.unmount();

        mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
        render(<MessageBody messageUid="m4" messageVersion={1} title="Hello" />);
        expect(await screen.findByText("Could not load this message.")).toBeInTheDocument();
    });

    it("stops caring about a request that was superseded: no error is shown for an aborted one", async () => {
        let signal: AbortSignal | undefined;
        mockFetch((_url, init) => {
            signal = init.signal as AbortSignal;
            return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
        });
        const { unmount } = render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" />);
        unmount();
        expect(signal!.aborted).toBe(true);
        await act(async () => undefined);
    });

    it("remembers a body for the session, so a message opened again does not ask the server twice", async () => {
        const fetchMock = mockFetch(() => html("<p>Once</p>"));
        const first = render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" />);
        await screen.findByTitle("Hello");
        first.unmount();
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" />);
        expect(screen.getByTitle("Hello")).toHaveAttribute("srcdoc", expect.stringContaining("Once"));
        await act(async () => undefined);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("picks a remembered body up when the message it shows changes, and asks again for a new version", async () => {
        const fetchMock = mockFetch((url) => html(`<p>${url}</p>`));
        const { rerender } = render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" />);
        await screen.findByTitle("Hello");
        rerender(<MessageBody messageUid="m2" messageVersion={1} title="Hello" />);
        await waitFor(() => expect(screen.getByTitle("Hello")).toHaveAttribute("srcdoc", expect.stringContaining("/api/mail/messages/m2/content")));
        rerender(<MessageBody messageUid="m1" messageVersion={1} title="Hello" />);
        expect(screen.getByTitle("Hello")).toHaveAttribute("srcdoc", expect.stringContaining("/api/mail/messages/m1/content"));
        expect(fetchMock).toHaveBeenCalledTimes(2);
        rerender(<MessageBody messageUid="m1" messageVersion={2} title="Hello" />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    });

    it("does not ask the server for a body it was handed (decrypted or verified content)", async () => {
        const fetchMock = mockFetch(() => html("never"));
        const { rerender } = render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "html", html: "<p>Secret</p>" }} />);
        expect(screen.getByTitle("Hello")).toHaveAttribute("srcdoc", expect.stringContaining("Secret"));
        rerender(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "text", text: "plain secret" }} />);
        expect(screen.getByLabelText("Hello")).toHaveTextContent("plain secret");
        await act(async () => undefined);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("MessageBody frame", () => {
    it("is a sandboxed frame that can never run script, holding the sanitized message behind the CSP", async () => {
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "html", html: '<p>Hi</p><script>window.__pwned=1</script><img src=x onerror="window.__pwned=1"><a href="javascript:x()">j</a>' }} />);
        const frame = screen.getByTitle("Hello");
        expect(frame).toHaveAttribute("sandbox", FRAME_SANDBOX);
        expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
        expect(frame).toHaveAttribute("scrolling", "no");
        expect(frame).not.toHaveAttribute("src");
        const srcdoc = frame.getAttribute("srcdoc")!;
        expect(srcdoc).toContain("<p>Hi</p>");
        expect(srcdoc).not.toMatch(/<script|onerror|javascript:/i);
        expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("<p>Hi</p>"));
        expect(srcdoc).toContain("script-src 'none'");
    });

    it("keeps the skeleton until the document has loaded and been adapted, then shows the frame at the height of its content", async () => {
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "html", html: "<p>Hi</p>" }} />);
        const frame = screen.getByTitle("Hello");
        expect(screen.getByRole("status")).toBeInTheDocument();
        expect(frame.className).toContain("invisible");
        await loadFrame(frame);
        await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
        expect(frame.className).not.toContain("invisible");
        expect(frame.style.height).toBe("240px");
    });

    it("follows the content's height as it changes, and lets go of the document when it is gone", async () => {
        const { unmount } = render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "html", html: "<p>Hi</p>" }} />);
        const frame = screen.getByTitle("Hello");
        await loadFrame(frame);
        wrapperBottom = 500;
        // (jsdom announces a frame's load twice when the document is written into it; the last controller is the live one.)
        const observer = FakeObserver.instances.at(-1)!;
        await act(async () => observer.callback());
        expect(frame.style.height).toBe("500px");
        unmount();
        expect(observer.disconnected).toBe(true);
    });

    it("adapts a message to the theme by default and says whether 'view original' would change anything", async () => {
        const onAdaptable = vi.fn();
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "html", html: "<p>Hi</p>" }} onAdaptable={onAdaptable} />);
        await loadFrame(screen.getByTitle("Hello"));
        expect(adaptDocument).toHaveBeenCalled();
        expect(adaptDocument.mock.calls.at(-1)![1]).toMatchObject({ dark: false });
        await waitFor(() => expect(onAdaptable).toHaveBeenCalledWith(true));
        // A message the theme leaves as it is offers nothing to toggle.
        adaptDocument.mockResolvedValue({ ...RESULT, material: false });
        render(<MessageBody messageUid="m2" messageVersion={1} title="Second" content={{ kind: "html", html: "<p>Hi</p>" }} onAdaptable={onAdaptable} />);
        await loadFrame(screen.getByTitle("Second"));
        await waitFor(() => expect(onAdaptable).toHaveBeenCalledWith(false));
    });

    it("frames a message whose own background is the canvas, and leaves one on the theme surface unframed", async () => {
        adaptDocument.mockResolvedValue({ ...RESULT, authoredCanvas: true });
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "html", html: "<p>Hi</p>" }} />);
        const frame = screen.getByTitle("Hello");
        await loadFrame(frame);
        await waitFor(() => expect(frame.className).toContain("ring-1"));

        adaptDocument.mockResolvedValue({ ...RESULT, authoredCanvas: false });
        render(<MessageBody messageUid="m2" messageVersion={1} title="Plain" content={{ kind: "html", html: "<p>Hi</p>" }} />);
        const plain = screen.getByTitle("Plain");
        await loadFrame(plain);
        await waitFor(() => expect(screen.queryAllByRole("status")).toHaveLength(0));
        expect(plain.className).not.toContain("ring-1");
    });

    it("shows a message as authored when asked - a light document with the browser's margin on a white canvas, adapting nothing", async () => {
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" original content={{ kind: "html", html: "<p>Hi</p>" }} />);
        const frame = screen.getByTitle("Hello");
        const srcdoc = frame.getAttribute("srcdoc")!;
        expect(srcdoc).toContain(":where(body){margin:8px}");
        expect(srcdoc).not.toContain("rgb(1, 2, 3)");
        expect(frame.parentElement!.style.backgroundColor).toBe("rgb(255, 255, 255)");
        await loadFrame(frame);
        expect(adaptDocument).not.toHaveBeenCalled();
        await waitFor(() => expect(frame.className).toContain("ring-1"));
    });

    it("shows the message on the theme's opaque surface, whatever the card's own translucency", () => {
        document.documentElement.setAttribute("data-theme", "dark");
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "html", html: "<p>Hi</p>" }} />);
        expect(screen.getByTitle("Hello").parentElement!.style.backgroundColor).toBe("rgb(27, 32, 34)");
    });

    it("gives a message that carries its own dark styles those styles - it is neither adapted nor offered 'view original'", async () => {
        document.documentElement.setAttribute("data-theme", "dark");
        const onAdaptable = vi.fn();
        render(
            <MessageBody
                messageUid="m1"
                messageVersion={1}
                title="Hello"
                onAdaptable={onAdaptable}
                content={{ kind: "html", html: '<meta name="color-scheme" content="light dark"><style>@media (prefers-color-scheme: dark){p{color:#eee}}</style><p>Hi</p>' }}
            />,
        );
        const frame = screen.getByTitle("Hello");
        const srcdoc = frame.getAttribute("srcdoc")!;
        expect(srcdoc).toContain(":where(html){color-scheme:dark;background-color:rgb(27, 32, 34);color:rgb(238, 242, 243)}");
        expect(srcdoc).toContain("@media (min-width: 0px)");
        expect(onAdaptable).toHaveBeenCalledWith(false);
        await loadFrame(frame);
        expect(adaptDocument).not.toHaveBeenCalled();
        // Still native when the reader asked for the original: its own styles are the original.
        render(<MessageBody messageUid="m2" messageVersion={1} title="Second" original content={{ kind: "html", html: '<meta name="color-scheme" content="dark"><p>Hi</p>' }} />);
        expect(screen.getByTitle("Second").getAttribute("srcdoc")).toContain("color-scheme:dark");
    });

    it("is a different document - and adapts afresh - when the theme changes", async () => {
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "html", html: "<p>Hi</p>" }} />);
        const before = screen.getByTitle("Hello").getAttribute("srcdoc")!;
        expect(before).toContain(":where(html){color-scheme:light}");
        await loadFrame(screen.getByTitle("Hello"));
        await act(async () => {
            document.documentElement.setAttribute("data-theme", "dark");
        });
        await waitFor(() => expect(screen.getByTitle("Hello").getAttribute("srcdoc")).toContain(":where(html){color-scheme:dark}"));
        const observersBefore = FakeObserver.instances.length;
        await loadFrame(screen.getByTitle("Hello"));
        expect(adaptDocument.mock.calls.at(-1)![1]).toMatchObject({ dark: true });
        // The previous document's controller was stopped before the new one started.
        expect(FakeObserver.instances.length).toBeGreaterThan(observersBefore);
        expect(FakeObserver.instances.slice(0, observersBefore).every((observer) => observer.disconnected)).toBe(true);
    });

    it("resolves an inline image of a server message to this server's attachment URL and allows exactly that in the CSP", () => {
        const attachments = [{ uid: "a1", contentId: "logo@x", filename: "logo.png", mimeType: "image/png", sizeBytes: 10, isInline: true }] as never;
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" attachments={attachments} content={{ kind: "html", html: '<img src="cid:logo@x"><img src="cid:other@x">' }} />);
        const srcdoc = screen.getByTitle("Hello").getAttribute("srcdoc")!;
        expect(srcdoc).toContain(`src="${window.location.origin}/api/mail/attachments/a1/content"`);
        expect(srcdoc).toContain(`img-src data: ${window.location.origin}/api/mail/attachments/;`);
        expect(srcdoc.match(/<img/g)).toHaveLength(2);
        expect(srcdoc.match(/ src=/g)).toHaveLength(1);
    });

    it("resolves an inline image of a decrypted message from the part inside it, as an embedded image", () => {
        const parts = [{ contentType: "image/png", disposition: "inline", contentId: "logo@x", decode: () => new Uint8Array([137, 80, 78, 71]) }] as never;
        render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" inlineParts={parts} content={{ kind: "html", html: '<img src="cid:logo@x">' }} />);
        const srcdoc = screen.getByTitle("Hello").getAttribute("srcdoc")!;
        expect(srcdoc).toContain('src="data:image/png;base64,iVBORw=="');
        expect(srcdoc).toContain("img-src data:;");
    });

    it("offers a message too large to show on its own page when the server has it, and just says so when it does not", () => {
        const huge = "x".repeat(1_600_000);
        const first = render(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "html", html: huge }} />);
        expect(screen.getByText(/too large to show here/)).toBeInTheDocument();
        expect(screen.queryByRole("link")).not.toBeInTheDocument();
        first.unmount();

        mockFetch(() => html(huge));
        render(<MessageBody messageUid="m2" messageVersion={1} title="Hello" />);
        return screen.findByRole("link", { name: "Open it in its own tab" }).then((link) => {
            expect(link).toHaveAttribute("href", "/api/mail/messages/m2/content");
            expect(link).toHaveAttribute("target", "_blank");
            expect(link).toHaveAttribute("rel", "noopener noreferrer");
        });
    });
});
