///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ChangeEvent, useRef } from "react";
import {
    HiOutlineArrowDownTray,
    HiOutlineArrowUpTray,
    HiOutlineEnvelope,
    HiOutlinePencil,
    HiOutlineStar,
    HiOutlineTag,
    HiOutlineTrash,
    HiOutlineUserPlus,
    HiStar,
} from "react-icons/hi2";
import { SHORTCUTS } from "../../keyboard/keymap.js";
import { useShortcutProps } from "../../keyboard/useShortcutProps.js";
import ResponsiveToolbar, { ToolbarAction } from "../layout/ResponsiveToolbar.js";

export interface ContactsToolbarProps {
    selectedCount: number;
    /** `true` only when every currently-selected contact is already favorited — flips the "favorite" button
     * to act (and read) as a removal instead of an addition. */
    allSelectedFavorited: boolean;
    onNewContact: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onEmail: () => void;
    onToggleFavorite: () => void;
    onAddCategory: () => void;
    onExportVCard: () => void;
    /** A `.vcf` file the user picked via the toolbar's own hidden file input — parsing/import is the
     * page's responsibility (it has the mailbox/folder context and the actual `createContact` calls). */
    onImportFile: (file: File) => void;
    /** The keyboard's "New contact" is registered by the page: the button names its shortcut in its tooltip and `aria-keyshortcuts`. */
    shortcuts?: boolean;
    /** Leaves the New contact button out - the phone layout offers it as a floating button instead. */
    hideNew?: boolean;
}

/**
 * Contacts' Outlook-style ribbon toolbar, fitted to its column (`ResponsiveToolbar`): captions under the icons while there is room, then icons
 * alone, then the rarely used actions - Import, Export, Add category, and so on up - in a "More" menu; the bar can never spill into the pane
 * beside it. Every button keeps its tooltip (New contact its shortcut's) and accessible name in every layout. Deliberately presentational — every action is a callback the
 * page (`apps/www/contacts/index.tsx`) implements, since it owns the actual contact data, the current
 * selection, and the mailbox/folder context every real action (create/delete/email/favorite/category)
 * needs. "New contact list" isn't duplicated here — `ContactsSidebar` already has its own inline
 * "+ New list" affordance next to the "Your contact lists" heading.
 */
export default function ContactsToolbar({
    selectedCount,
    allSelectedFavorited,
    onNewContact,
    onEdit,
    onDelete,
    onEmail,
    onToggleFavorite,
    onAddCategory,
    onExportVCard,
    onImportFile,
    shortcuts,
    hideNew,
}: ContactsToolbarProps) {
    const newContactHint = useShortcutProps("New contact", SHORTCUTS.contacts.create, !!shortcuts);
    const importInputRef = useRef<HTMLInputElement | null>(null);
    const hasSelection = selectedCount > 0;

    function handleImportFileChosen(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) {
            onImportFile(file);
        }
    }

    const actions: ToolbarAction[] = [
        ...(hideNew
            ? []
            : [{ id: "new", label: "New contact", icon: HiOutlineUserPlus, onClick: onNewContact, hint: shortcuts ? newContactHint : undefined, group: 0, rank: 99, essential: true }]),
        { id: "edit", label: "Edit", icon: HiOutlinePencil, onClick: onEdit, disabled: selectedCount !== 1, group: 1, rank: 6 },
        { id: "delete", label: "Delete", icon: HiOutlineTrash, onClick: onDelete, disabled: !hasSelection, group: 1, rank: 5 },
        { id: "email", label: "Email", icon: HiOutlineEnvelope, onClick: onEmail, disabled: !hasSelection, group: 2, rank: 4 },
        {
            id: "favorite",
            label: allSelectedFavorited ? "Unfavorite" : "Favorite",
            icon: allSelectedFavorited ? HiStar : HiOutlineStar,
            onClick: onToggleFavorite,
            disabled: !hasSelection,
            group: 2,
            rank: 3,
        },
        { id: "category", label: "Add category", icon: HiOutlineTag, onClick: onAddCategory, disabled: !hasSelection, group: 2, rank: 2 },
        { id: "export", label: "Export", icon: HiOutlineArrowUpTray, onClick: onExportVCard, disabled: !hasSelection, group: 3, rank: 1 },
        { id: "import", label: "Import", icon: HiOutlineArrowDownTray, onClick: () => importInputRef.current?.click(), group: 3, rank: 0 },
    ];

    return (
        <ResponsiveToolbar label="Contacts actions" actions={actions}>
            <input ref={importInputRef} type="file" accept=".vcf" className="sr-only" aria-label="Import contacts file" onChange={handleImportFileChosen} />
        </ResponsiveToolbar>
    );
}
