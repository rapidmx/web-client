///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_ENVIRONMENT, currentEnvironment, isElectronClient, isMacPlatform } from "../../../apps/shared/keyboard/platform.js";

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as { rapidmx?: unknown }).rapidmx;
});

describe("isMacPlatform", () => {
    it("reads navigator.platform", () => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
        expect(isMacPlatform()).toBe(true);
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("iPad");
        expect(isMacPlatform()).toBe(true);
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
        expect(isMacPlatform()).toBe(false);
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Linux x86_64");
        expect(isMacPlatform()).toBe(false);
    });

    it("prefers navigator.userAgentData where the browser has it", () => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
        vi.stubGlobal("navigator", { platform: "Win32", userAgentData: { platform: "macOS" } });
        expect(isMacPlatform()).toBe(true);
    });

    it("is false with no platform to read", () => {
        vi.stubGlobal("navigator", {});
        expect(isMacPlatform()).toBe(false);
    });

    it("is false where there is no navigator (the server)", () => {
        vi.stubGlobal("navigator", undefined);
        expect(isMacPlatform()).toBe(false);
    });
});

describe("isElectronClient", () => {
    it("is true only where the desktop client's preload exposed window.rapidmx", () => {
        expect(isElectronClient()).toBe(false);
        (window as { rapidmx?: unknown }).rapidmx = { getConfig: () => undefined };
        expect(isElectronClient()).toBe(true);
    });

    it("is false where there is no window (the server)", () => {
        vi.stubGlobal("window", undefined);
        expect(isElectronClient()).toBe(false);
    });
});

describe("currentEnvironment", () => {
    it("combines both", () => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
        (window as { rapidmx?: unknown }).rapidmx = {};
        expect(currentEnvironment()).toEqual({ mac: true, electron: true });
    });

    it("has a fixed server-side environment for the first render", () => {
        expect(SERVER_ENVIRONMENT).toEqual({ mac: false, electron: false });
    });
});
