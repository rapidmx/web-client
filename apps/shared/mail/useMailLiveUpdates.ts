///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, Mailbox, listFolders } from "@rapidmx/react-shared/mail/mailApi.js";
import { getPushClient, PushEvent } from "@rapidmx/react-shared/mail/pushClient.js";
import type { MailboxFolders } from "../components/mail/layout/MailShell.js";
import { SIGN_OUT_CHANNEL } from "../search/localIndexRpcClient.js";

/** How often the safety-net poll runs while the tab is visible. The push socket does the real work; this is for a network
 * that blocks or silently drops it, and for events published while it was reconnecting (Redis pub/sub is never replayed). */
export const LIVE_POLL_INTERVAL_MS = 45_000;

/** Events arriving this close together are answered with one refresh - a burst of new mail is one refetch, not one each. */
export const LIVE_EVENT_DEBOUNCE_MS = 400;

/** What changed, as far as a list on screen is concerned. */
export interface LiveUpdates {
    /** Bumped each time the list should quietly refetch its first page. `0` until the first bump. */
    tick: number;
    /** The folders the events behind the latest bump touched - `null` when that isn't known (a poll, a reconnect, the tab
     * coming back to the front), meaning any folder may have changed. */
    folderUids: ReadonlySet<string> | null;
}

export const NO_LIVE_UPDATES: LiveUpdates = { tick: 0, folderUids: null };

/** The class names `NotificationUtils.sendMessage()` publishes are the model's (`MessageMongo`, `MessageSQL`, `FolderMongo`). */
const MESSAGE_EVENT = /^Message/;
const FOLDER_EVENT = /^Folder/;
const MESSAGE_ACTIONS = new Set(["create", "update", "delete"]);

/**
 * The channels to subscribe to, most important first (the push client keeps the first `PUSH_MAX_CHANNELS`): every
 * mailbox's Inbox - where mail lands - then each mailbox's other folders in the sidebar's own order, then the mailbox uids
 * themselves (which announce new folders). A folder is a channel of its own; subscribing to a mailbox does not deliver its
 * folders' events.
 */
export function pushChannelsFor(mailboxFolders: MailboxFolders[], mailboxes: Mailbox[]): string[] {
    const inboxes = mailboxFolders.flatMap((entry) => entry.folders.filter((folder) => folder.type === "inbox"));
    const others = mailboxFolders.flatMap((entry) => entry.folders.filter((folder) => folder.type !== "inbox"));
    return [...new Set([...inboxes, ...others].map((folder) => folder.uid).concat(mailboxes.map((mailbox) => mailbox.uid)))];
}

function isFolder(value: unknown): value is Folder {
    const folder = value as Partial<Folder> | null;
    return !!folder && typeof folder.uid === "string" && typeof folder.mailboxUid === "string" && typeof folder.type === "string";
}

/** The folder a message event is about: the message's own `folderUid`, else the channel it arrived on (when the server said). */
function folderOfMessageEvent(event: PushEvent): string | undefined {
    const data = event.data as { folderUid?: unknown } | null | undefined;
    if (typeof data?.folderUid === "string") {
        return data.folderUid;
    }
    return event.channel;
}

export interface UseMailLiveUpdatesOptions {
    /** Nothing runs without a signed-in user. */
    userUid?: string;
    mailboxes: Mailbox[];
    mailboxFolders: MailboxFolders[];
    /** Called with a folder another client (or this one) created, so the sidebar shows it. Called only for one not already known. */
    onFolderCreated: (folder: Folder) => void;
}

export interface MailLiveUpdates {
    live: LiveUpdates;
    /** The latest unread count of each folder that has been refreshed since load, by folder uid - what the sidebar's badges show
     * instead of the count the folder list was loaded with. */
    unreadCounts: Record<string, number>;
}

/**
 * Keeps Mail current without a page reload. One shared push connection per tab (`getPushClient()`) is subscribed to every
 * folder of every accessible mailbox; a message event for any of them, a reconnect, a poll of the safety net (every
 * `LIVE_POLL_INTERVAL_MS` while the tab is visible - and the only mechanism, silently, where the socket can't connect), the
 * tab coming back to the front or the browser coming back online, all end in the same debounced refresh: `live` is bumped
 * (the list on screen refetches its first page - see `mergeFirstPage()`) and every folder's unread count is re-read.
 *
 * Sign-out closes the socket for good: another tab's or this one's, heard on the same channel `AppShell` listens on.
 * Renders nothing and does nothing where there is no window (server-side rendering).
 */
