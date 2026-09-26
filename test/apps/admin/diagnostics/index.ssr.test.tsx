// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Forced onto the plain `node` environment (rather than the `jsdom` environment the rest of
// `test/apps/**` uses) via the `@vitest-environment` docblock above, so `window` and `document` are genuinely
// undefined here, the way they are under real SSR.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DiagnosticsPage from "../../../../apps/admin/diagnostics/index.js";
import DiagnosticsManager from "../../../../apps/shared/components/admin/diagnostics/DiagnosticsManager.js";
import { logsUrl } from "../../../../apps/shared/components/admin/diagnostics/logClient.js";

describe("DiagnosticsPage SSR guard (no window)", () => {
    it("renders without throwing when there is no window or document", () => {
        expect(typeof window).toBe("undefined");
        expect(typeof document).toBe("undefined");
        expect(() => renderToStaticMarkup(<DiagnosticsPage userUid="admin-1" />)).not.toThrow();
    });

    it("renders the diagnostics page itself, on its first tab, without opening a stream or polling", () => {
        const html = renderToStaticMarkup(<DiagnosticsManager />);
        expect(html).toContain("Diagnostics");
        expect(html).toContain('aria-selected="true"');
    });

    it("has no log stream URL without a page origin", () => {
        expect(logsUrl()).toBeUndefined();
    });
});
