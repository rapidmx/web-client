///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useMemo, useState } from "react";
import { listMessages } from "@rapidmx/react-shared/mail/mailApi.js";
import type { MailboxFolders } from "../../components/mail/layout/MailShell.js";
import { FolderCount, countOfFolder } from "../folderCounts.js";
import { OutboxFolderStatus, summarizeOutbox } from "./outboxState.js";

/** The most Outbox messages read to say what state they are in; beyond this the pill still shows the folder's own total. */
export const OUTBOX_STATUS_LIMIT = 50;

/**
 * What the messages in each Outbox folder are doing (sending / retrying / failed / scheduled), by folder uid - the second line of the Outbox
 * indicator, next to the folder's own count. A folder only costs a request while it holds something (its count is above zero) and is read again
 * whenever that count or the live updates change, so an empty Outbox - almost always - is free. A failed read keeps what was known.
 */
export function useOutboxStatus(mailboxFolders: MailboxFolders[], counts: Record<string, FolderCount>, liveTick: number, enabled: boolean): Record<string, OutboxFolderStatus> {
    const [statuses, setStatuses] = useState<Record<string, OutboxFolderStatus>>({});
    const outboxes = useMemo(
        () =>
            mailboxFolders.flatMap((entry) => entry.folders.filter((folder) => folder.type === "outbox")).map((folder) => ({ uid: folder.uid, total: countOfFolder(folder, counts).total })),
        [mailboxFolders, counts],
    );
    const key = outboxes.map((outbox) => `${outbox.uid}:${outbox.total}`).join("|");

    useEffect(() => {
        if (!enabled) {
            return;
        }
        const occupied = outboxes.filter((outbox) => outbox.total > 0);
        setStatuses((previous) => {
            const emptied = Object.keys(previous).filter((uid) => !occupied.some((outbox) => outbox.uid === uid));
            if (emptied.length === 0) {
                return previous;
            }
            const next = { ...previous };
            for (const uid of emptied) {
                delete next[uid];
            }
            return next;
        });
        let cancelled = false;
        for (const outbox of occupied) {
            listMessages(outbox.uid, { limit: OUTBOX_STATUS_LIMIT }).then(
                (messages) => {
                    if (!cancelled) {
                        setStatuses((previous) => ({ ...previous, [outbox.uid]: summarizeOutbox(messages) }));
                    }
                },
                () => undefined,
            );
        }
        return () => {
            cancelled = true;
        };
    }, [enabled, key, liveTick]);

    return statuses;
}
