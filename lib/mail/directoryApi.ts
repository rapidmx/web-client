///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s `BaseDirectoryRoute` - recipient suggestions for compose. `GET
 * /mail/directory` searches the server's mailboxes (people, shared mailboxes, rooms and equipment) and distribution
 * lists; `GET /mail/directory/contacts` searches the caller's own contacts; `GET /mail/directory/correspondents` searches
 * everyone the caller's mailboxes have exchanged mail or shared an event with, address book or not. All match every word of
 * the query against the start of a name word or of an address, and return only a display name, an address and a kind.
 */
import { ApiClient, ApiRequestError, withClient } from "../util/api.js";

/** What a suggestion names. `"contact"` comes from the caller's contacts, `"correspondent"` from the people they have written to, heard from or
 * met with, everything else from the server directory. */
export type RecipientSuggestionKind = "user" | "shared" | "room" | "equipment" | "list" | "contact" | "correspondent";

export interface RecipientSuggestion {
    displayName: string;
    address: string;
    kind: RecipientSuggestionKind;
}

/** The shortest trimmed query the server searches for - shorter ones resolve to `[]` without a request. */
export const RECIPIENT_SUGGESTION_MIN_QUERY_LENGTH = 2;
/** The longest query the server accepts; longer ones are cut to this length. */
export const RECIPIENT_SUGGESTION_MAX_QUERY_LENGTH = 100;
/** The server's own default and cap for `limit`. */
export const RECIPIENT_SUGGESTION_DEFAULT_LIMIT = 8;
export const RECIPIENT_SUGGESTION_MAX_LIMIT = 20;

export interface RecipientSuggestionOptions {
    /** At most this many entries (the server caps it at `RECIPIENT_SUGGESTION_MAX_LIMIT`). */
    limit?: number;
    /** Aborts the request, rejecting with the fetch's `AbortError`. */
    signal?: AbortSignal;
}

export interface ContactSuggestionOptions extends RecipientSuggestionOptions {
    /** Also search this mailbox's contacts (e.g. the shared mailbox being composed from) when the caller may read it.
     * The caller's own mailboxes are always searched. */
    mailboxUid?: string;
}

/** The trimmed query to send, or `undefined` when it's too short to search. */
function normalizeQuery(query: string): string | undefined {
    const trimmed = query.trim().slice(0, RECIPIENT_SUGGESTION_MAX_QUERY_LENGTH).trim();
    return trimmed.length >= RECIPIENT_SUGGESTION_MIN_QUERY_LENGTH ? trimmed : undefined;
}

/** Keeps only well-formed entries of a response. */
function wellFormed(body: unknown): RecipientSuggestion[] {
    return Array.isArray(body)
        ? body
              .filter((entry) => entry && typeof entry.address === "string" && entry.address.length > 0)
              .map((entry) => ({
                  displayName: typeof entry.displayName === "string" ? entry.displayName : "",
                  address: entry.address,
                  kind: entry.kind,
              }))
        : [];
}

async function fetchSuggestions(
    path: string,
    query: string,
    params: Record<string, string | undefined>,
    signal?: AbortSignal,
    client?: ApiClient,
): Promise<RecipientSuggestion[]> {
    const q = normalizeQuery(query);
    if (q === undefined) {
        return [];
    }
    const search = new URLSearchParams({ q });
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            search.set(key, value);
        }
    }
    return wellFormed(await withClient(client, `${path}?${search.toString()}`, signal ? { signal } : {}));
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */

/** Searches the server directory. Rejects with a 403 `ApiRequestError` for a caller without a mailbox on the server,
 * and a 429 one when the caller searches too often. */
export function searchDirectory(query: string, options: RecipientSuggestionOptions = {}, client?: ApiClient): Promise<RecipientSuggestion[]> {
    return fetchSuggestions("/mail/directory", query, { limit: options.limit?.toString() }, options.signal, client);
}

/** Searches the caller's contacts (every address of a contact whose name matches, or the addresses that match). */
export function searchContactSuggestions(
    query: string,
    options: ContactSuggestionOptions = {},
    client?: ApiClient,
): Promise<RecipientSuggestion[]> {
    return fetchSuggestions(
        "/mail/directory/contacts",
        query,
        { limit: options.limit?.toString(), mailboxUid: options.mailboxUid },
        options.signal,
        client,
    );
}

/** Searches the people the caller's mailboxes have exchanged mail or shared an event with, whether or not they are in the address book. Rejects like
 * `searchDirectory()`; a server that predates the endpoint answers 404, which `fetchRecipientSuggestions()` treats as "none". */
export function searchCorrespondents(query: string, options: ContactSuggestionOptions = {}, client?: ApiClient): Promise<RecipientSuggestion[]> {
    return fetchSuggestions(
        "/mail/directory/correspondents",
        query,
        { limit: options.limit?.toString(), mailboxUid: options.mailboxUid },
        options.signal,
        client,
    );
}

/** Contacts first, then directory entries, then the people the caller has corresponded with, without repeating an address (compared
 * case-insensitively; the first occurrence wins), at most `limit`. */
export function mergeRecipientSuggestions(
    contacts: RecipientSuggestion[],
    directory: RecipientSuggestion[],
    limit: number = RECIPIENT_SUGGESTION_DEFAULT_LIMIT,
    correspondents: RecipientSuggestion[] = [],
): RecipientSuggestion[] {
    const seen = new Set<string>();
    const result: RecipientSuggestion[] = [];
    for (const entry of [...contacts, ...directory, ...correspondents]) {
        const key = entry.address.trim().toLowerCase();
        if (result.length >= limit) {
            break;
        }
        if (!seen.has(key)) {
            seen.add(key);
            result.push(entry);
        }
    }
    return result;
}

function isAbort(error: unknown): boolean {
    return (error as { name?: string } | undefined)?.name === "AbortError";
}

/**
 * Contacts, directory and correspondent suggestions for `query`, merged by `mergeRecipientSuggestions()`. Any source failing (a 403
 * directory for a caller with no mailbox here, a 429, a network error, a server without the correspondents endpoint) still returns
 * the others' entries; only when the contacts and the directory both fail does this reject, with the contacts error - the
 * correspondents are a bonus and never turn a working search into an error. An aborted `signal` always rejects with the `AbortError`.
 */
export async function fetchRecipientSuggestions(
    query: string,
    options: ContactSuggestionOptions = {},
    client?: ApiClient,
): Promise<RecipientSuggestion[]> {
    const limit = options.limit ?? RECIPIENT_SUGGESTION_DEFAULT_LIMIT;
    const [contacts, directory, correspondents] = await Promise.allSettled([
        searchContactSuggestions(query, { ...options, limit }, client),
        searchDirectory(query, { limit, signal: options.signal }, client),
        searchCorrespondents(query, { ...options, limit }, client),
    ]);
    for (const outcome of [contacts, directory, correspondents]) {
        if (outcome.status === "rejected" && isAbort(outcome.reason)) {
            throw outcome.reason;
        }
    }
    if (contacts.status === "rejected" && directory.status === "rejected") {
        throw contacts.reason instanceof Error ? contacts.reason : new ApiRequestError("Suggestions couldn't be loaded.", 0);
    }
    return mergeRecipientSuggestions(
        contacts.status === "fulfilled" ? contacts.value : [],
        directory.status === "fulfilled" ? directory.value : [],
        limit,
        correspondents.status === "fulfilled" ? correspondents.value : [],
    );
}
