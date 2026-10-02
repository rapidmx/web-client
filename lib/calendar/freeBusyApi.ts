///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** The client of `@rapidmx/restapi`'s `POST /mail/calendar-events/free-busy` - when other people are busy, for an event dialog's "Find a time" - and the
 * small pure helpers that turn its answer into what a grid and a list of suggested times need.
 *
 * What the server tells about a person is only ever when they are busy, never why: no title, place, guest or id. And for some people it tells nothing at
 * all, which is not the same as telling they are free: `"unknown"` is a person the server has no calendar for (an external address, or a calendar too big
 * to read) and `"restricted"` is one who chose not to share their free/busy with the caller (`Mailbox.freeBusyVisibility`). Every helper here treats both
 * as *not known to be free* - they are never counted as available, and never make a time "free for everyone". */

import { ApiClient, withClient } from "../util/api.js";

/** The most addresses one request may ask about. */
export const FREE_BUSY_MAX_ADDRESSES = 50;
/** The longest window one request may ask about, in days. */
export const FREE_BUSY_MAX_DAYS = 31;

/** `"available"`: the server read the person's calendar (`busy` is what it found). `"unknown"`: it has no information. `"restricted"`: they hide it from you. */
export type FreeBusyStatus = "available" | "unknown" | "restricted";

/** One stretch of busy time, as the server sends it (UTC ISO 8601, sorted, merged and clipped to the window). */
export interface FreeBusyWindow {
    start: string;
    end: string;
    /** Only tentatively busy (a tentative event, or an invitation not yet answered firmly). */
    tentative: boolean;
}

export interface FreeBusyResult {
    address: string;
    status: FreeBusyStatus;
    /** Empty unless `status` is `"available"`. */
    busy: FreeBusyWindow[];
}

