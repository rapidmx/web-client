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
        expect(saved).toEqual([{ defaultQuotaBytes: 10_000_000_000, autoProvisionEnabled: true, autoProvisionQuotaBytes: 2_500_000_000 }]);
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
        expect(saved).toEqual([{ defaultQuotaBytes: 5_000_000_000, autoProvisionEnabled: true, autoProvisionQuotaBytes: 3_000_000_000 }]);

        fail = true;
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

    it("shows load and save errors", async () => {
        mockPolicy(() => jsonResponse(400, { message: "Too big" }));
        const user = userEvent.setup();
        const { unmount } = renderPage();
        await user.click(await screen.findByRole("button", { name: "Save" }));
        expect(await screen.findByText("Too big")).toBeInTheDocument();
        unmount();

        mockPolicy(undefined, jsonResponse(500, { message: "Policy unavailable" }));
        renderPage();
        expect(await screen.findByText("Policy unavailable")).toBeInTheDocument();
    });
});
