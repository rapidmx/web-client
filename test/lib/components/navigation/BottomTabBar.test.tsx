// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HiOutlineCalendarDays, HiOutlineClipboardDocumentList, HiOutlineEnvelope, HiOutlineUsers } from "react-icons/hi2";
import BottomTabBar, { NavItem, splitTabs } from "../../../../lib/components/navigation/BottomTabBar.js";

// A stand-in for a real app's own nav-item list - `BottomTabBar` is deliberately agnostic to any one
// consumer's app set (see its own doc comment), so this test doesn't reach into a consumer app for one.
const APPS: NavItem[] = [
    { id: "mail", href: "/", label: "Mail", icon: HiOutlineEnvelope },
    { id: "calendar", href: "/calendar", label: "Calendar", icon: HiOutlineCalendarDays },
    { id: "contacts", href: "/contacts", label: "Contacts", icon: HiOutlineUsers },
    { id: "tasks", href: "/tasks", label: "Tasks", icon: HiOutlineClipboardDocumentList },
];

const MANY: NavItem[] = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, href: `/p${i}`, label: `Item ${i}`, icon: HiOutlineEnvelope }));

describe("BottomTabBar", () => {
    it("renders a link for every app, using the shared APPS data", () => {
        render(<BottomTabBar apps={APPS} active="mail" />);

        for (const app of APPS) {
            const link = screen.getByRole("link", { name: app.label });
            expect(link).toHaveAttribute("href", app.href);
        }
    });

    it("puts a count chip on an item that has one, named in its link, and none at zero", () => {
        const { rerender } = render(<BottomTabBar apps={[{ ...APPS[0], badge: 3 }, APPS[1]]} active="calendar" />);
        expect(screen.getByRole("link", { name: "Mail, 3 unread" })).toBeInTheDocument();
        expect(screen.getAllByTestId("nav-badge")).toHaveLength(1);
        expect(screen.getByTestId("nav-badge")).toHaveTextContent("3");
        rerender(<BottomTabBar apps={[{ ...APPS[0], badge: 250 }, APPS[1]]} active="calendar" />);
        expect(screen.getByTestId("nav-badge")).toHaveTextContent("99+");
        rerender(<BottomTabBar apps={[{ ...APPS[0], badge: 0 }, APPS[1]]} active="calendar" />);
        expect(screen.queryByTestId("nav-badge")).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Mail" })).toBeInTheDocument();
    });

    it("marks only the active app's link with aria-current", () => {
        render(<BottomTabBar apps={APPS} active="calendar" />);

        expect(screen.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
        expect(screen.getByRole("link", { name: "Mail" })).not.toHaveAttribute("aria-current");
        expect(screen.getByRole("link", { name: "Contacts" })).not.toHaveAttribute("aria-current");
        expect(screen.getByRole("link", { name: "Tasks" })).not.toHaveAttribute("aria-current");
    });

    it("shows up to five items directly, with no More button", () => {
        const five: NavItem[] = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, href: `/p${i}`, label: `Item ${i}`, icon: HiOutlineEnvelope }));
        render(<BottomTabBar apps={five} active="p0" />);
        expect(screen.getAllByRole("link")).toHaveLength(5);
        expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    });

    it("keeps the bar inside the screen with more than five: four items and a More (...) button that opens the rest", async () => {
        const user = userEvent.setup();
        render(<BottomTabBar apps={MANY} active="p0" />);

        const bar = screen.getByRole("navigation", { name: "Mobile navigation" });
        expect(bar).not.toHaveClass("overflow-x-auto");
        expect(within(bar).getAllByRole("link").map((link) => link.textContent)).toEqual(["Item 0", "Item 1", "Item 2", "Item 3"]);
        const more = screen.getByRole("button", { name: "More" });
        expect(more).toHaveAttribute("aria-haspopup", "menu");
        expect(more).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();

        await user.click(more);
        expect(more).toHaveAttribute("aria-expanded", "true");
        const menu = screen.getByRole("menu", { name: "More" });
        expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Item 4", "Item 5", "Item 6"]);
        expect(within(menu).getByRole("menuitem", { name: "Item 5" })).toHaveAttribute("href", "/p5");

        await user.click(more);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("closes the menu on Escape (back to the button), on a click elsewhere, and on choosing an item", async () => {
        const user = userEvent.setup();
        render(
            <div>
                <button type="button">elsewhere</button>
                <BottomTabBar apps={MANY} active="p0" />
            </div>,
        );
        const more = screen.getByRole("button", { name: "More" });

        await user.click(more);
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(more).toHaveFocus();

        await user.click(more);
        await user.keyboard("a");
        expect(screen.getByRole("menu")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "elsewhere" }));
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();

        await user.click(more);
        await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Item 4" }));
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();

        // A tap inside the menu or on the button itself is not "elsewhere".
        await user.click(more);
        fireEvent.touchStart(screen.getByRole("menu"));
        expect(screen.getByRole("menu")).toBeInTheDocument();
        fireEvent.touchStart(document.body);
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("always keeps the active item on the bar, in the last slot, when it would be behind More", () => {
        render(<BottomTabBar apps={MANY} active="p6" />);
        const links = within(screen.getByRole("navigation", { name: "Mobile navigation" })).getAllByRole("link");
        expect(links.map((link) => link.textContent)).toEqual(["Item 0", "Item 1", "Item 2", "Item 6"]);
        expect(screen.getByRole("link", { name: "Item 6" })).toHaveAttribute("aria-current", "page");
    });

    it("keeps an active item that is already on the bar where it is, and ignores an unknown active id", () => {
        const { rerender } = render(<BottomTabBar apps={MANY} active="p3" />);
        expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Item 0", "Item 1", "Item 2", "Item 3"]);
        rerender(<BottomTabBar apps={MANY} active="nothing" />);
        expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Item 0", "Item 1", "Item 2", "Item 3"]);
    });

    it("splits the items the same way for anything it is given", () => {
        expect(splitTabs(MANY.slice(0, 5), "p4")).toEqual({ shown: MANY.slice(0, 5), more: [] });
        expect(splitTabs(MANY, "p5").shown.map((item) => item.id)).toEqual(["p0", "p1", "p2", "p5"]);
        expect(splitTabs(MANY, "p5").more.map((item) => item.id)).toEqual(["p3", "p4", "p6"]);
    });

    it("flags unread items behind More, and carries their chips into the menu", async () => {
        const user = userEvent.setup();
        const apps = MANY.map((item) => (item.id === "p5" ? { ...item, badge: 4 } : item));
        render(<BottomTabBar apps={apps} active="p0" />);
        expect(screen.getByRole("button", { name: "More, with unread items" })).toBeInTheDocument();
        expect(screen.getByTestId("more-dot")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "More, with unread items" }));
        expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Item 5, 4 unread" })).toBeInTheDocument();
        expect(within(screen.getByRole("menu")).getByTestId("nav-badge")).toHaveTextContent("4");
    });

    it("is hidden at md and above, and only shown below it", () => {
        render(<BottomTabBar apps={APPS} active="mail" />);
        expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toHaveClass("md:hidden");
    });
});
