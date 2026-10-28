// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../../../testUtils.js";
import DnsProviderPageBase from "../../../../../apps/admin/integrations/dns-providers/[uid].js";
import { latestRouter, withTestRouter } from "../../../routerTestUtils.js";
import { cloudflareProvider, MASK, providerTypes } from "../fixtures.js";

const DnsProviderPage = withTestRouter(DnsProviderPageBase);

beforeEach(() => {
    // Two minutes after the fixture's report: recent enough to be believed.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T10:02:00.000Z") });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const route53Provider = {
    ...cloudflareProvider,
    uid: "route-53-k2j3h4g5",
    name: "Route 53",
    type: "route53",
    zones: ["example.net"],
    options: { region: "eu-west-1", zoneType: "public" },
    credentials: { accessKeyId: MASK, secretAccessKey: MASK },
    origin: "installer",
    domainCount: 0,
};

const queuedTest = {
    uid: "op-1",
    type: "test",
    providerUid: "cloudflare-ab12cd34",
    state: "queued",
    dateCreated: "2026-10-27T10:05:00.000Z",
};

const queuedTakeover = {
    uid: "op-2",
    type: "takeover",
    providerUid: "cloudflare-ab12cd34",
    endpointSetId: "hosts-cloudflare-ab12cd34",
    state: "queued",
    dateCreated: "2026-10-27T10:05:00.000Z",
};

const host = (recordName: string, recordKind: string, over: Record<string, unknown> = {}) => ({
    type: recordKind === "CNAME" ? "host_cname" : "host_a",
    recordName,
    recordKind,
    state: "published",
    providerUid: "cloudflare-ab12cd34",
    ...over,
});

interface Handlers {
    hosts?: () => Response | Promise<Response>;
    takeover?: (body: any) => Response;
    provider?: () => Response;
    types?: () => Response;
    operations?: () => Response;
    put?: (body: any) => Response;
    test?: () => Response;
    remove?: () => Response;
}

function mockProvider(provider: any, handlers: Handlers = {}) {
    const calls: { method: string; url: string; body?: any }[] = [];
    mockFetch((url, init) => {
        const method = init?.method ?? "GET";
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/setup") return jsonResponse(200, { required: false });
        calls.push({ method, url, ...(init?.body ? { body: JSON.parse(init.body as string) } : {}) });
        const base = `/api/system/dns-providers/${provider.uid}`;
        if (url === "/api/system/dns-providers/types") {
            return handlers.types ? handlers.types() : jsonResponse(200, providerTypes);
        }
        if (url === "/api/system/dns-providers/hosts") return handlers.hosts ? handlers.hosts() : jsonResponse(200, []);
        if (url === `${base}/takeover` && method === "POST") {
            return handlers.takeover ? handlers.takeover(JSON.parse(init.body as string)) : jsonResponse(200, queuedTakeover);
        }
        if (url === `${base}/operations`) return handlers.operations ? handlers.operations() : jsonResponse(200, []);
        if (url === `${base}/test` && method === "POST") {
            return handlers.test ? handlers.test() : jsonResponse(200, queuedTest);
        }
        if (url === base && method === "PUT") {
            return handlers.put ? handlers.put(JSON.parse(init.body as string)) : jsonResponse(200, provider);
        }
        if (url === base && method === "DELETE") return handlers.remove ? handlers.remove() : emptyResponse(204);
        if (url === base) return handlers.provider ? handlers.provider() : jsonResponse(200, provider);
        throw new Error(`unexpected ${method} ${url}`);
    });
    return calls;
}

const renderPage = (uid: string = cloudflareProvider.uid) =>
    render(<DnsProviderPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid }} />);

