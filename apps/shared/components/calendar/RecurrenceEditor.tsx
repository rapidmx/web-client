///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { format } from "date-fns";
import { RecurrenceFrequency, RecurrenceRule, WeekdayCode } from "../../../../lib/calendar/calendarApi.js";
import { WEEKDAY_CODES, WEEKDAY_LABELS, describeRecurrence } from "../../../../lib/calendar/recurrence.js";
import { recurrenceUntilDateKey, recurrenceUntilInstant } from "./allDay.js";

const SELECT_CLASS =
    "text-sm py-2 px-2 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";
const INPUT_CLASS =
    "text-sm py-2 px-2 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

const FREQ_LABEL: Record<RecurrenceFrequency, { unit: string; unitPlural: string }> = {
    daily: { unit: "day", unitPlural: "days" },
    weekly: { unit: "week", unitPlural: "weeks" },
    monthly: { unit: "month", unitPlural: "months" },
    yearly: { unit: "year", unitPlural: "years" },
};

type EndCondition = "never" | "count" | "until";

/** The most an interval ("every N days") or a count ("after N occurrences") can be set to. */
const MAX_INTERVAL = 999;
const MAX_COUNT = 1000;

function endConditionOf(rule: RecurrenceRule): EndCondition {
    if (rule.count) return "count";
    if (rule.until) return "until";
    return "never";
}

export interface RecurrenceEditorProps {
    /** `null` means "does not repeat". */
    value: RecurrenceRule | null;
    onChange: (value: RecurrenceRule | null) => void;
    /** Whether the event is all-day - its series expands in UTC, so the inclusive "Ends on" date is stored as
     * the end of that UTC day rather than the local one (see `allDay.ts`'s `recurrenceUntilInstant()`). */
    allDay?: boolean;
    /** The weekday the event starts on (in the frame its series expands in - see `allDay.ts`'s
     * `startWeekdayCode()`): the day a new weekly rule, or one switched to Weekly, repeats on. Defaults to Monday. */
    startWeekday?: WeekdayCode;
    /** The event's start date (`yyyy-MM-dd`): "Ends on" starts at today, or at this date when the event starts later - a series that ends before it
     * starts has no occurrences at all. */
    startDateKey?: string;
    /** Leaves out the "Repeats" checkbox, for a caller that already turns repeating on and off itself (the event form's
     * "Does not repeat" menu): what remains is the rule's details, shown only while there is a rule. */
    hideToggle?: boolean;
}

/**
 * A recurring-event editor: frequency + interval, a weekday picker (weekly only), and an end
 * condition (never / after N occurrences / on a date) — everything `RecurrenceRule` can express. The
 * live "every ... until/for ..." summary comes from `describeRecurrence()` (built on `rrule`'s own
 * `.toText()`), so it never drifts out of sync with what will actually be submitted.
 */
