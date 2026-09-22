// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import UserMenu from "../../../apps/shared/components/layout/UserMenu.js";

afterEach(() => {
    vi.restoreAllMocks();
});

/** A button's rectangle as the layout would report it. */
function place(rect: { top: number; bottom: number; right: number }) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
        () => ({ ...rect, left: rect.right - 40, x: rect.right - 40, y: rect.top, width: 40, height: rect.bottom - rect.top, toJSON: () => ({}) }),
    );
}

describe("UserMenu's placement", () => {
    it("is drawn into <body>, not inside the container it belongs to, so no ancestor's overflow can clip it", async () => {
        place({ top: 10, bottom: 50, right: 1000 });
        const user = userEvent.setup();
        const { container } = render(
            <div style={{ overflow: "hidden", height: 20 }} data-testid="clipper">
                <UserMenu userUid="jane" onSignOut={vi.fn()} />
            </div>,
        );
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        const menu = screen.getByRole("menu");
        expect(container.contains(menu)).toBe(false);
        expect(menu.parentElement).toBe(document.body);
        expect(menu.style.position).toBe("fixed");
        expect(menu).toHaveClass("z-[70]");
    });

    it("opens below the button, its right edge on the button's, by default", async () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
        place({ top: 10, bottom: 50, right: 1200 });
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} />);
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        const menu = screen.getByRole("menu");
        expect(menu.style.top).toBe("58px");
        expect(menu.style.right).toBe("80px");
        expect(menu.style.bottom).toBe("");
    });

    it("opens upward from a button in a footer", async () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
        Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
        place({ top: 750, bottom: 790, right: 1280 });
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} placement="up" />);
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        const menu = screen.getByRole("menu");
        expect(menu.style.bottom).toBe("58px");
        expect(menu.style.top).toBe("");
        // Never off the window's right edge.
        expect(menu.style.right).toBe("8px");
    });

    it("follows the button when the window resizes or anything scrolls, and stops when closed", async () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
        place({ top: 0, bottom: 40, right: 1280 });
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={vi.fn()} />);
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menu").style.top).toBe("48px");
        place({ top: 100, bottom: 140, right: 1280 });
        act(() => {
            window.dispatchEvent(new Event("scroll"));
        });
        expect(screen.getByRole("menu").style.top).toBe("148px");
        place({ top: 200, bottom: 240, right: 1280 });
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });
        expect(screen.getByRole("menu").style.top).toBe("248px");
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        // Nothing left listening: a further scroll doesn't bring it back.
        act(() => {
            window.dispatchEvent(new Event("scroll"));
        });
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("stays open for a press inside it (it is outside the container's DOM) and closes for one anywhere else", async () => {
        place({ top: 0, bottom: 40, right: 1000 });
        const user = userEvent.setup();
        render(
            <div>
                <UserMenu userUid="jane" onSignOut={vi.fn()} />
                <p>elsewhere</p>
            </div>,
        );
        await user.click(screen.getByRole("button", { name: "Account menu" }));
        fireEvent.mouseDown(screen.getByText("jane"));
        expect(screen.getByRole("menu")).toBeInTheDocument();
        fireEvent.mouseDown(screen.getByRole("button", { name: "Account menu" }));
        expect(screen.getByRole("menu")).toBeInTheDocument();
        fireEvent.mouseDown(screen.getByText("elsewhere"));
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("keeps working from a keyboard: reachable with Tab, opened with Enter, and Sign Out is a menu item", async () => {
        place({ top: 0, bottom: 40, right: 1000 });
        const onSignOut = vi.fn();
        const user = userEvent.setup();
        render(<UserMenu userUid="jane" onSignOut={onSignOut} />);
        await user.tab();
        expect(screen.getByRole("button", { name: "Account menu" })).toHaveFocus();
        await user.keyboard("{Enter}");
        await user.click(screen.getByRole("menuitem", { name: "Sign Out" }));
        expect(onSignOut).toHaveBeenCalled();
    });
});
