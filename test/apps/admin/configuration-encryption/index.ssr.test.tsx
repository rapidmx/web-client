// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Forced onto the plain `node` environment, so `window` is genuinely undefined here, the way it is under real SSR.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ConfigurationEncryptionPage from "../../../../apps/admin/configuration-encryption/index.js";

describe("ConfigurationEncryptionPage SSR guard (no window)", () => {
    it("renders without throwing when there is no window global", () => {
        expect(typeof window).toBe("undefined");
        expect(() => renderToStaticMarkup(<ConfigurationEncryptionPage userUid="admin-1" />)).not.toThrow();
    });
});
