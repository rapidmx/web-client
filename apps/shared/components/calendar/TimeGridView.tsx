///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { addMinutes, format, isSameDay, isToday, startOfDay } from "date-fns";
import { dayDropId, eventDragId, resizeDragId, slotDropId } from "@rapidmx/react-shared/calendarDragIds.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/recurrence.js";

const HOUR_HEIGHT_PX = 48;
const SLOT_MINUTES = 30;
const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export interface TimeGridViewProps {
    /** One day for the Day view, seven for the Week view, five for the Work Week view. */
    days: Date[];
    /** Already expanded for the visible range — see `recurrence.ts`'s `expandAllOccurrences`. */
    occurrences: CalendarOccurrence[];
    /** Each occurrence's own calendar color, keyed by `folderUid` — see `calendarColors.ts`. */
    folderColors: Record<string, string>;
    onSelectEvent: (occurrence: CalendarOccurrence) => void;
    /** Click on an empty slot — start/end default to a 30-minute block there, for the "New event" flow. */
    onSelectSlot: (start: Date, end: Date) => void;
}

/** An hourly time grid (Week, Work Week, or Day view — they share all their rendering/drag logic and
 * differ only in how many day columns are shown), with a day-header row and all-day events in a
 * header strip above it. */
export default function TimeGridView({ days, occurrences, folderColors, onSelectEvent, onSelectSlot }: TimeGridViewProps) {
    const allDayEvents = occurrences.filter((occ) => occ.allDay);
    const timedEvents = occurrences.filter((occ) => !occ.allDay);

    return (
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
            <div className="flex border-b border-border shrink-0">
                <div className="w-14 shrink-0" />
                {days.map((day) => (
                    <div
                        key={day.toISOString()}
                        className={["flex-1 min-w-0 py-1 text-center text-xs font-semibold border-l border-border", isToday(day) ? "text-primary-dark" : ""].join(" ")}
                    >
                        {format(day, "EEE d")}
                    </div>
                ))}
            </div>
            {allDayEvents.length > 0 && (
                <div className="flex border-b border-border shrink-0">
                    <div className="w-14 shrink-0" />
                    {days.map((day) => (
                        <div key={day.toISOString()} className="flex-1 min-w-0 p-1 flex flex-col gap-0.5 border-l border-border">
                            {allDayEvents
                                .filter((occ) => isSameDay(new Date(occ.startDate), day))
                                .map((occ) => (
                                    <button
                                        key={occ.occurrenceKey}
                                        type="button"
                                        onClick={() => onSelectEvent(occ)}
                                        style={{ backgroundColor: folderColors[occ.folderUid], color: "#fff" }}
                                        className="text-xs text-left truncate rounded-sm px-1.5 py-0.5"
                                    >
                                        {occ.title}
                                    </button>
                                ))}
                        </div>
                    ))}
                </div>
            )}
            <div className="flex flex-1">
                <div className="w-14 shrink-0">
                    {HOURS.map((hour) => (
                        <div key={hour} style={{ height: HOUR_HEIGHT_PX }} className="text-[10px] text-text-muted text-right pr-1.5 -mt-1.5">
                            {hour === 0 ? "" : format(new Date(2000, 0, 1, hour), "ha")}
                        </div>
                    ))}
                </div>
                {days.map((day) => (
                    <DayColumn
                        key={day.toISOString()}
                        day={day}
                        occurrences={timedEvents.filter((occ) => isSameDay(new Date(occ.startDate), day))}
                        folderColors={folderColors}
                        onSelectEvent={onSelectEvent}
                        onSelectSlot={onSelectSlot}
                    />
                ))}
            </div>
        </div>
    );
}

interface DayColumnProps {
    day: Date;
    occurrences: CalendarOccurrence[];
    folderColors: Record<string, string>;
    onSelectEvent: (occurrence: CalendarOccurrence) => void;
    onSelectSlot: (start: Date, end: Date) => void;
}

