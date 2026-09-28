// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe("messageBodySanitizer without a usable DOM", () => {
    it("returns an empty string rather than the unsanitized input when there is no window", async () => {
        const { sanitizeMessageBodyHtml, sanitizeQuotedHtml } = await import("../../../lib/mail/messageBodySanitizer.js");
        expect(sanitizeMessageBodyHtml("<p>Hi</p><script>evil()</script>")).toBe("");
        expect(sanitizeQuotedHtml("<p>Hi</p><script>evil()</script>")).toBe("");
    });

    it("returns an empty string when DOMPurify can't run in the window it's given", async () => {
        vi.stubGlobal("window", {});
        const { sanitizeMessageBodyHtml } = await import("../../../lib/mail/messageBodySanitizer.js");
        expect(sanitizeMessageBodyHtml("<p>Hi</p>")).toBe("");
    });
});
