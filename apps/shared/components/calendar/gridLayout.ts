///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { addDays } from "date-fns";

/** Where things sit in the hour grids of the Week, Work Week, Day and Split views: 24 rows of one clock hour each. */
export const HOUR_HEIGHT_PX = 48;
export const SLOT_MINUTES = 30;
export const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;
/** The least height a block is drawn with, so a very short event can still be seen and clicked. */
export const MIN_BLOCK_HEIGHT_PX = 16;

/** Minutes after midnight on the wall clock (the local zone) at `ms`. */
function wallMinutes(ms: number): number {
    const date = new Date(ms);
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

/**
 * The start of the `index`th half-hour row of the day beginning at `dayStart`, by the wall clock - the rows are labelled with clock hours, so on the
 * day a daylight-saving change makes 23 or 25 hours long the row labelled 10 AM must still be 10:00, not ten hours after midnight. (A row whose
 * clock time does not exist that day is the next one that does.)
 */
export function slotStart(dayStart: Date, index: number): Date {
    return new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), 0, index * SLOT_MINUTES);
}

/**
 * Where a block for an event from `startMs` to `endMs` goes in the column of the day beginning at `dayStart`: a multi-day event is clipped to the day,
 * and (`wholeDay`, for an all-day event) fills it. Positioned by wall-clock minute, like the rows, so a block lines up with its hour on a 23 or 25
 * hour day too.
 */
export function blockSpan(startMs: number, endMs: number, dayStart: Date, wholeDay = false): { top: number; height: number } {
    const dayEnd = addDays(dayStart, 1).getTime();
    const from = wholeDay || startMs < dayStart.getTime() ? 0 : wallMinutes(startMs);
    const to = wholeDay || endMs >= dayEnd ? 24 * 60 : wallMinutes(endMs);
    return {
        top: (from / 60) * HOUR_HEIGHT_PX,
        height: Math.max(((to - from) / 60) * HOUR_HEIGHT_PX, MIN_BLOCK_HEIGHT_PX),
    };
}

/** One block's share of the width of its column: the lane it sits in, out of how many its overlapping neighbours need. */
export interface Lane {
    lane: number;
    lanes: number;
}

/**
 * Splits a column's width between blocks that overlap in time, as Outlook and Google Calendar do, so none is hidden behind another: blocks that
 * overlap (directly or through a chain of others) form a group, and within it each takes the first lane that is free when it starts. Every block of a
 * group gets the group's lane count; a block that overlaps nothing is alone in one lane (the whole width). Results are in the order of `spans`.
 */
export function layoutLanes(spans: { top: number; height: number }[]): Lane[] {
    const lanes: Lane[] = spans.map(() => ({ lane: 0, lanes: 1 }));
    const order = spans.map((_, index) => index).sort((a, b) => spans[a].top - spans[b].top || spans[b].height - spans[a].height);
    let group: number[] = [];
    let groupEnd = Number.NEGATIVE_INFINITY;
    let laneEnds: number[] = [];
    const closeGroup = () => {
        for (const index of group) {
            lanes[index].lanes = laneEnds.length;
        }
        group = [];
        laneEnds = [];
    };
    for (const index of order) {
        const { top, height } = spans[index];
        if (top >= groupEnd) {
            closeGroup();
            groupEnd = Number.NEGATIVE_INFINITY;
        }
        let lane = laneEnds.findIndex((end) => end <= top);
        if (lane === -1) {
            lane = laneEnds.length;
            laneEnds.push(top + height);
        } else {
            laneEnds[lane] = top + height;
        }
        lanes[index].lane = lane;
        group.push(index);
        groupEnd = Math.max(groupEnd, top + height);
    }
    closeGroup();
    return lanes;
}

/** The horizontal placement of a block in its column: the whole width less a 2px margin, or its lane's share of it. */
export function laneStyle({ lane, lanes }: Lane): { left: string | number; width?: string; right?: number } {
    return lanes === 1
        ? { left: 2, right: 2 }
        : { left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` };
}
