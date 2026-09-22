///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, Mailbox, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { getPushClient, PushEvent } from "@rapidmx/react-shared/mail/pushClient.js";
import { SendEvent, parseSendEvent } from "@rapidmx/react-shared/mail/sendEvents.js";
import type { MailboxFolders } from "../components/mail/layout/MailShell.js";
import { SIGN_OUT_CHANNEL } from "../search/localIndexRpcClient.js";
import { FolderCounts, useFolderCounts } from "./folderCounts.js";
import { FolderChange, sortFolders } from "./folderTree.js";

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
 * mailbox's Inbox - where mail lands - then the mailbox uids themselves (which announce new, renamed and deleted folders, so
 * they must outrank any folder's own mail), then each mailbox's other folders in the sidebar's own order - a folder that has
 * just appeared is filed by its type like any other, so when the server's cap bites it is the last of them that go without live
 * updates. A folder is a channel of its own; subscribing to a mailbox does not deliver its folders' events.
 */
export function pushChannelsFor(mailboxFolders: MailboxFolders[], mailboxes: Mailbox[]): string[] {
    const inboxes = mailboxFolders.flatMap((entry) => entry.folders.filter((folder) => folder.type === "inbox"));
    const others = mailboxFolders.flatMap((entry) => sortFolders(entry.folders.filter((folder) => folder.type !== "inbox")));
    return [...new Set([...inboxes.map((folder) => folder.uid), ...mailboxes.map((mailbox) => mailbox.uid), ...others.map((folder) => folder.uid)])];
}

function isFolder(value: unknown): value is Folder {
    const folder = value as Partial<Folder> | null;
    return !!folder && typeof folder.uid === "string" && typeof folder.mailboxUid === "string" && typeof folder.type === "string";
}

/** A `Folder` update event that says the folder's name or type changed (and names the folder): the counts-only ones the server publishes after every message change do not. */
function isFolderChange(value: unknown): value is FolderChange {
    const change = value as Partial<FolderChange> | null;
    return !!change && typeof change.uid === "string" && (typeof change.name === "string" || typeof change.type === "string");
}

function isMessage(value: unknown): value is Message {
    const message = value as Partial<Message> | null;
    return (
        !!message &&
        typeof message.uid === "string" &&
        typeof message.folderUid === "string" &&
        typeof message.flags === "object" &&
        message.flags !== null
    );
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
    /** Called when a folder's name or type was changed elsewhere (a `Folder` update event that says so - one that only carries counts is not this). */
    onFolderChanged?: (change: FolderChange) => void;
    /** Called with the uid of a folder that was deleted elsewhere. */
    onFolderDeleted?: (folderUid: string) => void;
    /** Called with a mailbox's folders as the server just listed them - on every refresh (a message event, the poll, a reconnect, the tab
     * coming back, a send) - so a folder the tree does not know is found whichever way it appeared. */
    onFoldersListed?: (folders: Folder[]) => void;
    /** Called with each new message the push connection announces (a `create` event) - once per message, never for a list
     * refetch, the initial load or a reconnect (nothing published while the socket was down is replayed). The caller decides
     * whether it is worth telling the user about. */
    onMessageCreated?: (message: Message) => void;
    /** Called with the outcome of a message sent in the background (`send-succeeded`, `send-failed`, `send-retrying`). Every one also
     * refreshes what is on screen (the Outbox and Sent Items lists and counts change with it). */
    onSendEvent?: (event: SendEvent) => void;
}

export interface MailLiveUpdates {
    live: LiveUpdates;
    /** The folder badges' numbers and how to change them - see `useFolderCounts()`. Kept in an overlay of their own, **not** in
     * `mailboxFolders`, because the list effect reloads - and forgets the selection - whenever `mailboxFolders` changes. */
    folderCounts: FolderCounts;
}

