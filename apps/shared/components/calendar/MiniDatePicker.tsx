///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, startOfMonth, startOfWeek } from "date-fns";

export interface MiniDatePickerProps {
    /** The main view's current date — determines both the month shown and which day is highlighted. */
    selected: Date;
    onSelect: (date: Date) => void;
}

const WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

/** A compact month-grid date picker for the Calendar sidebar, reusing `MonthView`'s own grid-generation
 * approach (`date-fns`'s `startOfWeek`/`endOfWeek`/`eachDayOfInterval`, Monday-start) rather than
 * re-deriving it — this component just renders that same grid far smaller and without any event data.
 * Its own displayed month tracks `selected` (so navigating the main view keeps this in sync) but can
 * also be paged independently via the arrows without moving the main view until a day is actually
 * clicked. */
export default function MiniDatePicker({ selected, onSelect }: MiniDatePickerProps) {
    const [shownMonth, setShownMonth] = useState(() => startOfMonth(selected));
    // Tracks the last `selected` month this picker synced to, in the standard React
    // "adjust state during render" shape — resyncs `shownMonth` whenever the caller's selected date
    // moves to a different month (e.g. via the main view's own Previous/Next/Today controls), but
    // otherwise leaves it alone so paging this picker's own arrows isn't immediately undone.
    const [trackedSelectedMonth, setTrackedSelectedMonth] = useState(() => startOfMonth(selected));
    if (!isSameMonth(trackedSelectedMonth, selected)) {
        setTrackedSelectedMonth(startOfMonth(selected));
        setShownMonth(startOfMonth(selected));
    }

    const gridStart = startOfWeek(startOfMonth(shownMonth), { weekStartsOn: 1 });
    const gridEnd = endOfWeek(endOfMonth(shownMonth), { weekStartsOn: 1 });
    const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

    return (
        <nav aria-label="Mini calendar" className="p-2">
            <div className="flex items-center justify-between mb-1.5">
                <button
                    type="button"
                    aria-label="Previous month"
                    onClick={() => setShownMonth((m) => addMonths(m, -1))}
                    className="w-6 h-6 text-xs rounded-sm hover:bg-surface-alt"
                >
                    &lsaquo;
                </button>
                <span className="text-xs font-semibold">{format(shownMonth, "MMMM yyyy")}</span>
                <button
                    type="button"
                    aria-label="Next month"
                    onClick={() => setShownMonth((m) => addMonths(m, 1))}
                    className="w-6 h-6 text-xs rounded-sm hover:bg-surface-alt"
                >
                    &rsaquo;
                </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5">
                {WEEKDAY_LABELS.map((label, i) => (
                    <div key={i} className="text-[10px] text-text-muted text-center">
                        {label}
                    </div>
                ))}
                {days.map((day) => (
                    <button
                        key={day.toISOString()}
                        type="button"
                        onClick={() => {
                            onSelect(day);
                            setShownMonth(startOfMonth(day));
                        }}
                        className={[
                            "text-[11px] w-6 h-6 rounded-full flex items-center justify-center mx-auto",
                            isSameDay(day, selected)
                                ? "bg-primary text-white"
                                : isToday(day)
                                  ? "text-primary-dark font-semibold"
                                  : isSameMonth(day, shownMonth)
                                    ? "text-text hover:bg-surface-alt"
                                    : "text-text-muted/50 hover:bg-surface-alt",
                        ].join(" ")}
                    >
                        {format(day, "d")}
                    </button>
                ))}
            </div>
        </nav>
    );
}
