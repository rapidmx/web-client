// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Forced onto the plain `node` environment (rather than the `jsdom` environment the rest of
// `test/apps/**` uses) via the `@vitest-environment` docblock above, so `window` is genuinely undefined
// here, the way it is under real SSR.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ContactDetailPage from "../../../apps/www/contacts/[uid].js";

describe("ContactDetailPage SSR guard (no window)", () => {
    it("renders without throwing when there is no window global", () => {
        expect(typeof window).toBe("undefined");
        expect(() => renderToStaticMarkup(<ContactDetailPage userUid="u1" params={{ uid: "c1" }} />)).not.toThrow();
    });
});
