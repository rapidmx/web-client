///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * RFC5545 recurrence expansion, entirely client-side — `@rapidmx/restapi` stores/returns
 * `RecurrenceRule` as-is and does no expansion of its own (see `calendarApi.ts`'s own header
 * comment). Built on the `rrule` package.
 */

// `rrule` ships a real ESM build (resolved by the client bundler via its own module graph, where
// named imports work normally) alongside a separate CJS build with no `"exports"` map (resolved by
// this framework's *server-side* render path via Node's own loader, which falls back to the CJS
// build since "module" is a bundler-only convention Node itself doesn't honor). Node's static
// named-export detection for that CJS build doesn't pick up `RRule` (confirmed directly: SSR-ing the
// calendar page threw "does not provide an export named 'RRule'"), so a plain named import breaks
// under SSR even though it works in the browser. A namespace import sidesteps the static check
// entirely; reading `.default` afterward reaches the same class via Node's CJS interop (`default`
// always aliases `module.exports` for a CJS module) without disturbing the ESM path, where `.default`
// simply doesn't exist and the direct named property is used instead.
import * as RRuleNS from "rrule";
import type { Weekday } from "rrule";
import { CalendarEvent, RecurrenceRule, WeekdayCode } from "./calendarApi.js";

/** Extracted so the CJS-interop fallback branch can be exercised directly with a plain object,
 * without needing to fight a module mock into reproducing Node's exact interop shape. */
export function resolveRRuleExport(ns: typeof RRuleNS): typeof RRuleNS.RRule {
    return ns.RRule ?? (ns as unknown as { default: typeof RRuleNS }).default.RRule;
}

const RRule = resolveRRuleExport(RRuleNS);

const FREQ_MAP: Record<RecurrenceRule["freq"], number> = {
    yearly: RRule.YEARLY,
    monthly: RRule.MONTHLY,
    weekly: RRule.WEEKLY,
    daily: RRule.DAILY,
};

// `RRule`'s own `.toText()` formatter requires actual `Weekday` instances in `byweekday` — passing the
// raw two-letter strings works for occurrence expansion (`.between()`) but throws inside `.toText()`
// (confirmed by reproducing it directly against this exact package version).
const WEEKDAY_OBJECT: Record<WeekdayCode, Weekday> = {
    MO: RRule.MO,
    TU: RRule.TU,
    WE: RRule.WE,
    TH: RRule.TH,
    FR: RRule.FR,
    SA: RRule.SA,
    SU: RRule.SU,
};

function createRRule(rule: RecurrenceRule, dtstart: Date, until: Date | null, tzid: string | null): RRuleNS.RRule {
    return new RRule({
        freq: FREQ_MAP[rule.freq],
        interval: rule.interval,
        dtstart,
        tzid,
        byweekday: rule.byDay?.map((code) => WEEKDAY_OBJECT[code]),
        bymonthday: rule.byMonthDay,
        bymonth: rule.byMonth,
        count: rule.count,
        until,
    });
}

/**
 * Builds an `RRule` instance from this app's `RecurrenceRule` shape, anchored at `dtstart`. Pass the
 * event's IANA `tzid` so the rule carries it (e.g. `DTSTART;TZID=America/New_York:...` from
 * `.toString()`) — note that, per `rrule`'s own convention, a rule with a non-UTC `tzid` expects
 * `dtstart` to be a "floating" wall-clock time expressed as a UTC `Date` and rezones its generated
 * dates using the *runtime's* local zone, which is why `expandOccurrences()` below does its own
 * timezone conversion instead of relying on this.
 */
export function buildRRule(rule: RecurrenceRule, dtstart: Date, tzid?: string): RRuleNS.RRule {
    return createRRule(rule, dtstart, rule.until ? new Date(rule.until) : null, tzid ?? null);
}

/**
 * Converts between real instants and "wall-clock as UTC" milliseconds (the local date/time fields of
 * an instant in some zone, packed into a UTC timestamp) — the standard floating-time trick for
 * running `rrule`, which does all of its date arithmetic in UTC fields, in an arbitrary zone.
 */
