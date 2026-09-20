// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import MailboxPolicyPage from "../../../../apps/admin/mailbox-policy/index.js";

const policy = { defaultQuotaBytes: 5_000_000_000, autoProvisionEnabled: false, autoProvisionQuotaBytes: 2_500_000_000 };

function mockPolicy(put?: (body: any) => Response, get: Response = jsonResponse(200, policy)) {
    return mockFetch((url, init) => {
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/setup") return jsonResponse(200, { required: false });
        if (url === "/api/system/mailbox-policy" && init?.method === "PUT") return put!(JSON.parse(init.body as string));
        if (url === "/api/system/mailbox-policy") return get;
        throw new Error(`unexpected ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

const renderPage = () => render(<MailboxPolicyPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

describe("MailboxPolicyPage", () => {
    it("shows quotas in GB and saves them in bytes, revealing the self-created quota only when enabled", async () => {
        const saved: any[] = [];
        mockPolicy((body) => {
            saved.push(body);
            return jsonResponse(200, body);
        });
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByLabelText("Default quota (GB)")).toHaveValue(5);
        expect(screen.queryByLabelText("Quota for self-created mailboxes (GB)")).not.toBeInTheDocument();
        await user.click(screen.getByLabelText(/Let people create their own mailbox/));
        expect(screen.getByLabelText("Quota for self-created mailboxes (GB)")).toHaveValue(2.5);

        await user.clear(screen.getByLabelText("Default quota (GB)"));
        await user.type(screen.getByLabelText("Default quota (GB)"), "10");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        // Only what changed is sent.
        expect(saved).toEqual([{ defaultQuotaBytes: 10_000_000_000, autoProvisionEnabled: true }]);
    });

    it("saves an edited self-created mailbox quota, and shows a generic error for a non-API failure", async () => {
        let fail = false;
        const saved: any[] = [];
        mockPolicy((body) => {
            if (fail) throw new TypeError("network down");
            saved.push(body);
            return jsonResponse(200, body);
        }, jsonResponse(200, { ...policy, autoProvisionEnabled: true }));
        const user = userEvent.setup();
        renderPage();

        const autoQuota = await screen.findByLabelText("Quota for self-created mailboxes (GB)");
        await user.clear(autoQuota);
        await user.type(autoQuota, "3");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(saved).toEqual([{ autoProvisionQuotaBytes: 3_000_000_000 }]);

        fail = true;
        await user.type(autoQuota, "5");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Could not save the mailbox policy.")).toBeInTheDocument();
    });

    it("rejects a quota of zero without saving", async () => {
        const put = vi.fn();
        mockPolicy(put);
        const user = userEvent.setup();
        renderPage();
        await user.clear(await screen.findByLabelText("Default quota (GB)"));
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Quotas must be more than 0 GB.")).toBeInTheDocument();
        expect(put).not.toHaveBeenCalled();
    });

    it("shows small and unrounded quotas exactly, and keeps a quota's stored bytes when saving something else", async () => {
        const saved: any[] = [];
        mockPolicy(
            (body) => {
                saved.push(body);
                return jsonResponse(200, { defaultQuotaBytes: 4_000_000, autoProvisionEnabled: true, autoProvisionQuotaBytes: 1_073_741_824, ...body });
            },
            jsonResponse(200, { defaultQuotaBytes: 4_000_000, autoProvisionEnabled: false, autoProvisionQuotaBytes: 1_073_741_824 }),
        );
        const user = userEvent.setup();
        renderPage();
        expect(await screen.findByLabelText("Default quota (GB)")).toHaveValue(0.004);

        // Nothing changed: nothing to send.
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(saved).toEqual([]);

        await user.click(screen.getByLabelText(/Let people create their own mailbox/));
        expect(screen.getByLabelText("Quota for self-created mailboxes (GB)")).toHaveValue(1.073741824);
        await user.click(screen.getByRole("button", { name: "Save" }));
        await vi.waitFor(() => expect(saved).toEqual([{ autoProvisionEnabled: true }]));
    });

    it("offers to reset a field to the server's config value, and saves the reset like any other edit", async () => {
        const saved: any[] = [];
        const defaults = { defaultQuotaBytes: 5_000_000_000, autoProvisionEnabled: false, autoProvisionQuotaBytes: 2_500_000_000 };
        mockPolicy(
            (body) => {
                saved.push(body);
                return jsonResponse(200, { ...current, ...body, defaults });
            },
            jsonResponse(200, { defaultQuotaBytes: 10_000_000_000, autoProvisionEnabled: true, autoProvisionQuotaBytes: 1_000_000_000, defaults }),
        );
        const current = { defaultQuotaBytes: 10_000_000_000, autoProvisionEnabled: true, autoProvisionQuotaBytes: 1_000_000_000 };
        const user = userEvent.setup();
        renderPage();

        expect(await screen.findByLabelText("Default quota (GB)")).toHaveValue(10);
        await user.click(screen.getByRole("button", { name: "Reset to server default (5 GB)" }));
        expect(screen.getByLabelText("Default quota (GB)")).toHaveValue(5);
        // Back on the config value, so there is nothing left to reset.
        expect(screen.queryByRole("button", { name: "Reset to server default (5 GB)" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Reset to server default (2.5 GB)" }));
        expect(screen.getByLabelText("Quota for self-created mailboxes (GB)")).toHaveValue(2.5);

        await user.click(screen.getByRole("button", { name: "Reset to server default (off)" }));
        expect(screen.getByLabelText(/Let people create their own mailbox/)).not.toBeChecked();
        expect(screen.queryByLabelText("Quota for self-created mailboxes (GB)")).not.toBeInTheDocument();

        // Nothing is saved until the form is.
        expect(saved).toEqual([]);
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(saved).toEqual([{ defaultQuotaBytes: 5_000_000_000, autoProvisionQuotaBytes: 2_500_000_000, autoProvisionEnabled: false }]);
    });

    it("offers no reset for a field already at the config value, or when the server reports no defaults", async () => {
        const defaults = { defaultQuotaBytes: 5_000_000_000, autoProvisionEnabled: true, autoProvisionQuotaBytes: 2_500_000_000 };
        mockPolicy(undefined, jsonResponse(200, { ...defaults, autoProvisionEnabled: true, defaults }));
        const { unmount } = renderPage();
        await screen.findByLabelText("Default quota (GB)");
        expect(screen.queryByRole("button", { name: /Reset to server default/ })).not.toBeInTheDocument();

        // A change of the checkbox alone offers its own reset, phrased with the config value ("on").
        await userEvent.setup().click(screen.getByLabelText(/Let people create their own mailbox/));
        expect(screen.getByRole("button", { name: "Reset to server default (on)" })).toBeInTheDocument();
        unmount();

        mockPolicy(undefined, jsonResponse(200, { defaultQuotaBytes: 10_000_000_000, autoProvisionEnabled: true, autoProvisionQuotaBytes: 1_000_000_000 }));
        renderPage();
        await screen.findByLabelText("Default quota (GB)");
        expect(screen.queryByRole("button", { name: /Reset to server default/ })).not.toBeInTheDocument();
    });

    it("shows load and save errors", async () => {
        mockPolicy(() => jsonResponse(400, { message: "Too big" }));
        const user = userEvent.setup();
        const { unmount } = renderPage();
        await user.click(await screen.findByLabelText(/Let people create their own mailbox/));
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Too big")).toBeInTheDocument();
        unmount();

        mockPolicy(undefined, jsonResponse(500, { message: "Policy unavailable" }));
        renderPage();
        expect(await screen.findByText("Policy unavailable")).toBeInTheDocument();
    });
});