export interface FreeBusyResponse {
    start: string;
    end: string;
    /** One result per address asked, in the order asked. */
    results: FreeBusyResult[];
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */
/**
 * When the people at `addresses` (1 to `FREE_BUSY_MAX_ADDRESSES`) are busy between `start` and `end` (at most `FREE_BUSY_MAX_DAYS` days). The caller's own
 * mailboxes are always answered as available with their real busy time. Rejects with an `ApiRequestError`: 400 for a bad request, 401 when signed out,
 * 429 when asked too often (60 a minute).
 */
export function getFreeBusy(addresses: string[], start: Date | string, end: Date | string, client?: ApiClient): Promise<FreeBusyResponse> {
    return withClient(client, "/mail/calendar-events/free-busy", {
        method: "POST",
        body: JSON.stringify({
            addresses,
            start: typeof start === "string" ? start : start.toISOString(),
            end: typeof end === "string" ? end : end.toISOString(),
        }),
    });
}

/** A stretch of busy time as milliseconds since the epoch. */
export interface BusyBlock {
    startMs: number;
    endMs: number;
    tentative: boolean;
}

/** What is known about one person's time. */
export interface PersonAvailability {
    address: string;
    status: FreeBusyStatus;
    busy: BusyBlock[];
}

/** What a person's calendar says about a stretch of time. `"unknown"` is any person the server did not (or would not) tell about - never free. */
export type AvailabilityState = "free" | "tentative" | "busy" | "unknown";

/** The response's results with their times as milliseconds (a person who isn't `"available"` has no blocks whatever the server sent). A window
 * whose start or end can't be read is busy for all time - never silently free, which is what comparing `NaN` would make it. */
export function availabilityOf(response: FreeBusyResponse): PersonAvailability[] {
    return response.results.map((result) => ({
        address: result.address,
        status: result.status,
        busy: result.status === "available" ? result.busy.map(toBusyBlock) : [],
    }));
}

function toBusyBlock(window: { start: string; end: string; tentative: boolean }): BusyBlock {
    const startMs = Date.parse(window.start);
    const endMs = Date.parse(window.end);
    return Number.isFinite(startMs) && Number.isFinite(endMs)
        ? { startMs, endMs, tentative: window.tentative }
        : { startMs: Number.NEGATIVE_INFINITY, endMs: Number.POSITIVE_INFINITY, tentative: window.tentative };
}

/** Whether a block overlaps the stretch from `startMs` to `endMs` (touching ends do not overlap). */
function overlaps(block: BusyBlock, startMs: number, endMs: number): boolean {
    return block.startMs < endMs && block.endMs > startMs;
}

/** What `person` is between `startMs` and `endMs`: `"busy"` when a firm block overlaps, else `"tentative"` when a tentative one does, else `"free"` - and
 * `"unknown"`, whatever the blocks, for a person who isn't `"available"`. */
export function availabilityDuring(person: PersonAvailability, startMs: number, endMs: number): AvailabilityState {
    if (person.status !== "available") {
        return "unknown";
    }
    const overlapping = person.busy.filter((block) => overlaps(block, startMs, endMs));
    if (overlapping.some((block) => !block.tentative)) {
        return "busy";
    }
    return overlapping.length > 0 ? "tentative" : "free";
}

/** How a stretch of time stands for a group. */
export interface AvailabilitySummary {
    /** People known to be busy for some of it (firm or tentative). */
    conflicts: number;
    /** Of those, the ones only tentatively busy. */
    tentative: number;
    /** People nothing is known about (external, too big, or hiding their calendar): not counted as free, not counted as conflicts. */
    unknown: number;
    /** People known to be free for all of it. */
    free: number;
}

export function summarizeAvailability(people: PersonAvailability[], startMs: number, endMs: number): AvailabilitySummary {
    const summary: AvailabilitySummary = { conflicts: 0, tentative: 0, unknown: 0, free: 0 };
    for (const person of people) {
        const state = availabilityDuring(person, startMs, endMs);
        if (state === "unknown") {
            summary.unknown++;
        } else if (state === "free") {
            summary.free++;
        } else {
            summary.conflicts++;
            if (state === "tentative") {
                summary.tentative++;
            }
        }
    }
    return summary;
}

/**
 * `people` without the blocks that are exactly the stretch from `startMs` to `endMs`, for the addresses in `addresses` (lower case): what an event that is
 * being rescheduled takes up on the calendars of the people already invited to it - which would otherwise show as everyone's conflict with itself. Only an
 * exact match goes, so a block that the server merged with a neighbouring or overlapping event stays (a conflict shown, never one hidden).
 */
export function withoutOwnBlock(people: PersonAvailability[], addresses: Set<string>, startMs: number, endMs: number): PersonAvailability[] {
    return people.map((person) =>
        addresses.has(person.address.toLowerCase())
            ? { ...person, busy: person.busy.filter((block) => block.startMs !== startMs || block.endMs !== endMs) }
            : person,
    );
}

export interface SuggestTimesOptions {
    /** The stretches a meeting may fall in (e.g. each day's 8:00 to 18:00), in any order. A slot lies wholly inside one. */
    windows: { startMs: number; endMs: number }[];
    /** How long the meeting is. */
    durationMs: number;
    /** How far apart slots start, from a window's start (default 30 minutes). */
    stepMs?: number;
    /** How many to find (default 5). */
    limit?: number;
    /** No slot starts before this (e.g. now). */
    notBeforeMs?: number;
}

const DEFAULT_STEP_MS = 30 * 60_000;
/** The finest step `suggestTimes()` takes: a zero or negative one would never advance, a tiny one would test millions of slots. */
const MIN_STEP_MS = 60_000;
const DEFAULT_SUGGESTIONS = 5;

/**
 * The start times (ms) of the first `limit` slots of `durationMs` inside `windows` where everyone known is free - no firm or tentative block overlaps it.
 * People who are `"unknown"` or `"restricted"` cannot be checked and so do not constrain the answer (a caller says so next to the suggestions); with nobody
 * known at all there is nothing to base a suggestion on and the answer is empty.
 */
export function suggestTimes(people: PersonAvailability[], options: SuggestTimesOptions): number[] {
    const known = people.filter((person) => person.status === "available");
    if (known.length === 0 || options.durationMs <= 0) {
        return [];
    }
    const step = Number.isFinite(options.stepMs) ? Math.max(MIN_STEP_MS, options.stepMs!) : DEFAULT_STEP_MS;
    const limit = options.limit ?? DEFAULT_SUGGESTIONS;
    const found: number[] = [];
    for (const window of [...options.windows].sort((a, b) => a.startMs - b.startMs)) {
        for (let start = window.startMs; start + options.durationMs <= window.endMs; start += step) {
            if (start < (options.notBeforeMs ?? Number.NEGATIVE_INFINITY)) {
                continue;
            }
            if (known.every((person) => availabilityDuring(person, start, start + options.durationMs) === "free")) {
                found.push(start);
                if (found.length >= limit) {
                    return found;
                }
            }
        }
    }
    return found;
}
