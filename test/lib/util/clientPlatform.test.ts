// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientPlatform, isConstrainedConnection } from "../../../lib/util/clientPlatform.js";

function stubNavigator(fields: Record<string, unknown>) {
    vi.stubGlobal("navigator", { ...fields });
}

afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as { rapidmx?: unknown }).rapidmx;
});

describe("clientPlatform", () => {
    it("is desktop under a native host, unless the host says it is on a phone", () => {
        (window as { rapidmx?: unknown }).rapidmx = { getConfig: vi.fn() };
        expect(clientPlatform()).toBe("desktop");
        (window as { rapidmx?: unknown }).rapidmx = { getConfig: vi.fn(), formFactor: "mobile" };
        expect(clientPlatform()).toBe("mobile");
    });

    it("tells a phone browser from a computer's, by client hints first, then the user agent", () => {
        stubNavigator({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" });
        expect(clientPlatform()).toBe("mobile");
        stubNavigator({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
        expect(clientPlatform()).toBe("web");
        stubNavigator({ userAgent: "Mozilla/5.0 (Linux; Android 15) Mobile", userAgentData: { mobile: false } });
        expect(clientPlatform()).toBe("web");
        stubNavigator({ userAgentData: { mobile: true } });
        expect(clientPlatform()).toBe("mobile");
        stubNavigator({});
        expect(clientPlatform()).toBe("web");
    });

    it("is web where there is no browser at all", () => {
        vi.stubGlobal("navigator", undefined);
        vi.stubGlobal("window", undefined);
        expect(clientPlatform()).toBe("web");
        expect(isConstrainedConnection()).toBe(false);
    });
});

describe("isConstrainedConnection", () => {
    it("is cellular or data saver, and unconstrained when the browser doesn't say", () => {
        stubNavigator({ connection: { type: "cellular" } });
        expect(isConstrainedConnection()).toBe(true);
        stubNavigator({ connection: { type: "wifi", saveData: true } });
        expect(isConstrainedConnection()).toBe(true);
        stubNavigator({ connection: { type: "wifi" } });
        expect(isConstrainedConnection()).toBe(false);
        stubNavigator({});
        expect(isConstrainedConnection()).toBe(false);
    });
});
