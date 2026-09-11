// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The bulk of this component's rendering logic (every optional field, Edit/Delete callbacks) is already
// exercised end-to-end via `test/apps/contacts/index.test.tsx` (ContactsContent renders this component,
// unmocked, for the desktop selected-contact pane). This file only covers what that one doesn't: the
// `backHref` prop, which only the mobile detail route (`apps/www/contacts/[uid].tsx`) ever passes.
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ContactDetailPane from "../../../apps/shared/components/contacts/ContactDetailPane.js";
import type { Contact } from "@rapidmx/react-shared/contactsApi.js";

function contactFixture(overrides: Partial<Contact> = {}): Contact {
    return {
        uid: "c1",
        version: 0,
        dateCreated: "",
        dateModified: "",
        mailboxUid: "mb1",
        folderUid: "f1",
        displayName: "Jane Doe",
        emails: [],
        phones: [],
        addresses: [],
        ...overrides,
    };
}

describe("ContactDetailPane", () => {
    it("renders no back link when backHref is absent", () => {
        render(<ContactDetailPane contact={contactFixture()} onEdit={vi.fn()} onDelete={vi.fn()} />);
        expect(screen.queryByRole("link", { name: /Back to contacts/ })).not.toBeInTheDocument();
    });

    it("renders a back link to the given href when backHref is present", () => {
        render(<ContactDetailPane contact={contactFixture()} onEdit={vi.fn()} onDelete={vi.fn()} backHref="/contacts" />);
        expect(screen.getByRole("link", { name: /Back to contacts/ })).toHaveAttribute("href", "/contacts");
    });

    it("calls onEdit and onDelete from their respective buttons", async () => {
        const onEdit = vi.fn();
        const onDelete = vi.fn();
        const user = userEvent.setup();
        render(<ContactDetailPane contact={contactFixture()} onEdit={onEdit} onDelete={onDelete} />);

        await user.click(screen.getByRole("button", { name: "Edit" }));
        expect(onEdit).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(onDelete).toHaveBeenCalledTimes(1);
    });
});
