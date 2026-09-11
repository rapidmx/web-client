// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ContactsToolbar from "../../../apps/shared/components/contacts/ContactsToolbar.js";

function renderToolbar(overrides: Partial<React.ComponentProps<typeof ContactsToolbar>> = {}) {
    const handlers = {
        onNewContact: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        onEmail: vi.fn(),
        onToggleFavorite: vi.fn(),
        onAddCategory: vi.fn(),
        onExportVCard: vi.fn(),
        onImportFile: vi.fn(),
    };
    render(
        <ContactsToolbar
            selectedCount={0}
            allSelectedFavorited={false}
            {...handlers}
            {...overrides}
        />,
    );
    return handlers;
}

describe("ContactsToolbar", () => {
    it("always enables New contact and Import, regardless of selection.", () => {
        renderToolbar({ selectedCount: 0 });
        expect(screen.getByText("New contact").closest("button")).not.toBeDisabled();
        expect(screen.getByText("Import").closest("button")).not.toBeDisabled();
    });

    it("disables every selection-dependent action when nothing is selected.", () => {
        renderToolbar({ selectedCount: 0 });
        for (const label of ["Edit", "Delete", "Email", "Favorite", "Add category", "Export"]) {
            expect(screen.getByText(label).closest("button")).toBeDisabled();
        }
    });

    it("keeps Edit disabled when more than one contact is selected.", () => {
        renderToolbar({ selectedCount: 2 });
        expect(screen.getByText("Edit").closest("button")).toBeDisabled();
    });

    it("enables Edit when exactly one contact is selected.", () => {
        renderToolbar({ selectedCount: 1 });
        expect(screen.getByText("Edit").closest("button")).not.toBeDisabled();
    });

    it("enables Delete/Email/Favorite/Add category/Export for a multi-selection.", () => {
        renderToolbar({ selectedCount: 3 });
        for (const label of ["Delete", "Email", "Favorite", "Add category", "Export"]) {
            expect(screen.getByText(label).closest("button")).not.toBeDisabled();
        }
    });

    it("shows 'Favorite' when not every selected contact is already favorited.", () => {
        renderToolbar({ selectedCount: 2, allSelectedFavorited: false });
        expect(screen.getByText("Favorite")).toBeInTheDocument();
    });

    it("shows 'Unfavorite' when every selected contact is already favorited.", () => {
        renderToolbar({ selectedCount: 2, allSelectedFavorited: true });
        expect(screen.getByText("Unfavorite")).toBeInTheDocument();
    });

    it("calls the right handler for New contact/Edit/Delete/Email/Favorite/Add category/Export.", async () => {
        const user = userEvent.setup();
        const handlers = renderToolbar({ selectedCount: 1 });

        await user.click(screen.getByText("New contact"));
        expect(handlers.onNewContact).toHaveBeenCalledTimes(1);
        await user.click(screen.getByText("Edit"));
        expect(handlers.onEdit).toHaveBeenCalledTimes(1);
        await user.click(screen.getByText("Delete"));
        expect(handlers.onDelete).toHaveBeenCalledTimes(1);
        await user.click(screen.getByText("Email"));
        expect(handlers.onEmail).toHaveBeenCalledTimes(1);
        await user.click(screen.getByText("Favorite"));
        expect(handlers.onToggleFavorite).toHaveBeenCalledTimes(1);
        await user.click(screen.getByText("Add category"));
        expect(handlers.onAddCategory).toHaveBeenCalledTimes(1);
        await user.click(screen.getByText("Export"));
        expect(handlers.onExportVCard).toHaveBeenCalledTimes(1);
    });

    it("opens the hidden file picker when Import is clicked, and forwards the chosen file.", async () => {
        const user = userEvent.setup();
        const handlers = renderToolbar();
        const file = new File(["BEGIN:VCARD..."], "contacts.vcf", { type: "text/vcard" });

        await user.click(screen.getByText("Import"));
        await user.upload(screen.getByLabelText("Import contacts file"), file);

        expect(handlers.onImportFile).toHaveBeenCalledWith(file);
    });

    it("does not call onImportFile when the file picker is dismissed with no file chosen.", async () => {
        const handlers = renderToolbar();
        const input = screen.getByLabelText("Import contacts file");
        fireEvent.change(input, { target: { files: [] } });

        expect(handlers.onImportFile).not.toHaveBeenCalled();
    });
});
