// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import ThemeSwitch from "../../../apps/shared/components/layout/ThemeSwitch.js";
import UserMenu from "../../../apps/shared/components/layout/UserMenu.js";
import AppearanceProvider from "../../../apps/shared/appearance/AppearanceProvider.js";
import { AppearanceContext, INERT_APPEARANCE, type AppearanceApi } from "../../../apps/shared/appearance/appearanceContext.js";
import { useResolvedTheme } from "../../../apps/shared/appearance/resolvedTheme.js";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
});

function fakeApi(mode: "system" | "light" | "dark", setPrefs = vi.fn()): AppearanceApi {
    return { ...INERT_APPEARANCE, prefs: { version: 1, mode }, setPrefs };
}

function renderWith(api: AppearanceApi) {
    return render(
        <AppearanceContext.Provider value={api}>
            <ThemeSwitch />
        </AppearanceContext.Provider>,
    );
}

/** A provider that keeps the mode it is told, like the real one, and reports every change. */
function Stateful({ initial, onChange }: { initial: "system" | "light" | "dark"; onChange: (mode: string) => void }) {
    const [mode, setMode] = React.useState(initial);
    const api = fakeApi(mode, (patch) => {
        setMode(patch.mode);
        onChange(patch.mode);
    });
    return (
        <AppearanceContext.Provider value={api}>
            <ThemeSwitch />
        </AppearanceContext.Provider>
    );
}

describe("ThemeSwitch", () => {
    it("renders nothing outside an AppearanceProvider", () => {
        const { container } = render(<ThemeSwitch />);
        expect(container).toBeEmptyDOMElement();
    });

    it("is a labelled radiogroup of System, Light and Dark with tooltips and only the current one checked and tabbable", () => {
        renderWith(fakeApi("dark"));
        const group = screen.getByRole("radiogroup", { name: "Theme" });
        const radios = screen.getAllByRole("radio");
        expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["System", "Light", "Dark"]);
        expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
        expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
        expect(radios.map((r) => r.getAttribute("title"))).toEqual(["System - follow this device", "Light", "Dark"]);
        expect(group).toBeInTheDocument();
        radios.forEach((radio) => expect(radio.querySelector("svg")).toHaveAttribute("aria-hidden", "true"));
    });

    it("applies a click through setPrefs at once, and does nothing for the choice already made", async () => {
        const setPrefs = vi.fn();
        const user = userEvent.setup();
        renderWith(fakeApi("system", setPrefs));
        await user.click(screen.getByRole("radio", { name: "Dark" }));
        expect(setPrefs).toHaveBeenCalledWith({ mode: "dark" });
        setPrefs.mockClear();
        await user.click(screen.getByRole("radio", { name: "System" }));
        expect(setPrefs).not.toHaveBeenCalled();
    });

    it("moves and chooses with the arrow keys, wrapping round, and with Home and End", async () => {
        const changes = vi.fn();
        const user = userEvent.setup();
        render(<Stateful initial="light" onChange={changes} />);
        screen.getByRole("radio", { name: "Light" }).focus();

        await user.keyboard("{ArrowRight}");
        expect(changes).toHaveBeenLastCalledWith("dark");
        expect(screen.getByRole("radio", { name: "Dark" })).toHaveFocus();
        await user.keyboard("{ArrowRight}");
        expect(changes).toHaveBeenLastCalledWith("system");
        expect(screen.getByRole("radio", { name: "System" })).toHaveFocus();
        await user.keyboard("{ArrowLeft}");
        expect(changes).toHaveBeenLastCalledWith("dark");
        await user.keyboard("{ArrowUp}");
        expect(changes).toHaveBeenLastCalledWith("light");
        await user.keyboard("{ArrowDown}");
        expect(changes).toHaveBeenLastCalledWith("dark");
        await user.keyboard("{Home}");
        expect(changes).toHaveBeenLastCalledWith("system");
        await user.keyboard("{End}");
        expect(changes).toHaveBeenLastCalledWith("dark");
        changes.mockClear();
        await user.keyboard("a");
        expect(changes).not.toHaveBeenCalled();
    });
});

describe("the theme control in the account menu", () => {
    beforeEach(() => {
        mockMatchMedia(false);
        localStorage.clear();
    });

    function Surface() {
        return <span data-testid="surface">{useResolvedTheme()}</span>;
    }

    it("is not offered where there is no AppearanceProvider, and keeps every other item", async () => {
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} showSettingsLink />);
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Sign Out" })).toBeInTheDocument();
    });

    it("switches every surface in the same frame, saves in the background, and survives a reload from the cache", async () => {
        const fetchMock = mockFetch((url, init) => {
            if ((init.method ?? "GET") === "PUT") {
                return jsonResponse(200, { version: 1, mode: JSON.parse(String(init.body)).mode, updatedAt: "2026-09-21T10:00:00.000Z" });
            }
            return jsonResponse(200, { version: 1, mode: "system", updatedAt: "2026-09-21T09:00:00.000Z" });
        });
        const user = userEvent.setup();
        const tree = (
            <AppearanceProvider userUid="jane" lookUp>
                <Surface />
                <UserMenu userUid="jane" onSignOut={vi.fn()} showSettingsLink />
            </AppearanceProvider>
        );
        const { unmount } = render(tree);
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");

        await user.click(screen.getByRole("radio", { name: "Dark" }));
        // Instant: the choice is checked, the page wears it and a surface reading the resolved scheme follows, before any save has answered.
        expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
        expect(screen.getByTestId("surface")).toHaveTextContent("dark");
        expect(screen.getByRole("menu")).toBeInTheDocument();

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 900));
        });
        expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === "PUT")).toBe(true);

        // A new page load (a fresh provider) starts from the browser's cache, before any request has answered.
        unmount();
        document.documentElement.removeAttribute("data-theme");
        render(tree);
        expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
});
