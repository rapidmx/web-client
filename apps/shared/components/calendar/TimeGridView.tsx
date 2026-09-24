///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { addDays, addMinutes, format, isToday, startOfDay } from "date-fns";
import { dayDropId, eventDragId, resizeDragId, slotDropId } from "@rapidmx/react-shared/calendar/calendarDragIds.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import { occursOnDay, startsOnDay } from "./allDay.js";
import { EventAnchor, anchorOf } from "./EventShell.js";

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
    /** Click on an empty slot — start/end default to a 30-minute block there, for the "New event" flow. `anchor` is the slot, for the
     * quick-create popover to open beside. */
    onSelectSlot: (start: Date, end: Date, anchor: EventAnchor) => void;
}

/** An hourly time grid (Week, Work Week, or Day view — they share all their rendering/drag logic and
 * differ only in how many day columns are shown), with a day-header row and all-day events in a
 * header strip above it. */
export default function TimeGridView({ days, occurrences, folderColors, onSelectEvent, onSelectSlot }: TimeGridViewProps) {
    const allDayEvents = occurrences.filter((occ) => occ.allDay);
    const timedEvents = occurrences.filter((occ) => !occ.allDay);

    return (
        <div data-calendar-scroller className="flex-1 flex flex-col min-h-0 overflow-y-auto">
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
                                .filter((occ) => occursOnDay(occ, day))
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
                        occurrences={timedEvents.filter((occ) => occursOnDay(occ, day))}
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
    onSelectSlot: (start: Date, end: Date, anchor: EventAnchor) => void;
}

function DayColumn({ day, occurrences, folderColors, onSelectEvent, onSelectSlot }: DayColumnProps) {
    const dayStart = startOfDay(day);

    return (
        <div className={["flex-1 min-w-0 relative border-l border-border", isToday(day) ? "bg-primary/5" : ""].join(" ")}>
            {Array.from({ length: SLOTS_PER_DAY }, (_, i) => {
                const slotStart = addMinutes(dayStart, i * SLOT_MINUTES);
                return <TimeSlot key={i} start={slotStart} onSelectSlot={onSelectSlot} />;
            })}
            {occurrences.map((occurrence) =>
                startsOnDay(occurrence, day) ? (
                    <EventBlock
                        key={occurrence.occurrenceKey}
                        occurrence={occurrence}
                        color={folderColors[occurrence.folderUid]}
                        dayStart={dayStart}
                        onSelect={onSelectEvent}
                    />
                ) : (
                    <ContinuationBlock
                        key={occurrence.occurrenceKey}
                        occurrence={occurrence}
                        color={folderColors[occurrence.folderUid]}
                        dayStart={dayStart}
                        onSelect={onSelectEvent}
                    />
                ),
            )}
        </div>
    );
}

function TimeSlot({ start, onSelectSlot }: { start: Date; onSelectSlot: (start: Date, end: Date, anchor: EventAnchor) => void }) {
    const { setNodeRef, isOver } = useDroppable({ id: slotDropId(start) });
    return (
        <button
            ref={setNodeRef}
            type="button"
            onClick={(e) => onSelectSlot(start, addMinutes(start, SLOT_MINUTES), anchorOf(e.currentTarget))}
            style={{ height: HOUR_HEIGHT_PX / 2 }}
            className={["block w-full border-b border-border/50 text-left", isOver ? "bg-primary/10" : ""].join(" ")}
            aria-label={`New event at ${format(start, "h:mm a, MMM d")}`}
        />
    );
}

/** A block's position within its day column. A multi-day event is drawn in every day column it
 * overlaps, clipped to that day. */
function blockGeometry(occurrence: CalendarOccurrence, dayStart: Date): { top: number; height: number } {
    const visibleStart = Math.max(new Date(occurrence.startDate).getTime(), dayStart.getTime());
    const visibleEnd = Math.min(new Date(occurrence.endDate).getTime(), addDays(dayStart, 1).getTime());
    return {
        top: ((visibleStart - dayStart.getTime()) / 60_000 / 60) * HOUR_HEIGHT_PX,
        height: Math.max(((visibleEnd - visibleStart) / 60_000 / 60) * HOUR_HEIGHT_PX, 16),
    };
}

/** A multi-day event's block in a day column after its first: clickable, but not draggable/resizable
 * (its drag ids are already taken by the start day's block). */
function ContinuationBlock({
    occurrence,
    color,
    dayStart,
    onSelect,
}: {
    occurrence: CalendarOccurrence;
    color: string;
    dayStart: Date;
    onSelect: (occurrence: CalendarOccurrence) => void;
}) {
    const isFree = occurrence.busyStatus === "free";
    const { top, height } = blockGeometry(occurrence, dayStart);
    return (
        <div
            onClick={() => onSelect(occurrence)}
            style={{ position: "absolute", top, height, left: 2, right: 2, ...(isFree ? undefined : { backgroundColor: color, color: "#fff" }) }}
            className={["rounded-sm px-1.5 py-0.5 text-xs text-left overflow-hidden cursor-pointer", isFree ? "bg-surface-alt text-text-muted" : ""].join(" ")}
        >
            <div className="font-medium truncate">{occurrence.title}</div>
        </div>
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
    const { top, height } = blockGeometry(occurrence, dayStart);
    // The resize handle's own drag position has no live pixel preview (it only applies its ns-resize
    // affordance) — the actual new end time is computed from whichever slot it's dropped onto (see
    // `resolveDragAction`'s "resize" case), snapped to the grid rather than following the pointer
    // continuously. Simpler, and avoids a visual preview that could disagree with the snapped result.

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
