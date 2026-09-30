///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { IconType } from "react-icons";
import {
    HiOutlineArchiveBox,
    HiOutlineArrowUpTray,
    HiOutlineBookOpen,
    HiOutlineCalendarDays,
    HiOutlineClipboardDocumentList,
    HiOutlineFolder,
    HiOutlineInbox,
    HiOutlinePaperAirplane,
    HiOutlinePencilSquare,
    HiOutlineShieldExclamation,
    HiOutlineTrash,
    HiOutlineUsers,
    HiUserGroup,
} from "react-icons/hi2";
import type { FolderType } from "../../../../../lib/mail/mailApi.js";

const FOLDER_ICONS: Record<FolderType, IconType> = {
    inbox: HiOutlineInbox,
    drafts: HiOutlinePencilSquare,
    sent_items: HiOutlinePaperAirplane,
    outbox: HiOutlineArrowUpTray,
    junk: HiOutlineShieldExclamation,
    archive: HiOutlineArchiveBox,
    deleted_items: HiOutlineTrash,
    calendar: HiOutlineCalendarDays,
    contacts: HiOutlineUsers,
    tasks: HiOutlineClipboardDocumentList,
    notes: HiOutlineBookOpen,
    user: HiOutlineFolder,
};

/** The icon drawn to the left of a folder's name: one per well-known folder, a plain folder for the user's own. */
export function FolderTypeIcon({ type }: { type: FolderType | string }) {
    const Icon = FOLDER_ICONS[type as FolderType] ?? HiOutlineFolder;
    return <Icon size={18} aria-hidden="true" className="shrink-0 text-text-muted" />;
}

/** What marks a mailbox other people share with this user, beside its name: the group icon, and for a screen reader the word it stands for. */
export function SharedMailboxMark() {
    return (
        <>
            <HiUserGroup size={14} aria-hidden="true" className="inline-block ml-1.5 align-[-2px] shrink-0 text-text-muted" />
            {" "}
            <span className="sr-only">(shared)</span>
        </>
    );
}
