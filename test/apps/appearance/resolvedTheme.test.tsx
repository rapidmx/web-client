// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockMatchMedia } from "../testUtils.js";
import {
    readResolvedTheme,
    useAppearance,
    useResolvedTheme,
    useSystemPrefersDark,
} from "../../../apps/shared/appearance/resolvedTheme.js";
import { INERT_APPEARANCE } from "../../../apps/shared/appearance/appearanceContext.js";

function Theme() {
    return <p data-testid="theme">{useResolvedTheme()}</p>;
}

function System() {
    return <p data-testid="system">{String(useSystemPrefersDark())}</p>;
}

beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
});

describe("readResolvedTheme", () => {
    it("is an explicit data-theme first", () => {
        mockMatchMedia(true);
        document.documentElement.setAttribute("data-theme", "light");
        expect(readResolvedTheme()).toBe("light");
        document.documentElement.setAttribute("data-theme", "dark");
        mockMatchMedia(false);
        expect(readResolvedTheme()).toBe("dark");
    });

    it("follows the operating system when there is no (valid) data-theme", () => {
        mockMatchMedia(true);
        expect(readResolvedTheme()).toBe("dark");
        document.documentElement.setAttribute("data-theme", "sepia");
        expect(readResolvedTheme()).toBe("dark");
        mockMatchMedia(false);
        expect(readResolvedTheme()).toBe("light");
    });

    it("is light where there is no matchMedia", () => {
        vi.stubGlobal("matchMedia", undefined);
        expect(readResolvedTheme()).toBe("light");
    });
});

describe("useResolvedTheme", () => {
    it("follows the operating system live", () => {
        const media = mockMatchMedia(false);
        render(<Theme />);
        expect(screen.getByTestId("theme")).toHaveTextContent("light");
        act(() => media.setMatches(true));
        expect(screen.getByTestId("theme")).toHaveTextContent("dark");
        act(() => media.setMatches(false));
        expect(screen.getByTestId("theme")).toHaveTextContent("light");
    });

    it("follows <html data-theme> as it changes, and lets it win over the system", async () => {
        mockMatchMedia(true);
        render(<Theme />);
        expect(screen.getByTestId("theme")).toHaveTextContent("dark");
        await act(async () => {
            document.documentElement.setAttribute("data-theme", "light");
        });
        expect(screen.getByTestId("theme")).toHaveTextContent("light");
        await act(async () => {
            document.documentElement.setAttribute("data-theme", "dark");
        });
        expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    });

    it("works without matchMedia, and stops listening when unmounted", () => {
        vi.stubGlobal("matchMedia", undefined);
        const { unmount } = render(<Theme />);
        expect(screen.getByTestId("theme")).toHaveTextContent("light");
        unmount();
    });
});

describe("useSystemPrefersDark", () => {
    it("reports only the media query, never data-theme", () => {
        const media = mockMatchMedia(false);
        document.documentElement.setAttribute("data-theme", "dark");
        render(<System />);
        expect(screen.getByTestId("system")).toHaveTextContent("false");
        act(() => media.setMatches(true));
        expect(screen.getByTestId("system")).toHaveTextContent("true");
    });

    it("is false without matchMedia", () => {
        vi.stubGlobal("matchMedia", undefined);
        render(<System />);
        expect(screen.getByTestId("system")).toHaveTextContent("false");
    });
});

describe("useAppearance outside a provider", () => {
    it("is inert: the defaults, and changes go nowhere", async () => {
        let api!: ReturnType<typeof useAppearance>;
        function Probe() {
            api = useAppearance();
            return null;
        }
        render(<Probe />);
        expect(api).toBe(INERT_APPEARANCE);
        expect(api.prefs).toEqual({ version: 1, mode: "system" });
        expect(api.isDefault).toBe(true);
        api.setPrefs({ mode: "dark" });
        api.clearError();
        await api.uploadBackground(new Blob(["x"]));
        await api.removeBackground();
        await api.reset();
        expect(api.prefs.mode).toBe("system");
    });
});
