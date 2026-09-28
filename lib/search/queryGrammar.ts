///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Parses `specs/search.md` §14's light operator syntax (`from:`, `to:`, `cc:`, `subject:`,
 * `has:attachment`, `before:`, `after:`, `in:`, `is:`, `label:`, `type:`) out of a raw search box
 * string, once, client-side — per the spec's own requirement that parsing happen in exactly one place
 * so every tier (server Tier 1 today; a future local Tier 2/3) interprets the grammar identically.
 *
 * Only the *operator* tokens are extracted. Everything else — plain words, quoted phrases, a leading
 * `-` negating a term — is left untouched in the returned `text` remainder, because each provider's own
 * free-text engine already understands that syntax natively (`specs/search.md` §14's own "Provider
 * Implementation": Postgres's `websearch_to_tsquery` handles quoted phrases, `OR`, and `-` negation
 * safely on untrusted input). Rewriting that ourselves would just be a worse reimplementation of what
 * the provider already does correctly.
 *
 * An operator token is only recognized when it starts at a word boundary (start of string, or after
 * whitespace) — `-from:bob` therefore is NOT parsed as a negated operator (the operator fields
 * `BaseSearchRoute` accepts are single-value/AND-only with no negated form) and is left in `text`
 * verbatim, and a deliberately-quoted phrase like `"from:bob"` is never mistaken for the operator
 * either, since the match requires an *unquoted* key immediately followed by `:`.
 */
import { SearchEntityType } from "./searchApi.js";

export interface ParsedSearchQuery {
    /** The remaining free-text portion — quotes, `-` negation, and `OR` preserved verbatim for each
     * provider's own free-text engine to interpret. Never rewritten by this parser beyond removing the
     * operator tokens themselves and collapsing the whitespace that leaves behind. */
    text: string;
    /** `from:` — sender address or display name. */
    from?: string;
    /** `to:` — a recipient address. */
    to?: string;
    /** `cc:` — a recipient address. */
    cc?: string;
    /** `subject:` — restricts matching to the subject/title field. */
    subject?: string;
    /** `has:attachment` */
    hasAttachment?: boolean;
    /** `before:` — parsed via `new Date()`; an unparseable value is left in `text` rather than dropped. */
    before?: Date;
    /** `after:` — see `before`. */
    after?: Date;
    /** `in:` — folder or calendar uid. */
    folderUid?: string;
    /** `is:` — one or more flag/state strings (`is:read`, repeated `is:` tokens, or a single
     * comma-separated `is:read,flagged` token all accumulate into this array). */
    flags?: string[];
    /** `label:` — one or more `Label.uid`s. Same repeat/comma-separation rules as `flags`. */
    labels?: string[];
    /** `type:` — maps to `SearchQuery.entityTypes`. An unrecognized type token is dropped rather than
     * forwarded, since the server has no representation for anything outside `SearchEntityType`. */
    entityTypes?: SearchEntityType[];
}

const VALID_ENTITY_TYPES: ReadonlySet<string> = new Set<SearchEntityType>(["message", "contact", "calendarEvent", "note", "task"]);

/** Finds and removes the first `key:value`/`key:"quoted value"` occurrence of `key` in `input`, where
 * `value` is either a quoted phrase or a run of non-whitespace characters. Returns `undefined` for
 * `value` (and `input` unchanged as `rest`) when no such token exists. The matched span is replaced by
 * the single whitespace character that preceded it (or removed entirely at start-of-string), so
 * `removeRange` never joins two words together — final whitespace collapsing happens once, in
 * `parseSearchQuery()` itself, after every extraction has run. */
function extractFirst(input: string, key: string): { value?: string; rest: string } {
    const pattern = new RegExp(`(^|\\s)${key}:(?:"([^"]*)"|(\\S+))`, "i");
    const match = pattern.exec(input);
    if (!match) {
        return { rest: input };
    }
    const value = match[2] ?? match[3] ?? "";
    const rest = input.slice(0, match.index) + match[1] + input.slice(match.index + match[0].length);
    return { value, rest };
}

