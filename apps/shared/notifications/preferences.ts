///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The user's one switch for every pop-up (new mail, a failed send, an API error, a reminder), per browser in `localStorage`.
 * Framework-free like the store, which reads it: `notify()` keeps a notification out of sight while it is off (it is still
 * listed in "Recent notifications") - except an error that carries actions (Retry, Open draft), which would otherwise be unreachable.
 */

/**
 * `localStorage` key of the switch. Absent means on; `"off"` means the user turned pop-ups off. The name is from when the switch
 * only covered new mail, and is kept so a browser where that was turned off stays off.
 */
export const NOTIFICATIONS_ENABLED_KEY = "rapidmx-new-mail-popups";

/** Whether pop-up notifications are on (the default). */
export function getNotificationsEnabled(): boolean {
    try {
        return localStorage.getItem(NOTIFICATIONS_ENABLED_KEY) !== "off";
    } catch {
        return true;
    }
}

export function setNotificationsEnabled(enabled: boolean): void {
    try {
        if (enabled) {
            localStorage.removeItem(NOTIFICATIONS_ENABLED_KEY);
        } else {
            localStorage.setItem(NOTIFICATIONS_ENABLED_KEY, "off");
        }
    } catch {
        // Storage blocked or full: the choice lasts until the page is reloaded, no longer.
    }
}

/**
 * `localStorage` key of the switch for the sounds that go with notifications (a chime for new mail, a bell for a calendar alarm, a buzz for an
 * error). Absent means on; `"off"` means the user turned them off. Independent of the pop-ups themselves.
 */
export const NOTIFICATION_SOUNDS_KEY = "rapidmx-notification-sounds";

/** Whether notification sounds are on (the default). */
export function getNotificationSoundsEnabled(): boolean {
    try {
        return localStorage.getItem(NOTIFICATION_SOUNDS_KEY) !== "off";
    } catch {
        return true;
    }
}

export function setNotificationSoundsEnabled(enabled: boolean): void {
    try {
        if (enabled) {
            localStorage.removeItem(NOTIFICATION_SOUNDS_KEY);
        } else {
            localStorage.setItem(NOTIFICATION_SOUNDS_KEY, "off");
        }
    } catch {
        // Storage blocked or full: the choice lasts until the page is reloaded, no longer.
    }
}
