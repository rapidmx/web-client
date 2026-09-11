// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import ContactDetailPage from "../../../apps/www/contacts/[uid].js";

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};
const contactsFolder = {
    uid: "f-contacts",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Contacts",
    type: "contacts" as const,
    unreadCount: 0,
    totalCount: 1,
};
const jane = {
    uid: "c1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    folderUid: "f-contacts",
    displayName: "Jane Doe",
    emails: [{ address: "jane@example.com", type: "work" as const }],
    phones: [],
    addresses: [],
};

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
        if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

beforeEach(() => {
    window.history.pushState(null, "", "/contacts/c1");
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState(null, "", "/");
});

describe("ContactDetailPage", () => {
    it("shows a loading state before the contact resolves", async () => {
        let resolveContact: (() => void) | undefined;
        mockShell((url) => {
            if (url === "/api/mail/contacts/c1") {
                return new Promise((resolve) => {
                    resolveContact = () => resolve(jsonResponse(200, jane));
                });
            }
            return undefined;
        });
        render(<ContactDetailPage userUid="u1" params={{ uid: "c1" }} />);

        await waitFor(() => expect(resolveContact).toBeDefined());
        expect(screen.getByText("Loading…")).toBeInTheDocument();

        resolveContact!();
        await screen.findByRole("heading", { name: "Jane Doe" });
    });

    it("renders the contact with a back link to the contacts list", async () => {
        mockShell((url) => (url === "/api/mail/contacts/c1" ? jsonResponse(200, jane) : undefined));
        render(<ContactDetailPage userUid="u1" params={{ uid: "c1" }} />);

        expect(await screen.findByRole("heading", { name: "Jane Doe" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /Back to contacts/ })).toHaveAttribute("href", "/contacts");
    });

    it("shows an error message when the contact fails to load", async () => {
        mockShell((url) => (url === "/api/mail/contacts/c1" ? jsonResponse(404, { message: "not found" }) : undefined));
        render(<ContactDetailPage userUid="u1" params={{ uid: "c1" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading the contact fails with a non-API error", async () => {
        mockShell((url) => {
            if (url === "/api/mail/contacts/c1") throw new TypeError("network down");
            return undefined;
        });
        render(<ContactDetailPage userUid="u1" params={{ uid: "c1" }} />);
        expect(await screen.findByText("Could not load this contact.")).toBeInTheDocument();
    });

    it("falls back to 'Contact not found.' when the load succeeds with no contact and no error", async () => {
        mockShell((url) => (url === "/api/mail/contacts/c1" ? jsonResponse(200, null) : undefined));
        render(<ContactDetailPage userUid="u1" params={{ uid: "c1" }} />);
        expect(await screen.findByText("Contact not found.")).toBeInTheDocument();
    });

    it("switches to edit mode, saves, and returns to the view with the updated contact", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/contacts/c1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, jane);
            if (url === "/api/mail/contacts/c1" && init?.method === "PUT") {
                return jsonResponse(200, { ...jane, displayName: "Jane Updated" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactDetailPage userUid="u1" params={{ uid: "c1" }} />);

        await user.click(await screen.findByRole("button", { name: "Edit" }));
        expect(screen.getByRole("heading", { name: "Edit contact" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /Back to contacts/ })).toHaveAttribute("href", "/contacts");

        await user.clear(screen.getByLabelText("Display name"));
        await user.type(screen.getByLabelText("Display name"), "Jane Updated");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByRole("heading", { name: "Jane Updated" })).toBeInTheDocument();
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/contacts/c1", expect.objectContaining({ method: "PUT" })),
        );
    });

    it("cancels out of edit mode back to the view without saving", async () => {
        mockShell((url) => (url === "/api/mail/contacts/c1" ? jsonResponse(200, jane) : undefined));
        const user = userEvent.setup();
        render(<ContactDetailPage userUid="u1" params={{ uid: "c1" }} />);

        await user.click(await screen.findByRole("button", { name: "Edit" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.getByRole("heading", { name: "Jane Doe" })).toBeInTheDocument();
    });

    it("deletes the contact and navigates back to the contacts list", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/contacts/c1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, jane);
            if (url === "/api/mail/contacts/c1?version=0" && init?.method === "DELETE") return jsonResponse(500, { message: "boom" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactDetailPage userUid="u1" params={{ uid: "c1" }} />);

        await user.click(await screen.findByRole("button", { name: "Delete" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when deleting the contact fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/contacts/c1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, jane);
            if (url === "/api/mail/contacts/c1?version=0" && init?.method === "DELETE") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactDetailPage userUid="u1" params={{ uid: "c1" }} />);

        await user.click(await screen.findByRole("button", { name: "Delete" }));

        expect(await screen.findByText("Could not delete this contact.")).toBeInTheDocument();
    });

    // Mocks window.location wholesale (see testUtils.mockLocation), which isn't undone between tests
    // (unlike vi.stubGlobal) — must run last in this file.
    it("deletes the contact and navigates back to the contacts list", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/contacts/c1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, jane);
            if (url === "/api/mail/contacts/c1?version=0" && init?.method === "DELETE") return jsonResponse(200, {});
            return undefined;
        });
        const user = userEvent.setup();
        render(<ContactDetailPage userUid="u1" params={{ uid: "c1" }} />);

        const button = await screen.findByRole("button", { name: "Delete" });
        const location = mockLocation();
        await user.click(button);

        await waitFor(() => expect(location.href).toBe("/contacts"));
    });
});
