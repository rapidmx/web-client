///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { RecurrenceFrequency, RecurrenceRule, WeekdayCode } from "@rapidmx/react-shared/calendarApi.js";
import { WEEKDAY_CODES, WEEKDAY_LABELS, describeRecurrence } from "@rapidmx/react-shared/recurrence.js";

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

function endConditionOf(rule: RecurrenceRule): EndCondition {
    if (rule.count) return "count";
    if (rule.until) return "until";
    return "never";
}

export interface RecurrenceEditorProps {
    /** `null` means "does not repeat". */
    value: RecurrenceRule | null;
    onChange: (value: RecurrenceRule | null) => void;
}

/**
 * A recurring-event editor: frequency + interval, a weekday picker (weekly only), and an end
 * condition (never / after N occurrences / on a date) — everything `RecurrenceRule` can express. The
 * live "every ... until/for ..." summary comes from `describeRecurrence()` (built on `rrule`'s own
 * `.toText()`), so it never drifts out of sync with what will actually be submitted.
 */
export default function RecurrenceEditor({ value, onChange }: RecurrenceEditorProps) {
    function handleEnable(enabled: boolean) {
        onChange(enabled ? { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] } : null);
    }

    // `update`/`toggleDay` are only ever invoked from handlers rendered inside the `{value && (...)}`
    // block below, so `value` is always non-null here — no defensive null check needed.
    function update(patch: Partial<RecurrenceRule>) {
        onChange({ ...(value as RecurrenceRule), ...patch });
    }

    function toggleDay(day: WeekdayCode) {
        const current = (value as RecurrenceRule).byDay ?? [];
        const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
        update({ byDay: next });
    }

    function handleEndCondition(condition: EndCondition) {
        if (condition === "never") {
            update({ count: undefined, until: undefined });
        } else if (condition === "count") {
            update({ count: 10, until: undefined });
        } else {
            update({ until: new Date().toISOString(), count: undefined });
        }
    }

    return (
        <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={value !== null} onChange={(e) => handleEnable(e.target.checked)} />
                Repeats
            </label>

            {value && (
                <div className="flex flex-col gap-3 pl-6 border-l-2 border-border">
                    <div className="flex items-center gap-2 text-sm">
                        <span>Every</span>
                        <input
                            type="number"
                            min={1}
                            className={`${INPUT_CLASS} w-16`}
                            value={value.interval}
                            onChange={(e) => update({ interval: Number(e.target.value) })}
                            aria-label="Recurrence interval"
                        />
                        <select
                            className={SELECT_CLASS}
                            value={value.freq}
                            onChange={(e) => update({ freq: e.target.value as RecurrenceFrequency })}
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
                                className={`${INPUT_CLASS} w-16`}
                                value={value.count ?? 10}
                                disabled={endConditionOf(value) !== "count"}
                                onChange={(e) => update({ count: Number(e.target.value) })}
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
                                value={value.until ? value.until.slice(0, 10) : ""}
                                disabled={endConditionOf(value) !== "until"}
                                onChange={(e) => update({ until: new Date(e.target.value).toISOString() })}
                                aria-label="End date"
                            />
                        </label>
                    </fieldset>

                    {((value.freq !== "weekly" || (value.byDay ?? []).length > 0)) && (
                        <p className="text-xs text-text-muted">Repeats {describeRecurrence(value)}.</p>
                    )}
                </div>
            )}
        </div>
    );
}
