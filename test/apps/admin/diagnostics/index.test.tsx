// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import DiagnosticsPage from "../../../../apps/admin/diagnostics/index.js";
import { adminNavItems } from "../../../../apps/shared/components/admin/layout/AdminShell.js";
import { runtimeFixture, versionsFixture } from "./fixtures.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

function mockApi(canary: () => Response = () => jsonResponse(200, {})) {
    return mockFetch((url) => {
        switch (url) {
            case "/api/admin/release-notes":
                return canary();
            case "/api/system/setup":
                return jsonResponse(200, { required: false });
            case "/api/admin/diagnostics/versions":
                return jsonResponse(200, versionsFixture());
            case "/api/admin/diagnostics/runtime":
                return jsonResponse(200, runtimeFixture());
            case "/api/system/plugins":
                return jsonResponse(200, []);
            case "/api/system/plugins/status":
                return jsonResponse(200, { hash: "h", instances: [] });
            default:
                throw new Error(`unexpected ${url}`);
        }
    });
}

const renderPage = () => render(<DiagnosticsPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

describe("DiagnosticsPage", () => {
    it("is the Diagnostics section of the admin console, with the diagnostics page inside", async () => {
        mockApi();
        renderPage();
        expect(await screen.findByRole("heading", { level: 1, name: "Diagnostics" })).toBeInTheDocument();
        expect(await screen.findByRole("region", { name: "Server" })).toBeInTheDocument();
        const rail = within(screen.getByRole("navigation", { name: "Admin sections" }));
        const link = rail.getByRole("link", { name: "Diagnostics" });
        expect(link).toHaveAttribute("href", "/admin/diagnostics");
        expect(link).toHaveAttribute("aria-current", "page");
        // The console's own header names the section too.
        expect(screen.getAllByText("Diagnostics").length).toBeGreaterThan(1);
    });

    it("is in the console's navigation after Plugins", () => {
        const labels = adminNavItems().map((item) => item.label);
        expect(labels).toContain("Diagnostics");
        expect(labels.indexOf("Diagnostics")).toBe(labels.indexOf("Plugins") + 1);
    });

    it("shows the console's own answer when the administrator is not allowed in", async () => {
        mockApi(() => jsonResponse(403, { code: "api-103", message: "No." }));
        renderPage();
        expect(await screen.findByText("You do not have administrator access.")).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Diagnostics" })).not.toBeInTheDocument();
    });
});
