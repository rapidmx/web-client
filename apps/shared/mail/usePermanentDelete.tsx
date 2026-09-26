///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactElement, useRef, useState } from "react";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import PermanentDeleteDialog from "../components/mail/PermanentDeleteDialog.js";
import { useMailShell } from "../components/mail/layout/MailShell.js";
import { notifyApiError } from "../notifications/apiErrors.js";
import { removeLocalEntity } from "../search/localIndexRpcClient.js";
import {
    EmptyFolderOutcome,
    PurgeOutcome,
    messageCount,
    notifyFolderEmptied,
    notifyPurged,
    purgeFolder,
    purgeMessages,
} from "./permanentDelete.js";

/** The folder "Empty folder" is about. */
export interface EmptiableFolder {
    uid: string;
    name: string;
}

export interface PermanentDelete {
    /**
     * Asks, then permanently deletes `messages` (Delete in Deleted Items - the Delete menu item of a message card calls this too). Resolves
     * with what came of it once the dialog is gone, and everything a delete has to tell has been told: the folder badges follow, the local
     * search index drops the messages, and a notification says "N messages permanently deleted" or which could not be and why. Resolves
     * `null` - and sends nothing - when the reader cancels, when `messages` is empty, or while another request is already open.
     */
    requestPermanentDelete: (messages: Message[]) => Promise<PurgeOutcome | null>;
    /**
     * Asks, then permanently deletes everything in `folder`. `count` is how many messages it holds when that is known (the dialog and the
     * notification then say so). Resolves as `requestPermanentDelete()` does; a request that failed outright (the server is down) has said so and resolves an
     * outcome with nothing deleted, so the caller reloads what it lists.
     */
    requestEmptyFolder: (folder: EmptiableFolder, count?: number) => Promise<EmptyFolderOutcome | null>;
    /** A request is open (the dialog is up, or the delete is on the wire): what should hold every other action of the list meanwhile. */
    busy: boolean;
    /** The confirmation dialog - render it once, anywhere (it is a portal). */
    dialog: ReactElement;
}

type Request = { kind: "messages"; messages: Message[] } | { kind: "folder"; folder: EmptiableFolder; count?: number };

interface Pending {
    request: Request;
    resolve: (outcome: never) => void;
}

/**
 * The one place a permanent delete is confirmed and carried out - for the mail list (the selection bar, the Delete key, Empty folder) and
 * for a message card's own Delete, so all of them ask the same question, delete the same way and report the same way. Call it inside the
 * mail shell (it keeps that shell's folder badges right).
 *
 * The reader always confirms: nothing is remembered between requests.
 */
export function usePermanentDelete(): PermanentDelete {
    const { trackMessageChange, refreshFolderCounts } = useMailShell();
    const [pending, setPending] = useState<Pending | null>(null);
    const [running, setRunning] = useState(false);
    // Set at once (state is a render later), so a key pressed twice does not open two dialogs.
    const pendingRef = useRef<Pending | null>(null);

    function ask<T>(request: Request): Promise<T | null> {
        if (pendingRef.current) {
            return Promise.resolve(null);
        }
        return new Promise<T | null>((resolve) => {
            const next: Pending = { request, resolve };
            pendingRef.current = next;
            setPending(next);
        });
    }

    function requestPermanentDelete(messages: Message[]): Promise<PurgeOutcome | null> {
        return messages.length === 0 ? Promise.resolve(null) : ask<PurgeOutcome>({ kind: "messages", messages });
    }

    function requestEmptyFolder(folder: EmptiableFolder, count?: number): Promise<EmptyFolderOutcome | null> {
        return ask<EmptyFolderOutcome>({ kind: "folder", folder, count });
    }

    /** Closes the dialog and hands the caller what came of it. */
    function finish(outcome: PurgeOutcome | null) {
        const current = pendingRef.current!;
        pendingRef.current = null;
        setPending(null);
        setRunning(false);
        current.resolve(outcome as never);
    }

    /** What every delete tells the rest of the page: the badges (each message is one fewer in its folder) and the local search index. */
    function afterDeleted(deleted: Message[]) {
        for (const message of deleted) {
            trackMessageChange(message, null).settle();
            void removeLocalEntity(message.mailboxUid, message.uid);
        }
    }

    async function confirm() {
        const { request } = pendingRef.current!;
        setRunning(true);
        if (request.kind === "messages") {
            const outcome = await purgeMessages(request.messages);
            afterDeleted(outcome.deleted);
            notifyPurged(outcome);
            finish(outcome);
            return;
        }
        let outcome: EmptyFolderOutcome;
        try {
            outcome = await purgeFolder(request.folder.uid);
        } catch (err) {
            notifyApiError(err, `Couldn't empty ${request.folder.name}`);
            // Part of it may have gone before the failure: the caller reloads rather than assume nothing did.
            outcome = { emptied: false, deleted: [], failed: [] };
        }
        afterDeleted(outcome.deleted);
        // The whole-folder request does not say which messages went, so the counts are read back rather than adjusted.
        refreshFolderCounts();
        if (outcome.emptied || outcome.deleted.length > 0 || outcome.failed.length > 0) {
            notifyFolderEmptied(request.folder.name, outcome, request.count);
        }
        finish(outcome);
    }

    function cancel() {
        finish(null);
    }

    const request = pending?.request;
    const folderRequest = request?.kind === "folder" ? request : undefined;
    const dialog = (
        <PermanentDeleteDialog
            open={pending !== null}
            title={folderRequest ? `Empty ${folderRequest.folder.name}` : "Delete permanently"}
            message={
                folderRequest
                    ? `Permanently delete ${
                          folderRequest.count === undefined
                              ? "all items"
                              : folderRequest.count === 1
                                ? "the only item"
                                : `all ${folderRequest.count} items`
                      } in ${folderRequest.folder.name}? This can't be undone.`
                    : `Permanently delete ${messageCount(request?.kind === "messages" ? request.messages.length : 0)}? This can't be undone.`
            }
            confirmLabel={folderRequest ? "Delete all permanently" : "Delete permanently"}
            busy={running}
            onConfirm={() => void confirm()}
            onCancel={cancel}
        />
    );

    return { requestPermanentDelete, requestEmptyFolder, busy: pending !== null, dialog };
}
