// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../../testUtils.js";
import NewMailFilterPage from "../../../../../apps/www/settings/filters/new/index.js";

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
const inboxFolder = {
    uid: "f1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Inbox",
    type: "inbox" as const,
    unreadCount: 0,
    totalCount: 0,
};
const archiveFolder = { ...inboxFolder, uid: "f2", name: "Archive" };
const contactsFolder = { ...inboxFolder, uid: "f3", name: "Contacts", type: "contacts" as const };

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder, archiveFolder, contactsFolder]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("NewMailFilterPage", () => {
    it("shows a loading state before folders resolve, then the form", async () => {
        let resolveFolders: (() => void) | undefined;
        mockShell((url) => {
            if (url.startsWith("/api/mail/folders")) {
                return new Promise((resolve) => {
                    resolveFolders = () => resolve(jsonResponse(200, [inboxFolder]));
                });
            }
            return undefined;
        });
        render(<NewMailFilterPage userUid="u1" />);

        expect(await screen.findByText("Loading…")).toBeInTheDocument();
        resolveFolders!();
        expect(await screen.findByLabelText("Name")).toBeInTheDocument();
    });

    it("only offers real mail folders (not Contacts) in the move/copy folder picker", async () => {
        mockShell();
        const user = userEvent.setup();
        render(<NewMailFilterPage userUid="u1" />);

        await screen.findByLabelText("Name");
        // "move_to_folder" is the default selection — Add action alone is enough to reveal the picker.
        await user.click(screen.getByRole("button", { name: "Add action" }));

        const options = screen.getByLabelText("Destination folder");
        expect(options).toHaveTextContent("Inbox");
        expect(options).toHaveTextContent("Archive");
        expect(options).not.toHaveTextContent("Contacts");
    });

    it("validates the name before submitting", async () => {
        mockShell();
        const user = userEvent.setup();
        render(<NewMailFilterPage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Create filter" }));
        expect(await screen.findByText("A name is required.")).toBeInTheDocument();
    });

    it("creates the filter (with an edited condition and a move-to-folder action) and redirects to its detail page", async () => {
        let requestBody: any;
        mockShell((url, init) => {
            if (url === "/api/mail/mail-filter-rules" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "mfr1" });
            }
            return undefined;
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<NewMailFilterPage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Name"), "File newsletters");
        await user.click(screen.getByRole("checkbox", { name: "Has an attachment" }));
        // "move_to_folder" is the default selection — Add action alone is enough.
        await user.click(screen.getByRole("button", { name: "Add action" }));
        await user.selectOptions(screen.getByLabelText("Destination folder"), "f2");
        await user.click(screen.getByRole("button", { name: "Create filter" }));

        await vi.waitFor(() => expect(location.href).toBe("/settings/filters/mfr1?mailboxUid=mb1"));
        expect(requestBody.mailboxUid).toBe("mb1");
        expect(requestBody.name).toBe("File newsletters");
        expect(requestBody.conditions).toEqual({ hasAttachment: true });
        expect(requestBody.actions).toEqual([{ type: "move_to_folder", folderUid: "f2" }]);
    });

    it("supports every registered action type — move/copy to folder, delete, mark as read, and forward", async () => {
        let requestBody: any;
        mockShell((url, init) => {
            if (url === "/api/mail/mail-filter-rules" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "mfr1" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<NewMailFilterPage userUid="u1" />);
        await screen.findByLabelText("Name");
        await user.type(screen.getByLabelText("Name"), "Every action type");

        // "move_to_folder" is the default selection.
        await user.click(screen.getByRole("button", { name: "Add action" }));
        await user.selectOptions(screen.getAllByLabelText("Destination folder")[0], "f1");

        await user.selectOptions(screen.getByLabelText("New action type"), "copy_to_folder");
        await user.click(screen.getByRole("button", { name: "Add action" }));
        await user.selectOptions(screen.getAllByLabelText("Destination folder")[1], "f2");

        await user.selectOptions(screen.getByLabelText("New action type"), "delete");
        await user.click(screen.getByRole("button", { name: "Add action" }));

        await user.selectOptions(screen.getByLabelText("New action type"), "mark_as_read");
        await user.click(screen.getByRole("button", { name: "Add action" }));

        await user.selectOptions(screen.getByLabelText("New action type"), "forward");
        await user.click(screen.getByRole("button", { name: "Add action" }));
        await user.type(screen.getByLabelText("Forward to address"), "assistant@example.com");

        await user.click(screen.getByRole("button", { name: "Create filter" }));

        await vi.waitFor(() => expect(requestBody).toBeDefined());
        expect(requestBody.actions).toEqual([
            { type: "move_to_folder", folderUid: "f1" },
            { type: "copy_to_folder", folderUid: "f2" },
            { type: "delete" },
            { type: "mark_as_read" },
            { type: "forward", forwardTo: "assistant@example.com" },
        ]);
    });

    it("sets the importance select condition", async () => {
        let requestBody: any;
        mockShell((url, init) => {
            if (url === "/api/mail/mail-filter-rules" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "mfr1" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<NewMailFilterPage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Name"), "High importance");
        await user.selectOptions(screen.getByLabelText("Importance"), "high");
        await user.click(screen.getByRole("button", { name: "Create filter" }));

        await vi.waitFor(() => expect(requestBody).toBeDefined());
        expect(requestBody.conditions).toEqual({ importance: "high" });
    });

    it("shows an error message when the folder list fails to load", async () => {
        mockShell((url) => (url.startsWith("/api/mail/folders") ? jsonResponse(500, { message: "folder boom" }) : undefined));
        render(<NewMailFilterPage userUid="u1" />);
        expect(await screen.findByText("folder boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the folder list fails with a non-API error", async () => {
        mockShell((url) => {
            if (url.startsWith("/api/mail/folders")) throw new TypeError("network down");
            return undefined;
        });
        render(<NewMailFilterPage userUid="u1" />);
        expect(await screen.findByText("Could not load this mailbox's folders.")).toBeInTheDocument();
    });

    it("shows an error message when creation fails", async () => {
        mockShell((url, init) =>
            url === "/api/mail/mail-filter-rules" && init?.method === "POST" ? jsonResponse(500, { message: "boom" }) : undefined,
        );
        const user = userEvent.setup();
        render(<NewMailFilterPage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Name"), "File newsletters");
        await user.click(screen.getByRole("button", { name: "Create filter" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when creation fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/mail-filter-rules" && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<NewMailFilterPage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Name"), "File newsletters");
        await user.click(screen.getByRole("button", { name: "Create filter" }));

        expect(await screen.findByText("Could not create the mail filter.")).toBeInTheDocument();
    });

    it("the Cancel link returns to the mail filters list", async () => {
        mockShell();
        render(<NewMailFilterPage userUid="u1" />);
        expect(await screen.findByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/settings/filters?mailboxUid=mb1");
    });
});