export default function RecurrenceEditor({ value, onChange, allDay = false, startWeekday = "MO", startDateKey, hideToggle = false }: RecurrenceEditorProps) {
    function handleEnable(enabled: boolean) {
        onChange(enabled ? { freq: "weekly", interval: 1, byDay: [startWeekday], exceptions: [] } : null);
    }

    // `update`/`toggleDay` are only ever invoked from handlers rendered inside the `{value && (...)}`
    // block below, so `value` is always non-null here — no defensive null check needed.
    function update(patch: Partial<RecurrenceRule>) {
        onChange({ ...(value as RecurrenceRule), ...patch });
    }

    // A weekly rule always keeps at least one weekday: with none left, rrule would repeat every day instead.
    function toggleDay(day: WeekdayCode) {
        const current = (value as RecurrenceRule).byDay ?? [];
        if (current.length === 1 && current[0] === day) {
            return;
        }
        const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
        update({ byDay: next });
    }

    // react-shared passes `byDay` to rrule for every frequency, so a weekday list left over from Weekly would
    // turn "every day" into "every Monday". Leaving Weekly drops it; entering Weekly starts on the event's own
    // start weekday (a select only reports an actual change, so this is never Weekly -> Weekly).
    function handleFrequency(freq: RecurrenceFrequency) {
        update({ freq, byDay: freq === "weekly" ? [startWeekday] : undefined });
    }

    function handleEndCondition(condition: EndCondition) {
        if (condition === "never") {
            update({ count: undefined, until: undefined });
        } else if (condition === "count") {
            update({ count: 10, until: undefined });
        } else {
            const today = format(new Date(), "yyyy-MM-dd");
            update({ until: recurrenceUntilInstant(startDateKey && startDateKey > today ? startDateKey : today, allDay), count: undefined });
        }
    }

    /** A whole number from 1 to `max` from a number input, or `null` while it's empty (a user clearing the field
     * to type a new value) — the rule keeps its previous value then, rather than becoming 0/NaN. A huge one (an event
     * every day, a billion times) would make every view expand it forever. */
    function parsePositive(raw: string, max: number): number | null {
        if (raw.trim() === "") return null;
        const n = Math.floor(Number(raw));
        return n >= 1 ? Math.min(n, max) : 1;
    }

    function handleInterval(raw: string) {
        const interval = parsePositive(raw, MAX_INTERVAL);
        if (interval !== null) update({ interval });
    }

    function handleCount(raw: string) {
        const count = parsePositive(raw, MAX_COUNT);
        if (count !== null) update({ count });
    }

    function handleUntil(raw: string) {
        // A cleared (or partially typed) date input reports "" — keep the previous end date.
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) update({ until: recurrenceUntilInstant(raw, allDay) });
    }

    return (
        <div className="flex flex-col gap-3">
            {!hideToggle && (
                <label className="flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" checked={value !== null} onChange={(e) => handleEnable(e.target.checked)} />
                    Repeats
                </label>
            )}

            {value && (
                <div className="flex flex-col gap-3 pl-6 border-l-2 border-border">
                    <div className="flex items-center gap-2 text-sm">
                        <span>Every</span>
                        <input
                            type="number"
                            min={1}
                            max={MAX_INTERVAL}
                            className={`${INPUT_CLASS} w-16`}
                            value={value.interval}
                            onChange={(e) => handleInterval(e.target.value)}
                            aria-label="Recurrence interval"
                        />
                        <select
                            className={SELECT_CLASS}
                            value={value.freq}
                            onChange={(e) => handleFrequency(e.target.value as RecurrenceFrequency)}
                            aria-label="Recurrence frequency"
                        >
                            <option value="daily">{value.interval === 1 ? FREQ_LABEL.daily.unit : FREQ_LABEL.daily.unitPlural}</option>
                            <option value="weekly">{value.interval === 1 ? FREQ_LABEL.weekly.unit : FREQ_LABEL.weekly.unitPlural}</option>
                            <option value="monthly">{value.interval === 1 ? FREQ_LABEL.monthly.unit : FREQ_LABEL.monthly.unitPlural}</option>
                            <option value="yearly">{value.interval === 1 ? FREQ_LABEL.yearly.unit : FREQ_LABEL.yearly.unitPlural}</option>
                        </select>
                    </div>

                    {value.freq === "weekly" && (
                        <div className="flex gap-1">
                            {WEEKDAY_CODES.map((day) => (
                                <button
                                    key={day}
                                    type="button"
                                    onClick={() => toggleDay(day)}
                                    aria-pressed={(value.byDay ?? []).includes(day)}
                                    aria-label={WEEKDAY_LABELS[day]}
                                    className={[
                                        "w-9 h-9 rounded-full text-xs font-semibold border",
                                        (value.byDay ?? []).includes(day)
                                            ? "bg-primary text-white border-primary"
                                            : "bg-surface text-text-muted border-border hover:border-primary",
                                    ].join(" ")}
                                >
                                    <span aria-hidden="true">{WEEKDAY_LABELS[day][0]}</span>
                                </button>
                            ))}
                        </div>
                    )}

                    <fieldset className="flex flex-col gap-1.5 text-sm">
                        <legend className="text-xs font-bold uppercase tracking-wide text-text-muted mb-1">Ends</legend>
                        <label className="flex items-center gap-2">
                            <input
                                type="radio"
                                name="recurrence-end"
                                checked={endConditionOf(value) === "never"}
                                onChange={() => handleEndCondition("never")}
                            />
                            Never
                        </label>
                        <label className="flex items-center gap-2">
                            <input
                                type="radio"
                                name="recurrence-end"
                                aria-label="After"
                                checked={endConditionOf(value) === "count"}
                                onChange={() => handleEndCondition("count")}
                            />
                            After
                            <input
                                type="number"
                                min={1}
                                max={MAX_COUNT}
                                className={`${INPUT_CLASS} w-16`}
                                value={value.count ?? 10}
                                disabled={endConditionOf(value) !== "count"}
                                onChange={(e) => handleCount(e.target.value)}
                                aria-label="Number of occurrences"
                            />
                            occurrences
                        </label>
                        <label className="flex items-center gap-2">
                            <input
                                type="radio"
                                name="recurrence-end"
                                aria-label="On"
                                checked={endConditionOf(value) === "until"}
                                onChange={() => handleEndCondition("until")}
                            />
                            On
                            <input
                                type="date"
                                className={INPUT_CLASS}
                                value={value.until ? recurrenceUntilDateKey(value.until, allDay) : ""}
                                disabled={endConditionOf(value) !== "until"}
                                onChange={(e) => handleUntil(e.target.value)}
                                aria-label="End date"
                            />
                        </label>
                    </fieldset>

                    {(value.freq !== "weekly" || (value.byDay ?? []).length > 0) && (
                        <p className="text-xs text-text-muted">Repeats {describeRecurrence(value)}.</p>
                    )}
                </div>
            )}
        </div>
    );
}
