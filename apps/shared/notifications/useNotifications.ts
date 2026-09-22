///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useSyncExternalStore } from "react";
import {
    NotificationsSnapshot,
    clearHistory,
    dismiss,
    dismissAll,
    getNotificationsSnapshot,
    getServerNotificationsSnapshot,
    markHistorySeen,
    notify,
    subscribeNotifications,
    update,
} from "./store.js";

/** How many errors in the history nobody has looked at - a component that shows only this doesn't render again for every pop-up. */
export function useUnseenErrorCount(): number {
    return useSyncExternalStore(subscribeNotifications, () => getNotificationsSnapshot().unseenErrors, () => 0);
}

export interface Notifications extends NotificationsSnapshot {
    notify: typeof notify;
    update: typeof update;
    dismiss: typeof dismiss;
    dismissAll: typeof dismissAll;
    /** Marks the history as seen - clears the unseen-error count. */
    markHistorySeen: typeof markHistorySeen;
    clearHistory: typeof clearHistory;
}

/**
 * The notification stack and its history, and the functions that change them. The functions are the store's own (`notify`, `update`,
 * `dismiss` are plain functions usable outside React too); this hook is for a component that shows or reacts to what is on screen.
 */
export function useNotifications(): Notifications {
    const snapshot = useSyncExternalStore(subscribeNotifications, getNotificationsSnapshot, getServerNotificationsSnapshot);
    return { ...snapshot, notify, update, dismiss, dismissAll, markHistorySeen, clearHistory };
}
