// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// What `AppShell` does inside the persistent frame (the router's app shell, `apps/www/_shell.tsx`), and what the chrome it keeps mounted
// (`AppChrome`) does for the router: the page's own shell renders nothing of its own there; the chrome is busy while the router loads the
// next page, offers the content region the router moves focus to, and hides itself for a screen that takes over the window. (The title,
// focus, scroll and announcement after a navigation are the router's - see `test/apps/navigation/shell.navigation.test.tsx`.)
import React, { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import AppShell, { AppChrome } from "../../../apps/shared/components/layout/AppShell.js";
import { AppFrameContext } from "../../../apps/shared/navigation/frameContext.js";

vi.mock("@rapidmx/react-shared/crypto/useIdleKeyTimeout.js", () => ({ useIdleKeyTimeout: vi.fn() }));

const originalTitle = document.title;

beforeEach(() => {
    window.scrollTo = vi.fn();
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.title = originalTitle;
});

describe("AppShell inside the persistent frame", () => {
    it("renders only its children: the frame above it already has the rail, header and everything else", () => {
        render(
            <AppFrameContext.Provider value={{ enterTakeover: () => () => undefined }}>
                <AppShell active="mail" userUid="u1">
                    page content
                </AppShell>
            </AppFrameContext.Provider>,
        );
        expect(screen.getByText("page content")).toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Apps" })).not.toBeInTheDocument();
        expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    });

    it("is the whole chrome outside it", () => {
        mockFetch(() => jsonResponse(404, {}));
        render(
            <AppShell active="mail" userUid="u1">
                page content
            </AppShell>,
        );
        expect(screen.getByRole("navigation", { name: "Apps" })).toBeInTheDocument();
    });
});

describe("AppChrome for the router", () => {
    const branding = { companyName: "Acme", title: "Acme Mail" };

    function renderChrome(props: Record<string, unknown> = {}) {
        mockFetch(() => jsonResponse(200, branding));
        const utils = render(
            <AppChrome active="mail" userUid="u1" {...props}>
                page content
            </AppChrome>,
        );
        return {
            ...utils,
            update: (next: Record<string, unknown>) =>
                utils.rerender(
                    <AppChrome active="mail" userUid="u1" {...props} {...next}>
                        page content
                    </AppChrome>,
                ),
        };
    }

    it("leaves the document title, focus and scroll to the router: the chrome sets none of them", async () => {
        document.title = "Set by the page's title export";
        const { update } = renderChrome();
        update({ active: "calendar" });
        await Promise.resolve();
        expect(document.title).toBe("Set by the page's title export");
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(document.activeElement).toBe(document.body);
        expect(window.scrollTo).not.toHaveBeenCalled();
    });

    it("has the content region the router moves focus to, which script can focus without it becoming a tab stop", () => {
        renderChrome();
        const content = document.getElementById("app-content")!;
        expect(content).toHaveAttribute("tabindex", "-1");
        content.focus();
        expect(document.activeElement).toBe(content);
    });

    it("marks the content busy while the router loads the next page", () => {
        const { update } = renderChrome({ busy: true });
        expect(document.getElementById("app-content")).toHaveAttribute("aria-busy", "true");
        update({ busy: false });
        expect(document.getElementById("app-content")).not.toHaveAttribute("aria-busy");
    });

    it("hides the rail, header and footer for a screen that takes over the window, without unmounting the page", async () => {
        const user = userEvent.setup();
        function Counter() {
            const [count, setCount] = useState(0);
            return <button onClick={() => setCount((n) => n + 1)}>count {count}</button>;
        }
        mockFetch(() => jsonResponse(200, { ...branding, footerHtml: "<p>brand footer</p>" }));
        const view = (hideChrome: boolean) => (
            <AppChrome active="mail" userUid="u1" impersonating hideChrome={hideChrome}>
                <Counter />
            </AppChrome>
        );
        const { rerender } = render(view(false));
        await user.click(screen.getByRole("button", { name: "count 0" }));
        expect(screen.getByRole("navigation", { name: "Apps" })).toBeInTheDocument();
        expect(screen.getByRole("banner")).toBeInTheDocument();
        expect(screen.getByText(/You are viewing as/)).toBeInTheDocument();
        await screen.findByText("brand footer");

        rerender(view(true));
        expect(screen.queryByRole("navigation", { name: "Apps" })).not.toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).not.toBeInTheDocument();
        expect(screen.queryByRole("banner")).not.toBeInTheDocument();
        expect(screen.queryByText(/You are viewing as/)).not.toBeInTheDocument();
        expect(screen.queryByText("brand footer")).not.toBeInTheDocument();
        // The page kept its state: it was not remounted.
        expect(screen.getByRole("button", { name: "count 1" })).toBeInTheDocument();

        rerender(view(false));
        expect(screen.getByRole("navigation", { name: "Apps" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "count 1" })).toBeInTheDocument();
    });
});
