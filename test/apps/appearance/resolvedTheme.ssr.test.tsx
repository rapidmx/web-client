// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readResolvedTheme, useResolvedTheme, useSystemPrefersDark } from "../../../apps/shared/appearance/resolvedTheme.js";

function Probe() {
    return (
        <p>
            {useResolvedTheme()} {String(useSystemPrefersDark())}
        </p>
    );
}

describe("the theme hooks without a DOM", () => {
    it("say light, and not dark, on the server", () => {
        expect(typeof document).toBe("undefined");
        expect(readResolvedTheme()).toBe("light");
        expect(renderToStaticMarkup(<Probe />)).toBe("<p>light false</p>");
    });
});
