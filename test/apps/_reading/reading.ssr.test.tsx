// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MessageBody from "../../../apps/shared/components/mail/reading/MessageBody.js";
import { ReadingPaneSkeleton, SubjectCard } from "../../../apps/shared/components/mail/reading/MessageCard.js";
import { prepareBodyHtml } from "../../../apps/shared/components/mail/reading/bodyHtml.js";
import { DEFAULT_SURFACES, readThemeSurface } from "../../../apps/shared/components/mail/reading/themeSurface.js";
import { isViewedOriginal } from "../../../apps/shared/components/mail/reading/viewOriginal.js";

// The pages are server-rendered: nothing the reading pane's modules do at import or first render may need a `window` or a `document`.
describe("the reading pane on the server", () => {
    it("has no window and no document to lean on", () => {
        expect(typeof window).toBe("undefined");
        expect(typeof document).toBe("undefined");
    });

    it("renders a body as its skeleton, with no request and no frame", () => {
        const html = renderToString(<MessageBody messageUid="m1" messageVersion={1} title="Hello" />);
        expect(html).toContain("Loading the message");
        expect(html).not.toContain("<iframe");
    });

    it("renders a body it was handed as its frame or text without touching the DOM", () => {
        const framed = renderToString(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "html", html: "<p>x</p>" }} />);
        expect(framed).toContain("<iframe");
        expect(framed).toContain("sandbox=");
        // Nothing to parse the message with here: the frame is empty rather than carrying an unsanitized body.
        expect(framed).not.toContain("<p>x</p>");
        const text = renderToString(<MessageBody messageUid="m1" messageVersion={1} title="Hello" content={{ kind: "text", text: "plain" }} />);
        expect(text).toContain("plain");
    });

    it("renders the cards' pieces", () => {
        expect(renderToString(<ReadingPaneSkeleton subject="Hi" messageCount={2} />)).toContain("2 messages");
        expect(renderToString(<SubjectCard subject="Hi" />)).toContain("<h1");
    });

    it("has the built-in colours, no choice made and an empty fragment for a message", () => {
        expect(readThemeSurface("dark")).toBe(DEFAULT_SURFACES.dark);
        expect(isViewedOriginal("m1")).toBe(false);
        expect(prepareBodyHtml("<p>x</p>")).toEqual({ status: "ok", html: "", declaresDarkSupport: false, inlineImages: 0 });
    });
});
