///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, startOfMonth, startOfWeek } from "date-fns";
import { dayDropId, eventDragId } from "@rapidmx/react-shared/calendarDragIds.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/recurrence.js";

const MAX_CHIPS_PER_DAY = 3;

export interface MonthViewProps {
    /** Any date within the month to display. */
    viewDate: Date;
    /** Already expanded for the visible grid range — see `recurrence.ts`'s `expandAllOccurrences`. */
    occurrences: CalendarOccurrence[];
    /** Each occurrence's own calendar color, keyed by `folderUid` — see `calendarColors.ts`. */
    folderColors: Record<string, string>;
    onSelectDay: (date: Date) => void;
    onSelectEvent: (occurrence: CalendarOccurrence) => void;
}

/** A real 6-week month grid (Mon-start), matching Outlook/Gmail's month view. Multi-day/all-day
 * events are shown only on their start day — a deliberate v1 simplification, not a bug. */
export default function MonthView({ viewDate, occurrences, folderColors, onSelectDay, onSelectEvent }: MonthViewProps) {
    const gridStart = startOfWeek(startOfMonth(viewDate), { weekStartsOn: 1 });
    const gridEnd = endOfWeek(endOfMonth(viewDate), { weekStartsOn: 1 });
    const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

    return (
        <div className="flex-1 grid grid-cols-7 grid-rows-6 min-h-0" role="grid" aria-label="Month">
            {days.map((day) => (
                <DayCell
                    key={day.toISOString()}
                    day={day}
                    inCurrentMonth={isSameMonth(day, viewDate)}
                    occurrences={occurrences.filter((occ) => isSameDay(new Date(occ.startDate), day))}
                    folderColors={folderColors}
                    onSelectDay={onSelectDay}
                    onSelectEvent={onSelectEvent}
                />
            ))}
        </div>
    );
}

interface DayCellProps {
    day: Date;
    inCurrentMonth: boolean;
    occurrences: CalendarOccurrence[];
    folderColors: Record<string, string>;
    onSelectDay: (date: Date) => void;
    onSelectEvent: (occurrence: CalendarOccurrence) => void;
}

function DayCell({ day, inCurrentMonth, occurrences, folderColors, onSelectDay, onSelectEvent }: DayCellProps) {
    const { setNodeRef, isOver } = useDroppable({ id: dayDropId(day) });
    const visible = occurrences.slice(0, MAX_CHIPS_PER_DAY);
    const overflowCount = occurrences.length - visible.length;

    return (
        <div
            ref={setNodeRef}
            className={[
                "border-b border-r border-border p-1 flex flex-col gap-0.5 min-h-0 overflow-hidden",
                isOver ? "bg-primary/5" : "",
                inCurrentMonth ? "bg-surface" : "bg-surface-alt",
            ].join(" ")}
        >
            <button
                type="button"
                onClick={() => onSelectDay(day)}
                className={[
                    "self-start text-xs font-semibold w-6 h-6 rounded-full flex items-center justify-center shrink-0",
                    isToday(day) ? "bg-primary text-white" : inCurrentMonth ? "text-text" : "text-text-muted",
                ].join(" ")}
            >
                {format(day, "d")}
            </button>
            <div className="flex-1 flex flex-col gap-0.5 min-h-0 overflow-hidden">
                {visible.map((occurrence) => (
                    <EventChip
                        key={occurrence.occurrenceKey}
                        occurrence={occurrence}
                        color={folderColors[occurrence.folderUid]}
                        onSelect={onSelectEvent}
                    />
                ))}
                {overflowCount > 0 && (
                    <button
                        type="button"
                        onClick={() => onSelectDay(day)}
                        className="text-xs text-text-muted text-left hover:underline shrink-0"
                    >
                        +{overflowCount} more
                    </button>
                )}
            </div>
        </div>
    );
}

function EventChip({
    occurrence,
    color,
    onSelect,
}: {
    occurrence: CalendarOccurrence;
    /** This occurrence's calendar color — see `calendarColors.ts`. Only applied for a "busy" chip; a
     * "free" one keeps Outlook's own muted/outline treatment regardless of which calendar it's on. */
    color: string;
    onSelect: (occurrence: CalendarOccurrence) => void;
}) {
    const { setNodeRef, listeners, attributes, transform, isDragging } = useDraggable({ id: eventDragId(occurrence) });
    const isFree = occurrence.busyStatus === "free";

    return (
        <button
            ref={setNodeRef}
            type="button"
            onClick={() => onSelect(occurrence)}
            style={{
                ...(transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 10 } : undefined),
                ...(isFree ? undefined : { backgroundColor: color, color: "#fff" }),
            }}
            className={[
                "text-xs text-left truncate rounded-sm px-1.5 py-0.5 shrink-0",
                isFree ? "bg-surface-alt text-text-muted" : "",
                isDragging ? "opacity-50" : "",
            ].join(" ")}
            {...listeners}
            {...attributes}
        >
            {occurrence.allDay ? "" : `${format(new Date(occurrence.startDate), "h:mma")} `}
            {occurrence.title}
        </button>
    );
}
