// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import DnsResolverPage from "../../../../../apps/admin/integrations/dns-resolver/index.js";
import { integrationsView, mockIntegrations, setByAdmin } from "../fixtures.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

const renderPage = () => render(<DnsResolverPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

describe("DnsResolverPage", () => {
    it("shows the resolver, its DoH endpoint and that every DNS check follows a change at once", async () => {
        mockIntegrations(integrationsView());
        renderPage();

        expect(await screen.findByRole("heading", { name: "DNS resolver" })).toBeInTheDocument();
        expect(screen.getByLabelText("Resolver")).toHaveValue("node");
        expect(screen.getByText("Deployment default: The system resolver")).toBeInTheDocument();
        expect(screen.getByLabelText("DoH endpoint")).toHaveValue("https://cloudflare-dns.com/dns-query");
        expect(screen.getByText(/Every DNS check, domain verification and key discovery/)).toBeInTheDocument();
    });

    it("switches to DNS over HTTPS with another endpoint", async () => {
        const { puts } = mockIntegrations(integrationsView());
        const user = userEvent.setup();
        renderPage();

        await user.selectOptions(await screen.findByLabelText("Resolver"), "doh-dnssec");
        await user.clear(screen.getByLabelText("DoH endpoint"));
        await user.type(screen.getByLabelText("DoH endpoint"), "https://dns.example.net/dns-query");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() =>
            expect(puts).toEqual([
                {
                    section: "dnsResolver",
                    body: { mode: "doh-dnssec", dohEndpoint: "https://dns.example.net/dns-query", version: 3 },
                },
            ])
        );
    });

    it("resets the resolver set here", async () => {
        const { puts } = mockIntegrations(setByAdmin(integrationsView(), "dnsResolver", "mode", "doh-dnssec"));
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByLabelText("Resolver")).toHaveValue("doh-dnssec");
        await user.click(screen.getByRole("button", { name: "Reset resolver to the deployment default" }));
        expect(screen.getByLabelText("Resolver")).toHaveValue("node");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(puts.map((put) => put.body)).toEqual([{ mode: null, version: 3 }]));
    });
});
