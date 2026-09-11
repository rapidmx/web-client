///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { addMinutes, format, isSameDay, startOfDay } from "date-fns";
import { CalendarOccurrence } from "@rapidmx/react-shared/recurrence.js";

const HOUR_HEIGHT_PX = 48;
const SLOT_MINUTES = 30;
const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export interface SplitDayColumn {
    folderUid: string;
    name: string;
    color: string;
}

export interface SplitDayViewProps {
    day: Date;
    columns: SplitDayColumn[];
    /** Already expanded for `day` — see `recurrence.ts`'s `expandAllOccurrences`. Not pre-filtered by
     * calendar; this component splits them into columns itself by `occurrence.folderUid`. */
    occurrences: CalendarOccurrence[];
    onSelectEvent: (occurrence: CalendarOccurrence) => void;
    /** Click on an empty slot in one calendar's column — the calendar it belongs to is `folderUid`. */
    onSelectSlot: (start: Date, end: Date, folderUid: string) => void;
}

/**
 * Outlook's "Split" view: one column per checked calendar, all showing the same single day, so
 * events across calendars can be compared side by side. A deliberately separate component from
 * `TimeGridView` rather than a generalization of it — it shares that component's visual language
 * (same hour rail, same slot height) but is genuinely simpler in one respect: no drag-to-move/resize.
 * Dragging an event between calendar columns would mean reassigning its `folderUid`, a real feature
 * `moveOccurrence`/`resolveDragAction` don't support today; rather than bolt that on, this view is
 * click-only (select an event, or click a slot to create one already targeted at that column's
 * calendar) — a practical scope cut, not an oversight.
 */
export default function SplitDayView({ day, columns, occurrences, onSelectEvent, onSelectSlot }: SplitDayViewProps) {
    const dayOccurrences = occurrences.filter((occ) => isSameDay(new Date(occ.startDate), day));
    const dayStart = startOfDay(day);

    return (
        <div role="region" aria-label="Split view" className="flex-1 flex flex-col min-h-0 overflow-y-auto">
            <div className="flex border-b border-border shrink-0">
                <div className="w-14 shrink-0" />
                {columns.map((col) => (
                    <div key={col.folderUid} className="flex-1 min-w-0 py-1 flex items-center justify-center gap-1.5 border-l border-border">
                        <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                        <span className="text-xs font-semibold truncate">{col.name}</span>
                    </div>
                ))}
            </div>
            <div className="flex flex-1">
                <div className="w-14 shrink-0">
                    {HOURS.map((hour) => (
                        <div key={hour} style={{ height: HOUR_HEIGHT_PX }} className="text-[10px] text-text-muted text-right pr-1.5 -mt-1.5">
                            {hour === 0 ? "" : format(new Date(2000, 0, 1, hour), "ha")}
                        </div>
                    ))}
                </div>
                {columns.map((col) => (
                    <SplitColumn
                        key={col.folderUid}
                        column={col}
                        dayStart={dayStart}
                        occurrences={dayOccurrences.filter((occ) => occ.folderUid === col.folderUid)}
                        onSelectEvent={onSelectEvent}
                        onSelectSlot={onSelectSlot}
                    />
                ))}
            </div>
        </div>
    );
}

function SplitColumn({
    column,
    dayStart,
    occurrences,
    onSelectEvent,
    onSelectSlot,
}: {
    column: SplitDayColumn;
    dayStart: Date;
    occurrences: CalendarOccurrence[];
    onSelectEvent: (occurrence: CalendarOccurrence) => void;
    onSelectSlot: (start: Date, end: Date, folderUid: string) => void;
}) {
    return (
        <div className="flex-1 min-w-0 relative border-l border-border">
            {Array.from({ length: SLOTS_PER_DAY }, (_, i) => {
                const slotStart = addMinutes(dayStart, i * SLOT_MINUTES);
                return (
                    <button
                        key={i}
                        type="button"
                        onClick={() => onSelectSlot(slotStart, addMinutes(slotStart, SLOT_MINUTES), column.folderUid)}
                        style={{ height: HOUR_HEIGHT_PX / 2 }}
                        className="block w-full border-b border-border/50 text-left"
                        aria-label={`New event at ${format(slotStart, "h:mm a")} in ${column.name}`}
                    />
                );
            })}
            {occurrences.map((occurrence) => {
                const start = new Date(occurrence.startDate);
                const end = new Date(occurrence.endDate);
                const top = ((start.getTime() - dayStart.getTime()) / 60_000 / 60) * HOUR_HEIGHT_PX;
                const height = Math.max(((end.getTime() - start.getTime()) / 60_000 / 60) * HOUR_HEIGHT_PX, 16);
                const isFree = occurrence.busyStatus === "free";
                return (
                    <div
                        key={occurrence.occurrenceKey}
                        onClick={() => onSelectEvent(occurrence)}
                        style={{
                            position: "absolute",
                            top,
                            height,
                            left: 2,
                            right: 2,
                            ...(isFree ? undefined : { backgroundColor: column.color, color: "#fff" }),
                        }}
                        className={[
                            "rounded-sm px-1.5 py-0.5 text-xs text-left overflow-hidden cursor-pointer",
                            isFree ? "bg-surface-alt text-text-muted" : "",
                        ].join(" ")}
                    >
                        <div className="font-medium truncate">{occurrence.title}</div>
                        <div className="truncate">{format(start, "h:mma")}</div>
                    </div>
                );
            })}
        </div>
    );
}
