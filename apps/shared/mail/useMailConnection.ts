///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Folder, Mailbox, Message, listFolders, listMailboxes } from "@rapidmx/react-shared/mail/mailApi.js";
import { FOLDER_ORDER, FolderChange, MAIL_FOLDER_TYPES, isMailFolder, knownFolderUids, reconcileFolders, removeFolder, upsertFolder } from "./folderTree.js";
import type { MailboxFolders } from "../components/mail/layout/MailShell.js";
import { LiveUpdates, useMailLiveUpdates } from "./useMailLiveUpdates.js";
import type { CountTracker, FolderCounts } from "./folderCounts.js";
import { NewMailNotifications, useNewMailNotifications } from "./useNewMailNotifications.js";
import { usePushConnectionNotice } from "../notifications/pushStatus.js";
import { registerOutboxCounter } from "./outbox/sendJob.js";
import { handleSendEvent } from "./outbox/sendOutcomes.js";
import { OutboxFolderStatus } from "./outbox/outboxState.js";
import { useOutboxStatus } from "./outbox/useOutboxStatus.js";

/** Page size of the one `listMailboxes()` call. */
export const MAILBOX_LIST_LIMIT = 100;

// The sidebar's order and the folders Mail lists live in `folderTree.ts`; re-exported for what already imports them from here.
export { FOLDER_ORDER, MAIL_FOLDER_TYPES };

export type MailConnectionStatus = "checking" | "error" | "ready";

/** Everything the mail apps share about the user's mailboxes, and the one live connection that keeps it current. */
export interface MailConnection {
    /** Where the one `listMailboxes()` call is. */
    status: MailConnectionStatus;
    /** Why `status` is `"error"`. */
    error: string | null;
    mailboxes: Mailbox[];
    /** Every accessible mailbox's own mail folders, one entry per mailbox - see `MailboxFolders`. */
    mailboxFolders: MailboxFolders[];
    /** Their folder lists are still being fetched. */
    foldersLoading: boolean;
    /** Files a folder that was just created (by this client or another) under its mailbox, so the sidebar and every folder picker show it. */
    onFolderCreated: (folder: Folder) => void;
    /** Says which folders some message the page has met lives in (a list's rows, a conversation's folders): one the sidebar does not know is asked for
     * - its mailbox's folders are listed again, once, debounced - and files it. Each unknown uid is asked about once, so a folder Mail never lists
     * (another app's) cannot make the page ask again and again. */
    noteFolderUids: (folderUids: Iterable<string>) => void;
    /** Bumped whenever new mail may have arrived - see `useMailLiveUpdates()`. */
    live: LiveUpdates;
    /** The folder badges' numbers and how to change them. */
    folderCounts: FolderCounts;
    /** The new-mail pop-ups and desktop notifications, and what feeds them. */
    notifications: NewMailNotifications;
    /** What the messages in each Outbox folder are doing, by folder uid (the Outbox indicator's state) - see `useOutboxStatus()`. */
    outbox: Record<string, OutboxFolderStatus>;
}

const NO_TRACKER: CountTracker = { settle: () => undefined, revert: () => undefined };

/** What the persistent app frame (`AppChrome`) offers to the Mail shell so that it doesn't open a second connection. `null` outside a frame. */
export const MailConnectionContext = createContext<MailConnection | null>(null);

export interface UseMailConnectionOptions {
    /** Nothing is fetched, and no socket opened, without a signed-in user. */
    userUid?: string;
    /** Runs only while true. The frame turns it on; a Mail shell rendered outside a frame turns it on for itself; and the one that isn't
     * the owner leaves it off - so exactly one connection exists, whichever of them the page is rendered by. */
    enabled: boolean;
    /** Opens a message from a desktop notification's click (the router's `useNavigate()`); defaults to a plain navigation. */
    open?: (href: string) => void;
}

/**
 * The user's mailboxes and their mail folders, plus the live connection that keeps them - and the badges, the list, the new-mail
 * pop-ups - current. It is everything `MailShell` used to do on mount, gathered so that it can live in the persistent app frame instead: the
 * push socket (the server allows ten per user), the safety-net poll, the folder counters and the pop-ups then belong to the signed-in session
 * rather than to whichever page happens to be showing, and keep working in Calendar, Contacts, Tasks and Settings. `MailShell` reads the same
 * state from `MailConnectionContext` when there is a frame, and runs this hook itself when there isn't (a page rendered outside the router).
 */
