///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    NOTIFICATIONS_ENABLED_KEY,
    NOTIFICATION_SOUNDS_KEY,
    getNotificationSoundsEnabled,
    getNotificationsEnabled,
    setNotificationSoundsEnabled,
    setNotificationsEnabled,
} from "../../../apps/shared/notifications/preferences.js";
import { resetNotificationSounds } from "../../../apps/shared/notifications/sounds.js";
import { getNotificationsSnapshot, notify, resetNotifications } from "../../../apps/shared/notifications/store.js";

/** A stand-in for `AudioContext` that counts the oscillators the sounds are made of (a chime and a buzz are two, a bell is eight). */
function installFakeAudio(): { oscillators: number } {
    const made = { oscillators: 0 };
    class FakeAudioContext {
        state = "running";
        currentTime = 0;
        destination = {};
        createOscillator() {
            made.oscillators += 1;
            return { type: "", frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
        }
        createGain() {
            return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
        }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    return made;
}


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

describe("the notification sounds switch", () => {
    it("is on unless turned off, and remembers", () => {
        expect(getNotificationSoundsEnabled()).toBe(true);
        setNotificationSoundsEnabled(false);
        expect(localStorage.getItem(NOTIFICATION_SOUNDS_KEY)).toBe("off");
        expect(getNotificationSoundsEnabled()).toBe(false);
        setNotificationSoundsEnabled(true);
        expect(localStorage.getItem(NOTIFICATION_SOUNDS_KEY)).toBeNull();
        expect(getNotificationSoundsEnabled()).toBe(true);
    });

    it("is on, and changes nothing, when storage is blocked", () => {
        for (const method of ["getItem", "setItem", "removeItem"] as const) {
            vi.spyOn(Storage.prototype, method).mockImplementation(() => {
                throw new Error("blocked");
            });
        }
        expect(getNotificationSoundsEnabled()).toBe(true);
        expect(() => setNotificationSoundsEnabled(false)).not.toThrow();
        expect(() => setNotificationSoundsEnabled(true)).not.toThrow();
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

    it("still shows an error that offers an action, such as a failed send's Retry, as that is the only way back to it", () => {
        setNotificationsEnabled(false);
        notify({ kind: "error", title: "Message not sent", actions: [{ label: "Retry", onClick: vi.fn() }] });
        notify({ kind: "warning", title: "Hidden warning", actions: [{ label: "Undo" }] });
        const snapshot = getNotificationsSnapshot();
        expect(snapshot.visible.map((item) => item.title)).toEqual(["Message not sent"]);
        expect(snapshot.history.map((item) => item.title)).toEqual(["Hidden warning", "Message not sent"]);
    });

    it("makes no sound for what it does not show", () => {
        resetNotificationSounds();
        const audio = installFakeAudio();
        setNotificationsEnabled(false);
        notify({ kind: "mail", title: "jane@example.com" });
        expect(audio.oscillators).toBe(0);
        vi.unstubAllGlobals();
    });

    it("shows them again once switched back on", () => {
        setNotificationsEnabled(false);
        notify({ kind: "info", title: "Hidden" });
        setNotificationsEnabled(true);
        notify({ kind: "info", title: "Shown" });
        expect(getNotificationsSnapshot().visible.map((item) => item.title)).toEqual(["Shown"]);
    });
});
