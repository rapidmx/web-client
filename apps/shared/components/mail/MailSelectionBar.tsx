///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { Folder, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { Label } from "@rapidmx/react-shared/mail/labelsApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import MenuButton, { MenuSectionSpec } from "./MenuButton.js";
import LabelMenuButton from "./labelMenu.js";

/** The folder types a message can be moved *into* from this bar - Outbox is a transient send queue the
 * server owns, and the non-mail folders (`calendar`/`contacts`/`tasks`/`notes`) aren't message folders at
 * all, so neither is offered. */
const MOVE_TARGET_TYPES = new Set(["inbox", "drafts", "sent_items", "junk", "archive", "deleted_items", "user"]);

export interface MailSelectionBarProps {
    selected: Message[];
    /** Every message currently listed - what "Select all" selects and what `allSelected` is measured against. */
    listed: Message[];
    /** What the bar *counts*, when the rows being ticked aren't messages themselves: the conversation list
     * ticks conversations, each standing for several messages, so "3 conversations selected" is what the
     * reader picked while `selected` stays the messages every action below acts on. Left out by the flat
     * message list, which counts `selected`/`listed` directly. */
    totals?: { selected: number; listed: number; noun: string };
    onSelectAll: () => void;
    onClearSelection: () => void;
    /** Leaves select mode entirely (and clears the selection). */
    onCancel: () => void;
    folders: Folder[];
    currentFolderUid?: string;
    /** Every label this mailbox has, for the Apply label action. */
    labels: Label[];
    /** The mailbox a label created from Apply label belongs to. */
    mailboxUid: string;
    onLabelCreated: (label: Label) => void;
    /** Sets the selection's labels: every message ends up with `labelUids`, plus whichever of
     * `keepPartial` it already had (those rows were left partially applied, so each message keeps what
     * it has). */
    onApplyLabels: (labelUids: string[], keepPartial: string[]) => void;
    onSetRead: (read: boolean) => void;
    onSetFlagged: (flagged: boolean) => void;
    onArchive: () => void;
    onMoveTo: (folderUid: string) => void;
    onReportJunk: () => void;
    onDelete: () => void;
    /** A bulk action is in flight - every action is held until it settles, since the next one would send
     * `version`s the first has already superseded. */
    busy: boolean;
    error: string | null;
}

function actionClassName(): string {
    return "px-2 py-1 rounded-md text-sm text-text hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent";
}

/**
 * The header that replaces the list's own toolbar while select mode is on: how many rows are selected,
 * select-all/clear, and the bulk actions Outlook offers for a multi-selection - mark read/unread, flag,
 * archive, move, report junk and delete.
 *
 * "Delete" means *move to Deleted Items*, never a permanent erase: there is no bulk permanent-delete API,
 * and the collection-level DELETE truncates the folder rather than removing a selection. An action whose
 * target folder is the one already being viewed is disabled with a reason rather than hidden, so the set
 * of actions doesn't shift around between folders.
 */
