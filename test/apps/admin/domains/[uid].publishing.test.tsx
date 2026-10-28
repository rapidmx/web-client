// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The domain page's side of DNS publishing (spec dns_publishing_and_integrations.md, 9.4, 10.4 and 14): the DNS provider select, the checklist's
// "Published" column with "Take over", the root TXT opt-in with its keep list, the `_rapidmx-verify` hint and the openpgpkey warning.
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import DomainDetailPageBase from "../../../../apps/admin/domains/[uid].js";
import DomainApexTxt from "../../../../apps/shared/components/admin/settings/DomainApexTxt.js";
import { withTestRouter } from "../../routerTestUtils.js";

const DomainDetailPage = withTestRouter(DomainDetailPageBase);

afterEach(() => {
    vi.unstubAllGlobals();
});

const ELEVATION = { code: "api-104", message: "Requires elevation." };
const PROVIDER = "cloudflare-ab12cd34";

const domain = {
    uid: "example.com",
    version: 2,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    name: "example.com",
    enabled: true,
    verified: true,
    verificationToken: "tok123",
    dnsProviderUid: PROVIDER,
};

function provider(over: Record<string, unknown> = {}) {
    return {
        uid: PROVIDER,
        name: "Cloudflare",
        type: "cloudflare",
        zones: ["example.com"],
        options: {},
        credentials: {},
        enabled: true,
        allowTakeover: false,
        domainCount: 1,
        version: 1,
        ...over,
    };
}

function check(type: string, over: Record<string, unknown> = {}) {
    const kinds: Record<string, string> = { ownership: "TXT", mx: "MX", spf: "TXT", dkim: "TXT", dkim_next: "TXT", dkim_previous: "TXT", dmarc: "TXT", openpgpkey_cname: "CNAME" };
    return { type, recordKind: kinds[type], recordName: `${type}.example.com`, configured: true, recommendedValue: `value of ${type}`, found: true, matches: true, ...over };
}

interface Api {
    /** The domain's uid and name (default `example.com`). */
    uid?: string;
    domain?: Record<string, unknown> | (() => Record<string, unknown>);
    checks?: unknown[] | (() => unknown[]);
    /** What `GET /system/dns-providers` answers, or a response (a server that doesn't have the route: a 404). */
    providers?: unknown[] | Response;
    apex?: unknown | (() => Response | Promise<Response>);
    /** Answers to the writes, by `METHOD path`; a write not listed answers the domain. */
    writes?: Record<string, (body: any) => Response>;
}

/** Serves the admin shell's checks and the domain routes; every request is recorded in `calls`. */
function mockApi(api: Api = {}) {
    const calls: { method: string; url: string; body?: any }[] = [];
    const uid = api.uid ?? "example.com";
    const own = `/api/mail/domains/${uid}`;
    mockFetch((url, init) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/setup") return jsonResponse(200, { required: false });
        calls.push({ method, url: url.replace("/api", ""), body });
        const current = typeof api.domain === "function" ? api.domain() : (api.domain ?? { ...domain, uid, name: uid });
        if (method === "GET" && url === own) return jsonResponse(200, current);
        if (method === "GET" && url === `${own}/dns-setup`) return jsonResponse(200, typeof api.checks === "function" ? api.checks() : (api.checks ?? []));
        if (method === "GET" && url === "/api/system/dns-providers") {
            return api.providers instanceof Response ? api.providers.clone() : jsonResponse(200, api.providers ?? [provider()]);
        }
        if (method === "GET" && url === `${own}/apex-txt`) {
            return typeof api.apex === "function" ? api.apex() : jsonResponse(200, api.apex ?? { managed: false, keep: [], current: [], suggestedKeep: [] });
        }
        const write = api.writes?.[`${method} ${url.replace("/api", "")}`];
        if (write) return write(body);
        return jsonResponse(200, current);
    });
    return calls;
}

function renderPage(uid = "example.com") {
    return render(<DomainDetailPage userUid="admin-1" authServerUrl="https://auth.example.com" params={{ uid }} />);
}

/** The checklist's row for the record whose name is `name`. */
function row(name: string): HTMLElement {
    const table = within(screen.getByRole("table"));
    return table.getAllByText(name, { selector: "code" })[0].closest("tr") as HTMLElement;
}

