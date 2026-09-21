// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// What `AppShell` does inside the client-side router's persistent frame (`AppRouter`), and what the chrome it keeps mounted
// (`AppChrome`) does for the router: the page's own shell renders nothing of its own there; the chrome follows the page with the
// document title, focus, scroll and a live-region announcement, and hides itself for a screen that takes over the window.
import React, { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
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
            <AppChrome active="mail" userUid="u1" routeKey="initial" {...props}>
                page content
            </AppChrome>,
        );
        return {
            ...utils,
            update: (next: Record<string, unknown>) =>
                utils.rerender(
                    <AppChrome active="mail" userUid="u1" routeKey="initial" {...props} {...next}>
                        page content
                    </AppChrome>,
                ),
        };
    }

    it("sets the document title to the brand and the page", async () => {
        renderChrome({ active: "calendar" });
        await waitFor(() => expect(document.title).toBe("Acme Mail: Calendar"));
    });

    it("titles a settings page Settings, and a page it has no label for by the brand alone", async () => {
        const { update } = renderChrome({ active: "settings" });
        await waitFor(() => expect(document.title).toBe("Acme Mail: Settings"));
        update({ active: "some-plugin-app" });
        await waitFor(() => expect(document.title).toBe("Acme Mail"));
    });

    it("falls back to the company name, then to RapidMX, for the brand", async () => {
        mockFetch(() => jsonResponse(200, { companyName: "Acme", title: "" }));
        const { unmount } = render(
            <AppChrome active="tasks" userUid="u1" routeKey="initial">
                x
            </AppChrome>,
        );
        await waitFor(() => expect(document.title).toBe("Acme: Tasks"));
        unmount();
        mockFetch(() => jsonResponse(200, { companyName: "", title: "" }));
        render(
            <AppChrome active="tasks" userUid="u1" routeKey="initial">
                x
            </AppChrome>,
        );
        await waitFor(() => expect(document.title).toBe("RapidMX: Tasks"));
    });

    it("leaves the title, focus and announcements alone when it is not in the router (no routeKey)", async () => {
        mockFetch(() => jsonResponse(200, branding));
        document.title = "Set by the layout";
        const { rerender } = render(
            <AppChrome active="mail" userUid="u1">
                x
            </AppChrome>,
        );
        rerender(
            <AppChrome active="calendar" userUid="u1">
                x
            </AppChrome>,
        );
        await Promise.resolve();
        expect(document.title).toBe("Set by the layout");
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(window.scrollTo).not.toHaveBeenCalled();
    });

    it("does not move focus or announce anything for the page the document was loaded with", async () => {
        renderChrome();
        await waitFor(() => expect(document.title).toBe("Acme Mail: Mail"));
        expect(screen.getByRole("status")).toHaveTextContent("");
        expect(document.activeElement).toBe(document.body);
        expect(window.scrollTo).not.toHaveBeenCalled();
    });

    it("moves focus to the content, scrolls to the top and announces the page when the router shows another one", async () => {
        const { update } = renderChrome();
        await waitFor(() => expect(document.title).toBe("Acme Mail: Mail"));
        update({ active: "contacts", routeKey: "/contacts" });
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Contacts"));
        expect(document.activeElement).toBe(document.getElementById("app-content"));
        expect(document.getElementById("app-content")).toHaveAttribute("tabindex", "-1");
        expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
        expect(document.title).toBe("Acme Mail: Contacts");
    });

    it("announces nothing but still moves on for a page without a label", async () => {
        const { update } = renderChrome();
        update({ active: "some-plugin-app", routeKey: "/somewhere" });
        await waitFor(() => expect(document.activeElement).toBe(document.getElementById("app-content")));
        expect(screen.getByRole("status")).toHaveTextContent("");
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
