///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { format } from "date-fns";

/** The step between the times a time field offers. */
export const TIME_STEP_MINUTES = 15;
const MS_PER_MINUTE = 60_000;

/**
 * The start a new event gets when nothing was clicked: the next half hour (11:12 becomes 11:30; a time already on the half hour stays), with the
 * event lasting an hour from there.
 */
export function nextHalfHour(now: Date): Date {
    const slot = 30 * MS_PER_MINUTE;
    return new Date(Math.ceil(now.getTime() / slot) * slot);
}

/** `HH:mm` (24 hour) as a 12 hour clock reading: "13:05" is "1:05 PM". */
export function formatTimeOfDay(time: string): string {
    // A cleared date leaves no time to read: the field is empty, not an error.
    if (!/^\d\d:\d\d$/.test(time)) {
        return "";
    }
    const [hours, minutes] = time.split(":").map(Number);
    return format(new Date(2000, 0, 1, hours, minutes), "h:mm a");
}

/**
 * What was typed into a time field as `HH:mm`, or `null` when it isn't a time. Takes 24 hour and 12 hour readings, with or without the colon and
 * the space: "15:45", "3:45 pm", "3:45p", "345pm", "1130" and a bare hour such as "9" (9:00) are all times.
 */
export function parseTimeInput(text: string): string | null {
    const match = /^\s*(\d{1,2})(?::?(\d{2}))?\s*(?:([ap])\.?m?\.?)?\s*$/i.exec(text);
    if (!match) {
        return null;
    }
    let hours = Number(match[1]);
    const minutes = match[2] === undefined ? 0 : Number(match[2]);
    const meridiem = match[3]?.toLowerCase();
    if (minutes > 59) {
        return null;
    }
    if (meridiem) {
        if (hours < 1 || hours > 12) {
            return null;
        }
        hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
    } else if (hours > 23) {
        return null;
    }
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Every time of a day, a quarter hour apart, as `HH:mm`. */
export function dayTimes(): string[] {
    return Array.from({ length: (24 * 60) / TIME_STEP_MINUTES }, (_, i) => {
        const minutes = i * TIME_STEP_MINUTES;
        return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    });
}

/** A length of time as a menu says it: "15 mins", "1 hr", "1.5 hrs", "2 hrs". */
export function formatDuration(minutes: number): string {
    if (minutes < 60) {
        return `${minutes} min${minutes === 1 ? "" : "s"}`;
    }
    const hours = Math.round((minutes / 60) * 100) / 100;
    return `${hours} ${hours === 1 ? "hr" : "hrs"}`;
}

/** `YYYY-MM-DDTHH:mm` read as a wall clock, in minutes since the epoch (no zone: the daylight saving changes of a zone are not this field's business). */
function wallMinutes(value: string): number {
    return Date.parse(`${value.slice(0, 16)}:00Z`) / MS_PER_MINUTE;
}

function wallString(minutes: number): string {
    return new Date(minutes * MS_PER_MINUTE).toISOString().slice(0, 16);
}

export interface EndTimeOption {
    /** The end as `YYYY-MM-DDTHH:mm`. */
    value: string;
    /** The time of day, as a 12 hour clock reading. */
    label: string;
    /** How long the event would last, "(1.5 hrs)". */
    hint: string;
}

/**
 * The ends a time field offers for an event starting at `start` (`YYYY-MM-DDTHH:mm`): each quarter hour on the clock after the start, up to a
 * day later, with the length of the event that end would make.
 */
export function endTimeOptions(start: string): EndTimeOption[] {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(start)) {
        return [];
    }
    const startMinutes = wallMinutes(start);
    const options: EndTimeOption[] = [];
    for (let at = Math.floor(startMinutes / TIME_STEP_MINUTES + 1) * TIME_STEP_MINUTES; at <= startMinutes + 24 * 60; at += TIME_STEP_MINUTES) {
        const value = wallString(at);
        options.push({ value, label: formatTimeOfDay(value.slice(11, 16)), hint: `(${formatDuration(at - startMinutes)})` });
    }
    return options;
}
