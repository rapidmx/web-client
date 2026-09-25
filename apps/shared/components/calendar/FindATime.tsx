///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import {
    AvailabilityState,
    FREE_BUSY_MAX_ADDRESSES,
    PersonAvailability,
    availabilityDuring,
    availabilityOf,
    getFreeBusy,
    suggestTimes,
    summarizeAvailability,
    withoutOwnBlock,
} from "@rapidmx/react-shared/calendar/freeBusyApi.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { addDaysToKey } from "./allDay.js";
import { EventFormController } from "./eventForm.js";
import { formatFormWhen, localDateFromKey, msToWallString, wallStringToMs } from "./eventFormat.js";
import {
    SEARCH_DAYS,
    WORK_END_HOUR,
    WORK_START_HOUR,
    clockLabel,
    dayStartMs,
    freeBusyErrorMessage,
    isDayKey,
    minuteOfDay,
    summaryLine,
    workingWindows,
} from "./findTimeGrid.js";

/** How long the grid waits after the last change of day or guests before asking the server, so typing a list of guests is one look-up. */
export const FIND_TIME_DEBOUNCE_MS = 300;

const HOUR_WIDTH = 52;
const NAME_WIDTH = 136;
const HEADER_HEIGHT = 28;
const ROW_HEIGHT = 44;
const TIMELINE_WIDTH = HOUR_WIDTH * 24;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const GRID_LINES = `repeating-linear-gradient(to right, transparent 0, transparent ${HOUR_WIDTH - 1}px, var(--color-border) ${HOUR_WIDTH - 1}px, var(--color-border) ${HOUR_WIDTH}px)`;
const HATCH = "repeating-linear-gradient(45deg, transparent 0, transparent 4px, var(--color-text-muted) 4px, var(--color-text-muted) 5px)";
const TENTATIVE_HATCH =
    "repeating-linear-gradient(45deg, var(--color-danger-bg) 0, var(--color-danger-bg) 4px, var(--color-danger) 4px, var(--color-danger) 6px)";

/** "12am", "9am", "12pm" for the header cells and their labels. */
function hourLabel(hour: number): string {
    return format(new Date(2000, 0, 1, hour), "haaa");
}

interface Row {
    address: string;
    name: string;
    you: boolean;
}

type LookUp = { status: "loading" | "ready"; people: PersonAvailability[] } | { status: "error"; people: PersonAvailability[]; message: string };

/** What a row says about the proposed time, under the person's name. */
function stateText(state: AvailabilityState | undefined, status: PersonAvailability["status"] | undefined): string {
    if (status === "restricted") {
        return "Hides their calendar";
    }
    if (status === "unknown") {
        return "Availability unknown";
    }
    if (status === undefined) {
        return "Checking…";
    }
    // Their calendar was read, but the proposed time is not on the days it covers.
    if (state === undefined) {
        return "";
    }
    return state === "free" ? "Free" : state === "busy" ? "Busy at this time" : "Maybe busy at this time";
}

/**
 * The event dialog's "Find a time" tab: a day of the guests' calendars side by side, as Google Calendar draws it. A row for you and one for each guest,
 * the hours of the day across (working hours in view first), each person's busy time as a block (a tentative one hatched) and the event's proposed time as a
 * highlight across every row; pressing an hour, or a place in a row, moves the event's start there (its length is kept). Under the grid: whether the proposed
 * time suits everyone, and up to five suggested times - the next slots of the event's length, 8:00am to 6:00pm, when everyone who can be checked is free.
 *
 * Who can be checked: `POST /calendar-events/free-busy` tells a guest's busy time only for a mailbox on this server whose owner shares it with you. A guest it
 * cannot see - an external address, or somebody who hides their calendar - is shown as such, in the grid and in the summary, and is never counted as free;
 * suggestions ignore them (and say so). The look-up is made after a short pause (`FIND_TIME_DEBOUNCE_MS`) whenever the day or the guests change, one answer at
 * a time (an answer for a look-up that has since been replaced is dropped), and a failure - too many look-ups, or no connection - says so with a retry.
 */
