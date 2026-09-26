// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../testUtils.js";
import SetupPageBase from "../../../../apps/admin/setup/index.js";
import { latestRouter, withTestRouter } from "../../routerTestUtils.js";

// Rendered inside a router: what the page does after a save is navigate through it (see routerTestUtils.tsx).
const SetupPage = withTestRouter(SetupPageBase);

const domain = {
    uid: "example.com",
    version: 0,
    name: "example.com",
    enabled: true,
    verified: false,
    verificationToken: "tok",
};
const mailbox = (uid: string, ownerUserUid?: string) => ({
    uid,
    version: 0,
    ownerUserUid,
    primarySmtpAddress: `${uid}@example.com`,
    displayName: uid,
    timezone: "UTC",
    quotaBytes: 1,
    usedBytes: 0,
    aliasAddresses: [],
});

type Handler = (url: string, init?: RequestInit) => Response | undefined;

interface Options {
    currentStep?: string;
    domains?: unknown[];
    encryption?: Record<string, string>;
    mailboxes?: unknown[];
    extra?: Handler;
}

function mockSetup(options: Options = {}) {
    const domains = [...(options.domains ?? [])];
    return mockFetch((url, init) => {
        const method = init?.method ?? "GET";
        const custom = options.extra?.(url, init);
        if (custom) return custom;
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/setup" && method === "GET") return jsonResponse(200, { required: true, currentStep: options.currentStep });
        if (url === "/api/system/setup" && method === "PUT") return jsonResponse(200, { required: true, currentStep: JSON.parse(init.body as string).currentStep });
        if (url === "/api/system/setup/complete") return jsonResponse(200, { required: false });
        if (url.startsWith("/api/mail/domains?")) return jsonResponse(200, domains);
        if (url === "/api/mail/domains" && method === "POST") {
            const created = { ...domain, uid: JSON.parse(init.body as string).name, name: JSON.parse(init.body as string).name };
            domains.push(created);
            return jsonResponse(200, created);
        }
        if (url.startsWith("/api/mail/domains/") && url.endsWith("/dns-setup")) return jsonResponse(200, []);
        if (url.startsWith("/api/mail/domains/")) return jsonResponse(200, domains.find((d: any) => url.endsWith(encodeURIComponent(d.uid))) ?? domain);
        if (url === "/api/system/plugins") return jsonResponse(200, []);
        if (url === "/api/system/plugins/status") return jsonResponse(200, { hash: "h", instances: [] });
        if (url === "/api/system/encryption-policy") {
            return jsonResponse(200, options.encryption ?? { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" });
        }
        if (url === "/api/system/retention-policy") return jsonResponse(200, {});
        if (url === "/api/system/mailbox-policy") return jsonResponse(200, { defaultQuotaBytes: 2_000_000_000, autoProvisionEnabled: false, autoProvisionQuotaBytes: 1_000_000_000 });
        if (url.startsWith("/api/escrow/scopes")) return jsonResponse(200, []);
        if (url === "/api/system/branding") return jsonResponse(200, { companyName: "", title: "" });
        if (url.startsWith("/api/mail/mailboxes/domains")) return jsonResponse(200, ["example.com"]);
        if (url.startsWith("/api/mail/mailboxes/resolve-owner")) {
            const principal = new URL(url, "http://test.invalid").searchParams.get("principal");
            return jsonResponse(200, { userUid: principal, displayName: "Administrator", address: "admin@example.com" });
        }
        if (url.startsWith("/api/mail/mailboxes?")) return jsonResponse(200, options.mailboxes ?? []);
        throw new Error(`unexpected ${method} ${url}`);
    });
}

function calls(fetchMock: any, url: string, method: string): any[] {
    return fetchMock.mock.calls.filter((c: any[]) => c[0] === url && ((c[1] as RequestInit)?.method ?? "GET") === method);
}

afterEach(() => {
    vi.unstubAllGlobals();
});

const renderPage = () => render(<SetupPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

describe("SetupPage", () => {
    it("sends a signed-out visitor to sign in instead of showing the wizard", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/admin/setup";
        const fetchMock = mockSetup();
        render(<SetupPage authServerUrl="https://auth.example.com" />);
        await waitFor(() => expect(location.href).toMatch(/^https:\/\/auth\.example\.com\/auth\/signin\?return_to=/));
        expect(screen.queryByRole("heading", { name: /Step 1 of 6/ })).not.toBeInTheDocument();
        expect(calls(fetchMock, "/api/system/setup", "GET")).toHaveLength(0);
    });

    it("starts at the plugins step and requires a domain before moving past the domain step", async () => {
        const fetchMock = mockSetup();
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByRole("heading", { name: "Step 1 of 6: Plugins" })).toBeInTheDocument();
        expect(await screen.findByText("No plugins installed.")).toBeInTheDocument();
        // The plugins manager is embedded under the step's heading, without the Plugins page's own title.
        expect(screen.queryByRole("heading", { level: 1, name: "Plugins" })).not.toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 3, name: "Installed plugins" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add by name" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
        // Steps after the domain can't be jumped to until a domain exists.
        expect(screen.getByRole("button", { name: "3. Server settings" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(await screen.findByRole("heading", { name: "Step 2 of 6: Domain" })).toBeInTheDocument();
        expect(JSON.parse(calls(fetchMock, "/api/system/setup", "PUT")[0][1].body)).toEqual({ currentStep: "domain" });
        expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
        expect(screen.getByText("Add a domain to continue.")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Add domain" }));
        expect(await screen.findByText("A domain name is required.")).toBeInTheDocument();

        await user.type(screen.getByLabelText("Domain name"), "example.com");
        await user.click(screen.getByRole("button", { name: "Add domain" }));
        expect(await screen.findByText(/to prove ownership, then verify/)).toBeInTheDocument();
        expect(screen.getByLabelText("Add another domain")).toHaveValue("");
        expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();

        await user.click(screen.getByRole("button", { name: "Back" }));
        expect(await screen.findByRole("heading", { name: "Step 1 of 6: Plugins" })).toBeInTheDocument();
    });

    it("shows an error when adding the domain fails", async () => {
        mockSetup({
            currentStep: "domain",
            extra: (url, init) => (url === "/api/mail/domains" && init?.method === "POST" ? jsonResponse(409, { message: "That domain already exists." }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        await user.type(await screen.findByLabelText("Domain name"), "example.com");
        await user.click(screen.getByRole("button", { name: "Add domain" }));
        expect(await screen.findByText("That domain already exists.")).toBeInTheDocument();
    });

    it("shows a generic error when adding the domain fails with a non-API error", async () => {
        mockSetup({
            currentStep: "domain",
            extra: (url, init) => {
                if (url === "/api/mail/domains" && init?.method === "POST") throw new TypeError("network down");
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.type(await screen.findByLabelText("Domain name"), "example.com");
        await user.click(screen.getByRole("button", { name: "Add domain" }));
        expect(await screen.findByText("Could not add the domain.")).toBeInTheDocument();
    });

    it("still offers escrow when the encryption policy can't be read", async () => {
        mockSetup({
            currentStep: "escrow",
            domains: [domain],
            extra: (url) => (url === "/api/system/encryption-policy" ? jsonResponse(500, { message: "Policy unavailable" }) : undefined),
        });
        renderPage();
        expect(await screen.findByRole("heading", { name: "Step 4 of 6: Escrow" })).toBeInTheDocument();
        expect(await screen.findByText("How do you want to set up escrow?")).toBeInTheDocument();
        expect(screen.queryByText(/End-to-end encryption is turned off/)).not.toBeInTheDocument();
        // Only the step itself is headed "Escrow".
        expect(screen.queryByRole("heading", { name: "Escrow" })).not.toBeInTheDocument();
    });

    it("resumes at the saved step, and shows every server setting on the settings step", async () => {
        mockSetup({ currentStep: "settings", domains: [domain] });
        renderPage();
        expect(await screen.findByRole("heading", { name: "Step 3 of 6: Server settings" })).toBeInTheDocument();
        expect(await screen.findByLabelText("Mail within this server")).toBeInTheDocument();
        expect(await screen.findByText("Message retention (days)")).toBeInTheDocument();
        expect(await screen.findByLabelText("Default quota (GB)")).toHaveValue(2);
        // Each policy form is a section of the step rather than a page of its own.
        expect(screen.getByRole("heading", { level: 3, name: "End-to-end encryption" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 3, name: "Retention policy" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 3, name: "Mailboxes" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { level: 1, name: "Retention Policy" })).not.toBeInTheDocument();
        // The steps before it are marked done.
        expect(screen.getByRole("button", { name: /^1\. Plugins\s*\(done\)$/ })).toBeEnabled();
        expect(screen.getByRole("button", { name: /^2\. Domain\s*\(done\)$/ })).toBeEnabled();
        expect(screen.getByRole("button", { name: "4. Escrow" })).toBeEnabled();
    });

    it("falls back to the first step when the saved step is unknown or status can't load", async () => {
        mockSetup({ currentStep: "nonsense", domains: [domain] });
        const { unmount } = renderPage();
        expect(await screen.findByRole("heading", { name: "Step 1 of 6: Plugins" })).toBeInTheDocument();
        unmount();

        mockSetup({ extra: (url, init) => (url === "/api/system/setup" && !init?.method ? jsonResponse(500, {}) : undefined) });
        renderPage();
        expect(await screen.findByRole("heading", { name: "Step 1 of 6: Plugins" })).toBeInTheDocument();
    });

    it("skips escrow when end-to-end encryption is turned off everywhere", async () => {
        mockSetup({ currentStep: "escrow", domains: [domain], encryption: { encryptSameOrg: "prohibited", encryptFederated: "prohibited", encryptExternal: "prohibited" } });
        renderPage();
        expect(await screen.findByText(/End-to-end encryption is turned off, so escrow isn.t needed/)).toBeInTheDocument();
    });

    it("offers escrow when encryption is allowed, and tracks the policy saved on the settings step", async () => {
        let encryption = { encryptSameOrg: "prohibited", encryptFederated: "prohibited", encryptExternal: "prohibited" };
        mockSetup({
            currentStep: "settings",
            domains: [domain],
            extra: (url, init) => {
                if (url !== "/api/system/encryption-policy") return undefined;
                if (init?.method === "PUT") encryption = { ...encryption, ...JSON.parse(init.body as string) };
                return jsonResponse(200, encryption);
            },
        });
        const user = userEvent.setup();
        renderPage();
        await user.selectOptions(await screen.findByLabelText("Mail within this server"), "automatic");
        const encryptionForm = screen.getByLabelText("Mail within this server").closest("form") as HTMLElement;
        await user.click(within(encryptionForm).getByRole("button", { name: "Save" }));
        expect(await within(encryptionForm.parentElement as HTMLElement).findByText("Saved.")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(await screen.findByRole("heading", { name: "Step 4 of 6: Escrow" })).toBeInTheDocument();
        expect(await screen.findByText("How do you want to set up escrow?")).toBeInTheDocument();
    });

    it("shows branding on the branding step", async () => {
        mockSetup({ currentStep: "branding", domains: [domain] });
        renderPage();
        expect(await screen.findByRole("heading", { name: "Step 5 of 6: Branding" })).toBeInTheDocument();
        expect(await screen.findByLabelText("Company name")).toBeInTheDocument();
        // The step introduces branding, so the Branding page's title and introduction are left out.
        expect(screen.queryByRole("heading", { level: 1, name: "Branding" })).not.toBeInTheDocument();
        expect(screen.queryByText(/Customize the logo/)).not.toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 3, name: "Logo" })).toBeInTheDocument();
    });

    it("creates the admin's own mailbox first, then more, and finishes setup", async () => {
        const created: unknown[] = [];
        const fetchMock = mockSetup({
            currentStep: "mailboxes",
            domains: [{ ...domain, verified: true }],
            extra: (url, init) => {
                if (url === "/api/mail/mailboxes" && init?.method === "POST") {
                    const body = JSON.parse(init.body as string);
                    const row = { ...mailbox(body.primarySmtpAddress.split("@")[0], body.ownerUserUid), displayName: body.displayName, primarySmtpAddress: body.primarySmtpAddress };
                    created.push(body);
                    return jsonResponse(200, row);
                }
                return undefined;
            },
        });
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByRole("heading", { name: "Your mailbox" })).toBeInTheDocument();
        // The mailboxes that exist are asked for through the administration scope (metadata), not only the administrator's own.
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes?limit=100&page=0&scope=admin", expect.anything());
        expect(await screen.findByLabelText("Local part")).toHaveValue("admin");
        expect(screen.getByLabelText("Display name")).toHaveValue("Administrator");
        // The admin's own uid is looked up and shown automatically (it's the trusted `defaults` prop, not
        // something typed) but, like any other resolved principal, still needs an explicit confirm before it's used.
        expect(await screen.findByLabelText("Mailbox owner")).toHaveValue("admin-1");
        expect(await screen.findByText("Administrator <admin@example.com>")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Use this owner" }));
        await waitFor(() => expect(screen.getByLabelText("Quota (GB)")).toHaveValue(2));

        await user.click(screen.getByRole("button", { name: "Create mailbox" }));
        expect(await screen.findByRole("heading", { name: "Add another mailbox" })).toBeInTheDocument();
        expect(screen.getByText(/Administrator <admin@example.com>/)).toBeInTheDocument();
        expect(screen.getByText("(yours)")).toBeInTheDocument();
        expect(created[0]).toEqual(expect.objectContaining({ primarySmtpAddress: "admin@example.com", ownerUserUid: "admin-1", quotaBytes: 2_000_000_000 }));
        expect(screen.getByLabelText("Local part")).toHaveValue("");

        await user.click(screen.getByRole("button", { name: "Finish setup" }));
        await waitFor(() => expect(latestRouter().navigate.mock.lastCall?.[0]).toBe("/admin"));
        expect(calls(fetchMock, "/api/system/setup/complete", "POST")).toHaveLength(1);
    });

    it("asks before leaving the settings step with unsaved changes", async () => {
        mockSetup({ currentStep: "settings", domains: [domain] });
        const user = userEvent.setup();
        renderPage();
        const quota = await screen.findByLabelText("Default quota (GB)");
        await user.clear(quota);
        await user.type(quota, "5");

        await user.click(screen.getByRole("button", { name: "Continue" }));
        const dialog = await screen.findByRole("dialog", { name: "Discard unsaved changes?" });
        await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
        expect(screen.getByRole("heading", { name: "Step 3 of 6: Server settings" })).toBeInTheDocument();
        expect(screen.getByLabelText("Default quota (GB)")).toHaveValue(5);

        // Closing the dialog keeps editing too.
        await user.click(screen.getByRole("button", { name: "Continue" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Step 3 of 6: Server settings" })).toBeInTheDocument();

        // Choosing the step already shown does nothing - in particular it doesn't forget the unsaved edits.
        await user.click(within(screen.getByRole("list", { name: "Setup steps" })).getByRole("button", { name: /Server settings/ }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Continue" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Discard unsaved changes?" })).getByRole("button", { name: "Keep editing" }));
        expect(screen.getByLabelText("Default quota (GB)")).toHaveValue(5);

        // Once saved, there's nothing to lose.
        const mailboxForm = quota.closest("form") as HTMLElement;
        await user.click(within(mailboxForm).getByRole("button", { name: "Save" }));
        expect(await within(mailboxForm.parentElement as HTMLElement).findByText("Saved.")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(await screen.findByRole("heading", { name: "Step 4 of 6: Escrow" })).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Back" }));
        await user.type(await screen.findByLabelText("Message retention (days)"), "30");
        await user.click(screen.getByRole("button", { name: "Back" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard changes" }));
        expect(await screen.findByRole("heading", { name: "Step 2 of 6: Domain" })).toBeInTheDocument();
    });

    it("shows why domains couldn't load, retries, and needs a domain to finish", async () => {
        let domainsFail = true;
        mockSetup({
            currentStep: "mailboxes",
            extra: (url) => {
                if (!url.startsWith("/api/mail/domains?")) return undefined;
                return domainsFail ? jsonResponse(500, { message: "Domains are unavailable." }) : jsonResponse(200, [domain]);
            },
        });
        const user = userEvent.setup();
        renderPage();
        expect(await screen.findByText("Domains are unavailable.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Finish setup" })).toBeDisabled();
        expect(screen.getByText("Add a domain before finishing setup.")).toBeInTheDocument();

        domainsFail = false;
        await user.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Finish setup" })).toBeEnabled());
        expect(screen.queryByText("Domains are unavailable.")).not.toBeInTheDocument();
    });

    it("lists each existing mailbox once, even when the list is loaded twice (React strict mode)", async () => {
        mockSetup({ currentStep: "mailboxes", domains: [domain], mailboxes: [mailbox("admin", "admin-1"), mailbox("ops")] });
        render(
            <React.StrictMode>
                <SetupPage userUid="admin-1" authServerUrl="https://auth.example.com" />
            </React.StrictMode>,
        );
        expect(await screen.findByRole("heading", { name: "Add another mailbox" })).toBeInTheDocument();
        await waitFor(() => expect(screen.getAllByText(/<ops@example\.com>/)).toHaveLength(1));
        expect(screen.getAllByText(/<admin@example\.com>/)).toHaveLength(1);
    });

    it("says when the existing mailboxes couldn't be loaded", async () => {
        mockSetup({
            currentStep: "mailboxes",
            domains: [domain],
            extra: (url) => (url.startsWith("/api/mail/mailboxes?") ? jsonResponse(500, { message: "Mailboxes are unavailable." }) : undefined),
        });
        renderPage();
        expect(await screen.findByText(/Mailboxes are unavailable\. Check the Mailboxes page before creating your own/)).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Your mailbox" })).toBeInTheDocument();
    });

    it("records steps one at a time, skipping ones already passed, and notes when it can't", async () => {
        const releases: (() => void)[] = [];
        let fail = false;
        const fetchMock = mockSetup({
            currentStep: "plugins",
            domains: [domain],
            extra: ((url: string, init?: RequestInit) => {
                if (url !== "/api/system/setup" || init?.method !== "PUT") return undefined;
                const body = JSON.parse(init.body as string);
                return new Promise<Response>((resolve) =>
                    releases.push(() => resolve(fail ? jsonResponse(500, {}) : jsonResponse(200, { required: true, currentStep: body.currentStep }))),
                );
            }) as Handler,
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "3. Server settings" }));
        await user.click(screen.getByRole("button", { name: "4. Escrow" }));
        await user.click(screen.getByRole("button", { name: "5. Branding" }));
        const puts = () => calls(fetchMock, "/api/system/setup", "PUT").map((c) => JSON.parse(c[1].body).currentStep);
        expect(puts()).toEqual(["settings"]);

        fail = true;
        releases[0]();
        await waitFor(() => expect(puts()).toEqual(["settings", "branding"]));
        releases[1]();
        expect(await screen.findByText("Your place in setup couldn’t be saved.")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Step 5 of 6: Branding" })).toBeInTheDocument();
        warn.mockRestore();
    });

    it("offers a way out of setup only when it isn't required", async () => {
        mockSetup({ extra: (url, init) => (url === "/api/system/setup" && !init?.method ? jsonResponse(200, { required: false, completedAt: "2026-01-01" }) : undefined) });
        const { unmount } = renderPage();
        expect(await screen.findByRole("link", { name: "Exit setup" })).toHaveAttribute("href", "/admin");
        unmount();

        mockSetup();
        renderPage();
        expect(await screen.findByRole("heading", { name: "Step 1 of 6: Plugins" })).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Exit setup" })).not.toBeInTheDocument();
    });

    it("shows an error when finishing fails", async () => {
        mockSetup({
            currentStep: "mailboxes",
            domains: [domain],
            mailboxes: [mailbox("admin", "admin-1")],
            extra: (url) => (url === "/api/system/setup/complete" ? jsonResponse(500, { message: "Try again" }) : undefined),
        });
        const user = userEvent.setup();
        renderPage();
        await user.click(await screen.findByRole("button", { name: "Finish setup" }));
        expect(await screen.findByText("Try again")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Finish setup" })).toBeEnabled();
    });
});
