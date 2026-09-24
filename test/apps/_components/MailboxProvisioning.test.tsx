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
import { deviceTimeZone } from "@rapidmx/react-shared/util/timeZone.js";

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

    it("offers a retry, not 'No mailbox available', when the server couldn't read its provisioning policy (503).", async () => {
        let calls = 0;
        mockFetch(() => {
            calls += 1;
            return calls === 1 ? jsonResponse(503, { message: "policy unavailable" }) : jsonResponse(404, { message: "not enabled" });
        });
        const user = userEvent.setup();
        render(<MailboxProvisioning />);

        expect(await screen.findByText("Couldn’t check right now")).toBeInTheDocument();
        expect(screen.queryByText("No mailbox available")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Retry" }));

        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        expect(calls).toBe(2);
    });

    it("shows the server's own reason above the advice when provisioning was refused on purpose (404).", async () => {
        mockFetch(() => jsonResponse(404, { message: "Automatic mailbox provisioning is not enabled." }));
        render(<MailboxProvisioning />);

        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        const reason = screen.getByText("Automatic mailbox provisioning is not enabled.");
        const advice = screen.getByText("Ask an administrator to create one for you.");
        expect(reason.compareDocumentPosition(advice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    });

    it("shows the reason for an account with no registered username (404).", async () => {
        mockFetch(() => jsonResponse(404, { message: "No username is registered for this account." }));
        render(<MailboxProvisioning />);

        expect(await screen.findByText("No username is registered for this account.")).toBeInTheDocument();
        expect(screen.getByText("Ask an administrator to create one for you.")).toBeInTheDocument();
    });

    it("shows just the first line of a multi-line reason, cut to a sentence's length.", async () => {
        mockFetch(() => jsonResponse(403, { message: `  Not allowed here.\n    at Object.<anonymous> (/srv/app.js:1:1)` }));
        const { unmount } = render(<MailboxProvisioning />);
        expect(await screen.findByText("Not allowed here.")).toBeInTheDocument();
        expect(screen.queryByText(/app\.js/)).not.toBeInTheDocument();
        unmount();

        mockFetch(() => jsonResponse(400, { message: "x".repeat(500) }));
        render(<MailboxProvisioning />);
        expect(await screen.findByText("x".repeat(200))).toBeInTheDocument();
    });

    it("shows no reason line when the server's message is blank.", async () => {
        mockFetch(() => jsonResponse(404, { message: "   " }));
        const { container } = render(<MailboxProvisioning />);

        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        expect(container.querySelectorAll("p")).toHaveLength(1);
        expect(screen.getByText("Ask an administrator to create one for you.")).toBeInTheDocument();
    });

    it("shows no reason for a server error (5xx) - its message is internals, not a reason.", async () => {
        mockFetch(() => jsonResponse(500, { message: "TypeError: Cannot read properties of undefined (reading 'uid')" }));
        const { container } = render(<MailboxProvisioning />);

        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        expect(screen.queryByText(/Cannot read properties/)).not.toBeInTheDocument();
        expect(container.querySelectorAll("p")).toHaveLength(1);
        expect(screen.getByText("Ask an administrator to create one for you.")).toBeInTheDocument();
    });

    it("shows no reason for a non-error status below 400, or for a request that never reached the server.", async () => {
        mockFetch(() => emptyResponse(304, { statusText: "Not Modified" }));
        const { unmount } = render(<MailboxProvisioning />);
        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        expect(screen.queryByText("Not Modified")).not.toBeInTheDocument();
        unmount();

        mockFetch(() => {
            throw new TypeError("Failed to fetch");
        });
        render(<MailboxProvisioning />);
        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
    });

    it("offers a retry, saying the identity service could not be reached, on a 502.", async () => {
        let calls = 0;
        mockFetch(() => {
            calls += 1;
            return calls === 1
                ? jsonResponse(502, { message: "Could not reach the identity service to determine your mailbox address." })
                : jsonResponse(404, { message: "Automatic mailbox provisioning is not enabled." });
        });
        const user = userEvent.setup();
        render(<MailboxProvisioning />);

        expect(await screen.findByText("Couldn\u2019t check right now")).toBeInTheDocument();
        expect(screen.getByText("We couldn\u2019t reach the identity service to set up your mailbox. Please try again.")).toBeInTheDocument();
        expect(screen.queryByText("No mailbox available")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Retry" }));

        // A retry that ends differently leaves the retry screen, with that outcome's reason.
        expect(await screen.findByText("Automatic mailbox provisioning is not enabled.")).toBeInTheDocument();
        expect(calls).toBe(2);
    });

    it("words a 503 and a 502 differently, following whichever the latest attempt got.", async () => {
        const statuses = [503, 502, 503];
        let calls = 0;
        mockFetch(() => jsonResponse(statuses[calls++], { message: "unavailable" }));
        const user = userEvent.setup();
        render(<MailboxProvisioning />);

        expect(await screen.findByText(/couldn\u2019t check whether a mailbox can be set up/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByText(/couldn\u2019t reach the identity service/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(await screen.findByText(/couldn\u2019t check whether a mailbox can be set up/)).toBeInTheDocument();
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
                expect.objectContaining({ method: "POST", body: JSON.stringify({ alias: "jp", domain: "example.org", timezone: deviceTimeZone() }) }),
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
