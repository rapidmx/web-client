///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { Folder, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { Label } from "@rapidmx/react-shared/mail/labelsApi.js";
import LabelMenuButton from "./labelMenu.js";
import MoveToFolderDialog, { MOVE_TARGET_TYPES } from "./MoveToFolderDialog.js";
import { ariaKeyShortcuts, withHint } from "../../keyboard/format.js";
import { SHORTCUTS, ShortcutDef } from "../../keyboard/keymap.js";
import { useKeyEnvironment } from "../../keyboard/ShortcutProvider.js";

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
    /** A folder created from the Move to prompt, for the caller's own folder list and the sidebar. */
    onFolderCreated: (folder: Folder) => void;
    /** Sets the selection's labels: every message ends up with `labelUids`, plus whichever of
     * `keepPartial` it already had (those rows were left partially applied, so each message keeps what
     * it has). */
    onApplyLabels: (labelUids: string[], keepPartial: string[]) => void;
    onSetRead: (read: boolean) => void;
    onSetFlagged: (flagged: boolean) => void;
    onArchive: () => void;
    /** Moves the selection into `folderUid`, resolving once the bulk update has settled. It resolves
     * whether or not that update was rejected: a bulk update is applied element by element, so a failure
     * is explained by a pop-up (see `notifyApiError()`), raised by the page along with the reload it triggers, rather than in the
     * prompt, which would be claiming the move simply didn't happen. */
    onMoveTo: (folderUid: string) => Promise<void>;
    onReportJunk: () => void;
    onDelete: () => void;
    /** A bulk action is in flight - every action is held until it settles, since the next one would send
     * `version`s the first has already superseded. */
    busy: boolean;
    /** The keyboard acts on this selection (Delete, Ctrl+Q, Ctrl+U, Insert - registered by the page): Mark read, Mark unread, Flag and
     * Delete name their shortcut in the tooltip and `aria-keyshortcuts`. */
    shortcuts?: boolean;
    /** Why Move to is unavailable, when the selection is spread over mailboxes and a folder can only belong to one (search results over several
     * mailboxes). Shown as the button's tooltip. */
    moveDisabledReason?: string;
    /** The same for Apply label: a label belongs to one mailbox, and `labels` are one mailbox's. */
    labelsDisabledReason?: string;
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
    onFolderCreated,
    onApplyLabels,
    onSetRead,
    onSetFlagged,
    onArchive,
    onMoveTo,
    onReportJunk,
    onDelete,
    busy,
    shortcuts,
    moveDisabledReason,
    labelsDisabledReason,
}: MailSelectionBarProps) {
    const env = useKeyEnvironment();
    /** `title` and `aria-keyshortcuts` for an action the keyboard also does; `reason` (why it is disabled) wins the tooltip. */
    const hint = (label: string, shortcut: ShortcutDef, reason?: string) =>
        shortcuts
            ? { title: reason ?? withHint(label, shortcut, env), "aria-keyshortcuts": ariaKeyShortcuts(shortcut, env) }
            : { title: reason };
    const selectedCount = totals?.selected ?? selected.length;
    const listedCount = totals?.listed ?? listed.length;
    // Counted on the rows that were ticked, but *emptied* on the messages: a ticked conversation whose
    // messages are still being fetched has nothing for an action to act on yet.
    const none = selectedCount === 0 || selected.length === 0;
    const allSelected = listedCount > 0 && selectedCount === listedCount;
    const currentType = folders.find((folder) => folder.uid === currentFolderUid)?.type;
    const moveTargets = folders.filter((folder) => MOVE_TARGET_TYPES.has(folder.type) && folder.uid !== currentFolderUid);
    // The same prompt the reading pane's own Move to opens, so one list of destinations and one way to
    // create a folder serve both.
    const [movePrompt, setMovePrompt] = useState(false);

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


    return (
        <div className="border-b border-border">
            <MoveToFolderDialog
                open={movePrompt}
                onClose={() => setMovePrompt(false)}
                mailboxUid={mailboxUid}
                folders={folders}
                currentFolderUid={currentFolderUid}
                count={selected.length}
                onMove={onMoveTo}
                onFolderCreated={onFolderCreated}
            />
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
                <button type="button" onClick={() => onSetRead(true)} disabled={none || busy} className={actionClassName()} {...hint("Mark read", SHORTCUTS.mail.markRead)}>
                    Mark read
                </button>
                <button type="button" onClick={() => onSetRead(false)} disabled={none || busy} className={actionClassName()} {...hint("Mark unread", SHORTCUTS.mail.markUnread)}>
                    Mark unread
                </button>
                <button type="button" onClick={() => onSetFlagged(true)} disabled={none || busy} className={actionClassName()} {...hint("Flag", SHORTCUTS.mail.flag)}>
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
                    disabled={none || busy || !!labelsDisabledReason}
                    title={labelsDisabledReason}
                    note={
                        selected.length === 1
                            ? "Ticked labels are applied, unticked ones removed."
                            : "Ticked labels are applied to every selected message and unticked ones removed from all of them; a dash means only some have that label, and leaving it alone keeps it that way."
                    }
                    emptyNote="This mailbox has no labels yet."
                    commit={{ label: "Apply" }}
                    clear={{ label: "Remove all labels" }}
                />
                <button
                    type="button"
                    onClick={() => setMovePrompt(true)}
                    disabled={none || busy || !!moveDisabledReason}
                    title={moveDisabledReason}
                    className={actionClassName()}
                >
                    Move to
                </button>
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
                    className={actionClassName()}
                    {...hint("Delete", SHORTCUTS.mail.delete, deleteReason)}
                >
                    Delete
                </button>
            </div>
        </div>
    );
}
