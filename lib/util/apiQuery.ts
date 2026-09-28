///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The pagination query-string convention shared by every `*Api.ts` wrapper (`mailApi.ts`,
 * `contactsApi.ts`, `tasksApi.ts`, `calendarApi.ts`) — split out of `mailApi.ts` once more than one of
 * them needed it, rather than each reimplementing it or importing it from `mailApi.ts` for no reason
 * other than it happening to live there first.
 */

export interface ListParams {
    page?: number;
    limit?: number;
}

const DEFAULT_PAGE_SIZE = 25;

/**
 * Builds a `limit`/`page` query string, plus any extra scope/filter params (e.g. `folderUid`,
 * or one of `@rapidmx/restapi`'s generic query-operator values like `startDate=lte(...)`).
 */
export function buildQuery(params: ListParams, extra: Record<string, string> = {}): string {
    const parts: string[] = [`limit=${params.limit ?? DEFAULT_PAGE_SIZE}`, `page=${params.page ?? 0}`];
    for (const [key, value] of Object.entries(extra)) {
        parts.push(`${key}=${encodeURIComponent(value)}`);
    }
    return parts.join("&");
}

/**
 * Optional paging/scope params for the async-request list endpoints (`listExportRequests()`,
 * `listImportRequests()`, `listErasureRequests()`, `listMatterExportRequests()`,
 * `listAccessRequests()`). Server contract: newest first, `limit` capped at 500, `page` zero-based,
 * `matterId` honored only by the Matter-scoped (escrow) endpoints.
 */
export interface RequestListParams extends ListParams {
    /** Restricts the list to one Matter - only meaningful for Matter-scoped request lists. */
    matterId?: string;
}

/**
 * Builds a `?limit=&page=&matterId=` suffix from only the params actually supplied - unlike
 * `buildQuery()`, applies no default page size (these endpoints historically returned every request
 * with no params at all, so a caller passing nothing keeps that exact request). Returns `""` when no
 * param is set.
 */
export function buildRequestListQuery(params: RequestListParams = {}): string {
    const query = new URLSearchParams();
    if (params.limit !== undefined) {
        query.set("limit", String(params.limit));
    }
    if (params.page !== undefined) {
        query.set("page", String(params.page));
    }
    if (params.matterId) {
        query.set("matterId", params.matterId);
    }
    const encoded = query.toString();
    return encoded ? `?${encoded}` : "";
}
