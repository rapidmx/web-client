// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import IntegrationsPage from "../../../../apps/admin/integrations/index.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("IntegrationsPage", () => {
    it("is reached from the console's menu and lists every integration with what it is for", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/system/setup") return jsonResponse(200, { required: false });
            throw new Error(`unexpected ${url}`);
        });
        render(<IntegrationsPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByRole("heading", { name: "Integrations", level: 1 })).toBeInTheDocument();
        const rail = screen.getByRole("navigation", { name: "Admin sections" });
        expect(within(rail).getByRole("link", { name: "Integrations" })).toHaveAttribute("href", "/admin/integrations");
        expect(within(rail).getByRole("link", { name: "Integrations" })).toHaveAttribute("aria-current", "page");

        const areas = screen.getByRole("list", { name: "Integration areas" });
        expect(
            within(areas)
                .getAllByRole("link")
                .map((link) => link.getAttribute("href"))
        ).toEqual([
            "/admin/integrations/dns-providers",
            "/admin/integrations/giphy",
            "/admin/integrations/stun",
            "/admin/integrations/signing-ca",
            "/admin/integrations/dns-resolver",
            "/admin/integrations/plugin-registry",
        ]);
        expect(within(areas).getByText(/publish the DNS records of this server and its domains/)).toBeInTheDocument();
        // No area is the current one on the overview.
        expect(within(screen.getByRole("navigation", { name: "Integrations" })).queryByRole("link", { current: "page" })).not.toBeInTheDocument();
    });
});
