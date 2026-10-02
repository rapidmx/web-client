///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { KeyboardEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { addMinutes, format, isToday, startOfDay } from "date-fns";
import { dayDropId, eventDragId, resizeDragId, slotDropId } from "../../../../lib/calendar/calendarDragIds.js";
import { CalendarOccurrence } from "../../../../lib/calendar/recurrence.js";
import { occursOnDay, startsOnDay } from "./allDay.js";
import { occurrenceMarker, useActiveOccurrenceKey } from "./activeOccurrence.js";
import { EventAnchor, anchorOf } from "./EventShell.js";
import { HOUR_HEIGHT_PX, Lane, SLOTS_PER_DAY, SLOT_MINUTES, blockSpan, laneStyle, layoutLanes, slotStart } from "./gridLayout.js";

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
    const activeKey = useActiveOccurrenceKey();

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
                                .map((occ) => {
                                    const marker = occurrenceMarker(activeKey, occ);
                                    return (
                                        <button
                                            key={occ.occurrenceKey}
                                            type="button"
                                            {...marker.attrs}
                                            onClick={() => onSelectEvent(occ)}
                                            style={{ backgroundColor: folderColors[occ.folderUid], color: "#fff" }}
                                            className={["text-xs text-left truncate rounded-sm px-1.5 py-0.5", marker.className].join(" ")}
                                        >
                                            {occ.title}
                                        </button>
                                    );
                                })}
                        </div>
                    ))}
                </div>
            )}
            <div className="flex flex-1">
                <div className="w-14 shrink-0">
                    {HOURS.map((hour) => (
                        // Each label sits on its hour line, raised by half its own height with `relative`/`-top-1.5`: a negative margin here would
                        // also shorten the row, and the labels would drift up a little more with every hour (48px lines, 42px labels).
                        <div key={hour} style={{ height: HOUR_HEIGHT_PX }} className="relative -top-1.5 text-[10px] text-text-muted text-right pr-1.5">
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
    // Events that overlap in time share the column's width instead of covering one another.
    const lanes = layoutLanes(occurrences.map((occurrence) => blockSpan(new Date(occurrence.startDate).getTime(), new Date(occurrence.endDate).getTime(), dayStart)));

    return (
        <div className={["flex-1 min-w-0 relative border-l border-border", isToday(day) ? "bg-primary/5" : ""].join(" ")}>
            {Array.from({ length: SLOTS_PER_DAY }, (_, i) => (
                <TimeSlot key={i} start={slotStart(dayStart, i)} onSelectSlot={onSelectSlot} />
            ))}
            {occurrences.map((occurrence, index) =>
                startsOnDay(occurrence, day) ? (
                    <EventBlock
                        key={occurrence.occurrenceKey}
                        occurrence={occurrence}
                        color={folderColors[occurrence.folderUid]}
                        dayStart={dayStart}
                        lane={lanes[index]}
                        onSelect={onSelectEvent}
                    />
                ) : (
                    <ContinuationBlock
                        key={occurrence.occurrenceKey}
                        occurrence={occurrence}
                        color={folderColors[occurrence.folderUid]}
                        dayStart={dayStart}
                        lane={lanes[index]}
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
            // 48 of these a day would be hundreds of tab stops in a week: the New event shortcut is the keyboard's way in.
            tabIndex={-1}
            onClick={(e) => onSelectSlot(start, addMinutes(start, SLOT_MINUTES), anchorOf(e.currentTarget))}
            style={{ height: HOUR_HEIGHT_PX / 2 }}
            className={["block w-full border-b border-border/50 text-left", isOver ? "bg-primary/10" : ""].join(" ")}
            aria-label={`New event at ${format(start, "h:mm a, MMM d")}`}
        />
    );
}

/** Enter or Space on a focused event block opens the event, as a click does (the blocks are not `<button>`s: they hold a nested resize handle). */
function openOnKey(event: KeyboardEvent<HTMLElement>, open: () => void) {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        open();
    }
}

/** A block's position within its day column. A multi-day event is drawn in every day column it
 * overlaps, clipped to that day. */
function blockGeometry(occurrence: CalendarOccurrence, dayStart: Date): { top: number; height: number } {
    return blockSpan(new Date(occurrence.startDate).getTime(), new Date(occurrence.endDate).getTime(), dayStart);
}

/** A multi-day event's block in a day column after its first: clickable, but not draggable/resizable
 * (its drag ids are already taken by the start day's block). */
function ContinuationBlock({
    occurrence,
    color,
    dayStart,
    lane,
    onSelect,
}: {
    occurrence: CalendarOccurrence;
    color: string;
    dayStart: Date;
    lane: Lane;
    onSelect: (occurrence: CalendarOccurrence) => void;
}) {
    const isFree = occurrence.busyStatus === "free";
    const { top, height } = blockGeometry(occurrence, dayStart);
    const marker = occurrenceMarker(useActiveOccurrenceKey(), occurrence);
    return (
        <div
            {...marker.attrs}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(occurrence)}
            onKeyDown={(e) => openOnKey(e, () => onSelect(occurrence))}
            style={{ position: "absolute", top, height, ...laneStyle(lane), ...(isFree ? undefined : { backgroundColor: color, color: "#fff" }) }}
            className={["rounded-sm px-1.5 py-0.5 text-xs text-left overflow-hidden cursor-pointer", isFree ? "bg-surface-alt text-text-muted" : "", marker.className].join(" ")}
        >
            <div className="font-medium truncate">{occurrence.title}</div>
        </div>
    );
}

function EventBlock({
    occurrence,
    color,
    dayStart,
    lane,
    onSelect,
}: {
    occurrence: CalendarOccurrence;
    /** This occurrence's calendar color — see `calendarColors.ts`. Only applied for a "busy" block; a
     * "free" one keeps Outlook's own muted/outline treatment regardless of which calendar it's on. */
    color: string;
    dayStart: Date;
    /** Its share of the column's width, when other events overlap it in time. */
    lane: Lane;
    onSelect: (occurrence: CalendarOccurrence) => void;
}) {
    const { setNodeRef, listeners, attributes, transform, isDragging } = useDraggable({ id: eventDragId(occurrence) });
    const { setNodeRef: setResizeRef, listeners: resizeListeners, attributes: resizeAttributes } = useDraggable({
        id: resizeDragId(occurrence),
    });
    const isFree = occurrence.busyStatus === "free";

    const start = new Date(occurrence.startDate);
    const { top, height } = blockGeometry(occurrence, dayStart);
    const marker = occurrenceMarker(useActiveOccurrenceKey(), occurrence);
    // The resize handle's own drag position has no live pixel preview (it only applies its ns-resize
    // affordance) — the actual new end time is computed from whichever slot it's dropped onto (see
    // `resolveDragAction`'s "resize" case), snapped to the grid rather than following the pointer
    // continuously. Simpler, and avoids a visual preview that could disagree with the snapped result.

    return (
        <div
            ref={setNodeRef}
            {...marker.attrs}
            onClick={() => onSelect(occurrence)}
            style={{
                position: "absolute",
                top,
                height,
                ...laneStyle(lane),
                transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
                zIndex: isDragging ? 10 : undefined,
                ...(isFree ? undefined : { backgroundColor: color, color: "#fff" }),
            }}
            className={[
                "rounded-sm px-1.5 py-0.5 text-xs text-left overflow-hidden cursor-pointer",
                isFree ? "bg-surface-alt text-text-muted" : "",
                isDragging ? "opacity-50" : "",
                marker.className,
            ].join(" ")}
            {...listeners}
            {...attributes}
            onKeyDown={(e) => openOnKey(e, () => onSelect(occurrence))}
        >
            <div className="font-medium truncate">{occurrence.title}</div>
            <div className="truncate">{format(start, "h:mma")}</div>
            <div
                ref={setResizeRef}
                className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize"
                aria-label={`Resize "${occurrence.title}"`}
                {...resizeListeners}
                {...resizeAttributes}
                // Dragging is the only way to resize: a tab stop here would do nothing.
                tabIndex={-1}
            />
        </div>
    );
}
