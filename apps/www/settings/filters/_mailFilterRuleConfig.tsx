///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { Folder, FolderType } from "@rapidmx/react-shared/mailApi.js";
import { MailFilterAction } from "@rapidmx/react-shared/mailFilterRulesApi.js";
import { ActionTypeDef, ConditionFieldDef } from "../../../shared/components/rules/RuleBuilder.js";

const FIELD_INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** Folder types a mail filter can't meaningfully move/copy a message into — a mailbox's single
 * well-known `calendar`/`contacts`/`tasks`/`notes` folder holds a different entity type entirely, not
 * messages. */
const NON_MAIL_FOLDER_TYPES = new Set<FolderType>(["calendar", "contacts", "tasks", "notes"]);

export const MAIL_FILTER_CONDITION_FIELDS: ConditionFieldDef[] = [
    { key: "fromContains", label: "From contains", kind: "list" },
    { key: "subjectContains", label: "Subject contains", kind: "list" },
    { key: "bodyContains", label: "Body contains", kind: "list" },
    { key: "toCcContains", label: "Any To/Cc recipient equals", kind: "list" },
    { key: "hasAttachment", label: "Has an attachment", kind: "boolean" },
    {
        key: "importance",
        label: "Importance",
        kind: "select",
        options: [
            { value: "low", label: "Low" },
            { value: "normal", label: "Normal" },
            { value: "high", label: "High" },
        ],
    },
];

/**
 * Builds the mail-filter action-type registry for `RuleBuilder`, closing over `folders` so the
 * move/copy-to-folder actions can render a real folder picker. `RuleBuilder`'s own `render()` contract
 * is synchronous, so this resolves `folders` once up front (the caller already loads them for the page
 * itself) rather than each action row fetching independently.
 */
export function buildMailFilterActionTypes(folders: Folder[]): ActionTypeDef<MailFilterAction>[] {
    const destinationFolders = folders.filter((f) => !NON_MAIL_FOLDER_TYPES.has(f.type));

    const folderSelect = (action: MailFilterAction, onChange: (next: MailFilterAction) => void) => (
        <select
            aria-label="Destination folder"
            className={FIELD_INPUT_CLASS}
            value={action.folderUid ?? ""}
            onChange={(e) => onChange({ ...action, folderUid: e.target.value })}
        >
            <option value="">Choose a folder&hellip;</option>
            {destinationFolders.map((folder) => (
                <option key={folder.uid} value={folder.uid}>
                    {folder.name}
                </option>
            ))}
        </select>
    );

    return [
        {
            value: "move_to_folder",
            label: "Move to folder",
            createDefault: () => ({ type: "move_to_folder", folderUid: "" }),
            render: folderSelect,
        },
        {
            value: "copy_to_folder",
            label: "Copy to folder",
            createDefault: () => ({ type: "copy_to_folder", folderUid: "" }),
            render: folderSelect,
        },
        {
            value: "delete",
            label: "Delete the message",
            createDefault: () => ({ type: "delete" }),
            render: () => null,
        },
        {
            value: "mark_as_read",
            label: "Mark as read",
            createDefault: () => ({ type: "mark_as_read" }),
            render: () => null,
        },
        {
            value: "forward",
            label: "Forward to",
            createDefault: () => ({ type: "forward", forwardTo: "" }),
            render: (action, onChange) => (
                <input
                    type="email"
                    aria-label="Forward to address"
                    className={FIELD_INPUT_CLASS}
                    placeholder="assistant@example.com"
                    value={action.forwardTo ?? ""}
                    onChange={(e) => onChange({ ...action, forwardTo: e.target.value })}
                />
            ),
        },
    ];
}