export function useMailConnection({ userUid, enabled, open }: UseMailConnectionOptions): MailConnection {
    const [status, setStatus] = useState<MailConnectionStatus>("checking");
    const [error, setError] = useState<string | null>(null);
    const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
    const [mailboxFolders, setMailboxFolders] = useState<MailboxFolders[]>([]);
    const [foldersLoading, setFoldersLoading] = useState(true);

    useEffect(() => {
        if (!userUid || !enabled) {
            return;
        }
        listMailboxes({ limit: MAILBOX_LIST_LIMIT })
            .then((result) => {
                setMailboxes(result);
                setStatus("ready");
            })
            .catch((err) => {
                setError(err instanceof ApiRequestError ? err.message : "Could not load your mailboxes.");
                setStatus("error");
            });
    }, [userUid, enabled]);

    // Fans out one listFolders() call per accessible mailbox in parallel - each call catches its own failure into a MailboxFolders.error
    // rather than letting Promise.all reject, so one mailbox's fetch failure renders that section's own inline Alert instead of blanking out
    // every other mailbox's folder tree.
    useEffect(() => {
        if (mailboxes.length === 0) {
            // Deliberately leaves foldersLoading as-is: this also runs once before listMailboxes() has resolved, and clearing it here would
            // briefly render an empty sidebar the moment mailboxes arrive, before their folders do. A genuinely mailbox-less caller gets
            // MailboxProvisioning.
            setMailboxFolders([]);
            return;
        }
        setFoldersLoading(true);
        void Promise.all(
            mailboxes.map((mailbox) =>
                listFolders(mailbox.uid)
                    .then((result): MailboxFolders => ({ mailbox, folders: result.filter(isMailFolder) }))
                    .catch(
                        (err): MailboxFolders => ({
                            mailbox,
                            folders: [],
                            error: err instanceof ApiRequestError ? err.message : "Could not load folders.",
                        }),
                    ),
            ),
        )
            .then(setMailboxFolders)
            .finally(() => setFoldersLoading(false));
    }, [mailboxes]);

    /** Files a newly created folder under its own mailbox, leaving every other mailbox's list untouched - and ignoring a type the
     * sidebar doesn't list at all, the same filter the fetch above applies. One already there (another client's create event can arrive
     * after, or twice, or alongside our own) is not added again - see `upsertFolder()`. */
    const onFolderCreated = useCallback((folder: Folder) => setMailboxFolders((prev) => upsertFolder(prev, folder)), []);
    /** A folder was renamed or changed type elsewhere. */
    const onFolderChanged = useCallback((change: FolderChange) => setMailboxFolders((prev) => upsertFolder(prev, change)), []);
    const onFolderDeleted = useCallback((folderUid: string) => setMailboxFolders((prev) => removeFolder(prev, folderUid)), []);
    /** A mailbox's folders as the server just listed them (every count refresh does): folders the tree lacks - one created lazily on the
     * first send, or by another client whose event never arrived - are added. */
    const onFoldersListed = useCallback((listed: Folder[]) => setMailboxFolders((prev) => reconcileFolders(prev, listed)), []);

    const askedFolderUidsRef = useRef(new Set<string>());
    const foldersRef = useRef(mailboxFolders);
    foldersRef.current = mailboxFolders;
    // New mail without a reload: push events for every folder, plus a safety-net poll. Held in state beside `mailboxFolders` rather than
    // written into it, so a refreshed unread count never looks like a change of folders to the list on screen (which reloads, and forgets its
    // selection, whenever the folders do). A pop-up (and, in the background, a desktop notification) for each new message the connection
    // announces.
    const notifications = useNewMailNotifications({ mailboxes, mailboxFolders, open });
    const { live, folderCounts } = useMailLiveUpdates({
        userUid: enabled ? userUid : undefined,
        mailboxes,
        mailboxFolders,
        onFolderCreated,
        onFolderChanged,
        onFolderDeleted,
        onFoldersListed,
        onMessageCreated: notifications.announce,
        onSendEvent: handleSendEvent,
    });
    const noteFolderUids = useCallback(
        (folderUids: Iterable<string>) => {
            const known = knownFolderUids(foldersRef.current);
            const asked = askedFolderUidsRef.current;
            let unknown = false;
            for (const uid of folderUids) {
                if (uid && !known.has(uid) && !asked.has(uid)) {
                    asked.add(uid);
                    unknown = true;
                }
            }
            if (unknown) {
                // The counts' read-back lists every mailbox's folders and files the new ones; a burst is one refresh.
                folderCounts.refresh();
            }
        },
        [folderCounts.refresh],
    );
    // "Connection lost" for more than a few seconds is a subtle pop-up that goes when it is back.
    usePushConnectionNotice(!!userUid && enabled);

    // The Outbox indicator: a message being sent from this tab counts at once (before the server has heard of it), settled - or taken back - when
    // the server answers (see `sendJob.ts`); once it accepted one, the folders are read again, since the Outbox may not have existed yet.
    const latestRef = useRef({ mailboxFolders, folderCounts });
    latestRef.current = { mailboxFolders, folderCounts };
    useEffect(() => {
        if (!userUid || !enabled) {
            return;
        }
        return registerOutboxCounter(
            (mailboxUid) => {
                const { mailboxFolders: known, folderCounts: counts } = latestRef.current;
                const outbox = known.find((entry) => entry.mailbox.uid === mailboxUid)?.folders.find((folder) => folder.type === "outbox");
                return outbox ? counts.track(null, { folderUid: outbox.uid, flags: { read: true } } as Message) : NO_TRACKER;
            },
            (mailboxUid) => {
                // The server accepted a message: the Outbox (and, on an older server, Sent Items) may just have been made. The counts' read-back lists
                // every mailbox's folders and files the new ones (`onFoldersListed`); this reads the one mailbox at once.
                latestRef.current.folderCounts.refresh(0);
                listFolders(mailboxUid).then(onFoldersListed, () => undefined);
            },
        );
    }, [userUid, enabled, onFoldersListed]);
    const outbox = useOutboxStatus(mailboxFolders, folderCounts.counts, live.tick, !!userUid && enabled);

    return { status, error, mailboxes, mailboxFolders, foldersLoading, onFolderCreated, noteFolderUids, live, folderCounts, notifications, outbox };
}