interface ZoneConverter {
    toWall(instantMs: number): number;
    fromWall(wallMs: number): number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function positiveMs(ms: number): number {
    return ((ms % 1000) + 1000) % 1000;
}

/** The runtime's own local zone — used for a "floating" event with no (or an unrecognized) timezone. */
const LOCAL_ZONE: ZoneConverter = {
    toWall(instantMs) {
        const d = new Date(instantMs);
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
    },
    fromWall(wallMs) {
        const w = new Date(wallMs);
        return new Date(
            w.getUTCFullYear(),
            w.getUTCMonth(),
            w.getUTCDate(),
            w.getUTCHours(),
            w.getUTCMinutes(),
            w.getUTCSeconds(),
            w.getUTCMilliseconds(),
        ).getTime();
    },
};

/** UTC itself - used for all-day events, whose dates are stored as UTC midnight (date-only values). */
const UTC_ZONE: ZoneConverter = {
    toWall: (instantMs) => instantMs,
    fromWall: (wallMs) => wallMs,
};

function ianaZone(formatter: Intl.DateTimeFormat): ZoneConverter {
    const toWall = (instantMs: number): number => {
        const fields: Record<string, number> = {};
        for (const part of formatter.formatToParts(new Date(instantMs))) {
            fields[part.type] = Number(part.value);
        }
        // `% 24`: some engines render midnight as hour "24" even with `hourCycle: "h23"`.
        return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour % 24, fields.minute, fields.second, positiveMs(instantMs));
    };
    return {
        toWall,
        // RFC 5545 §3.3.5 resolution against the offsets in effect a day before and a day after (zones
        // change offset at most once in that window): an ambiguous (fall-back) wall time resolves to its
        // first occurrence (the earlier instant); a nonexistent (spring-forward) one is interpreted with
        // the offset from *before* the transition, so 02:30 on a US spring-forward day becomes 03:30 EDT.
        fromWall(wallMs) {
            const offsetBefore = toWall(wallMs - MS_PER_DAY) - (wallMs - MS_PER_DAY);
            const offsetAfter = toWall(wallMs + MS_PER_DAY) - (wallMs + MS_PER_DAY);
            const valid = [wallMs - offsetBefore, wallMs - offsetAfter].filter((instant) => toWall(instant) === wallMs);
            return valid.length > 0 ? Math.min(...valid) : wallMs - offsetBefore;
        },
    };
}

const zoneCache = new Map<string, ZoneConverter>();

/** Resolves `timezone` (an IANA zone id) to a converter, falling back to the runtime's local zone when
 * it's empty or not a zone `Intl` recognizes. */
function resolveZone(timezone: string | undefined): ZoneConverter {
    const key = timezone ?? "";
    let zone = zoneCache.get(key);
    if (!zone) {
        try {
            zone = key
                ? ianaZone(
                      new Intl.DateTimeFormat("en-US", {
                          timeZone: key,
                          hourCycle: "h23",
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                      }),
                  )
                : LOCAL_ZONE;
        } catch {
            zone = LOCAL_ZONE;
        }
        zoneCache.set(key, zone);
    }
    return zone;
}

/** A single expanded occurrence of a (possibly recurring) `CalendarEvent`, ready to render on a grid. */
export interface CalendarOccurrence extends CalendarEvent {
    /** A key unique per occurrence (`${event.uid}::${occurrence start}`) — use this for React `key`s and
     * drag-and-drop ids, since a recurring event's `uid` alone isn't unique across its occurrences. */
    occurrenceKey: string;
    /** `true` for a generated occurrence of a recurring event (as opposed to the stored master record, or
     * a genuinely non-recurring event) — moving/resizing one calls `updateCalendarEvent` differently (see
     * the calendar page's own drag handlers) since it must detach into its own standalone event. */
    isRecurringOccurrence: boolean;
}

/**
 * Converts an instant to the "wall-clock as UTC" milliseconds recurrence expansion works in for an event
 * with this `timezone`/`allDay` - UTC for an all-day event (stored as UTC-midnight dates), the event's IANA
 * zone otherwise (the runtime's local zone when empty or unrecognized). Exported for `calendarMutations.ts`,
 * which shifts a series' exception dates by the same wall-clock delta as its start.
 */
export function toEventWallClock(instantMs: number, timezone: string | undefined, allDay: boolean | undefined): number {
    return (allDay ? UTC_ZONE : resolveZone(timezone)).toWall(instantMs);
}

/** Inverse of `toEventWallClock()` (DST gaps/overlaps resolved per RFC 5545 - see `ianaZone()`). */
export function fromEventWallClock(wallMs: number, timezone: string | undefined, allDay: boolean | undefined): number {
    return (allDay ? UTC_ZONE : resolveZone(timezone)).fromWall(wallMs);
}

