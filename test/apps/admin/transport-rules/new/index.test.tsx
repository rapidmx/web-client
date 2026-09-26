// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../../testUtils.js";
import NewTransportRulePageBase from "../../../../../apps/admin/transport-rules/new/index.js";
import { latestRouter, withTestRouter } from "../../../routerTestUtils.js";

// Rendered inside a router: what the page does after a save is navigate through it (see routerTestUtils.tsx).
const NewTransportRulePage = withTestRouter(NewTransportRulePageBase);

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("NewTransportRulePage", () => {
    it("validates the name before submitting", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewTransportRulePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New transport rule");

        await user.click(screen.getByRole("button", { name: "Create transport rule" }));
        expect(await screen.findByText("A name is required.")).toBeInTheDocument();
    });

    it("creates the transport rule (with an edited condition and action) and redirects to its detail page", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/transport-rules" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "tr1" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<NewTransportRulePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New transport rule");

        await user.type(screen.getByLabelText("Name"), "Flag external senders");
        await user.click(screen.getByRole("checkbox", { name: "Any recipient is external" }));
        await user.selectOptions(screen.getByLabelText("New action type"), "add_header");
        await user.click(screen.getByRole("button", { name: "Add action" }));
        await user.type(screen.getByLabelText("Header name"), "X-External");
        await user.click(screen.getByRole("button", { name: "Create transport rule" }));

        await vi.waitFor(() => expect(latestRouter().navigate.mock.lastCall?.[0]).toBe("/admin/transport-rules/tr1"));
        expect(requestBody.name).toBe("Flag external senders");
        expect(requestBody.conditions).toEqual({ anyRecipientExternal: true });
        expect(requestBody.actions).toEqual([{ type: "add_header", headerName: "X-External", headerValue: "" }]);
    });

    it("supports every registered action type — reject, quarantine, add_header (both fields), and add_recipient", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/transport-rules" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "tr1" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<NewTransportRulePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New transport rule");

        await user.type(screen.getByLabelText("Name"), "Every action type");
        await user.click(screen.getByRole("checkbox", { name: "Has an attachment" }));

        // "reject" is the default selection — Add action alone is enough.
        await user.click(screen.getByRole("button", { name: "Add action" }));

        await user.selectOptions(screen.getByLabelText("New action type"), "quarantine");
        await user.click(screen.getByRole("button", { name: "Add action" }));

        await user.selectOptions(screen.getByLabelText("New action type"), "add_header");
        await user.click(screen.getByRole("button", { name: "Add action" }));
        await user.type(screen.getByLabelText("Header name"), "X-Flag");
        await user.type(screen.getByLabelText("Header value"), "reviewed");

        await user.selectOptions(screen.getByLabelText("New action type"), "add_recipient");
        await user.click(screen.getByRole("button", { name: "Add action" }));
        await user.type(screen.getByLabelText("Recipient address"), "compliance@example.com");

        await user.click(screen.getByRole("button", { name: "Create transport rule" }));

        await vi.waitFor(() => expect(requestBody).toBeDefined());
        expect(requestBody.actions).toEqual([
            { type: "reject" },
            { type: "quarantine" },
            { type: "add_header", headerName: "X-Flag", headerValue: "reviewed" },
            { type: "add_recipient", recipientAddress: "compliance@example.com" },
        ]);
    });

    it("shows an error message when creation fails", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(500, { message: "boom" });
        });
        const user = userEvent.setup();
        render(<NewTransportRulePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New transport rule");

        await user.type(screen.getByLabelText("Name"), "Flag external senders");
        await user.click(screen.getByRole("checkbox", { name: "Any recipient is external" }));
        await user.click(screen.getByRole("button", { name: "Create transport rule" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when creation fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<NewTransportRulePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New transport rule");

        await user.type(screen.getByLabelText("Name"), "Flag external senders");
        await user.click(screen.getByRole("checkbox", { name: "Any recipient is external" }));
        await user.click(screen.getByRole("button", { name: "Create transport rule" }));

        expect(await screen.findByText("Could not create the transport rule.")).toBeInTheDocument();
    });

    it("refuses to save a reject or quarantine rule with no conditions", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewTransportRulePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New transport rule");

        await user.type(screen.getByLabelText("Name"), "Block everything");
        await user.selectOptions(screen.getByLabelText("New action type"), "quarantine");
        await user.click(screen.getByRole("button", { name: "Add action" }));
        await user.click(screen.getByRole("button", { name: "Create transport rule" }));

        expect(await screen.findByText(/rejects or quarantines mail would do so for every message/)).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === "POST")).toBe(false);
    });

    it("asks before saving a rule with no conditions and non-blocking actions", async () => {
        let posted = 0;
        mockFetch((url, init) => {
            if (url === "/api/mail/transport-rules" && init?.method === "POST") {
                posted++;
                return jsonResponse(200, { uid: "tr2" });
            }
            return jsonResponse(200, {});
        });
        const user = userEvent.setup();
        render(<NewTransportRulePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New transport rule");

        await user.type(screen.getByLabelText("Name"), "Tag everything");
        await user.selectOptions(screen.getByLabelText("New action type"), "add_header");
        await user.click(screen.getByRole("button", { name: "Add action" }));
        await user.click(screen.getByRole("button", { name: "Create transport rule" }));

        const dialog = await screen.findByRole("dialog", { name: "Apply to every message?" });
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(posted).toBe(0);

        await user.click(screen.getByRole("button", { name: "Create transport rule" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Apply to every message?" })).getByRole("button", { name: "Save anyway" }));
        await vi.waitFor(() => expect(latestRouter().navigate.mock.lastCall?.[0]).toBe("/admin/transport-rules/tr2"));
        expect(posted).toBe(1);
    });

    it("the Cancel link returns to the transport rules list", async () => {
        mockFetch(() => jsonResponse(200, {}));
        render(<NewTransportRulePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/admin/transport-rules");
    });
});