describe("DnsProviderPage", () => {
    it("shows the config with its type fixed, its status and its credentials only as set", async () => {
        mockProvider(cloudflareProvider);
        renderPage();

        expect(await screen.findByRole("heading", { name: "Cloudflare" })).toBeInTheDocument();
        expect(screen.queryByLabelText("Type")).not.toBeInTheDocument();
        expect(screen.getByText("Type: Cloudflare")).toBeInTheDocument();
        expect(screen.getByText("Status: Running")).toBeInTheDocument();
        expect(screen.getByText(/Publishing 2 domains/)).toBeInTheDocument();
        expect(screen.getByLabelText("Name")).toHaveValue("Cloudflare");
        expect(screen.getByLabelText("Zones")).toHaveValue("example.com\nexample.org");
        expect(screen.getByLabelText("Zone IDs")).toHaveValue("0123456789abcdef0123456789abcdef\nfedcba9876543210fedcba9876543210");
        expect(screen.queryByLabelText("API token")).not.toBeInTheDocument();
        expect(screen.getByText("Set")).toBeInTheDocument();
        // A required credential can be replaced, never removed.
        expect(screen.getByRole("button", { name: "Replace API token" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Remove API token" })).not.toBeInTheDocument();
        expect(await screen.findByText("No operations yet.")).toBeInTheDocument();
    });

    it("says a credential the server can't read is set but must be entered again, for every such field", async () => {
        const unreadable = { secret: true, unreadable: true };
        const calls = mockProvider({ ...route53Provider, credentials: { accessKeyId: MASK, secretAccessKey: unreadable } });
        const user = userEvent.setup();
        renderPage(route53Provider.uid);

        expect(await screen.findByText("Set, but can't be read: enter it again")).toBeInTheDocument();
        // The readable one beside it is simply set.
        expect(screen.getAllByText("Set")).toHaveLength(1);
        // Saving without entering it again leaves it (and the other) alone.
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(calls.find((call) => call.method === "PUT")?.body).not.toHaveProperty("credentials");

        await user.click(screen.getByRole("button", { name: "Replace Secret access key" }));
        await user.type(screen.getByLabelText("Secret access key"), "entered-again");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2));
        expect(calls.filter((call) => call.method === "PUT")[1].body.credentials).toEqual({ secretAccessKey: "entered-again" });
    });

    it("says the one credential of a config the server can't read must be entered again", async () => {
        mockProvider({ ...cloudflareProvider, credentials: { apiToken: { secret: true, unreadable: true } } });
        renderPage();

        expect(await screen.findByText("Set, but can't be read: enter it again")).toBeInTheDocument();
        expect(screen.queryByText("Set")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Replace API token" })).toBeInTheDocument();
    });

    it("saves an edit without touching the credentials, then a replaced credential", async () => {
        const calls = mockProvider(cloudflareProvider, {
            put: (body) => jsonResponse(200, { ...cloudflareProvider, ...body, credentials: { apiToken: MASK }, version: 5 }),
        });
        const user = userEvent.setup();
        renderPage();

        await user.clear(await screen.findByLabelText("Name"));
        await user.type(screen.getByLabelText("Name"), "Cloudflare main");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Cloudflare main" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Replace API token" }));
        await user.type(screen.getByLabelText("API token"), "rotated-token");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2));
        const [first, second] = calls.filter((call) => call.method === "PUT").map((call) => call.body);
        expect(first).toEqual({
            name: "Cloudflare main",
            zones: ["example.com", "example.org"],
            options: { zoneIds: ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"] },
            enabled: true,
            allowTakeover: false,
            version: 4,
        });
        // The second is made against the version the first answered, and carries only the replaced credential.
        expect(second).toMatchObject({ credentials: { apiToken: "rotated-token" }, version: 5 });
        // After saving, the credential is shown as set again.
        expect(await screen.findByRole("button", { name: "Replace API token" })).toBeInTheDocument();
    });

    describe("a save refused for a newer version", () => {
        const refused = () => jsonResponse(409, { message: "This DNS provider was changed by someone else. Reload it and try again." });

        // The page's first read answers the provider, later ones `latest`; the first PUTs are refused, the rest answered with the body they carry.
        function mockRefusal(latest: () => Response, refusals = 1) {
            let reads = 0;
            let puts = 0;
            const calls = mockProvider(cloudflareProvider, {
                provider: () => (reads++ === 0 ? jsonResponse(200, cloudflareProvider) : latest()),
                put: (body) => (puts++ < refusals ? refused() : jsonResponse(200, { ...cloudflareProvider, ...body, credentials: { apiToken: MASK } })),
            });
            return () => calls.filter((call) => call.method === "PUT").map((call) => call.body.version);
        }

        it("saves again against the new version when only the controller's status moved it", async () => {
            const versions = mockRefusal(() => jsonResponse(200, { ...cloudflareProvider, version: 6, status: { ...cloudflareProvider.status, readyReplicas: 0 } }));
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Replace API token" }));
            await user.type(screen.getByLabelText("API token"), "rotated-token");
            await user.click(screen.getByRole("button", { name: "Save" }));
            expect(await screen.findByText("Saved.")).toBeInTheDocument();
            expect(versions()).toEqual([4, 6]);
        });

        it("keeps the entries and the new version when someone else changed the config, and replaces their change on the next save", async () => {
            const versions = mockRefusal(() => jsonResponse(200, { ...cloudflareProvider, name: "Renamed elsewhere", version: 6 }));
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Replace API token" }));
            await user.type(screen.getByLabelText("API token"), "rotated-token");
            await user.click(screen.getByRole("button", { name: "Save" }));
            expect(await screen.findByText(/changed by someone else. Your entries are kept/)).toBeInTheDocument();
            expect(screen.getByLabelText("API token")).toHaveValue("rotated-token");
            expect(screen.getByLabelText("Name")).toHaveValue("Cloudflare");

            await user.click(screen.getByRole("button", { name: "Save" }));
            expect(await screen.findByText("Saved.")).toBeInTheDocument();
            expect(versions()).toEqual([4, 6]);
        });

        it("shows the server's message when the version is still the same, or the config can't be read again", async () => {
            let latest: () => Response = () => jsonResponse(200, cloudflareProvider);
            const versions = mockRefusal(() => latest(), 2);
            const user = userEvent.setup();
            renderPage();

            await user.click(await screen.findByRole("button", { name: "Save" }));
            expect(await screen.findByText("This DNS provider was changed by someone else. Reload it and try again.")).toBeInTheDocument();
            expect(versions()).toEqual([4]);

            latest = () => jsonResponse(500, { message: "Database unavailable." });
            await user.click(screen.getByRole("button", { name: "Save" }));
            await vi.waitFor(() => expect(versions()).toEqual([4, 4]));
            expect(screen.getByText("This DNS provider was changed by someone else. Reload it and try again.")).toBeInTheDocument();
            expect(screen.queryByText("Database unavailable.")).not.toBeInTheDocument();
        });
    });

    it("removes an optional credential, or keeps it after all", async () => {
        const calls = mockProvider(route53Provider, {
            put: () => jsonResponse(400, { message: "'accessKeyId' and 'secretAccessKey' must be set together, or neither." }),
        });
        const user = userEvent.setup();
        renderPage(route53Provider.uid);

        expect(await screen.findByText("Added by the installer")).toBeInTheDocument();
        expect(screen.getByText("Not yet live-tested")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Remove Access key ID" }));
        expect(screen.getByText("Removed when you save.")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Undo removing Access key ID" }));
        expect(screen.queryByText("Removed when you save.")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Remove Access key ID" }));
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("'accessKeyId' and 'secretAccessKey' must be set together, or neither.")).toBeInTheDocument();
        expect(calls.find((call) => call.method === "PUT")?.body.credentials).toEqual({ accessKeyId: null });
    });

    it("shows a provider's last error and when it last synchronized", async () => {
        mockProvider({
            ...cloudflareProvider,
            domainCount: 1,
            status: {
                readyReplicas: 0,
                lastError: "Authentication error (10000)",
                lastSyncAt: "2026-10-27T09:00:00.000Z",
            },
        });
        renderPage();
        expect(await screen.findByText("Status: Error")).toBeInTheDocument();
        expect(screen.getByText("Authentication error (10000)")).toBeInTheDocument();
        expect(screen.getByText(/Last synchronized/)).toBeInTheDocument();
        expect(screen.getByText("Publishing 1 domain.")).toBeInTheDocument();
    });

    it("shows the status as unknown when the DNS controller last reported on it too long ago", async () => {
        vi.setSystemTime(new Date("2026-10-28T10:00:00.000Z"));
        mockProvider({
            ...cloudflareProvider,
            status: {
                readyReplicas: 1,
                lastError: "Authentication error (10000)",
                reportedAt: "2026-10-27T10:00:00.000Z",
            },
        });
        renderPage();
        expect(await screen.findByText("Status: Unknown")).toBeInTheDocument();
        expect(screen.getByText(/The DNS controller hasn't reported on it since .*; it may be down\./)).toBeInTheDocument();
        expect(screen.queryByText("Authentication error (10000)")).not.toBeInTheDocument();
    });

    it("tests the connection through the DNS controller and lists the operation", async () => {
        const calls = mockProvider(cloudflareProvider, {
            operations: () =>
                jsonResponse(200, [
                    {
                        uid: "op-0",
                        type: "takeover",
                        providerUid: "cloudflare-ab12cd34",
                        state: "succeeded",
                        domainUid: "example.com",
                        message: "Took over 3 records.",
                        dateCreated: "2026-10-26T10:00:00.000Z",
                        finishedAt: "2026-10-26T10:01:00.000Z",
                    },
                    {
                        uid: "op-r",
                        type: "restore",
                        providerUid: "cloudflare-ab12cd34",
                        state: "failed",
                        message: "Cancelled: the opt-out could not be saved.",
                    },
                    {
                        uid: "op-x",
                        type: "test",
                        providerUid: "cloudflare-ab12cd34",
                        state: "running",
                        startedAt: "2026-10-27T10:00:00.000Z",
                    },
                ]),
        });
        const user = userEvent.setup();
        renderPage();

        const operations = await screen.findByRole("table", { name: "Recent operations" });
        expect(within(operations).getByText("Took over 3 records.")).toBeInTheDocument();
        expect(within(operations).getByText("Take over (example.com)")).toBeInTheDocument();
        expect(within(operations).getByText("Restore")).toBeInTheDocument();
        expect(within(operations).getByText("Failed")).toBeInTheDocument();
        expect(within(operations).getByText("Running")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Test connection" }));
        expect(await screen.findByText(/The DNS controller runs the test and reports the result here/)).toBeInTheDocument();
        expect(within(operations).getByText("Queued")).toBeInTheDocument();
        expect(within(operations).getAllByText("Connection test")).toHaveLength(2);
        expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/test"))).toBe(true);
    });

    it("refreshes the operations and says why they can't be shown", async () => {
        let operations: () => Response = () => jsonResponse(503, { message: "DNS operations aren't available on this server." });
        mockProvider(cloudflareProvider, { operations: () => operations() });
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByText("DNS operations aren't available on this server.")).toBeInTheDocument();
        operations = () => jsonResponse(200, [queuedTest]);
        await user.click(screen.getByRole("button", { name: "Refresh" }));
        expect(await screen.findByText("Queued")).toBeInTheDocument();
        expect(screen.queryByText("DNS operations aren't available on this server.")).not.toBeInTheDocument();
    });

    it("says why a connection test wasn't queued", async () => {
        mockProvider(cloudflareProvider, {
            test: () => jsonResponse(403, { message: "Requires elevation.", code: "api-104" }),
        });
        const user = userEvent.setup();
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Test connection" }));
        expect(await screen.findByText(/recently confirmed your identity/)).toBeInTheDocument();
    });

    it("deletes the config after confirming, and goes back to the list", async () => {
        const calls = mockProvider(route53Provider);
        const user = userEvent.setup();
        renderPage(route53Provider.uid);

        await user.click(await screen.findByRole("button", { name: "Delete DNS provider" }));
        const dialog = screen.getByRole("dialog");
        expect(within(dialog).getByText(/own host names are removed from your DNS host/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Delete DNS provider" }));
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Delete DNS provider" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
        await vi.waitFor(() => expect(latestRouter().navigate.mock.lastCall?.[0]).toBe("/admin/integrations/dns-providers"));
        expect(calls.some((call) => call.method === "DELETE")).toBe(true);
    });

    it("keeps the dialog open with the server's reason when the config can't be deleted", async () => {
        let remove: () => Response = () =>
            jsonResponse(409, {
                message: "2 domain(s), such as 'example.com', are assigned to this DNS provider - assign them elsewhere first.",
            });
        mockProvider(cloudflareProvider, { remove: () => remove() });
        const user = userEvent.setup();
        renderPage();

        // A config publishing domains says that they must be moved first.
        await user.click(await screen.findByRole("button", { name: "Delete DNS provider" }));
        expect(within(screen.getByRole("dialog")).getByText(/domains are assigned to it \(2 domains\)/)).toBeInTheDocument();
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
        expect(await within(screen.getByRole("dialog")).findByText(/assign them elsewhere first/)).toBeInTheDocument();

        remove = () => {
            throw new TypeError("network down");
        };
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
        expect(await within(screen.getByRole("dialog")).findByText("Could not delete the DNS provider.")).toBeInTheDocument();
    });

    it("says why the config can't be shown", async () => {
        mockProvider(cloudflareProvider, { provider: () => jsonResponse(404, { message: "Not Found" }) });
        renderPage();
        expect(await screen.findByText("Not Found")).toBeInTheDocument();
    });

    it("falls back to a generic message", async () => {
        mockProvider(cloudflareProvider, {
            types: () => {
                throw new TypeError("network down");
            },
        });
        renderPage();
        expect(await screen.findByText("Could not load the DNS provider.")).toBeInTheDocument();
    });

    it("shows a config of a type this console doesn't know without its form", async () => {
        mockProvider({ ...cloudflareProvider, type: "webhook" });
        renderPage();
        expect(await screen.findByText("Type: webhook")).toBeInTheDocument();
        expect(screen.getByText(/This console doesn’t know this type/)).toBeInTheDocument();
        expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Delete DNS provider" })).toBeInTheDocument();
    });
});

describe("the deployment's hosts", () => {
    const hosts = [
        host("mail.example.com", "A", { state: "published" }),
        host("auth.example.com", "CNAME", {
            state: "conflict",
            conflictReason: "type_mismatch",
            existing: [
                { type: "A", value: "203.0.113.7" },
                { type: "AAAA", value: "2001:db8::7" },
            ],
        }),
        host("autodiscover.example.com", "CNAME", { state: "conflict", conflictReason: "not_owned" }),
        host("openpgpkey.example.com", "CNAME", { state: "pending" }),
        host("other.example.net", "A", { state: "conflict", conflictReason: "not_owned", providerUid: "someone-else" }),
        host("mx.example.org", "A", { state: "manual", manualReason: "no_addresses" }),
        host("target.example.org", "CNAME", { state: "manual", manualReason: "no_target" }),
        host("zone.example.org", "A", { state: "manual", manualReason: "outside_zones" }),
    ];

    it("lists only the hosts this config publishes, with each one's state", async () => {
        mockProvider(cloudflareProvider, { hosts: () => jsonResponse(200, hosts) });
        renderPage();

        const table = within(await screen.findByRole("table", { name: "Host names" }));
        expect(table.getByText("mail.example.com")).toBeInTheDocument();
        expect(table.queryByText("other.example.net")).not.toBeInTheDocument();
        expect(within(table.getByText("mail.example.com").closest("tr")!).getByText("Published")).toBeInTheDocument();
        expect(within(table.getByText("openpgpkey.example.com").closest("tr")!).getByText("Pending")).toBeInTheDocument();
        expect(within(table.getByText("mx.example.org").closest("tr")!).getByText(/no public address/i)).toBeInTheDocument();
        expect(within(table.getByText("target.example.org").closest("tr")!).getByText(/no mail host/i)).toBeInTheDocument();
        expect(within(table.getByText("zone.example.org").closest("tr")!).getByText(/outside the zones/i)).toBeInTheDocument();
    });

    it("shows the records to delete for a type mismatch, and never a takeover for it", async () => {
        mockProvider(cloudflareProvider, { hosts: () => jsonResponse(200, hosts) });
        renderPage();

        const authRow = (await screen.findByText("auth.example.com")).closest("tr")!;
        expect(within(authRow).getByText(/Records of another type are in the way/)).toBeInTheDocument();
        expect(within(authRow).getByText("A 203.0.113.7")).toBeInTheDocument();
        expect(within(authRow).getByText("AAAA 2001:db8::7")).toBeInTheDocument();
        expect(within(authRow).queryByRole("button")).not.toBeInTheDocument();
    });

    it("asks first, then queues a takeover of the hosts that are not owned and nothing else", async () => {
        const user = userEvent.setup();
        const calls = mockProvider(cloudflareProvider, { hosts: () => jsonResponse(200, hosts) });
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Take over host names" }));
        const dialog = within(screen.getByRole("dialog", { name: "Take over host names" }));
        expect(dialog.getByText("autodiscover.example.com")).toBeInTheDocument();
        expect(dialog.queryByText("auth.example.com")).not.toBeInTheDocument();
        expect(calls.some((call) => call.url.endsWith("/takeover"))).toBe(false);

        await user.click(dialog.getByRole("button", { name: "Take over" }));
        expect(await screen.findByText(/Takeover queued/)).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(calls.find((call) => call.url.endsWith("/takeover"))).toMatchObject({
            method: "POST",
            body: { hosts: true, records: ["autodiscover.example.com"] },
        });
        expect(screen.getByRole("button", { name: "Take over host names" })).toBeDisabled();
    });

    it("keeps the dialog open with the server's reason when the takeover is refused, and cancelling queues nothing", async () => {
        const user = userEvent.setup();
        const calls = mockProvider(cloudflareProvider, {
            hosts: () => jsonResponse(200, hosts),
            takeover: () => jsonResponse(400, { code: "api-100", message: "There is no host of this DNS provider to take over." }),
        });
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Take over host names" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Take over" }));
        expect(await within(screen.getByRole("dialog")).findByText(/no host of this DNS provider/)).toBeInTheDocument();
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.queryByText(/Takeover queued/)).not.toBeInTheDocument();
        expect(calls.filter((call) => call.url.endsWith("/takeover"))).toHaveLength(1);
    });

    it("offers no takeover when nothing is in conflict", async () => {
        mockProvider(cloudflareProvider, { hosts: () => jsonResponse(200, [host("mail.example.com", "A")]) });
        renderPage();
        await screen.findByRole("table", { name: "Host names" });
        expect(screen.queryByRole("button", { name: "Take over host names" })).not.toBeInTheDocument();
    });

    it("says nothing on a server without the route, or for a config that publishes no host", async () => {
        mockProvider(cloudflareProvider, { hosts: () => jsonResponse(404, { code: "api-404", message: "Not found" }) });
        const { unmount } = renderPage();
        await screen.findByText("No operations yet.");
        expect(screen.queryByRole("table", { name: "Host names" })).not.toBeInTheDocument();
        expect(screen.queryByText(/Host names/)).not.toBeInTheDocument();
        unmount();

        mockProvider(cloudflareProvider, { hosts: () => jsonResponse(200, [host("mail.example.com", "A", { providerUid: "someone-else" })]) });
        renderPage();
        await screen.findByText("No operations yet.");
        expect(screen.queryByRole("table", { name: "Host names" })).not.toBeInTheDocument();
    });

    it("never names a host in the takeover when one of its records is of another type", async () => {
        const user = userEvent.setup();
        const calls = mockProvider(cloudflareProvider, {
            hosts: () =>
                jsonResponse(200, [
                    host("mail.example.com", "A", { state: "conflict", conflictReason: "not_owned" }),
                    host("mail.example.com", "AAAA", { state: "conflict", conflictReason: "type_mismatch", existing: [{ type: "CNAME", value: "x.example.net" }] }),
                    host("autodiscover.example.com", "CNAME", { state: "conflict", conflictReason: "not_owned" }),
                ]),
        });
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Take over host names" }));
        const dialog = within(screen.getByRole("dialog", { name: "Take over host names" }));
        await user.click(dialog.getByRole("button", { name: "Take over" }));
        await screen.findByText(/Takeover queued/);
        expect(calls.find((call) => call.url.endsWith("/takeover"))?.body).toEqual({ hosts: true, records: ["autodiscover.example.com"] });
    });

    it("reloads on Refresh, clearing the queued note, and closes the dialog on Cancel", async () => {
        const user = userEvent.setup();
        let state = "conflict";
        const calls = mockProvider(cloudflareProvider, { hosts: () => jsonResponse(200, [host("mail.example.com", "A", { state, conflictReason: "not_owned" })]) });
        renderPage();

        await user.click(await screen.findByRole("button", { name: "Take over host names" }));
        await user.click(within(screen.getByRole("dialog", { name: "Take over host names" })).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Take over host names" }));
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

        await user.click(screen.getByRole("button", { name: "Take over host names" }));
        await user.click(within(screen.getByRole("dialog", { name: "Take over host names" })).getByRole("button", { name: "Take over" }));
        await screen.findByText(/Takeover queued/);
        const before = calls.filter((call) => call.url.endsWith("/hosts")).length;

        state = "published";
        await user.click(within((await screen.findByRole("table", { name: "Host names" })).closest("section")!).getByRole("button", { name: "Refresh" }));
        await waitFor(() => expect(screen.queryByText(/Takeover queued/)).not.toBeInTheDocument());
        await waitFor(() => expect(screen.queryByRole("button", { name: "Take over host names" })).not.toBeInTheDocument());
        expect(calls.filter((call) => call.url.endsWith("/hosts")).length).toBe(before + 1);
    });

    it.each([
        ["a host list", () => jsonResponse(200, [host("mail.example.com", "A")])],
        ["a failure", () => jsonResponse(500, { code: "api-500", message: "late boom" })],
    ])("ignores %s that arrives after the page was left", async (_name, late) => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const calls = mockProvider(cloudflareProvider, { hosts: () => gate.then(late) });
        const { unmount } = renderPage();
        await screen.findByRole("heading", { name: "Cloudflare" });
        unmount();
        release();
        await waitFor(() => expect(calls.some((call) => call.url.endsWith("/hosts"))).toBe(true));
        await new Promise((resolve) => setTimeout(resolve, 20));
    });

    it("reports a failure to load the hosts", async () => {
        mockProvider(cloudflareProvider, { hosts: () => jsonResponse(500, { code: "api-500", message: "boom" }) });
        renderPage();
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("names a hosts takeover in the operations list", async () => {
        mockProvider(cloudflareProvider, { operations: () => jsonResponse(200, [queuedTakeover]) });
        renderPage();
        expect(await screen.findByText("Take over (host names)")).toBeInTheDocument();
    });
});