export default function FindATime({ c }: { c: EventFormController }) {
    const { values, deviceZone, organizerAddress, occurrence } = c;
    const { start, end, allDay, formZone } = values;
    const startDay = start.slice(0, 10);
    const [dayKey, setDayKey] = useState(() => (isDayKey(startDay) ? startDay : format(new Date(), "yyyy-MM-dd")));
    const [retry, setRetry] = useState(0);
    // Picking another date in the form moves the grid to it.
    useEffect(() => {
        if (isDayKey(startDay)) {
            setDayKey(startDay);
        }
    }, [startDay]);

    // You, then each guest once (case-insensitively), at most as many as one look-up may ask about.
    const rows = useMemo<Row[]>(() => {
        const seen = new Set([organizerAddress.toLowerCase()]);
        const guests: Row[] = [];
        for (const attendee of values.attendees) {
            const key = attendee.address.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                guests.push({ address: attendee.address, name: attendee.displayName || attendee.address, you: false });
            }
        }
        return [{ address: organizerAddress, name: "You", you: true }, ...guests].slice(0, FREE_BUSY_MAX_ADDRESSES);
    }, [values.attendees, organizerAddress]);
    const guestCount = rows.length - 1;
    const addresses = rows.map((row) => row.address);
    const addressesKey = addresses.map((address) => address.toLowerCase()).join(",");

    const rangeStart = dayStartMs(dayKey, formZone, deviceZone);
    const rangeEnd = dayStartMs(addDaysToKey(dayKey, SEARCH_DAYS), formZone, deviceZone);
    const eventStart = allDay ? Number.NaN : wallStringToMs(start, formZone, deviceZone);
    const eventEnd = allDay ? Number.NaN : wallStringToMs(end, formZone, deviceZone);
    const timeIsValid = eventEnd > eventStart;

    const [lookUp, setLookUp] = useState<LookUp>({ status: "loading", people: [] });
    useEffect(() => {
        if (allDay || guestCount === 0 || Number.isNaN(rangeStart) || Number.isNaN(rangeEnd)) {
            return;
        }
        // Each run of this effect owns its answer: once the day or the guests change (or this unmounts) a slower earlier look-up is ignored.
        let current = true;
        setLookUp((previous) => ({ status: "loading", people: previous.people }));
        const timer = setTimeout(() => {
            getFreeBusy(addresses, new Date(rangeStart), new Date(rangeEnd)).then(
                (response) => current && setLookUp({ status: "ready", people: availabilityOf(response) }),
                (err: unknown) => current && setLookUp({ status: "error", people: [], message: freeBusyErrorMessage(err) }),
            );
        }, FIND_TIME_DEBOUNCE_MS);
        return () => {
            current = false;
            clearTimeout(timer);
        };
        // `addresses` is what `addressesKey` says.
    }, [addressesKey, rangeStart, rangeEnd, allDay, retry]);

    // The event's own time, when it is being rescheduled, is on the calendars of the people already invited: not their conflict with themselves.
    const people = useMemo(() => {
        if (!occurrence || occurrence.allDay) {
            return lookUp.people;
        }
        const invited = new Set([occurrence.organizer.address, ...occurrence.attendees.map((attendee) => attendee.address), organizerAddress].map((a) => a.toLowerCase()));
        return withoutOwnBlock(lookUp.people, invited, Date.parse(occurrence.startDate), Date.parse(occurrence.endDate));
    }, [lookUp.people, occurrence, organizerAddress]);

    // Working hours scrolled into view, or the event's own start when that lies outside them.
    const scroller = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (!scroller.current) {
            return;
        }
        const startHour = timeIsValid && msToWallString(eventStart, formZone, deviceZone).slice(0, 10) === dayKey ? Number(msToWallString(eventStart, formZone, deviceZone).slice(11, 13)) : undefined;
        const firstHour = startHour !== undefined && (startHour < WORK_START_HOUR || startHour >= WORK_END_HOUR - 3) ? Math.max(0, startHour - 1) : WORK_START_HOUR;
        scroller.current.scrollLeft = firstHour * HOUR_WIDTH;
        // Only a change of day moves the view: moving the event within it must not.
    }, [dayKey, guestCount > 0 && !allDay]);

    function startAt(minutes: number) {
        c.setStart(`${dayKey}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
    }

    function handleTimelineClick(event: MouseEvent<HTMLDivElement>) {
        const box = event.currentTarget.getBoundingClientRect();
        if (box.width > 0) {
            // Half hours: the smallest step of the form's own time inputs is a minute, but a row is only 52px an hour wide.
            startAt(Math.min(47, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * 48))) * 30);
        }
    }

    if (allDay) {
        return <p className="text-sm text-text-muted">Finding a time works for an event with a start and end time. Uncheck All day to see when your guests are free.</p>;
    }
    if (guestCount === 0) {
        return <p className="text-sm text-text-muted">Add guests to see when they are free.</p>;
    }

    const dayLabel = format(localDateFromKey(dayKey), "EEEE, MMMM d");
    const proposedFrom = timeIsValid ? minuteOfDay(eventStart, dayKey, formZone, deviceZone) : 0;
    const proposedTo = timeIsValid ? minuteOfDay(eventEnd, dayKey, formZone, deviceZone) : 0;
    const showProposed = timeIsValid && proposedTo > proposedFrom;
    const covered = timeIsValid && eventStart >= rangeStart && eventEnd <= rangeEnd;
    const answered = lookUp.status === "ready";
    const byAddress = new Map(people.map((person) => [person.address.toLowerCase(), person]));

    const summary = answered && covered ? summarizeAvailability(people, eventStart, eventEnd) : undefined;
    const suggestions =
        answered && timeIsValid
            ? suggestTimes(people, {
                  windows: workingWindows(dayKey, formZone, deviceZone),
                  durationMs: eventEnd - eventStart,
                  notBeforeMs: Date.now(),
              })
            : [];
    const seen = people.filter((person) => person.status === "available").length;
    const unseen = people.length - seen;

    /** What a screen reader hears of a person whose calendar was read: their busy times on the day shown. */
    function busyDescription(person: PersonAvailability): string {
        const dayEnd = dayStartMs(addDaysToKey(dayKey, 1), formZone, deviceZone);
        const blocks = person.busy.filter((block) => block.startMs < dayEnd && block.endMs > rangeStart);
        return blocks.length === 0
            ? "Free all day."
            : blocks
                  .map((block) => `${block.tentative ? "Tentatively busy" : "Busy"} ${clockLabel(block.startMs, formZone, deviceZone)} to ${clockLabel(block.endMs, formZone, deviceZone)}`)
                  .join(", ");
    }

    return (
        <div className="flex flex-col gap-3 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    aria-label="Previous day"
                    onClick={() => setDayKey((key) => addDaysToKey(key, -1))}
                    className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                >
                    &lsaquo;
                </button>
                <span className="text-sm font-medium min-w-[9rem] text-center">{dayLabel}</span>
                <button
                    type="button"
                    aria-label="Next day"
                    onClick={() => setDayKey((key) => addDaysToKey(key, 1))}
                    className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                >
                    &rsaquo;
                </button>
                <span className="text-xs text-text-muted">{formZone.replace(/_/g, " ")}</span>
            </div>

            {lookUp.status === "error" && (
                <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
                    <span>{lookUp.message}</span>
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setRetry((count) => count + 1)}>
                        Try again
                    </Button>
                </div>
            )}

            <div ref={scroller} role="group" aria-label="Guests' availability" aria-busy={lookUp.status === "loading"} className="overflow-x-auto border border-border rounded-md">
                <div className="relative" style={{ width: NAME_WIDTH + TIMELINE_WIDTH }}>
                    <div className="flex bg-surface border-b border-border" style={{ height: HEADER_HEIGHT }}>
                        <div className="sticky left-0 z-20 shrink-0 bg-surface border-r border-border" style={{ width: NAME_WIDTH }} />
                        {HOURS.map((hour) => (
                            <button
                                key={hour}
                                type="button"
                                aria-label={`Start at ${hourLabel(hour)}`}
                                title={`Start at ${hourLabel(hour)}`}
                                onClick={() => startAt(hour * 60)}
                                className="shrink-0 text-[10px] text-text-muted hover:bg-surface-alt hover:text-text text-left pl-1"
                                style={{ width: HOUR_WIDTH }}
                            >
                                {hourLabel(hour)}
                            </button>
                        ))}
                    </div>

                    {rows.map((row) => {
                        const person = byAddress.get(row.address.toLowerCase());
                        const state = person && timeIsValid && covered ? availabilityDuring(person, eventStart, eventEnd) : undefined;
                        const hidden = person && person.status !== "available" ? person : undefined;
                        return (
                            <div key={row.address.toLowerCase()} className="flex border-b border-border last:border-b-0" style={{ height: ROW_HEIGHT }}>
                                <div className="sticky left-0 z-10 shrink-0 flex items-center gap-2 px-2 bg-surface border-r border-border" style={{ width: NAME_WIDTH }}>
                                    <span aria-hidden="true" className="w-6 h-6 shrink-0 rounded-full bg-primary/15 text-primary-dark text-[11px] font-semibold flex items-center justify-center uppercase">
                                        {row.name.charAt(0)}
                                    </span>
                                    <div className="min-w-0">
                                        <div className="text-xs font-medium truncate">{row.name}</div>
                                        <div className="text-[10px] text-text-muted truncate">{stateText(state, person?.status)}</div>
                                    </div>
                                </div>
                                <div
                                    role="img"
                                    aria-label={`${row.name}: ${hidden ? stateText(undefined, hidden.status) : person ? busyDescription(person) : "Checking availability"}`}
                                    onClick={handleTimelineClick}
                                    className={["relative shrink-0 cursor-pointer", !person && lookUp.status === "loading" ? "animate-pulse bg-surface-alt" : ""].join(" ")}
                                    style={{ width: TIMELINE_WIDTH, backgroundImage: GRID_LINES }}
                                >
                                    <div aria-hidden="true" className="absolute inset-y-0 left-0 bg-surface-alt/70" style={{ width: WORK_START_HOUR * HOUR_WIDTH }} />
                                    <div aria-hidden="true" className="absolute inset-y-0 right-0 bg-surface-alt/70" style={{ width: (24 - WORK_END_HOUR) * HOUR_WIDTH }} />
                                    {hidden && (
                                        <>
                                            <div aria-hidden="true" className="absolute inset-0 opacity-30" style={{ backgroundImage: HATCH }} />
                                            <span aria-hidden="true" className="sticky left-2 inline-block px-2 mt-3 text-[11px] text-text bg-surface rounded-sm">
                                                {stateText(undefined, hidden.status)}
                                            </span>
                                        </>
                                    )}
                                    {person?.status === "available" &&
                                        person.busy.map((block, index) => {
                                            const from = minuteOfDay(block.startMs, dayKey, formZone, deviceZone);
                                            const to = minuteOfDay(block.endMs, dayKey, formZone, deviceZone);
                                            return to > from ? (
                                                <div
                                                    key={index}
                                                    aria-hidden="true"
                                                    data-busy={block.tentative ? "tentative" : "busy"}
                                                    className={["absolute top-2 bottom-2 rounded-sm border border-danger", block.tentative ? "" : "bg-danger/60"].join(" ")}
                                                    style={{ left: (from / 60) * HOUR_WIDTH, width: ((to - from) / 60) * HOUR_WIDTH, backgroundImage: block.tentative ? TENTATIVE_HATCH : undefined }}
                                                />
                                            ) : null;
                                        })}
                                </div>
                            </div>
                        );
                    })}

                    {showProposed && (
                        <div
                            aria-hidden="true"
                            data-proposed-time=""
                            className="absolute border-x-2 border-primary bg-primary/10 pointer-events-none z-[5]"
                            style={{
                                top: HEADER_HEIGHT,
                                bottom: 0,
                                left: NAME_WIDTH + (proposedFrom / 60) * HOUR_WIDTH,
                                width: ((proposedTo - proposedFrom) / 60) * HOUR_WIDTH,
                            }}
                        />
                    )}
                </div>
            </div>

            <div role="status" aria-live="polite" className="text-sm">
                {lookUp.status === "loading" && "Checking availability…"}
                {lookUp.status === "ready" && !timeIsValid && "Set a start and an end time to see who is free."}
                {lookUp.status === "ready" && timeIsValid && !covered && "Pick a time within this week to see who is free."}
                {summary && <span className={summary.conflicts > 0 ? "font-medium text-danger" : "font-medium"}>{summaryLine(summary)}</span>}
            </div>

            {answered && timeIsValid && (
                <section aria-labelledby="find-time-suggestions" className="flex flex-col gap-1.5">
                    <h4 id="find-time-suggestions" className="text-xs font-bold uppercase tracking-wide text-text-muted">
                        Suggested times
                    </h4>
                    {suggestions.length > 0 ? (
                        <ul className="flex flex-col gap-1">
                            {suggestions.map((ms) => {
                                const startWall = msToWallString(ms, formZone, deviceZone);
                                const endWall = msToWallString(ms + (eventEnd - eventStart), formZone, deviceZone);
                                return (
                                    <li key={ms}>
                                        <button type="button" onClick={() => c.setStart(startWall)} className="text-sm text-primary-dark hover:underline text-left">
                                            {formatFormWhen(startWall, endWall, false)}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <p className="text-sm text-text-muted">
                            {seen === 0
                                ? "There is no calendar to check, so no time can be suggested."
                                : `No time this week has everyone free between ${hourLabel(WORK_START_HOUR)} and ${hourLabel(WORK_END_HOUR)}.`}
                        </p>
                    )}
                    {unseen > 0 && (
                        <p className="text-xs text-text-muted">
                            Suggestions leave out {unseen} {unseen === 1 ? "person whose calendar" : "people whose calendars"} can&rsquo;t be seen.
                        </p>
                    )}
                </section>
            )}
        </div>
    );
}
