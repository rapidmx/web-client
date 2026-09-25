///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { eraseLeftoverMailbox } from "@rapidmx/react-shared/admin/leftoverMailboxApi.js";
import { DataSubjectErasureStatus, getErasureRequest } from "@rapidmx/react-shared/mail/erasureRequestApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import { notify } from "../../../notifications/store.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";
const DANGER_BUTTON_CLASS = "!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger";

/** How often the request is asked how far the erasure has got. */
export const ERASE_POLL_INTERVAL_MS = 2000;

export interface EraseLeftoverDataDialogProps {
    /** The deleted mailbox's address. */
    address: string;
    /** What is left, when the caller knows it (the list of deleted mailboxes does): named in the confirmation. */
    counts?: { folders: number; messages: number };
    /** An erasure already filed for the address (approved or running): the dialog then watches it instead of asking first. */
    resume?: { uid: string; status: DataSubjectErasureStatus };
    /** The button shown once the data is erased (`onDone` runs when it is pressed - the dialog closes itself first). Default "Done". */
    doneLabel?: string;
    onDone?: () => void;
    /** Called once when the data is erased - whether or not the dialog is still open by then. */
    onErased?: (address: string) => void;
    onClose: () => void;
    /** How often to ask how far the erasure has got. */
    pollIntervalMs?: number;
}

type Phase = "confirm" | "filing" | "watching" | "done" | "refused";

/** Where an erasure is, in words. */
function progressLabel(status: DataSubjectErasureStatus | undefined): string {
    return status === "in_progress" ? "Erasing the data…" : "Waiting for the erasure to start…";
}

/**
 * Erases the data a deleted mailbox left behind - permanently - after the administrator types its address to confirm, then shows
 * how far it has got: the erasure runs on the server in the background, so this asks about it every few seconds until it has
 * finished or been refused. Mount it (with the address as its `key`) only while it is wanted; it holds its own state.
 *
 * The request that files the erasure can't be interrupted (closing is ignored while it is under way); once it is filed, closing
 * only stops watching - the erasure carries on, and the deleted-mailbox list shows it.
 */
