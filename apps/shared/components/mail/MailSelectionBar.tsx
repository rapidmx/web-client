///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import {
    HiOutlineArchiveBox,
    HiOutlineCheckCircle,
    HiOutlineEnvelope,
    HiOutlineEnvelopeOpen,
    HiOutlineFlag,
    HiOutlineFolderArrowDown,
    HiOutlineMinusCircle,
    HiOutlineNoSymbol,
    HiOutlineTrash,
    HiOutlineXMark,
} from "react-icons/hi2";
import { Folder, Message } from "../../../../lib/mail/mailApi.js";
import { Label } from "../../../../lib/mail/labelsApi.js";
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
    /** Delete: moves the selection to Deleted Items - or, when `deletesPermanently`, permanently deletes it (the page asks first). */
    onDelete: () => void;
    /** The selection is in Deleted Items, so Delete is the permanent one: the button says "Delete permanently" and is styled as the destructive
     * action it is. The page decides (a search over several mailboxes lists messages from more than one folder, so the folder being viewed is not
     * always the answer). */
    deletesPermanently?: boolean;
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

/** The look of the bar's icon buttons - the reading pane's own command row (`ICON_BUTTON_CLASS` in `MessageDetailPane`), without its border, which nine of them in a row don't need. */
function iconClassName(destructive = false): string {
    return `inline-flex items-center justify-center p-1.5 rounded-md text-sm ${destructive ? "text-danger" : "text-text"} hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent`;
}

/** One of the bar's actions as an icon button: the action's name is its `aria-label` (so it has the accessible name its text button had) and its tooltip,
 * unless there is a `reason` it is unavailable, or a keyboard shortcut to name (`title` and `aria-keyshortcuts` from `hint()`). */
function BarAction({
    icon,
    label,
    onClick,
    disabled,
    reason,
    destructive,
    hint,
}: {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    reason?: string;
    destructive?: boolean;
    hint?: { title?: string; "aria-keyshortcuts"?: string };
}) {
    return (
        <button
            type="button"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
            className={iconClassName(destructive)}
            {...hint}
            title={reason ?? hint?.title ?? label}
        >
            {icon}
        </button>
    );
}

