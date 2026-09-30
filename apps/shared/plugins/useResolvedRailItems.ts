///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import { type ApiClient, withClient } from "../../../lib/util/api.js";
import { useApiClient } from "../../../lib/util/apiClientContext.js";
import { type PluginUiNavItem, isSafePluginHref } from "./pluginNav.js";

/** Where each app-rail entry that is worked out per user points, by entry id: only the entries the server answered for are here. */
export type ResolvedRailLinks = Record<string, string>;

/**
 * Asks, once per signed-in user, for the entries of a plugin's app rail that are worked out per user (they name an API path in `resolveFrom` - the
 * meet plugin's "Meet" button is one: it shows only for a user who has a personal room, and links to it). Each path is requested through
 * `apiFetch()`; a `200` answering `{ href }` with a same-origin path puts that link in the result, and anything else (no such thing for this user, a
 * server error, an answer that is not a path on this site) leaves the entry out, so a failing plugin never breaks the rail. Entries with no
 * `resolveFrom` are not asked about. Nothing is requested without a signed-in user.
 */
export function useResolvedRailItems(items: PluginUiNavItem[] | undefined, userUid: string | undefined, client?: ApiClient): ResolvedRailLinks {
    const explicitClient = useApiClient();
    const [links, setLinks] = useState<ResolvedRailLinks>({});
    const asked = (items ?? []).filter((item) => typeof item?.resolveFrom === "string" && item.resolveFrom !== "");
    // A list that is the same entries again (a new array on each render) does not start over.
    const key = asked.map((item) => `${item.id}=${item.resolveFrom}`).join("|");

    useEffect(() => {
        if (!userUid || asked.length === 0) {
            setLinks({});
            return undefined;
        }
        let cancelled = false;
        void Promise.all(
            asked.map(async (item): Promise<[string, string] | null> => {
                try {
                    const answer = await withClient<{ href?: unknown }>(client ?? explicitClient, item.resolveFrom!);
                    return typeof answer?.href === "string" && isSafePluginHref(answer.href) ? [item.id, answer.href] : null;
                } catch {
                    return null;
                }
            }),
        ).then((results) => {
            if (!cancelled) {
                setLinks(Object.fromEntries(results.filter((entry): entry is [string, string] => entry !== null)));
            }
        });
        return () => {
            cancelled = true;
        };
        // `asked` is derived from `key`.
    }, [key, userUid, client, explicitClient]);

    return links;
}
