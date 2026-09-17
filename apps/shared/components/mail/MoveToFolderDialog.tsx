///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useRef, useState } from "react";
import { HiOutlineFolder, HiOutlineFolderPlus } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Folder, createFolder } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

/**
 * The folder types a message can be moved *into* - Outbox is a transient send queue the server owns, and
 * the non-mail folders (`calendar`/`contacts`/`tasks`/`notes`) aren't message folders at all, so neither is
 * offered. Shared by the reading pane's Move to and select mode's bulk Move to, which is the whole point of
 * this component: one destination list, one set of rules.
 */
export const MOVE_TARGET_TYPES = new Set(["inbox", "drafts", "sent_items", "junk", "archive", "deleted_items", "user"]);

/** Above this many destinations the dialog offers a filter box - below it, one is just another thing to
 * skip past on the way to a list that already fits on screen. */
export const FOLDER_FILTER_THRESHOLD = 8;

/** What `@rapidmx/restapi` accepts as a folder name, so a name it would refuse is refused here, next to the
 * field, rather than as a 400 after a round trip. */
export const MAX_FOLDER_NAME_LENGTH = 255;

/**
 * Why a name can't be used, or `null` when it can. Folders are a real tree (`Folder.parentFolderUid`), not
 * paths, so a separator in a name would be a character in the name rather than a nesting instruction -
 * which is exactly why it is refused: it would read as a hierarchy this app never created.
 */
export function folderNameError(name: string, existing: Folder[]): string | null {
    const trimmed = name.trim();
    if (!trimmed) {
        return "Enter a name for the new folder.";
    }
    if (trimmed.length > MAX_FOLDER_NAME_LENGTH) {
        return `A folder name can be at most ${MAX_FOLDER_NAME_LENGTH} characters.`;
    }
    if (/[/\\]/.test(trimmed)) {
        return "A folder name can't contain / or \\.";
    }
    const clash = existing.find((folder) => folder.name.toLowerCase() === trimmed.toLowerCase());
    if (clash) {
        return `This mailbox already has a folder called "${clash.name}". Pick it from the list instead.`;
    }
    return null;
}

export interface MoveToFolderDialogProps {
    open: boolean;
    onClose: () => void;
    /** The mailbox whose folders are offered, and the one a new folder is created in. */
    mailboxUid: string;
    /** Every folder of that mailbox - filtered to the movable types here, so callers hand over the list
     * they already hold rather than pre-filtering it each time. */
    folders: Folder[];
    /** Where the message(s) are now: offered, but disabled, so the list doesn't change shape per folder. */
    currentFolderUid?: string;
    /** What is being moved, for the dialog's own title ("Move 3 messages to"). Defaults to one message. */
    count?: number;
    /**
     * Performs the move, resolving once it has settled. A rejection is shown in this dialog, beside the
     * destination that would retry it; the dialog closes on success. The bulk caller resolves either way
     * and reports its own outcome in the selection bar, which is where a partly-applied bulk update has to
     * be explained (see `runBulkAction()`).
     */
    onMove: (folderUid: string) => Promise<void>;
    /** A folder this dialog created, so the caller's own folder list - and the sidebar - pick it up without
     * a page load. Called before the move, so a failed move still leaves the folder that was created. */
    onFolderCreated?: (folder: Folder) => void;
}

/**
 * Outlook's "Move to" prompt: pick a destination folder for the open message or the selection, or create a
 * folder and move into it in one step.
 *
 * A `Modal` rather than a `MenuButton` because creating a folder needs a text field, and a `role="menu"`
 * has nowhere to put one (the same reason `NewLabelDialog` exists) - and because a destination list can be
 * as long as the mailbox has folders, which wants a filter box rather than a scrolling popup.
 *
 * A new folder is created at the **top level of the mailbox**, typed `user`, never as a child of the folder
 * being moved out of: this app's sidebar lists folders flat (`MailShell`'s own `FOLDER_ORDER`), so a
 * subfolder would be created into a hierarchy nothing here renders.
 */
