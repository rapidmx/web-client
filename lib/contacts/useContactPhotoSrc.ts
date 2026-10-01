///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import type { ApiClient } from "../util/api.js";
import { type Contact, contactPhotoUrl, fetchContactPhoto } from "./contactsApi.js";

/** How many pictures stay loaded (as `blob:` URLs) after nothing shows them any more, so a list scrolled back over does not fetch them all again. */
const CACHE_LIMIT = 50;

interface Entry {
    url: string;
    /** How many mounted avatars show this URL; it is never revoked while that is more than none. */
    refs: number;
}

/** Least recently used first (a `Map` iterates in insertion order, and a use moves the entry to the end). */
const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<string>>();
const clientIds = new WeakMap<ApiClient, number>();
let nextClientId = 0;

/** One key per picture of one account: the same uid never collides across the clients of a multi-account app, and a replaced picture (new version) is a new key. */
function keyOf(client: ApiClient, uid: string, version: number): string {
    let id = clientIds.get(client);
    if (id === undefined) {
        id = nextClientId++;
        clientIds.set(client, id);
    }
    return `${id}:${uid}:${version}`;
}

/** Revokes the pictures beyond the limit that nothing shows, oldest first. */
function trim(): void {
    for (const [key, entry] of entries) {
        if (entries.size <= CACHE_LIMIT) {
            return;
        }
        if (entry.refs === 0) {
            URL.revokeObjectURL(entry.url);
            entries.delete(key);
        }
    }
}

/** The `blob:` URL for `key`, fetched with `load` unless it is cached, and counted as shown until `release()`. Concurrent callers share one fetch. */
async function acquire(key: string, load: () => Promise<Blob>): Promise<string> {
    let entry = entries.get(key);
    if (!entry) {
        let request = pending.get(key);
        if (!request) {
            request = load()
                .then((blob) => {
                    const url = URL.createObjectURL(blob);
                    entries.set(key, { url, refs: 0 });
                    return url;
                })
                .finally(() => pending.delete(key));
            pending.set(key, request);
        }
        await request;
        entry = entries.get(key)!;
    }
    entry.refs++;
    entries.delete(key);
    entries.set(key, entry);
    return entry.url;
}

function release(key: string): void {
    const entry = entries.get(key);
    if (entry) {
        entry.refs--;
    }
    trim();
}

/** Forgets every cached picture (and revokes its URL). For a test, or when an account is signed out. */
export function clearContactPhotoCache(): void {
    for (const entry of entries.values()) {
        URL.revokeObjectURL(entry.url);
    }
    entries.clear();
}

/**
 * What to put in an `<img src>` for a contact's own picture, or `undefined` when they have none, it is still loading or it could not be loaded (the avatar
 * then shows initials). Without an explicit `client` that is the plain `contactPhotoUrl()`: the browser sends the `jwt` cookie with the request. A
 * token-authenticated client (the desktop and mobile apps) cannot do that - an `<img>` sends no `Authorization` header - so the picture is fetched through the client
 * and shown as a `blob:` URL, cached per client, contact and version with a small LRU and revoked once it falls out of it and nothing shows it.
 */
export function useContactPhotoSrc(contact: Pick<Contact, "uid" | "version" | "photoBlobKey"> | undefined, client?: ApiClient): string | undefined {
    const [loaded, setLoaded] = useState<{ key: string; url: string } | undefined>();
    const key = client && contact?.photoBlobKey ? keyOf(client, contact.uid, contact.version) : undefined;
    const uid = contact?.uid;
    const version = contact?.version;

    useEffect(() => {
        if (!key || !client) {
            return;
        }
        let cancelled = false;
        let held = false;
        acquire(key, () => fetchContactPhoto(uid!, version!, client)).then(
            (url) => {
                if (cancelled) {
                    release(key);
                } else {
                    held = true;
                    setLoaded({ key, url });
                }
            },
            () => undefined,
        );
        return () => {
            cancelled = true;
            if (held) {
                release(key);
            }
        };
    }, [key]);

    if (client) {
        return key !== undefined && loaded?.key === key ? loaded.url : undefined;
    }
    return contact && contactPhotoUrl(contact);
}
