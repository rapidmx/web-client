///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { parseISO } from "date-fns";

const MS_PER_DAY = 86_400_000;

/**
 * The stored value of a date-only due date (a `yyyy-MM-dd` day from a date input): UTC midnight of that day, so the task is due on the same
 * calendar day for everyone, whatever zone they read it in - the way an all-day event is stored. (The creator's local midnight would be a
 * different day for a reader in another zone.)
 */
export function dueDateInstant(dateKey: string): string {
    return `${dateKey}T00:00:00.000Z`;
}

/**
 * A task's `dueDate` as a local `Date`. An exact UTC midnight is a date-only due date (see `dueDateInstant()`) and reads as the start of that
 * calendar day wherever the reader is; any other instant - a time on the day, or a date-only value an older version stored as the creator's local
 * midnight - is that instant itself. (`parseISO()` rather than `new Date()`: a bare `yyyy-MM-dd` would be read as UTC.)
 */
export function parseDueDate(value: string): Date {
    const instant = parseISO(value);
    if (instant.getTime() % MS_PER_DAY !== 0) {
        return instant;
    }
    return new Date(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
}
