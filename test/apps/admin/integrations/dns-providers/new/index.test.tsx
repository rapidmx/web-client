// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../../../testUtils.js";
import NewDnsProviderPageBase from "../../../../../../apps/admin/integrations/dns-providers/new/index.js";
import { latestRouter, withTestRouter } from "../../../../routerTestUtils.js";
import { providerTypes } from "../../fixtures.js";

const NewDnsProviderPage = withTestRouter(NewDnsProviderPageBase);

afterEach(() => {
    vi.unstubAllGlobals();
});

function mockCreate(
    create: (body: any) => Response = (body) => jsonResponse(200, { ...body, uid: "cloudflare-ab12cd34" }),
    types: () => Response = () => jsonResponse(200, providerTypes)
) {
    const posts: any[] = [];
    mockFetch((url, init) => {
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/setup") return jsonResponse(200, { required: false });
        if (url === "/api/system/dns-providers/types") return types();
        if (url === "/api/system/dns-providers" && init?.method === "POST") {
            const body = JSON.parse(init.body as string);
            posts.push(body);
            return create(body);
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
    return posts;
}

const renderPage = () => render(<NewDnsProviderPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

describe("NewDnsProviderPage", () => {
    it("builds the form of the chosen type from the server's types, Cloudflare first", async () => {
        mockCreate();
        renderPage();

        expect(await screen.findByRole("heading", { name: "New DNS provider" })).toBeInTheDocument();
        const type = await screen.findByLabelText("Type");
        expect(type).toHaveValue("cloudflare");
        expect(screen.getByLabelText("Zone IDs")).toBeInTheDocument();
        expect(screen.getByText("The Cloudflare zone ID of each zone, in the same order as the zones.")).toBeInTheDocument();
        expect(screen.getByLabelText("API token")).toHaveAttribute("type", "password");
        expect(screen.getByText(/list every address the cluster reaches the internet from, IPv4 and IPv6/)).toBeInTheDocument();
        expect(screen.queryByText("Not yet live-tested")).not.toBeInTheDocument();
        expect(screen.getByLabelText(/Publish through this provider/)).toBeChecked();
        expect(screen.getByLabelText(/Allow taking over existing records/)).not.toBeChecked();
        expect(screen.getByText(/show as conflicts, with a Take over action on their domain/)).toBeInTheDocument();
    });

    it("says credentials are saved encrypted with the config, not in a separate secret store, and are never shown again", async () => {
        mockCreate();
        renderPage();

        expect(await screen.findByText("Saved encrypted, and never shown again.")).toBeInTheDocument();
        expect(screen.queryByText(/secret store/)).not.toBeInTheDocument();
    });

    it("creates a Cloudflare config and opens it", async () => {
        const posts = mockCreate();
        const user = userEvent.setup();
        renderPage();

        await user.type(await screen.findByLabelText("Name"), " Cloudflare ");
        await user.type(screen.getByLabelText("Zones"), "example.com\nexample.org\n");
        await user.type(screen.getByLabelText("Zone IDs"), "0123456789abcdef0123456789abcdef, fedcba9876543210fedcba9876543210");
        await user.type(screen.getByLabelText("API token"), "cf-token");
        await user.click(screen.getByLabelText(/Allow taking over existing records/));
        await user.click(screen.getByRole("button", { name: "Create DNS provider" }));

        await vi.waitFor(() => expect(latestRouter().navigate.mock.lastCall?.[0]).toBe("/admin/integrations/dns-providers/cloudflare-ab12cd34"));
        expect(posts).toEqual([
            {
                name: "Cloudflare",
                type: "cloudflare",
                zones: ["example.com", "example.org"],
                options: { zoneIds: ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"] },
                credentials: { apiToken: "cf-token" },
                enabled: true,
                allowTakeover: true,
            },
        ]);
    });

    it("switches the form to another type, with its defaults, its badge and no credentials when none are given", async () => {
        const posts = mockCreate((body) => jsonResponse(200, { ...body, uid: "bind-a1b2c3d4" }));
        const user = userEvent.setup();
        renderPage();

        await user.selectOptions(await screen.findByLabelText("Type"), "rfc2136");
        expect(screen.getByText("Not yet live-tested")).toBeInTheDocument();
        expect(screen.getByText(/MX and SRV records can't be managed/)).toBeInTheDocument();
        expect(screen.queryByLabelText("Zone IDs")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Port")).toHaveValue(53);
        expect(screen.getByLabelText("TSIG algorithm")).toHaveValue("hmac-sha256");
        expect(screen.getByLabelText(/Unsigned updates/)).not.toBeChecked();

        await user.type(screen.getByLabelText("Name"), "BIND");
        await user.type(screen.getByLabelText("Zones"), "example.com");
        await user.type(screen.getByLabelText("Servers"), "ns1.example.com\n192.0.2.53");
        await user.clear(screen.getByLabelText("Port"));
        await user.type(screen.getByLabelText("Port"), "5353");
        await user.type(screen.getByLabelText("Zone"), "example.com");
        await user.selectOptions(screen.getByLabelText("TSIG algorithm"), "hmac-sha1");
        await user.click(screen.getByLabelText(/Unsigned updates/));
        await user.click(screen.getByLabelText(/Publish through this provider/));
        await user.click(screen.getByRole("button", { name: "Create DNS provider" }));

        await vi.waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0]).toEqual({
            name: "BIND",
            type: "rfc2136",
            zones: ["example.com"],
            options: {
                hosts: ["ns1.example.com", "192.0.2.53"],
                port: 5353,
                zone: "example.com",
                tsigAlgorithm: "hmac-sha1",
                insecure: true,
            },
            enabled: false,
            allowTakeover: false,
        });
    });

    it("leaves out options left empty, for the server to fill in or refuse", async () => {
        const posts = mockCreate();
        const user = userEvent.setup();
        renderPage();

        await user.selectOptions(await screen.findByLabelText("Type"), "rfc2136");
        await user.type(screen.getByLabelText("Name"), "BIND");
        await user.type(screen.getByLabelText("Zones"), "example.com");
        await user.clear(screen.getByLabelText("Port"));
        await user.click(screen.getByRole("button", { name: "Create DNS provider" }));
        await vi.waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0].options).toEqual({ tsigAlgorithm: "hmac-sha256", insecure: false });
    });

    it("offers a choice without a default as not set, and takes a key file's content in a text area", async () => {
        // Refused, so the page stays to be submitted again.
        const posts = mockCreate(() => jsonResponse(400, { message: "Refused." }));
        const user = userEvent.setup();
        renderPage();

        await user.selectOptions(await screen.findByLabelText("Type"), "google");
        expect(screen.getByLabelText("Visibility")).toHaveValue("");
        const keyFile = screen.getByLabelText("Service account key (JSON)");
        expect(keyFile.tagName).toBe("TEXTAREA");
        await user.type(screen.getByLabelText("Name"), "Google");
        await user.type(screen.getByLabelText("Zones"), "example.com");
        await user.type(screen.getByLabelText("Project ID"), "my-project");
        await user.type(keyFile, '{{"type": "service_account"}');
        await user.click(screen.getByRole("button", { name: "Create DNS provider" }));
        await vi.waitFor(() => expect(posts).toHaveLength(1));
        expect(posts[0].options).toEqual({ project: "my-project" });
        expect(posts[0].credentials).toEqual({ serviceAccountJson: '{"type": "service_account"}' });

        await user.selectOptions(screen.getByLabelText("Visibility"), "private");
        await user.click(screen.getByRole("button", { name: "Create DNS provider" }));
        await vi.waitFor(() => expect(posts).toHaveLength(2));
        expect(posts[1].options).toEqual({ project: "my-project", visibility: "private" });
    });

    it("asks for a name and a zone before sending anything", async () => {
        const posts = mockCreate();
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Create DNS provider" }));
        expect(await screen.findByText("A name is required.")).toBeInTheDocument();
        await user.type(screen.getByLabelText("Name"), "Cloudflare");
        await user.type(screen.getByLabelText("Zones"), "  \n ");
        await user.click(screen.getByRole("button", { name: "Create DNS provider" }));
        expect(await screen.findByText("Enter at least one zone.")).toBeInTheDocument();
        expect(posts).toEqual([]);
    });

    it("shows the server's refusal, and asks to confirm the administrator's identity when that is why", async () => {
        let answer: () => Response = () => jsonResponse(400, { message: "'zoneIds' must have one zone ID per zone, in the same order as 'zones'." });
        mockCreate(() => answer());
        const user = userEvent.setup();
        renderPage();

        await user.type(await screen.findByLabelText("Name"), "Cloudflare");
        await user.type(screen.getByLabelText("Zones"), "example.com");
        await user.click(screen.getByRole("button", { name: "Create DNS provider" }));
        expect(await screen.findByText("'zoneIds' must have one zone ID per zone, in the same order as 'zones'.")).toBeInTheDocument();

        answer = () => jsonResponse(403, { message: "Requires elevation.", code: "api-104" });
        await user.click(screen.getByRole("button", { name: "Create DNS provider" }));
        expect(await screen.findByText(/recently confirmed your identity/)).toBeInTheDocument();

        answer = () => {
            throw new TypeError("network down");
        };
        await user.click(screen.getByRole("button", { name: "Create DNS provider" }));
        expect(await screen.findByText("Could not save the DNS provider.")).toBeInTheDocument();
    });

    it("says why the form can't be shown", async () => {
        mockCreate(undefined, () => jsonResponse(500, { message: "Unavailable." }));
        renderPage();
        expect(await screen.findByText("Unavailable.")).toBeInTheDocument();
    });
});
