// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import BottomTabBar from "../../../apps/shared/components/layout/BottomTabBar.js";
import { APPS } from "../../../apps/shared/components/layout/AppShell.js";

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

    it("is hidden at md and above, and only shown below it", () => {
        render(<BottomTabBar apps={APPS} active="mail" />);
        expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toHaveClass("md:hidden");
    });
});
