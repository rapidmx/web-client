///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Thin wrapper over this server's own Giphy search proxy (`src/routes/BaseGiphySearchRoute.ts`) —
 * never calls Giphy directly from the browser, since that would require shipping the API key in the
 * client bundle. See `GifPicker.tsx` for the UI this backs. */

import { ApiClient, withClient } from "../../util/api.js";

export interface GiphyGif {
    id: string;
    /** A small rendition, for the search grid's thumbnails. */
    previewUrl: string;
    /** The full-resolution GIF — inserted into the message body when chosen. */
    url: string;
    title: string;
}

/** An empty/blank `query` returns Giphy's trending feed (see the backend route's own doc comment). `client`,
 * given here, is an explicit `ApiClient` from `createApiClient()` (e.g. one account of a multi-account app) to
 * call instead of the default global `apiFetch()` - see `withClient()`'s own doc comment in `util/api.ts`.
 * Omitted (the default), this behaves exactly as before. */
export function searchGifs(query: string, client?: ApiClient): Promise<GiphyGif[]> {
    const params = new URLSearchParams();
    const trimmed = query.trim();
    if (trimmed) {
        params.set("q", trimmed);
    }
    return withClient(client, `/mail/giphy/search?${params.toString()}`);
}