export default function EraseLeftoverDataDialog({
    address,
    counts,
    resume,
    doneLabel = "Done",
    onDone,
    onErased,
    onClose,
    pollIntervalMs = ERASE_POLL_INTERVAL_MS,
}: EraseLeftoverDataDialogProps) {
    const [phase, setPhase] = useState<Phase>(resume ? "watching" : "confirm");
    const [typed, setTyped] = useState("");
    const [requestUid, setRequestUid] = useState<string | undefined>(resume?.uid);
    const [status, setStatus] = useState<DataSubjectErasureStatus | undefined>(resume?.status);
    const [error, setError] = useState<string | null>(null);
    // A check on the erasure failed (offline, a dropped connection): it is tried again, and the admin is told meanwhile.
    const [checkFailed, setCheckFailed] = useState(false);
    const onErasedRef = useRef(onErased);
    onErasedRef.current = onErased;

    const confirmed = typed.trim().toLowerCase() === address.trim().toLowerCase();

    async function handleErase(e: FormEvent) {
        e.preventDefault();
        if (!confirmed) {
            return;
        }
        setError(null);
        setPhase("filing");
        try {
            const request = await eraseLeftoverMailbox(address);
            setRequestUid(request.uid);
            setStatus(request.status);
            setPhase("watching");
        } catch (err) {
            // The server's own words: a legal hold names its matter, a mailbox that exists again says so.
            setError(err instanceof ApiRequestError ? err.message : "Could not start the erasure.");
            setPhase("confirm");
        }
    }

    // Watches the request until it has finished or been refused.
    useEffect(() => {
        if (phase !== "watching" || !requestUid) {
            return;
        }
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const check = async () => {
            try {
                const request = await getErasureRequest(requestUid);
                if (cancelled) {
                    return;
                }
                setCheckFailed(false);
                setStatus(request.status);
                if (request.status === "completed") {
                    setPhase("done");
                    notify({ kind: "success", title: "Leftover data erased", message: `Everything left over from ${address} was erased.` });
                    onErasedRef.current?.(address);
                    return;
                }
                if (request.status === "denied") {
                    setError(request.reason || "The erasure was refused.");
                    setPhase("refused");
                    return;
                }
            } catch {
                if (cancelled) {
                    return;
                }
                setCheckFailed(true);
            }
            timer = setTimeout(() => void check(), pollIntervalMs);
        };
        void check();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [phase, requestUid, address, pollIntervalMs]);

    // Closing is ignored while the request that files the erasure is under way, so its answer can't land on a dialog that was dismissed.
    function dismiss() {
        if (phase !== "filing") {
            onClose();
        }
    }

    function handleDone() {
        onClose();
        onDone?.();
    }

    const summary = counts
        ? `It still has ${counts.folders} ${counts.folders === 1 ? "folder" : "folders"} and ${counts.messages} ${counts.messages === 1 ? "message" : "messages"}, and everything else stored with them.`
        : "It still has its folders and everything stored in them.";

    return (
        <Modal open onClose={dismiss} title="Erase leftover data">
            {(phase === "confirm" || phase === "filing") && (
                <form onSubmit={handleErase}>
                    <p className="text-sm mb-3">
                        <strong className="break-all">{address}</strong> was deleted, but its data was kept. {summary}
                    </p>
                    <p className="text-sm mb-3">
                        Erasing permanently deletes all of it - the mail, drafts and attachments, contacts, calendar events, tasks,
                        notes, labels, filter rules and signatures, encryption keys, share links and access lists - and frees the
                        address for a new mailbox.
                    </p>
                    <p className="text-sm font-semibold text-danger mb-4">This is irreversible and cannot be undone.</p>
                    <label className="flex flex-col gap-1.5 text-sm mb-4">
                        <span className="font-semibold">
                            Type <span className="break-all">{address}</span> to confirm
                        </span>
                        <input
                            aria-label="Type the address to confirm"
                            className={INPUT_CLASS}
                            value={typed}
                            disabled={phase === "filing"}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(e) => setTyped(e.target.value)}
                        />
                    </label>
                    {error && <Alert>{error}</Alert>}
                    <div className="flex gap-3 justify-end">
                        <Button type="button" variant="secondary" className="!w-auto" disabled={phase === "filing"} onClick={dismiss}>
                            Cancel
                        </Button>
                        <Button type="submit" className={DANGER_BUTTON_CLASS} loading={phase === "filing"} disabled={phase === "filing" || !confirmed}>
                            Erase data
                        </Button>
                    </div>
                </form>
            )}

            {phase === "watching" && (
                <div>
                    <p className="text-sm mb-3">
                        Erasing the data left over from <strong className="break-all">{address}</strong>.
                    </p>
                    <p role="status" className="flex items-center gap-2 text-sm font-semibold mb-3">
                        <span className="w-4 h-4 rounded-full border-2 border-current/30 border-t-current animate-spin" aria-hidden="true" />
                        {progressLabel(status)}
                    </p>
                    {checkFailed && (
                        <p className="text-sm text-danger mb-3">Could not check how far the erasure has got. Trying again&hellip;</p>
                    )}
                    <p className="text-sm text-text-muted mb-4">
                        You can close this window: the erasure carries on in the background, and the Mailboxes page shows how it is going.
                    </p>
                    <div className="flex justify-end">
                        <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                            Stop watching
                        </Button>
                    </div>
                </div>
            )}

            {phase === "done" && (
                <div>
                    <p role="status" className="text-sm mb-4">
                        Everything left over from <strong className="break-all">{address}</strong> was erased. The address is free to use again.
                    </p>
                    <div className="flex justify-end">
                        <Button type="button" className="!w-auto" onClick={handleDone}>
                            {doneLabel}
                        </Button>
                    </div>
                </div>
            )}

            {phase === "refused" && (
                <div>
                    <Alert>{error}</Alert>
                    <div className="flex justify-end">
                        <Button type="button" variant="secondary" className="!w-auto" onClick={onClose}>
                            OK
                        </Button>
                    </div>
                </div>
            )}
        </Modal>
    );
}
