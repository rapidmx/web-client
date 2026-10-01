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
/** Fetches in flight, and how many avatars are waiting on each (they are all counted as showing the picture the moment it is stored). */
const pending = new Map<string, { request: Promise<string>; waiters: number }>();
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

/** How many pictures are fetched at once; a list of a hundred contacts must not open a hundred requests together. */
const MAX_CONCURRENT_FETCHES = 4;
let fetching = 0;
const waiting: (() => void)[] = [];

/** Runs `task` once fewer than `MAX_CONCURRENT_FETCHES` others are running, in the order asked. */
function limited<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const run = () => {
            task()
                .then(resolve, reject)
                .finally(() => {
                    // A waiting task takes over the slot; it is only given up when none waits.
                    const next = waiting.shift();
                    if (next) {
                        next();
                    } else {
                        fetching--;
                    }
                });
        };
        if (fetching < MAX_CONCURRENT_FETCHES) {
            fetching++;
            run();
        } else {
            waiting.push(run);
        }
    });
}

/** The `blob:` URL for `key`, fetched with `load` unless it is cached, and counted as shown until `release()`. Concurrent callers share one fetch. */
async function acquire(key: string, load: () => Promise<Blob>): Promise<string> {
    const entry = entries.get(key);
    if (entry) {
        entry.refs++;
        entries.delete(key);
        entries.set(key, entry);
        return entry.url;
    }
    let shared = pending.get(key);
    if (!shared) {
        const created: { request: Promise<string>; waiters: number } = {
            waiters: 0,
            request: limited(load)
                .then((blob) => {
                    const url = URL.createObjectURL(blob);
                    // Claimed by everyone waiting from the start: an entry nobody holds yet could be trimmed before its avatar got to it.
                    entries.set(key, { url, refs: created.waiters });
                    return url;
                })
                .finally(() => pending.delete(key)),
        };
        pending.set(key, created);
        shared = created;
    }
    shared.waiters++;
    return shared.request;
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
    return useContactPhoto(contact, client).src;
}

/**
 * `useContactPhotoSrc()`, also saying whether a picture that has to be fetched could not be (`failed`: no `src` is coming), and held back until `active` - an avatar
 * that is not on screen yet has no reason to fetch its picture.
 */
export function useContactPhoto(
    contact: Pick<Contact, "uid" | "version" | "photoBlobKey"> | undefined,
    client?: ApiClient,
    active = true,
): { src: string | undefined; failed: boolean } {
    const [loaded, setLoaded] = useState<{ key: string; url: string } | undefined>();
    const [failedKey, setFailedKey] = useState<string | undefined>();
    const key = active && client && contact?.photoBlobKey ? keyOf(client, contact.uid, contact.version) : undefined;
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
            () => !cancelled && setFailedKey(key),
        );
        return () => {
            cancelled = true;
            if (held) {
                release(key);
            }
        };
    }, [key]);

    if (client) {
        return { src: key !== undefined && loaded?.key === key ? loaded.url : undefined, failed: key !== undefined && failedKey === key };
    }
    return { src: contact && contactPhotoUrl(contact), failed: false };
}
