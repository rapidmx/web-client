///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Mailbox, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import type { MailboxFolders } from "../components/mail/layout/MailShell.js";
import {
    DesktopPermission,
    NewMailNotice,
    desktopPermission,
    getDesktopOfferDismissed,
    getNewMailPopupsEnabled,
    noticeFor,
    noticeSender,
    ownAddressesOf,
    requestDesktopPermission,
    setDesktopOfferDismissed,
    shouldAnnounce,
} from "./newMailNotifications.js";

/** The most pop-ups on screen at once; a new one pushes the oldest off. */
export const MAX_TOASTS = 3;

/** How long a pop-up stays before it goes by itself (while it is neither hovered nor focused, and the tab is in view). */
export const TOAST_DURATION_MS = 8_000;

/** At most this many desktop notifications in `DESKTOP_BURST_WINDOW_MS`: a flood of mail is a few notifications, not a hundred. */
export const DESKTOP_BURST_LIMIT = 5;
export const DESKTOP_BURST_WINDOW_MS = 30_000;

/** How many announced message uids are remembered, so an event delivered twice is announced once. */
const ANNOUNCED_LIMIT = 500;

export interface NewMailNotifications {
    /** The pop-ups on screen, oldest first. */
    toasts: NewMailNotice[];
    /** Takes one off the screen. */
    dismiss(uid: string): void;
    /** Whether the first pop-up should also offer to turn on desktop notifications: the browser can, has not been asked,
     * and the user has not said "Not now". */
    offerDesktop: boolean;
    /** The offer's "Turn on desktop notifications": asks the browser. Must be called from a click. */
    enableDesktop(): Promise<void>;
    /** The offer's "Not now": remembered, so it is not made again. */
    declineDesktop(): void;
    /** Announces a message that just arrived - if it is worth it (see `shouldAnnounce()`) and pop-ups are on. Stable. */
    announce(message: Message): void;
}

/** Whether the user is not looking at this tab: it is hidden, or another window has the focus. */
function tabIsInBackground(): boolean {
    return document.visibilityState === "hidden" || !document.hasFocus();
}

export interface UseNewMailNotificationsOptions {
    mailboxes: Mailbox[];
    mailboxFolders: MailboxFolders[];
    /** Opens a message from a desktop notification's click. Defaults to a plain navigation. */
    open?: (href: string) => void;
}

function defaultOpen(href: string): void {
    window.location.href = href;
}

/**
 * New-mail announcements: an in-app pop-up for each message that arrives (`MAX_TOASTS` at most on screen), and - while the tab
 * is in the background and the user has allowed it - a desktop notification with the same content, one per message however
 * many events name it. `announce()` is what `useMailLiveUpdates()`'s `onMessageCreated` calls; nothing else feeds it, so a
 * page load, a list refetch and a reconnect never announce anything.
 *
 * Nothing is ever asked of the browser on load: permission is requested only by `enableDesktop()`, from the offer in the
 * first pop-up, or from Settings. What the user answered is remembered in `localStorage` (see `newMailNotifications.ts`).
 */
export function useNewMailNotifications({ mailboxes, mailboxFolders, open = defaultOpen }: UseNewMailNotificationsOptions): NewMailNotifications {
    const [toasts, setToasts] = useState<NewMailNotice[]>([]);
    const [permission, setPermission] = useState<DesktopPermission>("unsupported");
    const [offerDismissed, setOfferDismissed] = useState(true);
    const folders = useMemo(() => mailboxFolders.flatMap((entry) => entry.folders), [mailboxFolders]);
    const ownAddresses = useMemo(() => ownAddressesOf(mailboxes), [mailboxes]);
    const latestRef = useRef({ folders, ownAddresses, open });
    latestRef.current = { folders, ownAddresses, open };
    const announcedRef = useRef<Set<string>>(new Set());
    const desktopShownRef = useRef<number[]>([]);

    // The browser's own state is only read on the client, after hydration, so the server and first client render agree.
    useEffect(() => {
        setPermission(desktopPermission());
        setOfferDismissed(getDesktopOfferDismissed());
    }, []);

    const dismiss = useCallback((uid: string) => {
        setToasts((previous) => previous.filter((toast) => toast.uid !== uid));
    }, []);

    const showDesktop = useCallback((notice: NewMailNotice) => {
        const now = Date.now();
        desktopShownRef.current = desktopShownRef.current.filter((at) => now - at < DESKTOP_BURST_WINDOW_MS);
        if (desktopShownRef.current.length >= DESKTOP_BURST_LIMIT) {
            return;
        }
        try {
            const notification = new Notification(noticeSender(notice), {
                body: [notice.subject, notice.preview].filter(Boolean).join("\n"),
                // One per message: a duplicate (another tab of this app, a re-delivered event) replaces instead of stacking.
                tag: notice.uid,
            });
            desktopShownRef.current.push(now);
            notification.onclick = () => {
                window.focus();
                notification.close();
                latestRef.current.open(notice.href);
            };
        } catch {
            // Some browsers refuse `new Notification()` outright (a mobile one wanting a service worker): the pop-up is enough.
        }
    }, []);

    const announce = useCallback(
        (message: Message) => {
            if (!getNewMailPopupsEnabled() || announcedRef.current.has(message.uid)) {
                return;
            }
            const { folders: knownFolders, ownAddresses: own } = latestRef.current;
            if (!shouldAnnounce(message, { folders: knownFolders, ownAddresses: own })) {
                return;
            }
            announcedRef.current.add(message.uid);
            if (announcedRef.current.size > ANNOUNCED_LIMIT) {
                announcedRef.current.delete(announcedRef.current.values().next().value!);
            }
            const notice = noticeFor(message);
            setToasts((previous) => [...previous.filter((toast) => toast.uid !== notice.uid), notice].slice(-MAX_TOASTS));
            if (desktopPermission() === "granted" && tabIsInBackground()) {
                showDesktop(notice);
            }
        },
        [showDesktop],
    );

    const enableDesktop = useCallback(async () => {
        const answer = await requestDesktopPermission();
        setPermission(answer);
        // Answered either way, so the offer goes: on granted it has done its job, on denied it can't be made again.
        setDesktopOfferDismissed(true);
        setOfferDismissed(true);
    }, []);

    const declineDesktop = useCallback(() => {
        setDesktopOfferDismissed(true);
        setOfferDismissed(true);
    }, []);

    return {
        toasts,
        dismiss,
        offerDesktop: permission === "default" && !offerDismissed,
        enableDesktop,
        declineDesktop,
        announce,
    };
}
