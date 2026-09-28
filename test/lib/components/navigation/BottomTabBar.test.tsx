// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HiOutlineCalendarDays, HiOutlineClipboardDocumentList, HiOutlineEnvelope, HiOutlineUsers } from "react-icons/hi2";
import BottomTabBar, { NavItem } from "../../../../lib/components/navigation/BottomTabBar.js";

// A stand-in for a real app's own nav-item list - `BottomTabBar` is deliberately agnostic to any one
// consumer's app set (see its own doc comment), so this test doesn't reach into a consumer app for one.
const APPS: NavItem[] = [
    { id: "mail", href: "/", label: "Mail", icon: HiOutlineEnvelope },
    { id: "calendar", href: "/calendar", label: "Calendar", icon: HiOutlineCalendarDays },
    { id: "contacts", href: "/contacts", label: "Contacts", icon: HiOutlineUsers },
    { id: "tasks", href: "/tasks", label: "Tasks", icon: HiOutlineClipboardDocumentList },
];

describe("BottomTabBar", () => {
    it("renders a link for every app, using the shared APPS data", () => {
        render(<BottomTabBar apps={APPS} active="mail" />);

        for (const app of APPS) {
            const link = screen.getByRole("link", { name: app.label });
            expect(link).toHaveAttribute("href", app.href);
        }
    });

    it("marks only the active app's link with aria-current", () => {
        render(<BottomTabBar apps={APPS} active="calendar" />);

        expect(screen.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
        expect(screen.getByRole("link", { name: "Mail" })).not.toHaveAttribute("aria-current");
        expect(screen.getByRole("link", { name: "Contacts" })).not.toHaveAttribute("aria-current");
        expect(screen.getByRole("link", { name: "Tasks" })).not.toHaveAttribute("aria-current");
    });

    it("keeps every item a readable width and scrolls sideways when there are too many to fit", () => {
        const many: NavItem[] = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, href: `/p${i}`, label: `Distribution Lists ${i}`, icon: HiOutlineEnvelope }));
        render(<BottomTabBar apps={many} active="p9" />);

        const bar = screen.getByRole("navigation", { name: "Mobile navigation" });
        expect(bar).toHaveClass("overflow-x-auto");
        for (const link of screen.getAllByRole("link")) {
            expect(link).toHaveClass("min-w-[4.75rem]", "shrink-0", "text-center");
        }
    });

    it("opens a scrolling bar with the active item centred, and leaves one that fits alone", () => {
        const many: NavItem[] = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, href: `/p${i}`, label: `Item ${i}`, icon: HiOutlineEnvelope }));
        // jsdom lays nothing out: stand in for a 320px bar of 76px items.
        const layout = (bar: HTMLElement, links: HTMLElement[]) => {
            Object.defineProperty(bar, "clientWidth", { value: 320, configurable: true });
            Object.defineProperty(bar, "scrollWidth", { value: 760, configurable: true });
            links.forEach((link, i) => {
                Object.defineProperty(link, "offsetLeft", { value: i * 76, configurable: true });
                Object.defineProperty(link, "offsetWidth", { value: 76, configurable: true });
            });
        };
        const first = render(<BottomTabBar apps={many} active="p0" />);
        const bar = screen.getByRole("navigation", { name: "Mobile navigation" });
        layout(bar, screen.getAllByRole("link"));
        first.rerender(<BottomTabBar apps={many} active="p9" />);
        expect(bar.scrollLeft).toBe(9 * 76 - (320 - 76) / 2);
        first.unmount();

        render(<BottomTabBar apps={APPS} active="tasks" />);
        expect(screen.getByRole("navigation", { name: "Mobile navigation" }).scrollLeft).toBe(0);
    });

    it("is hidden at md and above, and only shown below it", () => {
        render(<BottomTabBar apps={APPS} active="mail" />);
        expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toHaveClass("md:hidden");
    });
});
