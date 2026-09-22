///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef } from "react";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import CopyButton from "@rapidmx/react-shared/components/buttons/CopyButton.js";
import { HistoryEntry, NotificationKind } from "./store.js";
import { useNotifications } from "./useNotifications.js";

const KIND_LABEL: Record<NotificationKind, string> = {
    mail: "New message",
    calendar: "Reminder",
    info: "Information",
    success: "Done",
    warning: "Warning",
    error: "Error",
};

function HistoryItem({ entry, unseen }: { entry: HistoryEntry; unseen: boolean }) {
    return (
        <li className={["border-b border-border py-2.5 last:border-b-0", unseen ? "-mx-2 rounded-sm bg-danger-bg/60 px-2" : ""].join(" ")}>
            <div className="flex items-baseline justify-between gap-3 text-xs text-text-muted">
                <span className={["font-semibold uppercase tracking-wide", entry.kind === "error" ? "text-danger" : ""].join(" ")}>{KIND_LABEL[entry.kind]}</span>
                <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString()}</time>
            </div>
            <p className="mt-0.5 text-sm font-semibold [overflow-wrap:anywhere]">
                {entry.title}
                {entry.count > 1 && <span className="ml-1.5 text-xs font-medium text-text-muted">&times;{entry.count}</span>}
            </p>
            {entry.message && <p className="text-sm text-text-muted [overflow-wrap:anywhere]">{entry.message}</p>}
            {entry.details.length > 0 && (
                <details className="mt-1">
                    <summary className="cursor-pointer text-xs font-semibold text-text-muted">Technical details</summary>
                    <ul aria-label="Technical details" className="mt-1.5 max-h-40 overflow-auto rounded-sm border border-border bg-surface-alt p-2 font-mono text-xs select-text">
                        {entry.details.map((line, index) => (
                            <li key={index} className="whitespace-pre-wrap break-words">
                                {line}
                            </li>
                        ))}
                    </ul>
                    <div className="mt-1.5">
                        <CopyButton value={entry.details.join("\n")} label="Copy technical details" />
                    </div>
                </details>
            )}
        </li>
    );
}

export interface NotificationHistoryDialogProps {
    open: boolean;
    onClose: () => void;
}

/**
 * "Recent notifications": the last few pop-ups, newest first, so nothing is lost when one expires. Opening it counts as having seen
 * them (the unseen-error count on the account menu goes), but the errors that were unseen when it opened stay highlighted until it closes.
 */
export default function NotificationHistoryDialog({ open, onClose }: NotificationHistoryDialogProps) {
    const { history, markHistorySeen, clearHistory } = useNotifications();
    const unseenAtOpenRef = useRef<Set<string>>(new Set());
    if (!open) {
        unseenAtOpenRef.current = new Set(history.filter((entry) => entry.unseen && entry.kind === "error").map((entry) => entry.id));
    }
    useEffect(() => {
        if (open) {
            markHistorySeen();
        }
    }, [open, markHistorySeen]);
    return (
        <Modal open={open} onClose={onClose} title="Recent notifications">
            {history.length === 0 ? (
                <p className="text-sm text-text-muted">Nothing yet. Errors, sent messages and other pop-ups from this session are listed here.</p>
            ) : (
                <>
                    <ul aria-label="Recent notifications">
                        {history.map((entry) => (
                            <HistoryItem key={entry.id} entry={entry} unseen={unseenAtOpenRef.current.has(entry.id)} />
                        ))}
                    </ul>
                    <div className="mt-4">
                        <button type="button" onClick={clearHistory} className="rounded-sm px-2.5 py-1 text-xs font-semibold text-primary-dark hover:bg-surface-alt">
                            Clear list
                        </button>
                    </div>
                </>
            )}
        </Modal>
    );
}
