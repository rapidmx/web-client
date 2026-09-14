///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** Page size the list pages (Contacts, Tasks) request per call - restapi caps `limit` at 500. */
export const LIST_PAGE_SIZE = 500;

/** Safety cap on pages fetched - stops a server that ignores `page` (and keeps returning a full first
 * page) from looping forever. 40 pages x 500 = 20,000 items. */
export const MAX_LIST_PAGES = 40;

/**
 * Fetches every page of a zero-based `limit`/`page` list endpoint, stopping at the first short page
 * (fewer than `pageSize` items) - so a folder with more items than one page holds is shown in full
 * rather than silently cut off at the first page.
 */
export async function listAllPages<T>(
    fetchPage: (page: number) => Promise<T[]>,
    pageSize: number = LIST_PAGE_SIZE,
    maxPages: number = MAX_LIST_PAGES,
): Promise<T[]> {
    const all: T[] = [];
    for (let page = 0; page < maxPages; page++) {
        const batch = await fetchPage(page);
        all.push(...batch);
        if (batch.length < pageSize) {
            break;
        }
    }
    return all;
}
