// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MailboxTable from "../../../../apps/shared/components/admin/mailboxes/MailboxTable.js";
import { Mailbox } from "@rapidmx/react-shared/mailApi.js";

const owned: Mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "User One",
    timezone: "UTC",
    quotaBytes: 5_000_000_000,
    usedBytes: 2_500_000_000,
};

const shared: Mailbox = {
    ...owned,
    uid: "mb2",
    ownerUserUid: undefined,
    primarySmtpAddress: "support@example.com",
    displayName: "Support",
    quotaBytes: 1_000_000,
    usedBytes: 500,
};

describe("MailboxTable", () => {
    it("shows an empty-state message when there are no mailboxes", () => {
        render(<MailboxTable mailboxes={[]} />);
        expect(screen.getByText("No mailboxes found.")).toBeInTheDocument();
    });

    it("renders a row per mailbox with a link to its detail page", () => {
        render(<MailboxTable mailboxes={[owned]} />);
        expect(screen.getByText("u1@example.com")).toBeInTheDocument();
        expect(screen.getByText("User One")).toBeInTheDocument();
        expect(screen.getByText("u1")).toBeInTheDocument();
        expect(screen.getByText("2.5 GB / 5.0 GB")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "View" })).toHaveAttribute(
            "href",
            "/admin/mailboxes/mb1",
        );
    });

    it("shows a 'Shared' badge instead of an owner uid for an ownerless mailbox", () => {
        render(<MailboxTable mailboxes={[shared]} />);
        expect(screen.getByText("Shared")).toBeInTheDocument();
        expect(screen.getByText("500 B / 1.0 MB")).toBeInTheDocument();
    });

    it("formats a sub-KB and sub-MB quota correctly", () => {
        render(<MailboxTable mailboxes={[{ ...owned, usedBytes: 200_000, quotaBytes: 900_000 }]} />);
        expect(screen.getByText("200.0 KB / 900.0 KB")).toBeInTheDocument();
    });
});
