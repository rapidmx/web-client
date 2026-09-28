///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * `@dnd-kit/core` identifies draggables/droppables purely by string id — this module owns the
 * encoding scheme for calendar drag ids and, more importantly, `resolveDragAction()`: a pure
 * function turning a drag-end's (active id, over id) pair into "move this occurrence by N ms" or
 * "resize this occurrence's end to this instant", *without* touching `@dnd-kit` itself. Kept pure and
 * dependency-free from the grid components on purpose: `@dnd-kit`'s pointer-based drag sensors are
 * awkward to drive from jsdom in tests (they need real `PointerEvent`/`getBoundingClientRect`
 * behavior a headless DOM doesn't fully provide), but the *decision* a drag-end makes is ordinary
 * data-in-data-out logic that's trivial to unit test directly — see `calendarDragIds.test.ts`. The
 * grid views (`MonthView`/`TimeGridView`) only need to tag their draggable/droppable elements with
 * these ids correctly; the calendar page's `onDragEnd` calls `resolveDragAction` and then one of
 * `calendarMutations.ts`'s `moveOccurrence`/`resizeOccurrenceEnd`.
 */

import { CalendarOccurrence } from "./recurrence.js";

const DAY_ID_PREFIX = "day:";
const SLOT_ID_PREFIX = "slot:";
const RESIZE_ID_PREFIX = "resize:";

/**
 * A month-view day cell's droppable id, for the given day (any time-of-day on that calendar date) —
 * encoded as the runtime's *local* `yyyy-MM-dd`, matching the local-midnight day dates the grid views
 * build via `date-fns`.
 */
export function dayDropId(date: Date): string {
    const yyyy = String(date.getFullYear()).padStart(4, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${DAY_ID_PREFIX}${yyyy}-${mm}-${dd}`;
}

/** A week/day-view time slot's droppable id, rounded to the given date-time instant. */
export function slotDropId(date: Date): string {
    return `${SLOT_ID_PREFIX}${date.toISOString()}`;
}

/** An event chip/block's draggable id (drag-to-move). */
export function eventDragId(occurrence: CalendarOccurrence): string {
    return occurrence.occurrenceKey;
}

/** An event block's resize-handle draggable id (drag-to-resize, week/day view only). */
export function resizeDragId(occurrence: CalendarOccurrence): string {
    return `${RESIZE_ID_PREFIX}${occurrence.occurrenceKey}`;
}

export type DragAction =
    | { type: "move"; occurrence: CalendarOccurrence; deltaMs: number }
    | { type: "resize"; occurrence: CalendarOccurrence; newEnd: Date };

/**
 * Resolves a `@dnd-kit` drag-end's `active`/`over` ids into the action it represents, or `null` if
 * the drop doesn't correspond to anything actionable (dropped outside any droppable, or the dragged
 * id doesn't match any occurrence currently on the grid — e.g. it was removed by an in-flight reload
 * mid-drag).
 */
export function resolveDragAction(
    activeId: string,
    overId: string | undefined,
    occurrences: CalendarOccurrence[],
): DragAction | null {
    if (!overId) {
        return null;
    }

    const isResize = activeId.startsWith(RESIZE_ID_PREFIX);
    const occurrenceKey = isResize ? activeId.slice(RESIZE_ID_PREFIX.length) : activeId;
    const occurrence = occurrences.find((o) => o.occurrenceKey === occurrenceKey);
    if (!occurrence) {
        return null;
    }

    if (isResize) {
        if (!overId.startsWith(SLOT_ID_PREFIX)) {
            return null;
        }
        return { type: "resize", occurrence, newEnd: new Date(overId.slice(SLOT_ID_PREFIX.length)) };
    }

    if (overId.startsWith(DAY_ID_PREFIX)) {
        // Moving a timed event to another day keeps the occurrence's local wall-clock start time, so the delta is
        // "same local time on the target day" minus the original start — a whole number of calendar
        // days, which is not always a multiple of 24h when the move crosses a DST change.
        const [year, month, day] = overId.slice(DAY_ID_PREFIX.length).split("-").map(Number);
        // An all-day event's start is a UTC-midnight date-only value, so its target is that calendar date's
        // UTC midnight - never "the same local time", which west of UTC reads the stored midnight as the
        // previous evening and lands the event a day late.
        const source = new Date(occurrence.startDate);
        const target = new Date(source.getTime());
        if (occurrence.allDay) {
            target.setTime(Date.UTC(year, month - 1, day));
        } else {
            target.setFullYear(year, month - 1, day);
        }
        if (Number.isNaN(target.getTime())) {
            return null;
        }
        return { type: "move", occurrence, deltaMs: target.getTime() - source.getTime() };
    }

    if (overId.startsWith(SLOT_ID_PREFIX)) {
        const targetSlot = new Date(overId.slice(SLOT_ID_PREFIX.length));
        return { type: "move", occurrence, deltaMs: targetSlot.getTime() - new Date(occurrence.startDate).getTime() };
    }

    return null;
}