/**
 * Keeps Mail current without a page reload. One shared push connection per tab (`getPushClient()`) is subscribed to every
 * folder of every accessible mailbox; a message event for any of them, a reconnect, a poll of the safety net (every
 * `LIVE_POLL_INTERVAL_MS` while the tab is visible - and the only mechanism, silently, where the socket can't connect), the
 * tab coming back to the front or the browser coming back online, all end in the same debounced refresh: `live` is bumped
 * (the list on screen refetches its first page - see `mergeFirstPage()`) and every folder's counts are re-read. A new message
 * also bumps its folder's badge at once and is announced to `onMessageCreated`, and the server's `Folder` update events (the
 * folder's real counts) are applied to the badges - see `useFolderCounts()`.
 *
 * Sign-out closes the socket for good: another tab's or this one's, heard on the same channel `AppShell` listens on.
 * Renders nothing and does nothing where there is no window (server-side rendering).
 */
export function useMailLiveUpdates({
    userUid,
    mailboxes,
    mailboxFolders,
    onFolderCreated,
    onFolderChanged,
    onFolderDeleted,
    onFoldersListed,
    onMessageCreated,
    onSendEvent,
}: UseMailLiveUpdatesOptions): MailLiveUpdates {
    const [live, setLive] = useState<LiveUpdates>(NO_LIVE_UPDATES);
    const folders = useMemo(() => mailboxFolders.flatMap((entry) => entry.folders), [mailboxFolders]);
    const folderCounts = useFolderCounts(mailboxes, folders, onFoldersListed);
    // The latest inputs, for the long-lived listeners below.
    const latestRef = useRef({ mailboxes, mailboxFolders, onFolderCreated, onFolderChanged, onFolderDeleted, onMessageCreated, onSendEvent, folderCounts });
    latestRef.current = { mailboxes, mailboxFolders, onFolderCreated, onFolderChanged, onFolderDeleted, onMessageCreated, onSendEvent, folderCounts };

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
        let everOpen = false;

        // Never runs once `stopped`: whatever sets it clears the timer first.
        function flush() {
            timer = undefined;
            const folderUids = pendingUnknown ? null : new Set(pendingFolders);
            pendingFolders = new Set();
            pendingUnknown = false;
            setLive((previous) => ({ tick: previous.tick + 1, folderUids }));
            latestRef.current.folderCounts.refresh(0);
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
            const sendEvent = parseSendEvent(event);
            if (sendEvent) {
                // A queued message was relayed (or failed to be): it left Outbox for Sent Items, or stayed there failed - every list and count may have changed.
                latestRef.current.onSendEvent?.(sendEvent);
                schedule();
            } else if (MESSAGE_EVENT.test(event.type) && MESSAGE_ACTIONS.has(event.action ?? "")) {
                if (event.action === "create" && isMessage(event.data)) {
                    // Once per message, whatever else the event triggers: the badge first, then whoever announces it.
                    if (latestRef.current.folderCounts.noteCreated(event.data)) {
                        latestRef.current.onMessageCreated?.(event.data);
                    }
                }
                schedule(folderOfMessageEvent(event));
            } else if (FOLDER_EVENT.test(event.type) && event.action === "create" && isFolder(event.data)) {
                // A folder made by the server (on first use, or by another client) or by this one: filed in the sidebar and subscribed to at once (the
                // channel list follows the tree), and its real counts read - all without a reload.
                const folder = event.data;
                const known = latestRef.current.mailboxFolders.some((entry) => entry.folders.some((f) => f.uid === folder.uid));
                if (!known) {
                    latestRef.current.onFolderCreated(folder);
                    latestRef.current.folderCounts.refresh(0);
                }
            } else if (FOLDER_EVENT.test(event.type) && event.action === "update") {
                if (isFolderChange(event.data)) {
                    latestRef.current.onFolderChanged?.(event.data);
                }
                latestRef.current.folderCounts.applyFolderEvent(event.data);
            } else if (FOLDER_EVENT.test(event.type) && event.action === "delete") {
                const uid = (event.data as { uid?: unknown } | null | undefined)?.uid;
                if (typeof uid === "string") {
                    latestRef.current.onFolderDeleted?.(uid);
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

    return { live, folderCounts };
}
