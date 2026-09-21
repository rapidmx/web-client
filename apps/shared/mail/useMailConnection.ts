///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createContext, useCallback, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Folder, Mailbox, listFolders, listMailboxes } from "@rapidmx/react-shared/mail/mailApi.js";
import type { MailboxFolders } from "../components/mail/layout/MailShell.js";
import { LiveUpdates, useMailLiveUpdates } from "./useMailLiveUpdates.js";
import type { FolderCounts } from "./folderCounts.js";
import { NewMailNotifications, useNewMailNotifications } from "./useNewMailNotifications.js";

/** Page size of the one `listMailboxes()` call. */
export const MAILBOX_LIST_LIMIT = 100;

/** Well-known folders sort first in the sidebar, in Gmail/Outlook's conventional order; anything else (incl. `user`) sorts after, alphabetically. */
export const FOLDER_ORDER = ["inbox", "drafts", "outbox", "sent_items", "junk", "archive", "deleted_items"];

/**
 * A mailbox's `calendar`/`contacts`/`tasks`/`notes` folders back their own dedicated apps (see `CalendarShell`/`ContactsShell`/`TasksShell`), not
 * Mail - `listFolders()` returns every well-known folder for the mailbox regardless of which app owns it, so Mail's own folder tree filters down
 * to just the mail ones itself, or those other apps' folders leak into its sidebar.
 */
export const MAIL_FOLDER_TYPES = new Set([...FOLDER_ORDER, "user"]);

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
    /** Bumped whenever new mail may have arrived - see `useMailLiveUpdates()`. */
    live: LiveUpdates;
    /** The folder badges' numbers and how to change them. */
    folderCounts: FolderCounts;
    /** The new-mail pop-ups and desktop notifications, and what feeds them. */
    notifications: NewMailNotifications;
}

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
                    .then((result): MailboxFolders => ({ mailbox, folders: result.filter((f) => MAIL_FOLDER_TYPES.has(f.type)) }))
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
     * sidebar doesn't list at all, the same filter the fetch above applies. */
    const onFolderCreated = useCallback((folder: Folder) => {
        if (!MAIL_FOLDER_TYPES.has(folder.type)) {
            return;
        }
        setMailboxFolders((prev) =>
            prev.map((entry) =>
                // Not one already there: another client's create event can arrive after (or twice, or alongside) our own.
                entry.mailbox.uid === folder.mailboxUid && !entry.folders.some((existing) => existing.uid === folder.uid)
                    ? { ...entry, folders: [...entry.folders, folder] }
                    : entry,
            ),
        );
    }, []);

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
        onMessageCreated: notifications.announce,
    });

    return { status, error, mailboxes, mailboxFolders, foldersLoading, onFolderCreated, live, folderCounts, notifications };
}
