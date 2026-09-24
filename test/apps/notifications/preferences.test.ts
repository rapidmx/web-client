///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    NOTIFICATIONS_ENABLED_KEY,
    getNotificationsEnabled,
    setNotificationsEnabled,
} from "../../../apps/shared/notifications/preferences.js";
import { getNotificationsSnapshot, notify, resetNotifications } from "../../../apps/shared/notifications/store.js";

beforeEach(() => {
    localStorage.clear();
    resetNotifications();
});

afterEach(() => {
    vi.restoreAllMocks();
    resetNotifications();
});

describe("the notifications switch", () => {
    it("is on unless turned off, and remembers, under the key the new-mail switch always used", () => {
        expect(NOTIFICATIONS_ENABLED_KEY).toBe("rapidmx-new-mail-popups");
        expect(getNotificationsEnabled()).toBe(true);
        setNotificationsEnabled(false);
        expect(localStorage.getItem(NOTIFICATIONS_ENABLED_KEY)).toBe("off");
        expect(getNotificationsEnabled()).toBe(false);
        setNotificationsEnabled(true);
        expect(localStorage.getItem(NOTIFICATIONS_ENABLED_KEY)).toBeNull();
        expect(getNotificationsEnabled()).toBe(true);
    });

    it("is on, and changes nothing, when storage is blocked", () => {
        for (const method of ["getItem", "setItem", "removeItem"] as const) {
            vi.spyOn(Storage.prototype, method).mockImplementation(() => {
                throw new Error("blocked");
            });
        }
        expect(getNotificationsEnabled()).toBe(true);
        expect(() => setNotificationsEnabled(false)).not.toThrow();
        expect(() => setNotificationsEnabled(true)).not.toThrow();
    });
});

describe("with notifications off", () => {
    it("shows no pop-up of any kind, but still lists what would have been one in the history", () => {
        setNotificationsEnabled(false);
        notify({ kind: "error", title: "Could not save" });
        notify({ kind: "success", title: "Saved" });
        notify({ kind: "mail", title: "jane@example.com" });
        const snapshot = getNotificationsSnapshot();
        expect(snapshot.visible).toEqual([]);
        expect(snapshot.queued).toBe(0);
        // Mail is kept out of the history as ever (the inbox holds it).
        expect(snapshot.history.map((item) => item.title)).toEqual(["Saved", "Could not save"]);
        expect(snapshot.unseenErrors).toBe(1);
    });

    it("shows them again once switched back on", () => {
        setNotificationsEnabled(false);
        notify({ kind: "info", title: "Hidden" });
        setNotificationsEnabled(true);
        notify({ kind: "info", title: "Shown" });
        expect(getNotificationsSnapshot().visible.map((item) => item.title)).toEqual(["Shown"]);
    });
});