function DayColumn({ day, occurrences, folderColors, onSelectEvent, onSelectSlot }: DayColumnProps) {
    const dayStart = startOfDay(day);

    return (
        <div className={["flex-1 min-w-0 relative border-l border-border", isToday(day) ? "bg-primary/5" : ""].join(" ")}>
            {Array.from({ length: SLOTS_PER_DAY }, (_, i) => {
                const slotStart = addMinutes(dayStart, i * SLOT_MINUTES);
                return <TimeSlot key={i} start={slotStart} onSelectSlot={onSelectSlot} />;
            })}
            {occurrences.map((occurrence) => (
                <EventBlock
                    key={occurrence.occurrenceKey}
                    occurrence={occurrence}
                    color={folderColors[occurrence.folderUid]}
                    dayStart={dayStart}
                    onSelect={onSelectEvent}
                />
            ))}
        </div>
    );
}

function TimeSlot({ start, onSelectSlot }: { start: Date; onSelectSlot: (start: Date, end: Date) => void }) {
    const { setNodeRef, isOver } = useDroppable({ id: slotDropId(start) });
    return (
        <button
            ref={setNodeRef}
            type="button"
            onClick={() => onSelectSlot(start, addMinutes(start, SLOT_MINUTES))}
            style={{ height: HOUR_HEIGHT_PX / 2 }}
            className={["block w-full border-b border-border/50 text-left", isOver ? "bg-primary/10" : ""].join(" ")}
            aria-label={`New event at ${format(start, "h:mm a, MMM d")}`}
        />
    );
}

function EventBlock({
    occurrence,
    color,
    dayStart,
    onSelect,
}: {
    occurrence: CalendarOccurrence;
    /** This occurrence's calendar color — see `calendarColors.ts`. Only applied for a "busy" block; a
     * "free" one keeps Outlook's own muted/outline treatment regardless of which calendar it's on. */
    color: string;
    dayStart: Date;
    onSelect: (occurrence: CalendarOccurrence) => void;
}) {
    const { setNodeRef, listeners, attributes, transform, isDragging } = useDraggable({ id: eventDragId(occurrence) });
    const { setNodeRef: setResizeRef, listeners: resizeListeners, attributes: resizeAttributes } = useDraggable({
        id: resizeDragId(occurrence),
    });
    const isFree = occurrence.busyStatus === "free";

    const start = new Date(occurrence.startDate);
    const end = new Date(occurrence.endDate);
    const top = ((start.getTime() - dayStart.getTime()) / 60_000 / 60) * HOUR_HEIGHT_PX;
    // The resize handle's own drag position has no live pixel preview (it only applies its ns-resize
    // affordance) — the actual new end time is computed from whichever slot it's dropped onto (see
    // `resolveDragAction`'s "resize" case), snapped to the grid rather than following the pointer
    // continuously. Simpler, and avoids a visual preview that could disagree with the snapped result.
    const height = Math.max(((end.getTime() - start.getTime()) / 60_000 / 60) * HOUR_HEIGHT_PX, 16);

    return (
        <div
            ref={setNodeRef}
            onClick={() => onSelect(occurrence)}
            style={{
                position: "absolute",
                top,
                height,
                left: 2,
                right: 2,
                transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
                zIndex: isDragging ? 10 : undefined,
                ...(isFree ? undefined : { backgroundColor: color, color: "#fff" }),
            }}
            className={[
                "rounded-sm px-1.5 py-0.5 text-xs text-left overflow-hidden cursor-pointer",
                isFree ? "bg-surface-alt text-text-muted" : "",
                isDragging ? "opacity-50" : "",
            ].join(" ")}
            {...listeners}
            {...attributes}
        >
            <div className="font-medium truncate">{occurrence.title}</div>
            <div className="truncate">{format(start, "h:mma")}</div>
            <div
                ref={setResizeRef}
                className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize"
                aria-label={`Resize "${occurrence.title}"`}
                {...resizeListeners}
                {...resizeAttributes}
            />
        </div>
    );
}
