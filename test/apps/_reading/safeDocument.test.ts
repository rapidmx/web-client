// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { bodyOf, documentElementOf, viewOf } from "../../../apps/shared/components/mail/reading/safeDocument.js";

describe("safeDocument", () => {
    it("answers with the document's real body, root and window", () => {
        const iframe = document.createElement("iframe");
        document.body.appendChild(iframe);
        const doc = iframe.contentDocument!;
        expect(bodyOf(doc)).toBe(doc.body);
        expect(documentElementOf(doc)).toBe(doc.documentElement);
        expect(viewOf(doc)).toBe(iframe.contentWindow);
        iframe.remove();
    });

    it("answers with the real thing whatever a hostile document defines under those names", () => {
        const doc = document.implementation.createHTMLDocument("x");
        const decoy = doc.createElement("img");
        // What `<img name="body">` does on a Document: a property that overrides the built-in one.
        Object.defineProperty(doc, "body", { value: decoy, configurable: true });
        Object.defineProperty(doc, "documentElement", { value: decoy, configurable: true });
        Object.defineProperty(doc, "defaultView", { value: decoy, configurable: true });
        expect(bodyOf(doc)).not.toBe(decoy);
        expect(bodyOf(doc)!.localName).toBe("body");
        expect(documentElementOf(doc).localName).toBe("html");
        expect(viewOf(doc)).toBeNull();
    });
});
