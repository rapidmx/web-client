// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { htmlToPlainText, parseEventDescription, sanitizeEventDescriptionHtml } from "../../../lib/calendar/eventDescription.js";

describe("eventDescription without a DOM (server-side rendering)", () => {
    it("reads nothing, and never hands the input back", () => {
        expect(typeof DOMParser).toBe("undefined");
        expect(parseEventDescription("<script>alert(1)</script><p>x</p>")).toEqual([]);
        expect(sanitizeEventDescriptionHtml("<script>alert(1)</script><p>x</p>")).toBe("");
        expect(htmlToPlainText("<p>x</p>")).toBe("");
    });
});
