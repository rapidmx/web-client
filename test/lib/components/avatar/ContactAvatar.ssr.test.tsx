// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// On the plain `node` environment there is no `window`, `localStorage` or `IntersectionObserver`, the way it is under real SSR: the server
// (and the first client render, for hydration) always renders initials, as the Gravatar preference is off until the browser says otherwise.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ContactAvatar from "../../../../lib/components/avatar/ContactAvatar.js";
import GravatarSetting from "../../../../apps/shared/components/settings/GravatarSetting.js";

describe("SSR (no window)", () => {
    it("renders initials for an avatar with an address, never a Gravatar", () => {
        expect(typeof window).toBe("undefined");
        const html = renderToStaticMarkup(<ContactAvatar displayName="Jane Doe" email="jane@example.com" />);
        expect(html).toContain("JD");
        expect(html).not.toContain("<img");
    });

    it("renders the Gravatar setting unchecked", () => {
        expect(renderToStaticMarkup(<GravatarSetting />)).not.toContain("checked");
    });
});