/**
 * The header that replaces the list's own toolbar while select mode is on: how many rows are selected,
 * select-all/clear, and the bulk actions Outlook offers for a multi-selection - mark read/unread, flag,
 * archive, move, report junk and delete.
 *
 * "Delete" means *move to Deleted Items* - except on messages that are already in Deleted Items (`deletesPermanently`),
 * where it is "Delete permanently": the page confirms, then erases them for good, as Outlook's Delete does there. An
 * action whose target folder is the one already being viewed is disabled with a reason rather than hidden, so the set
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
    deletesPermanently = false,
    busy,
    shortcuts,
    moveDisabledReason,
    labelsDisabledReason,
}: MailSelectionBarProps) {
    const env = useKeyEnvironment();
    /** `title` and `aria-keyshortcuts` for an action the keyboard also does. */
    const hint = (label: string, shortcut: ShortcutDef) =>
        shortcuts ? { title: withHint(label, shortcut, env), "aria-keyshortcuts": ariaKeyShortcuts(shortcut, env) } : {};
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
    const deleteLabel = deletesPermanently ? "Delete permanently" : "Delete";

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
            <div className="flex items-center gap-1 px-3 py-1.5 bg-surface-alt">
                <span aria-live="polite" className="text-sm font-semibold text-text mr-auto">
                    {selectedCount}
                    {totals ? ` ${totals.noun}${selectedCount === 1 ? "" : "s"}` : ""} selected
                </span>
                <BarAction
                    icon={<HiOutlineCheckCircle size={16} aria-hidden="true" />}
                    label="Select all"
                    onClick={onSelectAll}
                    disabled={allSelected || listedCount === 0}
                />
                <BarAction icon={<HiOutlineMinusCircle size={16} aria-hidden="true" />} label="Clear" onClick={onClearSelection} disabled={selectedCount === 0} />
                <BarAction icon={<HiOutlineXMark size={16} aria-hidden="true" />} label="Cancel" onClick={onCancel} />
            </div>
            {/* Icon-only, so all nine fit one row of the 24rem list column; wraps if the column is ever narrower. */}
            <div className="flex flex-wrap items-center gap-0.5 px-1.5 py-1">
                <BarAction
                    icon={<HiOutlineEnvelopeOpen size={16} aria-hidden="true" />}
                    label="Mark read"
                    onClick={() => onSetRead(true)}
                    disabled={none || busy}
                    hint={hint("Mark read", SHORTCUTS.mail.markRead)}
                />
                <BarAction
                    icon={<HiOutlineEnvelope size={16} aria-hidden="true" />}
                    label="Mark unread"
                    onClick={() => onSetRead(false)}
                    disabled={none || busy}
                    hint={hint("Mark unread", SHORTCUTS.mail.markUnread)}
                />
                <BarAction
                    icon={<HiOutlineFlag size={16} aria-hidden="true" />}
                    label="Flag"
                    onClick={() => onSetFlagged(true)}
                    disabled={none || busy}
                    hint={hint("Flag", SHORTCUTS.mail.flag)}
                />
                <BarAction
                    icon={
                        // `hi2` has no flag-with-a-line-through glyph: the flag, struck through.
                        <span className="relative inline-flex" aria-hidden="true">
                            <HiOutlineFlag size={16} />
                            <span className="absolute left-1/2 top-[-1px] h-[18px] w-[1.5px] -translate-x-1/2 rotate-45 rounded bg-current" />
                        </span>
                    }
                    label="Unflag"
                    onClick={() => onSetFlagged(false)}
                    disabled={none || busy}
                />
                <BarAction
                    icon={<HiOutlineArchiveBox size={16} aria-hidden="true" />}
                    label="Archive"
                    onClick={onArchive}
                    disabled={none || busy || !!archiveReason}
                    reason={archiveReason}
                />
                <LabelMenuButton
                    aria-label="Apply label"
                    label="Apply label"
                    iconOnly
                    className={iconClassName()}
                    labels={labels}
                    mailboxUid={mailboxUid}
                    onLabelCreated={onLabelCreated}
                    applied={appliedToAll.map((label) => label.uid)}
                    partial={appliedToSome.map((label) => label.uid)}
                    onCommit={onApplyLabels}
                    busy={busy}
                    disabled={none || busy || !!labelsDisabledReason}
                    title={labelsDisabledReason ?? "Apply label"}
                    note={
                        selected.length === 1
                            ? "Ticked labels are applied, unticked ones removed."
                            : "Ticked labels are applied to every selected message and unticked ones removed from all of them; a dash means only some have that label, and leaving it alone keeps it that way."
                    }
                    emptyNote="This mailbox has no labels yet."
                    commit={{ label: "Apply" }}
                    clear={{ label: "Remove all labels" }}
                />
                <BarAction
                    icon={<HiOutlineFolderArrowDown size={16} aria-hidden="true" />}
                    label="Move to"
                    onClick={() => setMovePrompt(true)}
                    disabled={none || busy || !!moveDisabledReason}
                    reason={moveDisabledReason}
                />
                <BarAction
                    icon={<HiOutlineNoSymbol size={16} aria-hidden="true" />}
                    label="Report junk"
                    onClick={onReportJunk}
                    disabled={none || busy || !!junkReason}
                    reason={junkReason}
                />
                <BarAction
                    icon={<HiOutlineTrash size={16} aria-hidden="true" />}
                    label={deleteLabel}
                    onClick={onDelete}
                    disabled={none || busy}
                    destructive={deletesPermanently}
                    hint={hint(deleteLabel, SHORTCUTS.mail.delete)}
                />
            </div>
        </div>
    );
}
