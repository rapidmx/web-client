// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import MailFilterDetailPage from "../../../../apps/www/settings/filters/[uid].js";

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
const rule = {
    uid: "mfr1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "File newsletters",
    enabled: true,
    sequence: 0,
    stopProcessingRules: false,
    conditions: { hasAttachment: true },
    actions: [{ type: "move_to_folder", folderUid: "f1" }],
};

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [inboxFolder]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

beforeEach(() => {
    window.history.pushState(null, "", "/settings/filters/mfr1?mailboxUid=mb1");
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState(null, "", "/");
});

describe("MailFilterDetailPage", () => {
    it("renders the loaded rule's name, conditions, and actions in the rule builder", async () => {
        mockShell((url) => (url === "/api/mail/mail-filter-rules/mfr1" ? jsonResponse(200, rule) : undefined));
        render(<MailFilterDetailPage userUid="u1" params={{ uid: "mfr1" }} />);

        expect(await screen.findByRole("heading", { name: "File newsletters" })).toBeInTheDocument();
        expect(screen.getByLabelText("Name")).toHaveValue("File newsletters");
        expect(screen.getByRole("checkbox", { name: "Has an attachment" })).toBeChecked();
        expect(screen.getByLabelText("Destination folder")).toHaveValue("f1");
    });

    it("renders an empty destination-folder selection for an action loaded with folderUid unset", async () => {
        mockShell((url) =>
            url === "/api/mail/mail-filter-rules/mfr1"
                ? jsonResponse(200, { ...rule, actions: [{ type: "move_to_folder" }] })
                : undefined,
        );
        render(<MailFilterDetailPage userUid="u1" params={{ uid: "mfr1" }} />);

        expect(await screen.findByLabelText("Destination folder")).toHaveValue("");
    });

    it("still loads/renders the rule (with an empty folder picker) when the folder list fails to load — a secondary, best-effort fetch", async () => {
        mockShell((url) => {
            if (url === "/api/mail/mail-filter-rules/mfr1") return jsonResponse(200, rule);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(500, { message: "folder boom" });
            return undefined;
        });
        render(<MailFilterDetailPage userUid="u1" params={{ uid: "mfr1" }} />);

        expect(await screen.findByRole("heading", { name: "File newsletters" })).toBeInTheDocument();
        expect(within(screen.getByLabelText("Destination folder")).getAllByRole("option")).toHaveLength(1); // just the placeholder
    });

    it("renders an empty forward-to address for a forward action loaded with forwardTo unset", async () => {
        mockShell((url) =>
            url === "/api/mail/mail-filter-rules/mfr1" ? jsonResponse(200, { ...rule, actions: [{ type: "forward" }] }) : undefined,
        );
        render(<MailFilterDetailPage userUid="u1" params={{ uid: "mfr1" }} />);

        expect(await screen.findByLabelText("Forward to address")).toHaveValue("");
    });

    it("validates the name before saving", async () => {
        mockShell((url) => (url === "/api/mail/mail-filter-rules/mfr1" ? jsonResponse(200, rule) : undefined));
        const user = userEvent.setup();
        render(<MailFilterDetailPage userUid="u1" params={{ uid: "mfr1" }} />);
        await screen.findByLabelText("Name");

        await user.clear(screen.getByLabelText("Name"));
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("A name is required.")).toBeInTheDocument();
    });

    it("saves changes and shows a confirmation", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/mail-filter-rules/mfr1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, rule);
            if (url === "/api/mail/mail-filter-rules/mfr1" && init?.method === "PUT") {
                return jsonResponse(200, { ...rule, version: 1, name: "Renamed filter" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<MailFilterDetailPage userUid="u1" params={{ uid: "mfr1" }} />);
        await screen.findByLabelText("Name");

        await user.clear(screen.getByLabelText("Name"));
        await user.type(screen.getByLabelText("Name"), "Renamed filter");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Renamed filter" })).toBeInTheDocument();
    });

    it("shows an error message when saving fails, without discarding the loaded rule", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/mail-filter-rules/mfr1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, rule);
            if (url === "/api/mail/mail-filter-rules/mfr1" && init?.method === "PUT") return jsonResponse(409, { message: "version conflict" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<MailFilterDetailPage userUid="u1" params={{ uid: "mfr1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("version conflict")).toBeInTheDocument();
        expect(screen.getByLabelText("Name")).toHaveValue("File newsletters");
    });

    it("shows a generic error message when saving fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/mail-filter-rules/mfr1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, rule);
            if (url === "/api/mail/mail-filter-rules/mfr1" && init?.method === "PUT") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<MailFilterDetailPage userUid="u1" params={{ uid: "mfr1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("Could not save this mail filter.")).toBeInTheDocument();
    });

    it("shows an error message when the rule fails to load", async () => {
        mockShell((url) => (url === "/api/mail/mail-filter-rules/mfr1" ? jsonResponse(404, { message: "not found" }) : undefined));
        render(<MailFilterDetailPage userUid="u1" params={{ uid: "mfr1" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading the rule fails with a non-API error", async () => {
        mockShell((url) => {
            if (url === "/api/mail/mail-filter-rules/mfr1") throw new TypeError("network down");
            return undefined;
        });
        render(<MailFilterDetailPage userUid="u1" params={{ uid: "mfr1" }} />);
        expect(await screen.findByText("Could not load this mail filter.")).toBeInTheDocument();
    });

    it("falls back to 'Mail filter not found.' when the load succeeds with no rule and no error", async () => {
        mockShell((url) => (url === "/api/mail/mail-filter-rules/mfr1" ? jsonResponse(200, null) : undefined));
        render(<MailFilterDetailPage userUid="u1" params={{ uid: "mfr1" }} />);
        expect(await screen.findByText("Mail filter not found.")).toBeInTheDocument();
    });
});