describe("the Published column", () => {
    it("says beside each configured record whether it is published automatically or by hand, and why not", async () => {
        mockApi({
            checks: [
                check("mx", { publication: "published" }),
                check("dmarc", { publication: "pending", matches: false }),
                check("dkim", { publication: "conflict", matches: false, actualValue: "v=DKIM1; p=old" }),
                check("spf", { publication: "manual", manualReason: "apex_txt_unmanaged" }),
                check("openpgpkey_cname", { publication: "manual", manualReason: "kind_unsupported" }),
                check("ownership", { publication: "manual", manualReason: "outside_zones" }),
                check("dkim_next", { publication: "manual", manualReason: "no_provider", configured: true }),
                check("dkim_previous", { configured: false, found: false, matches: false, recommendedValue: undefined }),
            ],
        });
        renderPage();
        await screen.findByText("DNS setup checklist");

        const table = within(screen.getByRole("table"));
        expect(table.getByRole("columnheader", { name: "Published" })).toBeInTheDocument();
        expect(within(row("mx.example.com")).getByText("Automatic: published")).toBeInTheDocument();
        expect(within(row("dmarc.example.com")).getByText("Automatic: pending")).toBeInTheDocument();
        expect(within(row("dkim.example.com")).getByText("Automatic: conflict")).toBeInTheDocument();
        expect(within(row("spf.example.com")).getByText("Manual")).toBeInTheDocument();
        expect(within(row("spf.example.com")).getByText(/root TXT records, which you opt in to manage below/)).toBeInTheDocument();
        expect(within(row("openpgpkey_cname.example.com")).getByText(/can't hold this kind of record/)).toBeInTheDocument();
        expect(within(row("ownership.example.com")).getByText(/outside the zones of the DNS provider/)).toBeInTheDocument();
        expect(within(row("dkim_next.example.com")).getByText(/no DNS provider is assigned/i)).toBeInTheDocument();
        // A record that isn't configured yet has nothing to publish.
        expect(within(row("dkim_previous.example.com")).getByText("—", { selector: "td span" })).toBeInTheDocument();
    });

    it("shows a manual record without a reason when the server gives none", async () => {
        mockApi({ checks: [check("mx", { publication: "manual" })] });
        renderPage();
        await screen.findByText("DNS setup checklist");
        expect(within(row("mx.example.com")).getByText("Manual")).toBeInTheDocument();
        expect(within(row("mx.example.com")).queryByText(/provider/)).not.toBeInTheDocument();
    });

    it("labels the extra DKIM selectors a rotation publishes", async () => {
        mockApi({ checks: [check("dkim_next"), check("dkim_previous")] });
        renderPage();
        expect(await screen.findByText("DKIM (new key)")).toBeInTheDocument();
        expect(screen.getByText("DKIM (previous key)")).toBeInTheDocument();
    });

    it("leaves the column out when the server doesn't say how records are published", async () => {
        mockApi({ checks: [check("mx")] });
        renderPage();
        await screen.findByText("DNS setup checklist");
        expect(screen.queryByRole("columnheader", { name: "Published" })).not.toBeInTheDocument();
    });
});

describe("Take over", () => {
    const conflicting = [
        check("mx", { publication: "conflict", matches: false, actualValue: "5 old-mail.example.net", recommendedValue: "10 mail.example.com" }),
        check("spf", { publication: "conflict", matches: false, actualValue: "v=spf1 -all" }),
        check("dmarc", { publication: "conflict", matches: false }),
    ];

    it("shows the existing value next to the wanted one, and offers the takeover for every record but SPF", async () => {
        mockApi({ checks: conflicting });
        renderPage();
        await screen.findByText("DNS setup checklist");

        const mx = within(row("mx.example.com"));
        expect(mx.getByText("5 old-mail.example.net")).toBeInTheDocument();
        expect(mx.getByRole("button", { name: "Take over MX" })).toBeInTheDocument();
        expect(within(row("dmarc.example.com")).getByText(/this deployment doesn't own/)).toBeInTheDocument();
        expect(within(row("dmarc.example.com")).getByRole("button", { name: "Take over DMARC" })).toBeInTheDocument();
        // The root TXT set is taken over only through its own opt-in.
        expect(within(row("spf.example.com")).queryByRole("button", { name: /Take over/ })).not.toBeInTheDocument();
    });

    it("asks first, then queues the takeover of that record through the domain's provider and checks the list again", async () => {
        const user = userEvent.setup();
        const calls = mockApi({
            checks: conflicting,
            writes: { [`POST /system/dns-providers/${PROVIDER}/takeover`]: () => jsonResponse(200, { uid: "op1", type: "takeover", providerUid: PROVIDER, state: "queued" }) },
        });
        renderPage();
        await screen.findByText("DNS setup checklist");

        await user.click(within(row("mx.example.com")).getByRole("button", { name: "Take over MX" }));
        const dialog = within(screen.getByRole("dialog", { name: "Take over this record" }));
        expect(dialog.getByText(/overwrites the record at/)).toBeInTheDocument();
        expect(dialog.getByText("5 old-mail.example.net")).toBeInTheDocument();
        expect(dialog.getByText("10 mail.example.com")).toBeInTheDocument();
        expect(calls.some((call) => call.url.endsWith("/takeover"))).toBe(false);

        const before = calls.filter((call) => call.url.endsWith("/dns-setup")).length;
        await user.click(dialog.getByRole("button", { name: "Take over" }));

        await screen.findByText(/Takeover queued/);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(calls.find((call) => call.url.endsWith("/takeover"))).toEqual({
            method: "POST",
            url: `/system/dns-providers/${PROVIDER}/takeover`,
            body: { domainUid: "example.com", records: ["mx"] },
        });
        // The controller applies it later: the list is checked again on request, not at once.
        expect(calls.filter((call) => call.url.endsWith("/dns-setup")).length).toBe(before);
        await user.click(screen.getByRole("button", { name: "Check again" }));
        await waitFor(() => expect(calls.filter((call) => call.url.endsWith("/dns-setup")).length).toBe(before + 1));
        expect(screen.queryByText(/Takeover queued/)).not.toBeInTheDocument();
    });

    it("takes the queued record's button away until the list is checked again, and says where the result will be", async () => {
        const user = userEvent.setup();
        const calls = mockApi({ checks: conflicting, writes: { [`POST /system/dns-providers/${PROVIDER}/takeover`]: () => jsonResponse(200, { uid: "op1", type: "takeover" }) } });
        renderPage();
        await screen.findByText("DNS setup checklist");

        await user.click(within(row("mx.example.com")).getByRole("button", { name: "Take over MX" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Take over" }));
        await screen.findByText(/Takeover queued for the MX record/);

        // Once queued it can't be queued twice; the others still can.
        const queued = within(row("mx.example.com")).getByRole("button", { name: "Take over MX" });
        expect(queued).toBeDisabled();
        expect(queued).toHaveTextContent("Queued");
        expect(within(row("dmarc.example.com")).getByRole("button", { name: "Take over DMARC" })).toBeEnabled();
        expect(screen.getByRole("link", { name: "the DNS provider's page" })).toHaveAttribute("href", `/admin/integrations/dns-providers/${PROVIDER}`);

        await user.click(within(row("dmarc.example.com")).getByRole("button", { name: "Take over DMARC" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Take over" }));
        await screen.findByText(/Takeover queued for the MX, DMARC record/);
        expect(calls.filter((call) => call.url.endsWith("/takeover"))).toHaveLength(2);

        // Checking again offers the takeover once more, for a record still in conflict.
        await user.click(screen.getByRole("button", { name: "Check again" }));
        await waitFor(() => expect(within(row("mx.example.com")).getByRole("button", { name: "Take over MX" })).toBeEnabled());
    });

    it("says there is no existing value to show when the lookup found none, and cancelling queues nothing", async () => {
        const user = userEvent.setup();
        const calls = mockApi({ checks: conflicting });
        renderPage();
        await screen.findByText("DNS setup checklist");

        await user.click(within(row("dmarc.example.com")).getByRole("button", { name: "Take over DMARC" }));
        const dialog = within(screen.getByRole("dialog"));
        expect(dialog.getByText("(none found)")).toBeInTheDocument();
        await user.click(dialog.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(calls.some((call) => call.url.endsWith("/takeover"))).toBe(false);
    });

    it("keeps the dialog open with the server's reason when the takeover is refused, or needs the identity confirmed again", async () => {
        const user = userEvent.setup();
        let answer: Response = jsonResponse(400, { code: "api-100", message: "Not published through this DNS provider, so not taken over: mx." });
        mockApi({ checks: conflicting, writes: { [`POST /system/dns-providers/${PROVIDER}/takeover`]: () => answer.clone() } });
        renderPage();
        await screen.findByText("DNS setup checklist");

        await user.click(within(row("mx.example.com")).getByRole("button", { name: "Take over MX" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Take over" }));
        expect(await within(screen.getByRole("dialog")).findByText(/Not published through this DNS provider/)).toBeInTheDocument();

        answer = jsonResponse(403, ELEVATION);
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Take over" }));
        expect(await within(screen.getByRole("dialog")).findByText(/recently confirmed your identity/)).toBeInTheDocument();
        expect(screen.queryByText(/Takeover queued/)).not.toBeInTheDocument();
    });
});

describe("the ownership record", () => {
    it("says where to publish the token, and that the root value can go, while it is still at the domain's root", async () => {
        mockApi({ checks: [check("ownership", { recordName: "_rapidmx-verify.example.com", legacyApex: true })] });
        renderPage();
        expect(await screen.findByText(/Found at the domain's root \(the old location\)\. Publish it at/)).toBeInTheDocument();
        expect(screen.getByText(/the root value can then be removed/)).toBeInTheDocument();
        expect(screen.getAllByText("_rapidmx-verify.example.com", { selector: "strong" })).toHaveLength(1);
    });

    it("says nothing once it is at the new name", async () => {
        mockApi({ checks: [check("ownership", { recordName: "_rapidmx-verify.example.com" })] });
        renderPage();
        await screen.findByText("DNS setup checklist");
        expect(screen.queryByText(/the old location/)).not.toBeInTheDocument();
    });
});

describe("the openpgpkey warning", () => {
    it("warns that the host doesn't reach this server while it doesn't resolve to it", async () => {
        mockApi({ checks: [check("openpgpkey_cname", { recordName: "openpgpkey.example.com", found: false, matches: false })] });
        renderPage();
        const warning = await screen.findByRole("note", { name: "OpenPGP key host warning" });
        expect(warning).toHaveTextContent("openpgpkey.example.com doesn't resolve to this deployment yet");
        expect(warning).toHaveTextContent("Web Key Directory");
        expect(warning).not.toHaveTextContent("published automatically");
    });

    it("adds that it is being published when the provider is already on it", async () => {
        mockApi({ checks: [check("openpgpkey_cname", { recordName: "openpgpkey.example.com", found: true, matches: false, publication: "pending" })] });
        renderPage();
        expect(await screen.findByRole("note", { name: "OpenPGP key host warning" })).toHaveTextContent("It is being published automatically");
    });

    it("says nothing while it resolves to this deployment, or isn't configured", async () => {
        mockApi({ checks: [check("openpgpkey_cname", { recordName: "openpgpkey.example.com" })] });
        renderPage();
        await screen.findByText("DNS setup checklist");
        expect(screen.queryByRole("note", { name: "OpenPGP key host warning" })).not.toBeInTheDocument();
    });

    it("says nothing for a host with no mail server to point at", async () => {
        mockApi({ checks: [check("openpgpkey_cname", { configured: false, found: false, matches: false })] });
        renderPage();
        await screen.findByText("DNS setup checklist");
        expect(screen.queryByRole("note", { name: "OpenPGP key host warning" })).not.toBeInTheDocument();
    });
});

describe("the DNS provider select", () => {
    const nested = provider({ uid: "nested-1", name: "Nested", zones: ["mail.example.com"] });

    it("offers manual publishing and the provider whose zones cover the domain, with the one assigned selected", async () => {
        mockApi({ providers: [provider(), provider({ uid: "other-1", name: "Other", zones: ["example.net"] })] });
        renderPage();
        const select = await screen.findByRole("combobox", { name: "DNS provider" });
        expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Manual: I publish the records myself", "Cloudflare"]);
        expect(select).toHaveValue(PROVIDER);
        expect(screen.getByRole("button", { name: "Save DNS provider" })).toBeDisabled();
    });

    it("offers only the provider covering the domain most specifically, as the server accepts no other", async () => {
        mockApi({ uid: "mail.example.com", domain: { ...domain, uid: "mail.example.com", name: "mail.example.com", dnsProviderUid: null }, providers: [provider({ name: "Parent" }), nested] });
        renderPage("mail.example.com");
        const select = await screen.findByRole("combobox", { name: "DNS provider" });
        expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Manual: I publish the records myself", "Nested"]);
        expect(select).toHaveValue("");
    });

    it("keeps the assigned provider in the list when it is disabled or gone, saying so", async () => {
        mockApi({ providers: [provider({ enabled: false })] });
        const first = renderPage();
        const select = await screen.findByRole("combobox", { name: "DNS provider" });
        expect(within(select).getByRole("option", { name: "Cloudflare (disabled)" })).toBeInTheDocument();
        first.unmount();

        mockApi({ providers: [] });
        renderPage();
        const gone = await screen.findByRole("combobox", { name: "DNS provider" });
        expect(within(gone).getByRole("option", { name: `${PROVIDER} (no longer exists)` })).toBeInTheDocument();
        expect(gone).toHaveValue(PROVIDER);
    });

    it("assigns the chosen provider, then reloads the domain and its checklist", async () => {
        const user = userEvent.setup();
        let assigned: string | null = null;
        const calls = mockApi({
            domain: () => ({ ...domain, version: assigned ? 3 : 2, dnsProviderUid: assigned }),
            checks: () => [check("mx", { publication: assigned ? "pending" : "manual", manualReason: assigned ? undefined : "no_provider" })],
            writes: {
                "PUT /mail/domains/example.com/dns-provider": (body) => {
                    assigned = body.dnsProviderUid;
                    return jsonResponse(200, { ...domain, version: 3, dnsProviderUid: assigned });
                },
            },
        });
        // Starts as manual.
        assigned = null;
        renderPage();
        const select = await screen.findByRole("combobox", { name: "DNS provider" });
        expect(select).toHaveValue("");
        expect(screen.queryByText(/removes the records/)).not.toBeInTheDocument();

        await user.selectOptions(select, PROVIDER);
        await user.click(screen.getByRole("button", { name: "Save DNS provider" }));

        expect(await screen.findByText("Automatic: pending")).toBeInTheDocument();
        expect(calls.find((call) => call.method === "PUT")).toEqual({ method: "PUT", url: "/mail/domains/example.com/dns-provider", body: { dnsProviderUid: PROVIDER } });
        expect(screen.getByRole("combobox", { name: "DNS provider" })).toHaveValue(PROVIDER);
        expect(screen.getByText("Saved.")).toBeInTheDocument();
    });

    it("warns that leaving a provider removes the records it published, and sends null for manual", async () => {
        const user = userEvent.setup();
        const calls = mockApi({});
        renderPage();
        const select = await screen.findByRole("combobox", { name: "DNS provider" });
        await user.selectOptions(select, "");
        expect(screen.getByText(/removes the records the current provider published/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save DNS provider" }));
        await screen.findByText("Saved.");
        expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ dnsProviderUid: null });
    });

    it("shows the server's reason when the assignment is refused, or needs the identity confirmed again", async () => {
        const user = userEvent.setup();
        let answer: Response = jsonResponse(400, { code: "api-100", message: "'example.com' is covered more specifically by the zones of DNS provider 'Nested' (mail.example.com) - assign it there instead." });
        mockApi({ domain: { ...domain, dnsProviderUid: null }, writes: { "PUT /mail/domains/example.com/dns-provider": () => answer.clone() } });
        renderPage();
        const select = await screen.findByRole("combobox", { name: "DNS provider" });
        await user.selectOptions(select, PROVIDER);
        await user.click(screen.getByRole("button", { name: "Save DNS provider" }));
        expect(await screen.findByText(/covered more specifically/)).toBeInTheDocument();
        expect(screen.queryByText("Saved.")).not.toBeInTheDocument();

        answer = jsonResponse(403, ELEVATION);
        await user.click(screen.getByRole("button", { name: "Save DNS provider" }));
        expect(await screen.findByText(/recently confirmed your identity/)).toBeInTheDocument();
    });

    it("can't be changed while RapidMX manages the domain's root TXT records, which the provider must release first", async () => {
        mockApi({ domain: { ...domain, apexTxt: { managed: true, keep: [], spf: "v=spf1 mx ~all" } }, apex: { managed: true, keep: [], spf: "v=spf1 mx ~all", current: [], suggestedKeep: [] } });
        renderPage();
        const select = await screen.findByRole("combobox", { name: "DNS provider" });
        expect(select).toBeDisabled();
        expect(screen.getByText(/Stop managing the root TXT records first/)).toBeInTheDocument();
    });

    it("points to the DNS providers page when none exists yet", async () => {
        mockApi({ domain: { ...domain, dnsProviderUid: null }, providers: [] });
        renderPage();
        const link = await screen.findByRole("link", { name: "DNS providers" });
        expect(link).toHaveAttribute("href", "/admin/integrations/dns-providers");
        expect(screen.queryByRole("combobox", { name: "DNS provider" })).not.toBeInTheDocument();
    });

    it("is left out on a server without DNS providers", async () => {
        mockApi({ domain: { ...domain, dnsProviderUid: null }, providers: jsonResponse(404, { code: "api-404", message: "Not found" }) });
        renderPage();
        await screen.findByRole("heading", { name: "example.com" });
        await waitFor(() => expect(screen.queryByText("Loading…")).not.toBeInTheDocument());
        expect(screen.queryByRole("combobox", { name: "DNS provider" })).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "DNS providers" })).not.toBeInTheDocument();
    });
});

describe("the root TXT records", () => {
    const view = {
        managed: false,
        keep: [],
        current: ["v=spf1 include:_spf.google.com ~all", "google-site-verification=abc", "rapidmx-domain-verification=tok123"],
        suggestedKeep: ["google-site-verification=abc"],
    };
    const managedView = { managed: true, keep: ["google-site-verification=abc"], spf: "v=spf1 mx ~all", current: [], suggestedKeep: [] };

    it("is left out for a domain no provider publishes", async () => {
        const calls = mockApi({ domain: { ...domain, dnsProviderUid: null } });
        renderPage();
        await screen.findByRole("heading", { name: "example.com" });
        await screen.findByRole("combobox", { name: "DNS provider" });
        expect(screen.queryByText("Root TXT records")).not.toBeInTheDocument();
        expect(calls.some((call) => call.url.endsWith("/apex-txt"))).toBe(false);
    });

    it("lists what is at the root now and starts the values to keep from the suggestion", async () => {
        mockApi({ apex: view });
        renderPage();
        const keep = await screen.findByRole("textbox", { name: "Values to keep" });
        expect(keep).toHaveValue("google-site-verification=abc");
        const current = within(screen.getByRole("list", { name: "Current root TXT records" }));
        expect(current.getAllByRole("listitem")).toHaveLength(3);
        expect(current.getByText("v=spf1 include:_spf.google.com ~all")).toBeInTheDocument();
        expect(screen.getByText(/publishes nothing there unless you opt in/)).toBeInTheDocument();
    });

    it("opts in after showing what will be published and what will be removed, with the keep list as edited", async () => {
        const user = userEvent.setup();
        let managed = false;
        const calls = mockApi({
            domain: () => ({ ...domain, version: managed ? 3 : 2, apexTxt: managed ? { managed: true, keep: ["google-site-verification=abc", "MS=ms123"], spf: "v=spf1 mx ~all" } : null }),
            apex: () => jsonResponse(200, managed ? { ...managedView, keep: ["google-site-verification=abc", "MS=ms123"] } : view),
            writes: {
                "PUT /mail/domains/example.com/apex-txt": () => {
                    managed = true;
                    return jsonResponse(200, domain);
                },
            },
        });
        renderPage();
        const keep = await screen.findByRole("textbox", { name: "Values to keep" });
        await user.click(keep);
        await user.keyboard("{Control>}{End}{/Control}\n  MS=ms123  \n\n");
        await user.click(screen.getByRole("button", { name: "Manage the root TXT records" }));

        const dialog = within(screen.getByRole("dialog", { name: "Manage the root TXT records" }));
        // Published: the SPF value and the kept ones; removed: everything else there now, the old SPF and the ownership token included.
        expect(dialog.getByText(/v=spf1 mx ~all/)).toBeInTheDocument();
        expect(dialog.getByText("MS=ms123")).toBeInTheDocument();
        expect(dialog.getByText("v=spf1 include:_spf.google.com ~all")).toBeInTheDocument();
        expect(dialog.getByText("rapidmx-domain-verification=tok123")).toBeInTheDocument();
        expect(dialog.getByText(/removed within a minute/)).toBeInTheDocument();
        expect(calls.some((call) => call.method === "PUT")).toBe(false);

        await user.click(dialog.getByRole("button", { name: "Manage them" }));

        expect(await screen.findByText(/Values added at your DNS host are removed within a minute; add them here/)).toBeInTheDocument();
        expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ managed: true, keep: ["google-site-verification=abc", "MS=ms123"] });
        expect(screen.getByText("v=spf1 mx ~all")).toBeInTheDocument();
        expect(screen.getByRole("textbox", { name: "Values to keep" })).toHaveValue("google-site-verification=abc\nMS=ms123");
    });

    it("lists no removals when everything there is kept, and cancelling changes nothing", async () => {
        const user = userEvent.setup();
        const calls = mockApi({ apex: { managed: false, keep: [], current: ["google-site-verification=abc"], suggestedKeep: ["google-site-verification=abc"] } });
        renderPage();
        await screen.findByRole("textbox", { name: "Values to keep" });
        await user.click(screen.getByRole("button", { name: "Manage the root TXT records" }));
        const dialog = within(screen.getByRole("dialog"));
        expect(dialog.getByText("Nothing else is there to remove.")).toBeInTheDocument();
        await user.click(dialog.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(calls.some((call) => call.method === "PUT")).toBe(false);
    });

    it("keeps the dialog open with the server's reason when the opt-in is refused, or needs the identity confirmed again", async () => {
        const user = userEvent.setup();
        let answer: Response = jsonResponse(400, { code: "api-100", message: "A cloudflare DNS provider can't keep that." });
        mockApi({ apex: view, writes: { "PUT /mail/domains/example.com/apex-txt": () => answer.clone() } });
        renderPage();
        await screen.findByRole("textbox", { name: "Values to keep" });
        await user.click(screen.getByRole("button", { name: "Manage the root TXT records" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Manage them" }));
        expect(await within(screen.getByRole("dialog")).findByText(/can't keep that/)).toBeInTheDocument();

        answer = jsonResponse(403, ELEVATION);
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Manage them" }));
        expect(await within(screen.getByRole("dialog")).findByText(/recently confirmed your identity/)).toBeInTheDocument();
    });

    it("doesn't offer the opt-in when the root couldn't be looked up, and tries again on request", async () => {
        const user = userEvent.setup();
        let failed = true;
        const calls = mockApi({ apex: () => jsonResponse(200, failed ? { managed: false, keep: [], current: [], suggestedKeep: [], lookupFailed: true } : view) });
        renderPage();
        expect(await screen.findByText(/couldn't be looked up/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Manage the root TXT records" })).not.toBeInTheDocument();
        expect(screen.queryByRole("textbox", { name: "Values to keep" })).not.toBeInTheDocument();

        failed = false;
        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByRole("button", { name: "Manage the root TXT records" })).toBeInTheDocument();
        expect(calls.filter((call) => call.url.endsWith("/apex-txt"))).toHaveLength(2);
    });

    it("starts the keep list from the values kept before a stop too, which are not at the root until the restore has run", async () => {
        mockApi({ apex: { managed: false, keep: ["google-site-verification=abc", "MS=ms123"], spf: "v=spf1 mx ~all", current: [], suggestedKeep: ["other=1", "MS=ms123"] } });
        renderPage();
        expect(await screen.findByRole("textbox", { name: "Values to keep" })).toHaveValue("other=1\nMS=ms123\ngoogle-site-verification=abc");
    });

    it("lists what is at the root when the opt-in dialog opens, not when the page loaded, and waits for it", async () => {
        const user = userEvent.setup();
        let later: (response: Response) => void = vi.fn();
        let asked = 0;
        const calls = mockApi({
            apex: () => {
                asked++;
                return asked === 1 ? jsonResponse(200, view) : new Promise<Response>((resolve) => (later = resolve));
            },
        });
        renderPage();
        await screen.findByRole("textbox", { name: "Values to keep" });
        await user.click(screen.getByRole("button", { name: "Manage the root TXT records" }));

        const dialog = within(screen.getByRole("dialog", { name: "Manage the root TXT records" }));
        expect(dialog.getByText(/Checking what is at the root now/)).toBeInTheDocument();
        expect(dialog.getByRole("button", { name: "Manage them" })).toBeDisabled();
        later(jsonResponse(200, { ...view, current: [...view.current, "new-saas=verify"] }));

        expect(await dialog.findByText("new-saas=verify")).toBeInTheDocument();
        expect(dialog.queryByText(/Checking what is at the root now/)).not.toBeInTheDocument();
        expect(dialog.getByRole("button", { name: "Manage them" })).toBeEnabled();
        expect(calls.filter((call) => call.url.endsWith("/apex-txt"))).toHaveLength(2);
        // The keep list is the administrator's, whatever the new answer suggests.
        expect(screen.getByRole("textbox", { name: "Values to keep" })).toHaveValue("google-site-verification=abc");
    });

    it("closes the opt-in dialog when the root can't be looked up any more, or the values can't be read", async () => {
        const user = userEvent.setup();
        let asked = 0;
        mockApi({
            apex: () => {
                asked++;
                return asked === 1
                    ? jsonResponse(200, view)
                    : asked === 2
                      ? jsonResponse(200, { managed: false, keep: [], current: [], suggestedKeep: [], lookupFailed: true })
                      : jsonResponse(403, { code: "api-103", message: "Forbidden." });
            },
        });
        renderPage();
        await screen.findByRole("textbox", { name: "Values to keep" });
        await user.click(screen.getByRole("button", { name: "Manage the root TXT records" }));
        expect(await screen.findByText(/couldn't be looked up/)).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByText("Forbidden.")).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("keeps unsaved edits to the keep list when the domain is saved elsewhere on the page, and takes the newest answer over an older one", async () => {
        const user = userEvent.setup();
        const answers: ((response: Response) => void)[] = [];
        mockApi({ apex: () => (answers.length === 0 ? jsonResponse(200, managedView) : new Promise<Response>((resolve) => answers.push(resolve))) });
        const saved = { ...domain, apexTxt: managedView };
        const { rerender } = render(<DomainApexTxt domain={saved} onChanged={vi.fn()} />);
        const keep = await screen.findByRole("textbox", { name: "Values to keep" });
        await user.type(keep, "\nMS=ms123");

        // The version moves twice and the older answer comes last: the edit stays.
        answers.push(vi.fn());
        rerender(<DomainApexTxt domain={{ ...saved, version: 3 }} onChanged={vi.fn()} />);
        rerender(<DomainApexTxt domain={{ ...saved, version: 4 }} onChanged={vi.fn()} />);
        await waitFor(() => expect(answers).toHaveLength(3));
        await act(async () => {
            answers[2](jsonResponse(200, { ...managedView, keep: ["newest=1"] }));
            answers[1](jsonResponse(200, { ...managedView, keep: ["stale=1"] }));
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(screen.getByRole("textbox", { name: "Values to keep" })).toHaveValue("google-site-verification=abc\nMS=ms123");
    });

    it("takes the newest answer over an older one that comes last", async () => {
        const answers: ((response: Response) => void)[] = [];
        mockApi({ apex: () => (answers.length === 0 ? jsonResponse(200, managedView) : new Promise<Response>((resolve) => answers.push(resolve))) });
        const saved = { ...domain, apexTxt: managedView };
        const { rerender } = render(<DomainApexTxt domain={saved} onChanged={vi.fn()} />);
        await screen.findByRole("textbox", { name: "Values to keep" });
        answers.push(vi.fn());
        rerender(<DomainApexTxt domain={{ ...saved, version: 3 }} onChanged={vi.fn()} />);
        rerender(<DomainApexTxt domain={{ ...saved, version: 4 }} onChanged={vi.fn()} />);
        await waitFor(() => expect(answers).toHaveLength(3));
        answers[2](jsonResponse(200, { ...managedView, keep: ["newest=1"] }));
        await waitFor(() => expect(screen.getByRole("textbox", { name: "Values to keep" })).toHaveValue("newest=1"));
        await act(async () => {
            answers[1](jsonResponse(200, { ...managedView, keep: ["stale=1"] }));
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(screen.getByRole("textbox", { name: "Values to keep" })).toHaveValue("newest=1");
    });

    it("ignores the failure of an older request once a newer one has answered", async () => {
        const answers: ((response: Response) => void)[] = [];
        mockApi({ apex: () => (answers.length === 0 ? jsonResponse(200, managedView) : new Promise<Response>((resolve) => answers.push(resolve))) });
        const saved = { ...domain, apexTxt: managedView };
        const { rerender } = render(<DomainApexTxt domain={saved} onChanged={vi.fn()} />);
        await screen.findByRole("textbox", { name: "Values to keep" });
        answers.push(vi.fn());
        rerender(<DomainApexTxt domain={{ ...saved, version: 3 }} onChanged={vi.fn()} />);
        rerender(<DomainApexTxt domain={{ ...saved, version: 4 }} onChanged={vi.fn()} />);
        await waitFor(() => expect(answers).toHaveLength(3));
        await act(async () => {
            answers[2](jsonResponse(200, { ...managedView, keep: ["newest=1"] }));
            answers[1](jsonResponse(403, { code: "api-103", message: "Forbidden." }));
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(screen.getByRole("textbox", { name: "Values to keep" })).toHaveValue("newest=1");
        expect(screen.queryByText("Forbidden.")).not.toBeInTheDocument();
    });

    it("explains that an Azure provider keeps no values beside SPF, takes no keep list, and sends none", async () => {
        const user = userEvent.setup();
        const calls = mockApi({ providers: [provider({ type: "azure" })], apex: view });
        renderPage();
        expect(await screen.findByText(/An Azure DNS provider keeps one value per name/)).toBeInTheDocument();
        expect(screen.queryByRole("textbox", { name: "Values to keep" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Manage the root TXT records" }));
        const dialog = within(screen.getByRole("dialog"));
        expect(dialog.getByText("(none)")).toBeInTheDocument();
        expect(dialog.getByText("google-site-verification=abc")).toBeInTheDocument();
        await user.click(dialog.getByRole("button", { name: "Manage them" }));
        await waitFor(() => expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ managed: true, keep: [] }));
    });

    it("says an rfc2136 provider can't hold the set, and offers no opt-in", async () => {
        mockApi({ providers: [provider({ type: "rfc2136" })], apex: view });
        renderPage();
        expect(await screen.findByText(/An rfc2136 DNS provider can't keep the SPF value/)).toBeInTheDocument();
        expect(screen.getByRole("list", { name: "Current root TXT records" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Manage the root TXT records" })).not.toBeInTheDocument();
    });

    it("says an rfc2136 provider can't hold the set, with nothing to list when the root is empty", async () => {
        mockApi({ providers: [provider({ type: "rfc2136" })], apex: { managed: false, keep: [], current: [], suggestedKeep: [] } });
        renderPage();
        expect(await screen.findByText(/An rfc2136 DNS provider can't keep the SPF value/)).toBeInTheDocument();
        expect(screen.queryByRole("list", { name: "Current root TXT records" })).not.toBeInTheDocument();
    });

    it("leaves the decision to the server when the provider's type can't be read", async () => {
        mockApi({ providers: new Response("{}", { status: 404 }), apex: view });
        renderPage();
        expect(await screen.findByRole("textbox", { name: "Values to keep" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Manage the root TXT records" })).toBeInTheDocument();
    });

    it("shows the values it publishes and keeps while it manages the set, and saves an edit of the keep list", async () => {
        const user = userEvent.setup();
        const calls = mockApi({ domain: { ...domain, apexTxt: { managed: true, keep: ["google-site-verification=abc"], spf: "v=spf1 mx ~all" } }, apex: managedView });
        renderPage();
        const keep = await screen.findByRole("textbox", { name: "Values to keep" });
        expect(keep).toHaveValue("google-site-verification=abc");
        expect(screen.getByText("v=spf1 mx ~all")).toBeInTheDocument();
        expect(screen.getByText(/Values added at your DNS host are removed within a minute; add them here/)).toBeInTheDocument();
        expect(screen.queryByRole("list", { name: "Current root TXT records" })).not.toBeInTheDocument();
        const save = screen.getByRole("button", { name: "Save values to keep" });
        expect(save).toBeDisabled();

        await user.clear(keep);
        await user.type(keep, "MS=ms123");
        await user.click(save);

        await screen.findByText("Saved.");
        expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ managed: true, keep: ["MS=ms123"] });
    });

    it("shows the server's reason when the edit is refused, or needs the identity confirmed again", async () => {
        const user = userEvent.setup();
        let answer: Response = jsonResponse(400, { code: "api-100", message: "'keep' can't hold an SPF record." });
        mockApi({ domain: { ...domain, apexTxt: managedView }, apex: managedView, writes: { "PUT /mail/domains/example.com/apex-txt": () => answer.clone() } });
        renderPage();
        const keep = await screen.findByRole("textbox", { name: "Values to keep" });
        await user.type(keep, "\nv=spf1 -all");
        await user.click(screen.getByRole("button", { name: "Save values to keep" }));
        expect(await screen.findByText(/can't hold an SPF record/)).toBeInTheDocument();

        answer = jsonResponse(403, ELEVATION);
        await user.click(screen.getByRole("button", { name: "Save values to keep" }));
        expect(await screen.findByText(/recently confirmed your identity/)).toBeInTheDocument();
    });

    it("stops managing the set after saying that the SPF value and the kept ones come back as plain records", async () => {
        const user = userEvent.setup();
        let managed = true;
        const calls = mockApi({
            domain: () => ({ ...domain, version: managed ? 2 : 3, apexTxt: { ...managedView, managed } }),
            apex: () => jsonResponse(200, { ...managedView, managed }),
            writes: {
                "PUT /mail/domains/example.com/apex-txt": () => {
                    managed = false;
                    return jsonResponse(200, domain);
                },
            },
        });
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Stop managing" }));
        const dialog = within(screen.getByRole("dialog", { name: "Stop managing the root TXT records" }));
        expect(dialog.getByText("v=spf1 mx ~all")).toBeInTheDocument();
        expect(dialog.getByText("google-site-verification=abc")).toBeInTheDocument();
        expect(dialog.getByText(/missing for a few minutes/)).toBeInTheDocument();
        await user.click(dialog.getByRole("button", { name: "Stop managing" }));

        expect(await screen.findByText(/RapidMX no longer manages/)).toBeInTheDocument();
        expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ managed: false });
        // What was restored stays on the row, and is shown.
        expect(await screen.findByText("Restored when RapidMX stopped managing them")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Manage the root TXT records" })).toBeInTheDocument();
    });

    it("shows the server's reason when stopping is refused, or needs the identity confirmed again", async () => {
        const user = userEvent.setup();
        let answer: Response = jsonResponse(503, { code: "api-503", message: "DNS operations aren't available on this server." });
        mockApi({ domain: { ...domain, apexTxt: managedView }, apex: managedView, writes: { "PUT /mail/domains/example.com/apex-txt": () => answer.clone() } });
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Stop managing" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop managing" }));
        expect(await within(screen.getByRole("dialog")).findByText(/aren't available on this server/)).toBeInTheDocument();

        answer = jsonResponse(403, ELEVATION);
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Stop managing" }));
        expect(await within(screen.getByRole("dialog")).findByText(/recently confirmed your identity/)).toBeInTheDocument();
        // Cancelling closes it.
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("says why when the values can't be read", async () => {
        mockApi({ apex: () => jsonResponse(403, { code: "api-103", message: "Forbidden." }) });
        renderPage();
        expect(await screen.findByText("Forbidden.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Manage the root TXT records" })).not.toBeInTheDocument();
    });
});

describe("closing a dialog", () => {
    it("with its close button asks nothing of the server, for the takeover and for both root TXT dialogs", async () => {
        const user = userEvent.setup();
        const managedView = { managed: true, keep: ["a=b"], spf: "v=spf1 mx ~all", current: [], suggestedKeep: [] };
        const calls = mockApi({
            checks: [check("mx", { publication: "conflict", matches: false })],
            apex: { managed: false, keep: [], current: ["a=b"], suggestedKeep: ["a=b"] },
        });
        const first = renderPage();
        await screen.findByText("DNS setup checklist");
        await user.click(within(row("mx.example.com")).getByRole("button", { name: "Take over MX" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        await user.click(await screen.findByRole("button", { name: "Manage the root TXT records" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        first.unmount();

        mockApi({ domain: { ...domain, apexTxt: managedView }, apex: managedView });
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Stop managing" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(calls.filter((call) => call.method !== "GET" && call.url.startsWith("/"))).toEqual([]);
    });
});
