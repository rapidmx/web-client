///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useCallback, useEffect, useRef, useState } from "react";
import { getPushClient } from "../../../lib/mail/pushClient.js";
import { getNotificationsEnabled } from "../notifications/preferences.js";
import { playNotificationSound } from "../notifications/sounds.js";
import { notify } from "../notifications/store.js";
import { CalendarReminderNotice, SNOOZE_MS, calendarReminderOf, reminderMessage, reminderNotificationId } from "./calendarReminders.js";

export interface UseCalendarRemindersOptions {
    /** Nothing is shown without a signed-in user. */
    userUid?: string;
    /** Runs only while true - the persistent app frame turns it on, like `useMailConnection`'s identical option. */
    enabled: boolean;
}

/** The calendar alarms waiting on the person, as `CalendarAlarmDialog` draws them. */
export interface CalendarAlarms {
    /** The alarm on screen: the oldest one not yet answered. `undefined` when there is none. */
    current?: CalendarReminderNotice;
    /** How many more are waiting behind `current`. */
    waiting: number;
    /** Closes `current` and brings it back after `SNOOZE_MS` (five minutes). */
    snooze: () => void;
    /** Closes `current` for good. */
    dismiss: () => void;
}

/**
 * Calendar alarms. restapi's `CalendarReminderJob` fires a `"CalendarEvent"`/`"reminder"` push event (`{ eventUid, title, startDate, location }`)
 * when an event's `reminderMinutesBeforeStart` comes due, over the same shared push connection Mail already keeps open (`getPushClient()`) -
 * every accessible mailbox's own channel is already subscribed (`useMailLiveUpdates`'s `pushChannelsFor()`, and the event is published to the
 * mailbox channel as well as the folder's own), so this hook only has to listen, never to manage channels of its own. Lives in the persistent
 * app frame (`AppShell`), like `useSigningEnrollmentWatcher`, so an alarm shows wherever the user is signed in - Mail, Calendar, Contacts, Settings.
 *
 * An alarm is a modal (`CalendarAlarmDialog`), with a bell: not a pop-up that goes by itself, since a meeting missed to a toast that timed out
 * is the failure an alarm exists to prevent. Alarms that arrive together queue, one dialog at a time. **Snooze** closes it and brings it back -
 * with the bell again - after exactly `SNOOZE_MS`. A snooze is this tab's own `setTimeout`, cleared on unmount or sign-out; like the alarm itself (the
 * push event is never replayed), it does not survive the tab closing.
 *
 * With pop-ups turned off (`getNotificationsEnabled()`) no dialog is shown and nothing is heard: the alarm is only recorded in "Recent notifications".
 */
export function useCalendarReminders({ userUid, enabled }: UseCalendarRemindersOptions): CalendarAlarms {
    const [queue, setQueue] = useState<CalendarReminderNotice[]>([]);
    // The queue as of the last render, for the callbacks below to read (a state updater must not start a timer: React may run it twice).
    const queueRef = useRef(queue);
    queueRef.current = queue;
    const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

    const present = useCallback((notice: CalendarReminderNotice) => {
        if (!getNotificationsEnabled()) {
            // Off: only the history keeps it.
            notify({ id: reminderNotificationId(notice.eventUid, notice.startDate), kind: "calendar", title: notice.title, message: reminderMessage(notice.startDate) });
            return;
        }
        const id = reminderNotificationId(notice.eventUid, notice.startDate);
        setQueue((current) => (current.some((queued) => reminderNotificationId(queued.eventUid, queued.startDate) === id) ? current : [...current, notice]));
        playNotificationSound("calendar");
    }, []);

    useEffect(() => {
        if (!enabled || !userUid) {
            return;
        }
        const offEvent = getPushClient().onEvent((event) => {
            const notice = calendarReminderOf(event);
            if (notice) {
                present(notice);
            }
        });
        const pending = timers.current;
        return () => {
            offEvent();
            for (const timer of pending) {
                clearTimeout(timer);
            }
            pending.clear();
            setQueue([]);
        };
    }, [enabled, userUid, present]);

    const dismiss = useCallback(() => setQueue((current) => current.slice(1)), []);
    const snooze = useCallback(() => {
        const first = queueRef.current[0];
        if (first) {
            const timer = setTimeout(() => {
                timers.current.delete(timer);
                present(first);
            }, SNOOZE_MS);
            timers.current.add(timer);
        }
        setQueue((current) => current.slice(1));
    }, [present]);

    return { current: queue[0], waiting: Math.max(0, queue.length - 1), snooze, dismiss };
}
