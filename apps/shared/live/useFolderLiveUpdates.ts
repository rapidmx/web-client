///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useRef } from "react";
import { getPushClient, type PushEvent } from "../../../lib/mail/pushClient.js";

/** An item a push event says was created, changed or deleted: its uid, and whether it is gone. */
export interface FolderItemChange {
    uid: string;
    deleted: boolean;
}

/**
 * The item a push event says was created, changed or deleted, when the event's `type` - the published model class name (`ContactMongo`,
 * `TaskSQL`, ...) - matches `model`, or `undefined` for anything else the shared push connection delivers. Only the uid is taken: the payload
 * is whatever every subscriber of the folder may see (a private calendar event's busy block), so a page fetches the item again by its uid.
 */
export function changedItemOf(event: PushEvent, model: RegExp): FolderItemChange | undefined {
    if (!model.test(event.type) || (event.action !== "create" && event.action !== "update" && event.action !== "delete")) {
        return undefined;
    }
    const data = event.data as { uid?: unknown } | null | undefined;
    return typeof data?.uid === "string" ? { uid: data.uid, deleted: event.action === "delete" } : undefined;
}

/**
 * Keeps a page's folders live: while the page is mounted the tab's push connection is subscribed to `folderUids` (under the page's own
 * `group` - see `PushClient.setChannels()`; Mail's connection subscribes to mail folders only, so nothing else asks for a calendar,
 * contacts or tasks folder), and `onChange` is called with every item `parse` recognizes - created, changed or deleted anywhere: another
 * tab, a phone over ActiveSync, the server itself. `onChange` may change between renders; the latest is called.
 */
export function useFolderLiveUpdates(
    group: string,
    folderUids: readonly string[],
    parse: (event: PushEvent) => FolderItemChange | undefined,
    onChange: (change: FolderItemChange) => void,
): void {
    const key = [...new Set(folderUids)].sort().join(",");
    useEffect(() => {
        const client = getPushClient();
        client.setChannels(key ? key.split(",") : [], group);
        client.start();
        return () => client.setChannels([], group);
    }, [group, key]);

    const latest = useRef({ parse, onChange });
    latest.current = { parse, onChange };
    useEffect(
        () =>
            getPushClient().onEvent((event) => {
                const change = latest.current.parse(event);
                if (change) {
                    latest.current.onChange(change);
                }
            }),
        [],
    );
}