export default function MailSelectionBar({
    selected,
    listed,
    totals,
    onSelectAll,
    onClearSelection,
    onCancel,
    folders,
    currentFolderUid,
    labels,
    mailboxUid,
    onLabelCreated,
    onApplyLabels,
    onSetRead,
    onSetFlagged,
    onArchive,
    onMoveTo,
    onReportJunk,
    onDelete,
    busy,
    error,
}: MailSelectionBarProps) {
    const selectedCount = totals?.selected ?? selected.length;
    const listedCount = totals?.listed ?? listed.length;
    // Counted on the rows that were ticked, but *emptied* on the messages: a ticked conversation whose
    // messages are still being fetched has nothing for an action to act on yet.
    const none = selectedCount === 0 || selected.length === 0;
    const allSelected = listedCount > 0 && selectedCount === listedCount;
    const currentType = folders.find((folder) => folder.uid === currentFolderUid)?.type;
    const moveTargets = folders.filter((folder) => MOVE_TARGET_TYPES.has(folder.type) && folder.uid !== currentFolderUid);

    // None of the three needs its folder to exist first - the caller creates or lazily provisions it (see
    // `resolveFolderOfType()` and `bulkArchive()` in `apps/www/index.tsx`) - so the only thing that disables
    // them is already being in the folder they would move to.
    const archiveReason = currentType === "archive" ? "These messages are already in Archive" : undefined;
    const junkReason = currentType === "junk" ? "These messages are already in Junk" : undefined;
    const deleteReason = currentType === "deleted_items" ? "These messages are already in Deleted Items" : undefined;

    // A label every selected message already carries starts ticked; one only some of them carry starts
    // partially applied, and is left exactly as it is unless the reader touches that row.
    const appliedToAll = labels.filter((label) => !none && selected.every((m) => m.labelUids?.includes(label.uid)));
    const appliedToSome = labels.filter(
        (label) => selected.some((m) => m.labelUids?.includes(label.uid)) && !appliedToAll.includes(label),
    );

    const moveSections: MenuSectionSpec[] = [
        {
            key: "folders",
            label: "Move to folder",
            note: moveTargets.length === 0 ? "There is no other folder in this mailbox to move to." : undefined,
            items: moveTargets.map((folder) => ({
                key: folder.uid,
                label: folder.name,
                onSelect: () => onMoveTo(folder.uid),
            })),
        },
    ];

    return (
        <div className="border-b border-border">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-alt">
                <span aria-live="polite" className="text-sm font-semibold text-text">
                    {selectedCount}
                    {totals ? ` ${totals.noun}${selectedCount === 1 ? "" : "s"}` : ""} selected
                </span>
                <button type="button" onClick={onSelectAll} disabled={allSelected || listedCount === 0} className={actionClassName()}>
                    Select all
                </button>
                <button type="button" onClick={onClearSelection} disabled={selectedCount === 0} className={actionClassName()}>
                    Clear
                </button>
                <button type="button" onClick={onCancel} className={`${actionClassName()} ml-auto`}>
                    Cancel
                </button>
            </div>
            <div className="flex flex-wrap items-center gap-0.5 px-1.5 py-1">
                <button type="button" onClick={() => onSetRead(true)} disabled={none || busy} className={actionClassName()}>
                    Mark read
                </button>
                <button type="button" onClick={() => onSetRead(false)} disabled={none || busy} className={actionClassName()}>
                    Mark unread
                </button>
                <button type="button" onClick={() => onSetFlagged(true)} disabled={none || busy} className={actionClassName()}>
                    Flag
                </button>
                <button type="button" onClick={() => onSetFlagged(false)} disabled={none || busy} className={actionClassName()}>
                    Unflag
                </button>
                <button
                    type="button"
                    onClick={onArchive}
                    disabled={none || busy || !!archiveReason}
                    title={archiveReason}
                    className={actionClassName()}
                >
                    Archive
                </button>
                <LabelMenuButton
                    aria-label="Apply label"
                    label="Apply label"
                    className="text-sm"
                    labels={labels}
                    mailboxUid={mailboxUid}
                    onLabelCreated={onLabelCreated}
                    applied={appliedToAll.map((label) => label.uid)}
                    partial={appliedToSome.map((label) => label.uid)}
                    onCommit={onApplyLabels}
                    busy={busy}
                    disabled={none || busy}
                    note={
                        selected.length === 1
                            ? "Ticked labels are applied, unticked ones removed."
                            : "Ticked labels are applied to every selected message and unticked ones removed from all of them; a dash means only some have that label, and leaving it alone keeps it that way."
                    }
                    emptyNote="This mailbox has no labels yet."
                    commit={{ label: "Apply" }}
                    clear={{ label: "Remove all labels" }}
                />
                <MenuButton
                    aria-label="Move to"
                    label="Move to"
                    sections={moveSections}
                    disabled={none || busy || moveTargets.length === 0}
                    title={moveTargets.length === 0 ? "There is no other folder in this mailbox to move to" : undefined}
                />
                <button
                    type="button"
                    onClick={onReportJunk}
                    disabled={none || busy || !!junkReason}
                    title={junkReason}
                    className={actionClassName()}
                >
                    Report junk
                </button>
                <button
                    type="button"
                    onClick={onDelete}
                    disabled={none || busy || !!deleteReason}
                    title={deleteReason}
                    className={actionClassName()}
                >
                    Delete
                </button>
            </div>
            {error && (
                <div className="px-3 pb-2">
                    <Alert>{error}</Alert>
                </div>
            )}
        </div>
    );
}
