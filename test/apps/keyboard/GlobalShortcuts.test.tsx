///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalShortcuts } from "../../../apps/shared/keyboard/GlobalShortcuts.js";
import { ShortcutProvider } from "../../../apps/shared/keyboard/ShortcutProvider.js";
import { RouterContext } from "../../../apps/shared/navigation/routerContext.js";
import { SETTINGS_HREF } from "../../../apps/shared/navigation/appHrefs.js";

const realLocation = window.location;
let location: { href: string; pathname: string };

function pretendAt(pathname: string) {
    location.pathname = pathname;
}

function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
}

const CTRL_SHIFT = { ctrlKey: true, shiftKey: true };

function mount(props: { authServerUrl?: string; onToggleHelp?: () => void; inRouter?: boolean } = {}) {
    const navigate = vi.fn();
    const onToggleHelp = props.onToggleHelp ?? vi.fn();
    const shortcuts = <GlobalShortcuts authServerUrl={props.authServerUrl} onToggleHelp={onToggleHelp} />;
    render(
        <ShortcutProvider>
            {props.inRouter === false ? (
                shortcuts
            ) : (
                <RouterContext.Provider value={{ location: { pathname: "", search: "", hash: "" }, navigate }}>{shortcuts}</RouterContext.Provider>
            )}
        </ShortcutProvider>,
    );
    return { navigate, onToggleHelp };
}

beforeEach(() => {
    location = { href: "", pathname: "/" };
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: location });
});

afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: realLocation });
    delete (window as { rapidmx?: unknown }).rapidmx;
    vi.restoreAllMocks();
});

describe("GlobalShortcuts", () => {
    it("goes to each place through the client-side router", () => {
        const { navigate } = mount();
        pretendAt("/calendar");
        expect(press("M", CTRL_SHIFT).defaultPrevented).toBe(true);
        expect(navigate).toHaveBeenLastCalledWith("/");
        pretendAt("/");
        press("C", CTRL_SHIFT);
        expect(navigate).toHaveBeenLastCalledWith("/calendar");
        press("B", CTRL_SHIFT);
        expect(navigate).toHaveBeenLastCalledWith("/contacts");
        press("L", CTRL_SHIFT);
        expect(navigate).toHaveBeenLastCalledWith("/tasks");
        press("S", CTRL_SHIFT);
        expect(navigate).toHaveBeenLastCalledWith(SETTINGS_HREF);
        expect(navigate).toHaveBeenCalledTimes(5);
    });

    it("does not navigate to the page it is already on - but still takes the key", () => {
        const { navigate } = mount();
        for (const [pathname, key] of [
            ["/", "M"],
            ["/calendar", "C"],
            ["/contacts", "B"],
            ["/tasks", "L"],
            ["/settings/labels", "S"],
            ["/settings", "S"],
            ["/settings/filters/new", "S"],
        ] as const) {
            pretendAt(pathname);
            expect(press(key, CTRL_SHIFT).defaultPrevented, `${pathname} ${key}`).toBe(true);
        }
        expect(navigate).not.toHaveBeenCalled();
    });

    it("treats a page within an app as not being on the app's own page", () => {
        const { navigate } = mount();
        pretendAt("/messages/abc");
        press("M", CTRL_SHIFT);
        expect(navigate).toHaveBeenLastCalledWith("/");
        pretendAt("/contacts/abc");
        press("B", CTRL_SHIFT);
        expect(navigate).toHaveBeenLastCalledWith("/contacts");
        pretendAt("/settings-not-really");
        press("S", CTRL_SHIFT);
        expect(navigate).toHaveBeenLastCalledWith(SETTINGS_HREF);
    });

    it("goes to the account page of auth-server with a full navigation, tolerating a trailing slash", () => {
        const { navigate } = mount({ authServerUrl: "https://auth.example.com/" });
        expect(press("A", CTRL_SHIFT).defaultPrevented).toBe(true);
        expect(location.href).toBe("https://auth.example.com/account");
        expect(navigate).not.toHaveBeenCalled();
    });

    it("offers the account page only when auth-server is configured", () => {
        mount();
        expect(press("A", CTRL_SHIFT).defaultPrevented).toBe(false);
        expect(location.href).toBe("");
    });

    it("toggles the keyboard help with ? and Ctrl+/", () => {
        const { onToggleHelp } = mount();
        expect(press("?", { shiftKey: true }).defaultPrevented).toBe(true);
        expect(press("/", { ctrlKey: true }).defaultPrevented).toBe(true);
        expect(onToggleHelp).toHaveBeenCalledTimes(2);
    });

    it("works from a text field for the chords, and leaves the bare ? to the field", () => {
        const { navigate, onToggleHelp } = mount();
        const input = document.createElement("input");
        document.body.appendChild(input);
        pretendAt("/tasks");
        press("M", CTRL_SHIFT, input);
        expect(navigate).toHaveBeenCalledWith("/");
        press("/", { ctrlKey: true }, input);
        expect(onToggleHelp).toHaveBeenCalledTimes(1);
        expect(press("?", { shiftKey: true }, input).defaultPrevented).toBe(false);
        expect(onToggleHelp).toHaveBeenCalledTimes(1);
        input.remove();
    });

    it("has Ctrl+Shift+T for Tasks only in the desktop client", () => {
        const { navigate } = mount();
        pretendAt("/");
        expect(press("T", CTRL_SHIFT).defaultPrevented).toBe(false);
        (window as { rapidmx?: unknown }).rapidmx = {};
        expect(press("T", CTRL_SHIFT).defaultPrevented).toBe(true);
        expect(navigate).toHaveBeenCalledWith("/tasks");
        press("L", CTRL_SHIFT);
        expect(navigate).toHaveBeenCalledTimes(2);
    });

    it("keeps the navigation set on Ctrl+Shift on a Mac, and does not take Cmd+Shift", () => {
        vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
        const { navigate } = mount();
        pretendAt("/tasks");
        expect(press("M", { metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
        expect(press("M", CTRL_SHIFT).defaultPrevented).toBe(true);
        expect(navigate).toHaveBeenCalledTimes(1);
    });

    it("falls back to an ordinary navigation outside a router", () => {
        mount({ inRouter: false });
        pretendAt("/calendar");
        press("M", CTRL_SHIFT);
        expect(location.href).toBe("/");
    });

    it("does nothing while a modal dialog is open", () => {
        const { navigate } = mount();
        const modal = document.createElement("div");
        modal.setAttribute("aria-modal", "true");
        document.body.appendChild(modal);
        pretendAt("/tasks");
        expect(press("M", CTRL_SHIFT).defaultPrevented).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
        modal.remove();
    });
});
