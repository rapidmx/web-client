///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { BookingAvailabilityWindow } from "@rapidmx/react-shared/bookingApi.js";
import Button from "../buttons/Button.js";

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const INPUT_CLASS =
    "text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

function minutesToTimeValue(minutes: number): string {
    const h = Math.floor(minutes / 60)
        .toString()
        .padStart(2, "0");
    const m = (minutes % 60).toString().padStart(2, "0");
    return `${h}:${m}`;
}

function timeValueToMinutes(value: string): number {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
}

export interface AvailabilityEditorProps {
    value: BookingAvailabilityWindow[];
    onChange: (value: BookingAvailabilityWindow[]) => void;
}

/**
 * Adds/removes `BookingType.availability` weekly windows — deliberately does not cover `dateOverrides`
 * (per-date blackouts/exceptions), a separate, less commonly needed escape hatch left for a future pass;
 * `BookingUtils.generateCandidateSlots()` already handles an empty `dateOverrides` array gracefully.
 */
export default function AvailabilityEditor({ value, onChange }: AvailabilityEditorProps) {
    const [dayOfWeek, setDayOfWeek] = useState(1);
    const [startTime, setStartTime] = useState("09:00");
    const [endTime, setEndTime] = useState("17:00");
    const [error, setError] = useState<string | null>(null);

    function handleAdd() {
        const startMinute = timeValueToMinutes(startTime);
        const endMinute = timeValueToMinutes(endTime);
        if (startMinute >= endMinute) {
            setError("Start time must be before end time.");
            return;
        }
        setError(null);
        onChange([...value, { dayOfWeek, startMinute, endMinute }]);
    }

    function handleRemove(index: number) {
        onChange(value.filter((_, i) => i !== index));
    }

    return (
        <div className="flex flex-col gap-3">
            {error && <p className="text-sm text-danger">{error}</p>}
            {value.length === 0 ? (
                <p className="text-sm text-text-muted">No availability windows yet — add one below.</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {value.map((window, index) => (
                        <li
                            key={index}
                            className="flex items-center justify-between gap-3 py-2 px-3 border border-border rounded-sm text-sm"
                        >
                            <span>
                                {DAY_LABELS[window.dayOfWeek]} {minutesToTimeValue(window.startMinute)}&ndash;
                                {minutesToTimeValue(window.endMinute)}
                            </span>
                            <button
                                type="button"
                                onClick={() => handleRemove(index)}
                                className="text-sm text-danger hover:underline"
                            >
                                Remove
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <select
                    aria-label="Day of week"
                    value={dayOfWeek}
                    onChange={(e) => setDayOfWeek(Number(e.target.value))}
                    className={INPUT_CLASS}
                >
                    {DAY_LABELS.map((label, i) => (
                        <option key={label} value={i}>
                            {label}
                        </option>
                    ))}
                </select>
                <input
                    type="time"
                    aria-label="Start time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className={INPUT_CLASS}
                />
                <span className="text-sm text-text-muted">to</span>
                <input
                    type="time"
                    aria-label="End time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className={INPUT_CLASS}
                />
                <Button type="button" variant="secondary" className="!w-auto" onClick={handleAdd}>
                    Add window
                </Button>
            </div>
        </div>
    );
}