export default function MoveToFolderDialog({
    open,
    onClose,
    mailboxUid,
    folders,
    currentFolderUid,
    count = 1,
    onMove,
    onFolderCreated,
}: MoveToFolderDialogProps) {
    const [filter, setFilter] = useState("");
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const nameRef = useRef<HTMLInputElement | null>(null);

    // Every opening starts from the same place, so a filter or a half-typed folder name from last time is
    // never what the next move is made against.
    useEffect(() => {
        if (open) {
            setFilter("");
            setCreating(false);
            setNewName("");
            setBusy(false);
            setError(null);
        }
    }, [open]);

    // The field is only mounted once "New folder" is chosen, so focus moves to it when it appears.
    useEffect(() => {
        if (creating) {
            nameRef.current?.focus();
        }
    }, [creating]);

    const targets = folders.filter((folder) => MOVE_TARGET_TYPES.has(folder.type));
    const shown = filter.trim()
        ? targets.filter((folder) => folder.name.toLowerCase().includes(filter.trim().toLowerCase()))
        : targets;
    const offerFilter = targets.length > FOLDER_FILTER_THRESHOLD;
    const noun = count === 1 ? "message" : `${count} messages`;

    async function moveTo(folderUid: string) {
        setBusy(true);
        setError(null);
        try {
            await onMove(folderUid);
            onClose();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not move to that folder.");
        } finally {
            setBusy(false);
        }
    }

    async function handleCreate(e: FormEvent) {
        e.preventDefault();
        const invalid = folderNameError(newName, folders);
        if (invalid) {
            setError(invalid);
            return;
        }
        setBusy(true);
        setError(null);
        let created: Folder;
        try {
            created = await createFolder({ mailboxUid, name: newName.trim(), type: "user" });
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create that folder.");
            setBusy(false);
            return;
        }
        // Handed over before the move: the folder exists from here on whether or not the move lands, and
        // the reader would otherwise have to create it again to retry.
        onFolderCreated?.(created);
        setBusy(false);
        await moveTo(created.uid);
    }

    return (
        <Modal open={open} onClose={() => !busy && onClose()} title={`Move ${noun} to`}>
            {offerFilter && !creating && (
                <input
                    type="search"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    aria-label="Filter folders"
                    placeholder="Filter folders…"
                    className="w-full text-sm px-3 py-1.5 mb-2 rounded-md border border-border bg-surface"
                />
            )}
            {!creating && (
                <ul className="max-h-72 overflow-y-auto border border-border rounded-md divide-y divide-border">
                    {shown.map((folder) => {
                        const here = folder.uid === currentFolderUid;
                        return (
                            <li key={folder.uid}>
                                <button
                                    type="button"
                                    onClick={() => void moveTo(folder.uid)}
                                    disabled={busy || here}
                                    // Disabled rather than hidden, so the list doesn't change shape as the
                                    // reader moves between folders.
                                    title={here ? `Already in ${folder.name}` : undefined}
                                    className="w-full text-left flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent"
                                >
                                    <HiOutlineFolder size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
                                    <span className="truncate">{folder.name}</span>
                                    {here && <span className="ml-auto text-xs text-text-muted shrink-0">Already here</span>}
                                </button>
                            </li>
                        );
                    })}
                    {shown.length === 0 && (
                        <li className="px-3 py-2 text-sm text-text-muted">
                            {targets.length === 0 ? "This mailbox has no folders to move to yet." : "No folder matches that."}
                        </li>
                    )}
                </ul>
            )}
            {creating ? (
                <form onSubmit={handleCreate}>
                    <label className="block text-sm font-medium mb-1" htmlFor="move-to-new-folder">
                        New folder name
                    </label>
                    <input
                        id="move-to-new-folder"
                        ref={nameRef}
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        maxLength={MAX_FOLDER_NAME_LENGTH}
                        className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-surface"
                    />
                    <p className="text-xs text-text-muted mt-1">
                        Created at the top level of this mailbox, and the {count === 1 ? "message is" : "messages are"} moved
                        into it.
                    </p>
                    {error && (
                        <div className="mt-3">
                            <Alert>{error}</Alert>
                        </div>
                    )}
                    <div className="flex justify-end gap-2 mt-4">
                        <Button type="button" variant="secondary" onClick={() => setCreating(false)} disabled={busy}>
                            Back
                        </Button>
                        <Button type="submit" disabled={busy}>
                            {busy ? "Creating…" : "Create and move"}
                        </Button>
                    </div>
                </form>
            ) : (
                <>
                    <button
                        type="button"
                        onClick={() => {
                            setCreating(true);
                            setError(null);
                        }}
                        disabled={busy}
                        className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary-dark hover:underline disabled:opacity-50 disabled:no-underline"
                    >
                        <HiOutlineFolderPlus size={16} aria-hidden="true" />
                        New folder…
                    </button>
                    {error && (
                        <div className="mt-3">
                            <Alert>{error}</Alert>
                        </div>
                    )}
                </>
            )}
        </Modal>
    );
}
