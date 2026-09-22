///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect } from "react";
import { getPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import { notify } from "../notifications/store.js";
import { CalendarReminderNotice, calendarReminderOf, reminderMessage, reminderNotificationId, snoozeDelayMs } from "./calendarReminders.js";

/** Where a reminder's title leads. There is no per-event deep link yet (the calendar opens an event by local state, not a URL - see
 * `apps/www/calendar/index.tsx`'s `openEvent()`), so every reminder opens the calendar itself. */
export const CALENDAR_HREF = "/calendar";

export interface UseCalendarRemindersOptions {
    /** Nothing is shown without a signed-in user. */
    userUid?: string;
    /** Runs only while true - the persistent app frame turns it on, like `useMailConnection`'s identical option. */
    enabled: boolean;
}

/**
 * Pop-up meeting reminders. restapi's `CalendarReminderJob` fires a `"CalendarEvent"`/`"reminder"` push event (`{ eventUid, title, startDate }`)
 * when an event's `reminderMinutesBeforeStart` comes due, over the same shared push connection Mail already keeps open
 * (`getPushClient()`) - every accessible mailbox's own channel is already subscribed (`useMailLiveUpdates`'s `pushChannelsFor()`, and the
 * event is published to the mailbox channel as well as the folder's own), so this hook only has to listen, never to manage channels of its
 * own. Lives in the persistent app frame (`AppShell`), like `useSigningEnrollmentWatcher`, so a reminder shows wherever the user is signed in -
 * Mail, Calendar, Contacts, Settings.
 *
 * Each reminder is a sticky pop-up (`notify()`, kind `"calendar"`) with two actions: **Dismiss** closes it and does nothing else. **Snooze**
 * closes it and shows it again - reusing the same notification id, so it replaces rather than stacks - after `SNOOZE_MS` (five minutes), or
 * sooner if the meeting starts first (`snoozeDelayMs()`). A snooze is this tab's own `setTimeout`, cleared on unmount or sign-out; like the
 * reminder itself (the push event is never replayed), it does not survive the tab closing.
 */
export function useCalendarReminders({ userUid, enabled }: UseCalendarRemindersOptions): void {
    useEffect(() => {
        if (!enabled || !userUid) {
            return;
        }
        const timers = new Set<ReturnType<typeof setTimeout>>();

        function show(notice: CalendarReminderNotice): void {
            notify({
                id: reminderNotificationId(notice.eventUid, notice.startDate),
                kind: "calendar",
                title: notice.title,
                message: reminderMessage(notice.startDate),
                href: CALENDAR_HREF,
                sticky: true,
                actions: [
                    { label: "Dismiss" },
                    {
                        label: "Snooze",
                        onClick: () => {
                            const timer = setTimeout(() => {
                                timers.delete(timer);
                                show(notice);
                            }, snoozeDelayMs(notice.startDate));
                            timers.add(timer);
                        },
                    },
                ],
            });
        }

        const offEvent = getPushClient().onEvent((event) => {
            const notice = calendarReminderOf(event);
            if (notice) {
                show(notice);
            }
        });

        return () => {
            offEvent();
            for (const timer of timers) {
                clearTimeout(timer);
            }
            timers.clear();
        };
    }, [enabled, userUid]);
}