export function useMailLiveUpdates({ userUid, mailboxes, mailboxFolders, onFolderCreated }: UseMailLiveUpdatesOptions): MailLiveUpdates {
    const [live, setLive] = useState<LiveUpdates>(NO_LIVE_UPDATES);
    const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
    // The latest inputs, for the long-lived listeners below.
    const latestRef = useRef({ mailboxes, mailboxFolders, onFolderCreated });
    latestRef.current = { mailboxes, mailboxFolders, onFolderCreated };

    const channels = useMemo(() => pushChannelsFor(mailboxFolders, mailboxes), [mailboxFolders, mailboxes]);
    const channelKey = channels.join("|");
    const channelsRef = useRef(channels);
    channelsRef.current = channels;

    useEffect(() => {
        if (!userUid) {
            return;
        }
        const client = getPushClient();
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pendingFolders = new Set<string>();
        let pendingUnknown = false;
        let countsRun = 0;
        let everOpen = false;

        async function refreshCounts() {
            const run = ++countsRun;
            const results = await Promise.all(latestRef.current.mailboxes.map((mailbox) => listFolders(mailbox.uid).catch(() => undefined)));
            if (stopped || run !== countsRun) {
                return;
            }
            const fresh: Record<string, number> = {};
            for (const folders of results) {
                for (const folder of folders ?? []) {
                    fresh[folder.uid] = folder.unreadCount;
                }
            }
            setUnreadCounts((previous) => {
                const changed = Object.entries(fresh).some(([uid, count]) => previous[uid] !== count);
                return changed ? { ...previous, ...fresh } : previous;
            });
        }

        // Never runs once `stopped`: whatever sets it clears the timer first.
        function flush() {
            timer = undefined;
            const folderUids = pendingUnknown ? null : new Set(pendingFolders);
            pendingFolders = new Set();
            pendingUnknown = false;
            setLive((previous) => ({ tick: previous.tick + 1, folderUids }));
            void refreshCounts();
        }

        /** Asks for a refresh: of the given folders, or (no argument) of whatever may have changed. */
        function schedule(folderUid?: string) {
            if (stopped) {
                return;
            }
            if (folderUid) {
                pendingFolders.add(folderUid);
            } else {
                pendingUnknown = true;
            }
            timer ??= setTimeout(flush, LIVE_EVENT_DEBOUNCE_MS);
        }

        const offEvent = client.onEvent((event) => {
            if (MESSAGE_EVENT.test(event.type) && MESSAGE_ACTIONS.has(event.action ?? "")) {
                schedule(folderOfMessageEvent(event));
            } else if (FOLDER_EVENT.test(event.type) && event.action === "create" && isFolder(event.data)) {
                const folder = event.data;
                const known = latestRef.current.mailboxFolders.some((entry) => entry.folders.some((f) => f.uid === folder.uid));
                if (!known) {
                    latestRef.current.onFolderCreated(folder);
                }
            }
        });
        // Anything published while the socket was down is gone for good, so every reconnect is followed by a refresh.
        const offStatus = client.onStatus((status) => {
            if (status === "open") {
                if (everOpen) {
                    schedule();
                }
                everOpen = true;
            }
        });

        const poll = setInterval(() => {
            if (document.visibilityState === "visible") {
                schedule();
            }
        }, LIVE_POLL_INTERVAL_MS);
        function refreshNow() {
            if (document.visibilityState === "visible") {
                client.reconnectNow();
                schedule();
            }
        }
        function handleOnline() {
            client.reconnectNow();
            schedule();
        }
        document.addEventListener("visibilitychange", refreshNow);
        window.addEventListener("focus", refreshNow);
        window.addEventListener("online", handleOnline);

        // A sign-out, in this tab or another, ended the session behind the socket: close it for good and stop refreshing.
        const signOut = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(SIGN_OUT_CHANNEL);
        signOut?.addEventListener("message", (event: MessageEvent<{ type?: string }>) => {
            if (event.data?.type === "sign-out") {
                stopped = true;
                clearTimeout(timer);
                client.close();
            }
        });

        client.setChannels(channelsRef.current);
        client.start();

        return () => {
            stopped = true;
            clearTimeout(timer);
            clearInterval(poll);
            offEvent();
            offStatus();
            document.removeEventListener("visibilitychange", refreshNow);
            window.removeEventListener("focus", refreshNow);
            window.removeEventListener("online", handleOnline);
            signOut?.close();
        };
    }, [userUid]);

    useEffect(() => {
        if (userUid) {
            getPushClient().setChannels(channels);
        }
    }, [userUid, channelKey]);

    return { live, unreadCounts };
}