/** Repeatedly applies `extractFirst()` for `key` until no more occurrences remain, splitting any
 * comma-separated value into individual entries — so `is:read is:flagged` and `is:read,flagged` both
 * produce `["read", "flagged"]`. */
function extractAll(input: string, key: string): { values: string[]; rest: string } {
    const values: string[] = [];
    let rest = input;
    for (;;) {
        const result = extractFirst(rest, key);
        if (result.value === undefined) {
            return { values, rest };
        }
        rest = result.rest;
        for (const part of result.value.split(",")) {
            const trimmed = part.trim();
            if (trimmed) {
                values.push(trimmed);
            }
        }
    }
}

/** Removes the exact literal token `has:attachment` (case-insensitively), the one compound keyword the
 * spec defines for this operator — there is no `has:<other value>` form. */
function extractHasAttachment(input: string): { found: boolean; rest: string } {
    const pattern = /(^|\s)has:attachment\b/i;
    const match = pattern.exec(input);
    if (!match) {
        return { found: false, rest: input };
    }
    return { found: true, rest: input.slice(0, match.index) + match[1] + input.slice(match.index + match[0].length) };
}

/** Local midnight on `year`-`month`-`day`, or an Invalid Date when that calendar date doesn't exist
 * (e.g. `2026-02-30`, which the `Date` constructor would otherwise silently roll over into March). */
function localDate(year: number, month: number, day: number): Date {
    const date = new Date(year, month - 1, day);
    date.setFullYear(year);
    return date.getMonth() === month - 1 && date.getDate() === day ? date : new Date(Number.NaN);
}

function extractDate(input: string, key: string): { date?: Date; rest: string } {
    const { value, rest } = extractFirst(input, key);
    if (value === undefined) {
        return { rest: input };
    }
    // A date-only `yyyy-MM-dd` value means local midnight on that day (what a user typing `before:2026-01-02`
    // means) — `new Date("2026-01-02")` alone would parse it as UTC midnight per the ECMAScript spec.
    // Anything else (a full ISO date-time, with or without an offset) is left to `new Date()` as-is.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const date = dateOnly ? localDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])) : new Date(value);
    if (Number.isNaN(date.getTime())) {
        // Unparseable — leave the whole token in the free-text remainder rather than silently dropping
        // it, mirroring BaseSearchRoute's own parseDateParam() leniency (invalid date -> undefined).
        return { rest: input };
    }
    return { date, rest };
}

export function parseSearchQuery(raw: string): ParsedSearchQuery {
    let rest = raw;

    const from = extractFirst(rest, "from");
    rest = from.rest;
    const to = extractFirst(rest, "to");
    rest = to.rest;
    const cc = extractFirst(rest, "cc");
    rest = cc.rest;
    const subject = extractFirst(rest, "subject");
    rest = subject.rest;
    const folder = extractFirst(rest, "in");
    rest = folder.rest;

    const hasAttachment = extractHasAttachment(rest);
    rest = hasAttachment.rest;

    const before = extractDate(rest, "before");
    rest = before.rest;
    const after = extractDate(rest, "after");
    rest = after.rest;

    const flags = extractAll(rest, "is");
    rest = flags.rest;
    const labels = extractAll(rest, "label");
    rest = labels.rest;
    const types = extractAll(rest, "type");
    rest = types.rest;

    const entityTypes = types.values.filter((t): t is SearchEntityType => VALID_ENTITY_TYPES.has(t));

    return {
        text: rest.replace(/\s+/g, " ").trim(),
        from: from.value,
        to: to.value,
        cc: cc.value,
        subject: subject.value,
        hasAttachment: hasAttachment.found ? true : undefined,
        before: before.date,
        after: after.date,
        folderUid: folder.value,
        flags: flags.values.length > 0 ? flags.values : undefined,
        labels: labels.values.length > 0 ? labels.values : undefined,
        entityTypes: entityTypes.length > 0 ? entityTypes : undefined,
    };
}
