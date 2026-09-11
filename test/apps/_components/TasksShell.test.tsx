// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../testUtils.js";
import TasksShell, { useTasksShell } from "../../../apps/shared/components/tasks/layout/TasksShell.js";

const mailboxA = {
    uid: "mb-a",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "a@example.com",
    aliasAddresses: [],
    displayName: "Mailbox A",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};
const mailboxB = { ...mailboxA, uid: "mb-b", displayName: "Mailbox B", ownerUserUid: undefined };

const tasksFolder = {
    uid: "f-tasks",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb-a",
    name: "Tasks",
    type: "tasks" as const,
    unreadCount: 0,
    totalCount: 0,
};

function mockMailboxesAndFolders(mailboxes: unknown[], folders: unknown[]) {
    return mockFetch((url) => {
        // Checked before the general "/api/mail/mailboxes" prefix below, which would otherwise also
        // match this sub-path and hand `MailboxProvisioning` the mailbox list as if it were its own
        // response shape. 404 matches this feature's real default (disabled unless an admin configures it).
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, mailboxes);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
        throw new Error(`unexpected ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("TasksShell", () => {
    it("shows a skeleton sidebar immediately, instead of a blank pane, while mailboxes are still loading", async () => {
        let resolveMailboxes: (() => void) | undefined;
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) {
                return new Promise((resolve) => {
                    resolveMailboxes = () => resolve(jsonResponse(200, [mailboxA]));
                });
            }
            throw new Error(`unexpected ${url}`);
        });
        const { container } = render(<TasksShell userUid="u1">content</TasksShell>);

        await waitFor(() => expect(resolveMailboxes).toBeDefined());
        expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
        expect(screen.queryByText("content")).not.toBeInTheDocument();

        resolveMailboxes!();
        await screen.findByText("content");
    });


    it("redirects to auth-server's sign-in page when there is no userUid", async () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/tasks";
        render(<TasksShell authServerUrl="https://auth.example.com">content</TasksShell>);
        await waitFor(() =>
            expect(location.href).toBe(
                `https://auth.example.com/auth/signin?return_to=${encodeURIComponent("https://mail.example.com/tasks")}`,
            ),
        );
        expect(screen.queryByText("content")).not.toBeInTheDocument();
    });

    it("shows an error message when loading mailboxes fails", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(<TasksShell userUid="u1">content</TasksShell>);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading mailboxes fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(<TasksShell userUid="u1">content</TasksShell>);
        expect(await screen.findByText("Could not load your mailboxes.")).toBeInTheDocument();
    });

    it("shows a full-screen no-mailbox page — not the app's own chrome/content at all — when the caller has none", async () => {
        mockMailboxesAndFolders([], []);
        render(<TasksShell userUid="u1">content</TasksShell>);
        expect(await screen.findByText("No mailbox available")).toBeInTheDocument();
        expect(screen.queryByText("content")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Mailbox")).not.toBeInTheDocument();
        expect(screen.queryByRole("navigation", { name: "Apps" })).not.toBeInTheDocument();
    });

    it("renders a single mailbox's tasks folder with no mailbox switcher", async () => {
        mockMailboxesAndFolders([mailboxA], [tasksFolder]);
        render(<TasksShell userUid="u1">content</TasksShell>);

        await screen.findByText("content");
        expect(screen.queryByLabelText("Mailbox")).not.toBeInTheDocument();
    });

    it("shows the mailbox switcher when more than one mailbox is accessible, marking a shared one", async () => {
        mockMailboxesAndFolders([mailboxA, mailboxB], [tasksFolder]);
        render(<TasksShell userUid="u1">content</TasksShell>);

        await screen.findByLabelText("Mailbox");
        expect(screen.getByRole("option", { name: "Mailbox A" })).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Mailbox B (shared)" })).toBeInTheDocument();
    });

    it("navigates to the chosen mailbox when the switcher's selection changes", async () => {
        mockMailboxesAndFolders([mailboxA, mailboxB], [tasksFolder]);
        const location = mockLocation();
        const user = userEvent.setup();
        render(<TasksShell userUid="u1">content</TasksShell>);

        const select = await screen.findByLabelText("Mailbox");
        await user.selectOptions(select, "mb-b");

        expect(location.href).toBe("/tasks?mailboxUid=mb-b");
    });

    it("shows an error message when loading folders fails", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(500, { message: "folder boom" });
            throw new Error(`unexpected ${url}`);
        });
        render(<TasksShell userUid="u1">content</TasksShell>);
        expect(await screen.findByText("folder boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading folders fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            throw new TypeError("network down");
        });
        render(<TasksShell userUid="u1">content</TasksShell>);
        expect(await screen.findByText("Could not load this mailbox's tasks folder.")).toBeInTheDocument();
    });

    it("honors a ?mailboxUid= query param that names an accessible mailbox", async () => {
        const location = mockLocation();
        (location as any).search = "?mailboxUid=mb-b";
        mockMailboxesAndFolders([mailboxA, mailboxB], [tasksFolder]);
        render(<TasksShell userUid="u1">content</TasksShell>);

        const select = await screen.findByLabelText("Mailbox");
        expect(select).toHaveValue("mb-b");
    });

    it("ignores a ?mailboxUid= query param that isn't one of the caller's accessible mailboxes", async () => {
        const location = mockLocation();
        (location as any).search = "?mailboxUid=not-mine";
        mockMailboxesAndFolders([mailboxA, mailboxB], [tasksFolder]);
        render(<TasksShell userUid="u1">content</TasksShell>);

        const select = await screen.findByLabelText("Mailbox");
        expect(select).toHaveValue("mb-a");
    });

    it("does not show a mobile menu button when there's only one mailbox and no error (nothing to open)", async () => {
        mockMailboxesAndFolders([mailboxA], [tasksFolder]);
        render(<TasksShell userUid="u1">content</TasksShell>);
        await screen.findByText("content");
        expect(screen.queryByRole("button", { name: "Open mailbox switcher" })).not.toBeInTheDocument();
    });

    it("opens and closes the mailbox switcher drawer via the mobile menu button", async () => {
        mockMailboxesAndFolders([mailboxA, mailboxB], [tasksFolder]);
        const user = userEvent.setup();
        render(<TasksShell userUid="u1">content</TasksShell>);
        await screen.findByText("content");

        expect(screen.queryByRole("dialog", { name: "Mailbox" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Open mailbox switcher" }));
        const drawer = screen.getByRole("dialog", { name: "Mailbox" });
        expect(within(drawer).getByRole("combobox", { name: "Mailbox" })).toBeInTheDocument();

        await user.click(within(drawer).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog", { name: "Mailbox" })).not.toBeInTheDocument();
    });

    it("shows the mobile menu button for a folder-loading error even with only one mailbox", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailboxA]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(500, { message: "folder boom" });
            throw new Error(`unexpected ${url}`);
        });
        render(<TasksShell userUid="u1">content</TasksShell>);
        await screen.findByText("content");
        expect(await screen.findByRole("button", { name: "Open mailbox switcher" })).toBeInTheDocument();
    });

    it("provides the resolved mailbox/folder/mailboxes/userUid to children via useTasksShell()", async () => {
        function Probe() {
            const { mailboxUid, folderUid, mailboxes, userUid } = useTasksShell();
            return <span>{`${mailboxUid}/${folderUid}/${mailboxes.length}/${userUid}`}</span>;
        }
        mockMailboxesAndFolders([mailboxA], [tasksFolder]);
        render(
            <TasksShell userUid="u1">
                <Probe />
            </TasksShell>,
        );

        expect(await screen.findByText("mb-a/f-tasks/1/u1")).toBeInTheDocument();
    });
});
