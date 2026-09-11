///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ChangeEvent, useRef } from "react";
import type { IconType } from "react-icons";
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
}

function ToolbarButton({
    label,
    icon: Icon,
    disabled,
    onClick,
}: {
    label: string;
    icon: IconType;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="flex flex-col items-center gap-1 text-xs text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed px-2.5 py-1.5 rounded-sm hover:not-disabled:bg-surface-alt"
        >
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
        </button>
    );
}

function Divider() {
    return <div className="w-px self-stretch my-1 bg-border" aria-hidden="true" />;
}

/**
 * Contacts' Outlook-style ribbon toolbar. Deliberately presentational — every action is a callback the
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
}: ContactsToolbarProps) {
    const importInputRef = useRef<HTMLInputElement | null>(null);
    const hasSelection = selectedCount > 0;

    function handleImportFileChosen(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) {
            onImportFile(file);
        }
    }

    return (
        <div role="toolbar" aria-label="Contacts actions" className="border-b border-border bg-surface-alt flex items-center gap-0.5 px-2 py-1">
            <ToolbarButton label="New contact" icon={HiOutlineUserPlus} onClick={onNewContact} />
            <Divider />
            <ToolbarButton label="Edit" icon={HiOutlinePencil} disabled={selectedCount !== 1} onClick={onEdit} />
            <ToolbarButton label="Delete" icon={HiOutlineTrash} disabled={!hasSelection} onClick={onDelete} />
            <Divider />
            <ToolbarButton label="Email" icon={HiOutlineEnvelope} disabled={!hasSelection} onClick={onEmail} />
            <ToolbarButton
                label={allSelectedFavorited ? "Unfavorite" : "Favorite"}
                icon={allSelectedFavorited ? HiStar : HiOutlineStar}
                disabled={!hasSelection}
                onClick={onToggleFavorite}
            />
            <ToolbarButton label="Add category" icon={HiOutlineTag} disabled={!hasSelection} onClick={onAddCategory} />
            <Divider />
            <ToolbarButton label="Export" icon={HiOutlineArrowUpTray} disabled={!hasSelection} onClick={onExportVCard} />
            <ToolbarButton label="Import" icon={HiOutlineArrowDownTray} onClick={() => importInputRef.current?.click()} />
            <input ref={importInputRef} type="file" accept=".vcf" className="sr-only" aria-label="Import contacts file" onChange={handleImportFileChosen} />
        </div>
    );
}
