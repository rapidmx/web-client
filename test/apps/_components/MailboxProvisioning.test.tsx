// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import MailboxProvisioning from "../../../apps/shared/components/layout/MailboxProvisioning.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("MailboxProvisioning", () => {
    it("reloads the page when auto-provisioning creates a mailbox outright (no selection needed).", async () => {
        mockFetch((url, init) =>
            url === "/api/mail/mailboxes/auto-provision" && init?.method === "POST"
                ? jsonResponse(200, { status: "created", mailbox: { uid: "mb1" } })
                : emptyResponse(500),
        );
        const location = mockLocation();
        render(<MailboxProvisioning />);

        expect(screen.getByText("Setting up your mailbox…")).toBeInTheDocument();
        await waitFor(() => expect(location.reload).toHaveBeenCalled());
    });

    it("reloads the page when the caller already has a mailbox (status 'existing').", async () => {
        mockFetch(() => jsonResponse(200, { status: "existing", mailbox: { uid: "mb1" } }));
        const location = mockLocation();
        render(<MailboxProvisioning />);

        await waitFor(() => expect(location.reload).toHaveBeenCalled());
    });

    it("shows a fallback message when auto-provisioning isn't available (e.g. disabled, 404).", async () => {
        mockFetch(() => jsonResponse(404, { message: "not enabled" }));
        render(<MailboxProvisioning />);

        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        expect(screen.getByText("Ask an administrator to create one for you.")).toBeInTheDocument();
    });

    it("shows a picker with every alias x domain option when multiple are available, and creates the chosen one.", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (url === "/api/mail/mailboxes/auto-provision" && init?.method === "POST") {
                const body = init.body ? JSON.parse(init.body as string) : {};
                if (body.alias) {
                    return jsonResponse(200, { status: "created", mailbox: { uid: "mb1" } });
                }
                return jsonResponse(200, {
                    status: "needs_selection",
                    options: [
                        { alias: "jsteinmetz", domain: "example.com", primarySmtpAddress: "jsteinmetz@example.com" },
                        { alias: "jp", domain: "example.org", primarySmtpAddress: "jp@example.org" },
                    ],
                });
            }
            return emptyResponse(500);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<MailboxProvisioning />);

        expect(await screen.findByText("Choose your mailbox address to get started:")).toBeInTheDocument();
        const select = screen.getByLabelText<HTMLSelectElement>("Mailbox address");
        expect(Array.from(select.options).map((o) => o.value)).toEqual(["jsteinmetz@example.com", "jp@example.org"]);

        await user.selectOptions(select, "jp@example.org");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/mailboxes/auto-provision",
                expect.objectContaining({ method: "POST", body: JSON.stringify({ alias: "jp", domain: "example.org" }) }),
            ),
        );
        await waitFor(() => expect(location.reload).toHaveBeenCalled());
    });

    it("shows an API error message and lets the caller retry when confirming a selection fails.", async () => {
        mockFetch((url, init) => {
            if (url === "/api/mail/mailboxes/auto-provision" && init?.method === "POST") {
                const body = init.body ? JSON.parse(init.body as string) : {};
                if (body.alias) {
                    return jsonResponse(500, { message: "creation failed" });
                }
                return jsonResponse(200, {
                    status: "needs_selection",
                    options: [{ alias: "jsteinmetz", domain: "example.com", primarySmtpAddress: "jsteinmetz@example.com" }],
                });
            }
            return emptyResponse(500);
        });
        const user = userEvent.setup();
        render(<MailboxProvisioning />);

        await screen.findByText("Choose your mailbox address to get started:");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        expect(await screen.findByText("creation failed")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    });

    it("shows a generic error message when confirming a selection fails with a non-API error.", async () => {
        mockFetch((url, init) => {
            if (url === "/api/mail/mailboxes/auto-provision" && init?.method === "POST") {
                const body = init.body ? JSON.parse(init.body as string) : {};
                if (body.alias) {
                    throw new TypeError("network down");
                }
                return jsonResponse(200, {
                    status: "needs_selection",
                    options: [{ alias: "jsteinmetz", domain: "example.com", primarySmtpAddress: "jsteinmetz@example.com" }],
                });
            }
            return emptyResponse(500);
        });
        const user = userEvent.setup();
        render(<MailboxProvisioning />);

        await screen.findByText("Choose your mailbox address to get started:");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        expect(await screen.findByText("Could not create your mailbox.")).toBeInTheDocument();
    });
});
