///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import type { PushEvent } from "@rapidmx/react-shared/mail/pushClient.js";
import {
    SNOOZE_MS,
    calendarReminderOf,
    reminderMessage,
    reminderNotificationId,
    snoozeDelayMs,
} from "../../../apps/shared/calendar/calendarReminders.js";

const NOTICE = { eventUid: "evt1", title: "Team sync", startDate: "2026-09-22T15:00:00.000Z" };

describe("calendarReminderOf", () => {
    it("reads a CalendarEvent reminder push event", () => {
        const event: PushEvent = { type: "CalendarEvent", action: "reminder", data: NOTICE };
        expect(calendarReminderOf(event)).toEqual(NOTICE);
    });

    it("ignores every other type", () => {
        expect(calendarReminderOf({ type: "MessageMongo", action: "create", data: NOTICE })).toBeUndefined();
    });

    it("ignores a CalendarEvent event that isn't a reminder", () => {
        expect(calendarReminderOf({ type: "CalendarEvent", action: "update", data: NOTICE })).toBeUndefined();
    });

    it("ignores a reminder whose payload is malformed", () => {
        expect(calendarReminderOf({ type: "CalendarEvent", action: "reminder", data: { eventUid: "evt1" } })).toBeUndefined();
        expect(calendarReminderOf({ type: "CalendarEvent", action: "reminder", data: null })).toBeUndefined();
        expect(calendarReminderOf({ type: "CalendarEvent", action: "reminder", data: undefined })).toBeUndefined();
    });
});

describe("snoozeDelayMs", () => {
    const start = "2026-09-22T15:00:00.000Z";
    const startMs = new Date(start).getTime();

    it("is SNOOZE_MS when the meeting is far in the future", () => {
        expect(snoozeDelayMs(start, startMs - 60 * 60_000)).toBe(SNOOZE_MS);
    });

    it("is cut to the time left before the meeting starts", () => {
        expect(snoozeDelayMs(start, startMs - 2 * 60_000)).toBe(2 * 60_000);
    });

    it("is never negative - a meeting already under way snoozes to zero", () => {
        expect(snoozeDelayMs(start, startMs + 5 * 60_000)).toBe(0);
    });
});

describe("reminderMessage", () => {
    const start = "2026-09-22T15:00:00.000Z";
    const startMs = new Date(start).getTime();

    it("says how many minutes remain", () => {
        expect(reminderMessage(start, startMs - 10 * 60_000)).toMatch(/^Starting in 10 minutes - /);
    });

    it("uses the singular for one minute", () => {
        expect(reminderMessage(start, startMs - 60_000)).toMatch(/^Starting in 1 minute - /);
    });

    it("says 'now' once the start time has arrived", () => {
        expect(reminderMessage(start, startMs)).toMatch(/^Starting now - /);
        expect(reminderMessage(start, startMs + 60_000)).toMatch(/^Starting now - /);
    });
});

describe("reminderNotificationId", () => {
    it("is stable for the same occurrence and distinct for another", () => {
        const id = reminderNotificationId("evt1", "2026-09-22T15:00:00.000Z");
        expect(reminderNotificationId("evt1", "2026-09-22T15:00:00.000Z")).toBe(id);
        expect(reminderNotificationId("evt2", "2026-09-22T15:00:00.000Z")).not.toBe(id);
        expect(reminderNotificationId("evt1", "2026-09-23T15:00:00.000Z")).not.toBe(id);
    });
});
