///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** What `mergeFirstPage()` made of a fresh first page and the rows already on screen. */
export interface MergedPage<T> {
    /** The rows to show. */
    rows: T[];
    /** How many of the fresh page's rows were not on screen yet - the mail that arrived since. */
    added: number;
    /** `true` when `rows` is exactly the fresh page, because the whole listing fits on it. */
    complete: boolean;
}

/**
 * Folds a freshly fetched first page of a list into the rows already loaded (the first page plus whatever "load more"
 * added), for the quiet refresh that follows a push event or a poll - so new mail appears without the list being reset,
 * re-scrolled or re-selected the way a full reload would.
 *
 * - A page shorter than `pageSize` is the whole listing, so it simply replaces what is shown - which also drops what was
 * deleted or moved elsewhere.
 * - A full page is only the top of a longer listing. Its rows go first, in the server's order, followed by the loaded rows
 * it did not repeat (older ones the reader has scrolled to). What was removed elsewhere from a long, partly loaded list
 * stays until the next real load; nothing here can tell it from a row that merely slid off the first page.
 * - A row in both keeps whichever copy `pick` prefers - by default the fresh one - so, for messages, a row the reader has
 * just changed (a higher `version`) is not put back by a fetch that started before the change landed.
 */
export function mergeFirstPage<T>(
    current: T[],
    fresh: T[],
    idOf: (row: T) => string,
    pageSize: number,
    pick: (current: T, fresh: T) => T = (_current, next) => next,
): MergedPage<T> {
    const currentById = new Map(current.map((row) => [idOf(row), row]));
    const added = fresh.filter((row) => !currentById.has(idOf(row))).length;
    const rows = fresh.map((row) => {
        const existing = currentById.get(idOf(row));
        return existing ? pick(existing, row) : row;
    });
    if (fresh.length < pageSize) {
        return { rows, added, complete: true };
    }
    const freshIds = new Set(fresh.map(idOf));
    return { rows: [...rows, ...current.filter((row) => !freshIds.has(idOf(row)))], added, complete: false };
}
