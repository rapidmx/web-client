///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrapper over `@rapidmx/restapi`'s eDiscovery Matter-scoped search (`BaseMatterSearchRoute`,
 * mounted at `escrow/matter-search`) — holder-gated (`requireEscrowHolder()` against the matter's own
 * `escrowScopeId`). Lives under `admin/` only because that's where every other Matter/Escrow-family
 * wrapper in this package lives — consumed exclusively by `apps/escrow`.
 *
 * Reuses the exact same query-param grammar/shape `search/searchApi.ts`'s own `search()` already speaks
 * (`SearchParams`/`buildSearchParams()`) — this route is a fan-out of the same underlying
 * `SearchProvider`, once per the matter's own custodian mailboxes, not a new search capability. `before`/
 * `after` are always clamped server-side to the matter's own date range, regardless of what's supplied.
 * There is no merged cross-mailbox ranking or cursor-based pagination — the response is keyed by
 * `mailboxUid`, one page per custodian, matching how a holder-facing review UI groups results anyway.
 */
import { ApiClient, withClient } from "../util/api.js";
import { SearchParams, SearchResultPage, buildSearchParams } from "../search/searchApi.js";

export type { SearchParams, SearchResultPage };

/** `client`, given below, is an explicit `ApiClient` from `createApiClient()` (e.g. one account of a multi-account
 * app) to call instead of the default global `apiFetch()` - see `withClient()`'s own doc comment in `util/api.ts`.
 * Omitted (the default), this behaves exactly as before. */
export function searchMatter(
    matterId: string,
    text: string,
    params: SearchParams = {},
    client?: ApiClient,
): Promise<Record<string, SearchResultPage>> {
    const query = buildSearchParams(text, params);
    query.set("matterId", matterId);
    return withClient(client, `/escrow/matter-search?${query.toString()}`);
}
