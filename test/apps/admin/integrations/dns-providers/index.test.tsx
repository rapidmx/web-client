// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../../testUtils.js";
import DnsProvidersPage from "../../../../../apps/admin/integrations/dns-providers/index.js";
import { cloudflareProvider, providerTypes } from "../fixtures.js";

beforeEach(() => {
    // Two minutes after the fixtures' reports: recent enough to be believed.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T10:02:00.000Z") });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const noController = { handshake: null, lastReport: null, lastStandbyReport: null };

function mockProviders(providers: unknown[] | (() => Response), controller: unknown | (() => Response) = noController) {
    return mockFetch((url) => {
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/setup") return jsonResponse(200, { required: false });
        if (url === "/api/system/dns-providers/types") return jsonResponse(200, providerTypes);
        if (url === "/api/system/dns-providers/controller") {
            return typeof controller === "function" ? (controller as () => Response)() : jsonResponse(200, controller);
        }
        if (url === "/api/system/dns-providers") {
            return typeof providers === "function" ? providers() : jsonResponse(200, providers);
        }
        throw new Error(`unexpected ${url}`);
    });
}

const renderPage = () => render(<DnsProvidersPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

/** The text of each cell of the table's body rows. */
function rows(): string[][] {
    const [, body] = screen.getAllByRole("rowgroup");
    return within(body)
        .getAllByRole("row")
        .map((row) =>
            within(row)
                .getAllByRole("cell")
                .map((cell) => cell.textContent ?? "")
        );
}

describe("DnsProvidersPage", () => {
    it("lists each provider config with its type, zones, status and assigned domains", async () => {
        mockProviders([
            cloudflareProvider,
            {
                ...cloudflareProvider,
                uid: "route-53-k2j3h4g5",
                name: "Route 53",
                type: "route53",
                zones: ["example.net"],
                origin: "installer",
                status: { readyReplicas: 0, reportedAt: "2026-10-27T10:00:00.000Z" },
                domainCount: 0,
            },
            {
                ...cloudflareProvider,
                uid: "bind-a1b2c3d4",
                name: "BIND",
                type: "rfc2136",
                status: { readyReplicas: 1, lastError: "TSIG verification failed" },
                domainCount: 1,
            },
            { ...cloudflareProvider, uid: "old-z9y8x7w6", name: "Old", enabled: false, status: { readyReplicas: 0 } },
            {
                ...cloudflareProvider,
                uid: "new-q1w2e3r4",
                name: "New",
                type: "webhook",
                status: undefined,
                domainCount: 0,
            },
        ]);
        renderPage();

        expect(await screen.findByRole("heading", { name: "DNS providers" })).toBeInTheDocument();
        await screen.findByText("Route 53");
        expect(rows()).toEqual([
            ["Cloudflare", "Cloudflare", "example.com, example.org", "Running", "2", "View"],
            ["Route 53Added by the installer", "Amazon Route 53Not yet live-tested", "example.net", "Not ready", "0", "View"],
            ["BIND", "RFC 2136 (BIND and other DNS servers)Not yet live-tested", "example.com, example.org", "ErrorTSIG verification failed", "1", "View"],
            ["Old", "Cloudflare", "example.com, example.org", "Disabled", "2", "View"],
            // A type this console doesn't know is shown as the server names it.
            ["New", "webhook", "example.com, example.org", "Not ready", "0", "View"],
        ]);
        expect(screen.getAllByRole("link", { name: "View" })[0]).toHaveAttribute("href", "/admin/integrations/dns-providers/cloudflare-ab12cd34");
        expect(screen.getByRole("link", { name: "+ New DNS provider" })).toHaveAttribute("href", "/admin/integrations/dns-providers/new");
    });

    it("says when there are none, and that records are then published by hand", async () => {
        mockProviders([]);
        renderPage();
        expect(await screen.findByText(/No DNS providers yet/)).toBeInTheDocument();
        expect(screen.getByText(/published by hand/)).toBeInTheDocument();
    });

    it("says the DNS controller has never contacted this server", async () => {
        mockProviders([cloudflareProvider]);
        renderPage();
        expect(await screen.findByText(/The DNS controller hasn’t contacted this server yet/)).toBeInTheDocument();
    });

    it("shows the controller's version and last report while it works with this server", async () => {
        mockProviders([cloudflareProvider], {
            handshake: {
                controllerVersion: "0.1.0",
                apiVersions: ["dns.rapidmx.io/v1"],
                compatible: true,
                selected: "dns.rapidmx.io/v1",
                at: "2026-10-27T09:00:00.000Z",
            },
            lastReport: {
                controllerVersion: "0.1.0",
                leaseHolder: true,
                leaseIdentity: "dns-controller-0",
                at: "2026-10-27T10:00:00.000Z",
            },
            lastStandbyReport: null,
        });
        renderPage();
        expect(await screen.findByText(/DNS controller 0\.1\.0, last report/)).toBeInTheDocument();
    });

    it("says the controller connected but hasn't reported yet", async () => {
        mockProviders([cloudflareProvider], {
            handshake: {
                controllerVersion: "0.1.0",
                apiVersions: ["dns.rapidmx.io/v1"],
                compatible: true,
                at: "2026-10-27T10:01:00.000Z",
            },
            lastReport: null,
            lastStandbyReport: null,
        });
        renderPage();
        expect(await screen.findByText("DNS controller 0.1.0 has connected and not reported yet.")).toBeInTheDocument();
    });

    it("warns that the controller may be down when it hasn't reported for too long, and shows its providers' status as unknown", async () => {
        vi.setSystemTime(new Date("2026-10-27T10:11:00.000Z"));
        mockProviders([{ ...cloudflareProvider, status: { readyReplicas: 1, reportedAt: "2026-10-27T10:00:00.000Z" } }], {
            handshake: {
                controllerVersion: "0.1.0",
                apiVersions: ["dns.rapidmx.io/v1"],
                compatible: true,
                at: "2026-10-27T09:00:00.000Z",
            },
            lastReport: {
                controllerVersion: "0.1.0",
                leaseHolder: true,
                leaseIdentity: "dns-controller-0",
                at: "2026-10-27T10:00:00.000Z",
            },
            lastStandbyReport: null,
        });
        renderPage();
        expect(
            await screen.findByText(/The DNS controller hasn't been heard from since .*; it may be down\. Nothing is published or removed/)
        ).toBeInTheDocument();
        expect(screen.queryByText(/last report/)).not.toBeInTheDocument();
        expect(rows()[0][3]).toMatch(/^UnknownThe DNS controller hasn't reported on it since .*; it may be down\.$/);
    });

    it("takes a handshake after the last report as the controller being back", async () => {
        vi.setSystemTime(new Date("2026-10-27T10:11:00.000Z"));
        mockProviders([{ ...cloudflareProvider, status: { readyReplicas: 1, reportedAt: "2026-10-27T10:10:30.000Z" } }], {
            handshake: {
                controllerVersion: "0.1.1",
                apiVersions: ["dns.rapidmx.io/v1"],
                compatible: true,
                at: "2026-10-27T10:10:00.000Z",
            },
            lastReport: {
                controllerVersion: "0.1.0",
                leaseHolder: true,
                leaseIdentity: "dns-controller-0",
                at: "2026-10-27T10:00:00.000Z",
            },
            lastStandbyReport: null,
        });
        renderPage();
        expect(await screen.findByText(/DNS controller 0\.1\.0, last report/)).toBeInTheDocument();
        expect(screen.queryByText(/may be down/)).not.toBeInTheDocument();
    });

    it("warns that a controller which connected long ago and never reported may be down", async () => {
        mockProviders([cloudflareProvider], {
            handshake: {
                controllerVersion: "0.1.0",
                apiVersions: ["dns.rapidmx.io/v1"],
                compatible: true,
                at: "2026-10-27T09:00:00.000Z",
            },
            lastReport: null,
            lastStandbyReport: null,
        });
        vi.setSystemTime(new Date("2026-10-27T09:30:00.000Z"));
        renderPage();
        expect(await screen.findByText(/The DNS controller hasn't been heard from since .*; it may be down/)).toBeInTheDocument();
    });

    it("warns that a controller of another API version refuses to act", async () => {
        mockProviders([cloudflareProvider], {
            handshake: {
                controllerVersion: "0.4.0",
                apiVersions: ["dns.rapidmx.io/v2"],
                compatible: false,
                reason: "no API version in common: the controller speaks dns.rapidmx.io/v2, the server dns.rapidmx.io/v1",
                at: "2026-10-27T09:00:00.000Z",
            },
            lastReport: null,
            lastStandbyReport: null,
        });
        renderPage();
        expect(
            await screen.findByText(
                "DNS controller 0.4.0 can't work with this server (no API version in common: the controller speaks dns.rapidmx.io/v2, the server dns.rapidmx.io/v1). Nothing is published until matching versions are installed."
            )
        ).toBeInTheDocument();
    });

    it("leaves the controller out when its state can't be read", async () => {
        mockProviders([cloudflareProvider], () => jsonResponse(503, { message: "Unavailable" }));
        renderPage();
        await screen.findByRole("link", { name: "View" });
        expect(screen.queryByText(/DNS controller/)).not.toBeInTheDocument();
    });

    it("says why the list can't be shown", async () => {
        mockProviders(() => jsonResponse(403, { message: "Requires elevation.", code: "api-104" }));
        renderPage();
        expect(await screen.findByText(/recently confirmed your identity/)).toBeInTheDocument();
    });

    it("says when this server has no DNS providers to show", async () => {
        mockProviders(() => jsonResponse(404, { message: "Not Found" }));
        renderPage();
        expect(await screen.findByText("This server doesn't offer DNS providers yet. Upgrade it to manage them here.")).toBeInTheDocument();
    });

    it("shows a generic message when the list fails without one", async () => {
        mockProviders(() => {
            throw new TypeError("network down");
        });
        renderPage();
        expect(await screen.findByText("Could not load the DNS providers.")).toBeInTheDocument();
    });
});