/**
 * Expands `event` into every occurrence whose interval overlaps `[rangeStart, rangeEnd]`. A
 * non-recurring event yields itself (in a one-element array) if it overlaps, or `[]` otherwise —
 * callers don't need to special-case recurring vs. not.
 *
 * Recurrence is expanded in the event's own `timezone` (an IANA zone id; an empty or unrecognized
 * value falls back to the runtime's local zone, i.e. floating time), so every occurrence keeps the
 * master's local wall-clock start/end time and local weekday — a weekly Monday 23:00
 * America/New_York event stays on Monday 23:00 New York time across DST changes, rather than being
 * expanded on the UTC weekday/time of its first instance. An all-day event is the exception: its dates are
 * UTC-midnight date-only values, so it expands in UTC regardless of `timezone` - expanding a
 * `2026-09-14T00:00Z` Monday in America/New_York would otherwise see a Sunday-evening start and put every
 * occurrence on the wrong date. A timed occurrence that falls in a DST gap starts at the pre-transition
 * offset (RFC 5545) and keeps its wall-clock duration.
 */
export function expandOccurrences(event: CalendarEvent, rangeStart: Date, rangeEnd: Date): CalendarOccurrence[] {
    const start = new Date(event.startDate);
    const end = new Date(event.endDate);

    if (!event.recurrenceRule) {
        const overlaps = start < rangeEnd && end > rangeStart;
        return overlaps ? [{ ...event, occurrenceKey: event.uid, isRecurringOccurrence: false }] : [];
    }

    const zone = event.allDay ? UTC_ZONE : resolveZone(event.timezone);
    const startWall = zone.toWall(start.getTime());
    // The duration in wall-clock terms, so an occurrence also keeps its local end time across DST.
    const wallDurationMs = zone.toWall(end.getTime()) - startWall;
    const { until } = event.recurrenceRule;
    const rule = createRRule(
        event.recurrenceRule,
        new Date(startWall),
        until ? new Date(zone.toWall(new Date(until).getTime())) : null,
        null,
    );
    // Query in the wall-clock frame, widened by one occurrence's duration (so an occurrence that started
    // before `rangeStart` but is still in progress isn't missed) plus a day on each side to absorb the
    // zone's offset; the exact instant-based overlap filter at the end trims the excess.
    const queryStart = new Date(zone.toWall(rangeStart.getTime()) - wallDurationMs - MS_PER_DAY);
    const queryEnd = new Date(zone.toWall(rangeEnd.getTime()) + MS_PER_DAY);
    const occurrenceStarts = rule
        .between(queryStart, queryEnd, true)
        .map((occWall) => ({ start: new Date(zone.fromWall(occWall.getTime())), wall: occWall.getTime() }));
    const exceptions = new Set(event.recurrenceRule.exceptions.map((d) => new Date(d).getTime()));

    return occurrenceStarts
        .filter((occ) => !exceptions.has(occ.start.getTime()))
        .map(({ start: occStart, wall }) => {
            // Non-zero only when the start fell in a DST gap and was pushed forward - the end moves with it.
            const gapShiftMs = zone.toWall(occStart.getTime()) - wall;
            const occEnd = new Date(zone.fromWall(wall + gapShiftMs + wallDurationMs));
            return {
                ...event,
                startDate: occStart.toISOString(),
                endDate: occEnd.toISOString(),
                recurrenceId: occStart.toISOString(),
                occurrenceKey: `${event.uid}::${occStart.toISOString()}`,
                isRecurringOccurrence: true,
            };
        })
        .filter((occ) => new Date(occ.startDate) < rangeEnd && new Date(occ.endDate) > rangeStart);
}

/** Expands every event in `events` and flattens the result — the usual entry point for a grid view. */
export function expandAllOccurrences(events: CalendarEvent[], rangeStart: Date, rangeEnd: Date): CalendarOccurrence[] {
    return events.flatMap((event) => expandOccurrences(event, rangeStart, rangeEnd));
}

/** A human-readable summary of `rule` (e.g. "every 2 weeks on Monday, Wednesday until Jan 1, 2027"). */
export function describeRecurrence(rule: RecurrenceRule): string {
    const rrule = buildRRule(rule, new Date());
    return rrule.toText();
}

export const WEEKDAY_CODES: WeekdayCode[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const WEEKDAY_LABELS: Record<WeekdayCode, string> = {
    MO: "Mon",
    TU: "Tue",
    WE: "Wed",
    TH: "Thu",
    FR: "Fri",
    SA: "Sat",
    SU: "Sun",
};
