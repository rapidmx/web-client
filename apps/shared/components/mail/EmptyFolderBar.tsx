///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineTrash } from "react-icons/hi2";

export interface EmptyFolderBarProps {
    /** The folder the list is showing ("Deleted Items", "Junk Email"). */
    folderName: string;
    /** How many messages it holds, when that is known. */
    count?: number;
    /** Nothing to empty, or not allowed to. */
    disabled: boolean;
    /** Why, shown as the button's tooltip while it is disabled. */
    disabledReason?: string;
    onEmpty: () => void;
}

/**
 * Outlook's "Empty folder", at the top of the list of Deleted Items and of Junk Email: the whole folder is permanently deleted, after the
 * page has asked (this only reports the click). A row of its own under the toolbar rather than a toolbar button, so the toolbar keeps the
 * width a phone gives it and the action is never taken for one of the list's arrangement controls.
 */
export default function EmptyFolderBar({ folderName, count, disabled, disabledReason, onEmpty }: EmptyFolderBarProps) {
    return (
        <div className="flex items-center justify-between gap-2 px-3 py-1 border-b border-border text-xs text-text-muted">
            <span>{count === undefined ? "" : `${count} ${count === 1 ? "item" : "items"}`}</span>
            <button
                type="button"
                onClick={onEmpty}
                disabled={disabled}
                title={disabled ? disabledReason : `Permanently delete everything in ${folderName}`}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-sm text-danger hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent"
            >
                <HiOutlineTrash size={16} aria-hidden="true" className="shrink-0" />
                {`Empty ${folderName}`}
            </button>
        </div>
    );
}
