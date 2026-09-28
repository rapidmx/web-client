///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Client wrapper for `@rapidmx/restapi`'s `BaseSearchRoute` (mounted at `/mail/search` — see
 * `src/mongo/routes/SearchRoute.ts`/`src/sql/routes/SearchRoute.ts`), the full-text search endpoint across
 * a mailbox's messages/contacts/calendar events/notes/tasks. Scoped server-side to the caller's own mailbox
 * unless an optional `mailboxUid` (one the caller can access, e.g. the currently open shared mailbox) is
 * passed.
 *
 * The structured filter params below mirror `specs/search.md` §14's operator grammar
 * (`from:`/`to:`/`cc:`/`subject:`/`has:attachment`/`before:`/`after:`/`in:`/`is:`/`label:`), already parsed
 * out of raw query text by `queryGrammar.ts`'s `parseSearchQuery()` — this module only ever sends the
 * already-structured result, matching `BaseSearchRoute`'s own query-param names exactly
 * (`from`/`to`/`cc`/`subject`/`hasAttachment`/`before`/`after`/`in`/`is`/`label`).
 */
import { ApiClient, withClient } from "../util/api.js";

export type SearchEntityType = "message" | "contact" | "calendarEvent" | "note" | "task";

/** Which tier produced a result. Only `"server"` is possible until Tier 2 (local index) and Tier 3
 * (server-assisted narrowing) exist — kept as its own type now so a future client-side tier doesn't need
 * a breaking change to `SearchResult`. */
export type SearchResultSource = "server" | "local" | "candidate";

export interface SearchResult {
    entityType: SearchEntityType;
    entityUid: string;
    score: number;
    /** A short, provider-generated snippet highlighting the matched text, if supported. */
    snippet?: string;
    /** True when `score` is derived from server-visible metadata only (participants/date, not content —
     * always the case for an encrypted message) and is therefore not comparable to a result scored from
     * full content. See `searchScoring.ts` for how this is handled once mixed-source merging exists. */
    metadataOnly?: boolean;
    /** Which tier produced this result. Always `"server"` from this function today. */
    source?: SearchResultSource;
}

export interface SearchResultPage {
    results: SearchResult[];
    /** Opaque cursor to pass back as `cursor` to retrieve the next page, if more results exist. */
    nextCursor?: string;
}

export interface SearchParams {
    types?: SearchEntityType[];
    cursor?: string;
    limit?: number;
    /** `from:` — sender address. */
    from?: string;
    /** `to:` — a recipient address in the `To` line. */
    to?: string;
    /** `cc:` — a recipient address in the `Cc` line. */
    cc?: string;
    /** `subject:` — restricts matching to the subject/title field only. May be combined with free text. */
    subject?: string;
    /** `has:attachment` */
    hasAttachment?: boolean;
    /** `before:` */
    before?: Date;
    /** `after:` */
    after?: Date;
    /** `in:` — folder or calendar uid. */
    folderUid?: string;
    /** `is:` — one or more flag/state strings, matched as an AND (all must be present). */
    flags?: string[];
    /** `label:` — one or more `Label.uid`s, matched as an AND (all must be present). */
    labels?: string[];
    /** Which of the caller's accessible mailboxes to search (e.g. the one currently open). Omitted, the
     * server falls back to the caller's own mailbox; access to a supplied one is checked server-side. */
    mailboxUid?: string;
}

/** Exported so `admin/matterSearchApi.ts` can build the identical query-param set against a different
 * base path (`escrow/matter-search`, plus its own required `matterId`) — `BaseMatterSearchRoute` reuses
 * this exact same query-param grammar verbatim, per its own doc comment. */
export function buildSearchParams(text: string, params: SearchParams): URLSearchParams {
    const query = new URLSearchParams({ q: text });
    if (params.types?.length) {
        query.set("types", params.types.join(","));
    }
    if (params.cursor) {
        query.set("cursor", params.cursor);
    }
    if (params.limit) {
        query.set("limit", String(params.limit));
    }
    if (params.from) {
        query.set("from", params.from);
    }
    if (params.to) {
        query.set("to", params.to);
    }
    if (params.cc) {
        query.set("cc", params.cc);
    }
    if (params.subject) {
        query.set("subject", params.subject);
    }
    if (params.hasAttachment !== undefined) {
        query.set("hasAttachment", String(params.hasAttachment));
    }
    if (params.before) {
        query.set("before", params.before.toISOString());
    }
    if (params.after) {
        query.set("after", params.after.toISOString());
    }
    if (params.folderUid) {
        query.set("in", params.folderUid);
    }
    if (params.flags?.length) {
        query.set("is", params.flags.join(","));
    }
    if (params.labels?.length) {
        query.set("label", params.labels.join(","));
    }
    if (params.mailboxUid) {
        query.set("mailboxUid", params.mailboxUid);
    }
    return query;
}

export function search(text: string, params: SearchParams = {}, client?: ApiClient): Promise<SearchResultPage> {
    return withClient(client, `/mail/search?${buildSearchParams(text, params).toString()}`);
}

/**
 * Requests a Tier 3 candidate set (`specs/search.md` §6/§12) — identifiers only, ranked purely on
 * server-visible metadata, never on `subject`/`body`/`attachmentText`. Not called anywhere yet (Tier 3 is
 * a separate, not-yet-built follow-on to this pass) — added now so that work doesn't need to revisit this
 * file's shape, since the underlying route (`BaseSearchRoute.candidates()`) is already shipped.
 */
export interface CandidateParams {
    types?: SearchEntityType[];
    /** Participant terms extracted from the query text, matched against server-visible envelope data
     * (`from`/`to`/`cc`/`participants`). */
    participants?: string[];
    before?: Date;
    after?: Date;
    folderUid?: string;
    flags?: string[];
    labels?: string[];
    limit?: number;
    cursor?: string;
    /** Same as `SearchParams.mailboxUid`. */
    mailboxUid?: string;
}

export interface CandidateResult {
    entityType: SearchEntityType;
    entityUid: string;
}

export interface CandidateResultPage {
    candidates: CandidateResult[];
    nextCursor?: string;
}

function buildCandidateParams(params: CandidateParams): URLSearchParams {
    const query = new URLSearchParams();
    if (params.types?.length) {
        query.set("types", params.types.join(","));
    }
    if (params.participants?.length) {
        query.set("participants", params.participants.join(","));
    }
    if (params.before) {
        query.set("before", params.before.toISOString());
    }
    if (params.after) {
        query.set("after", params.after.toISOString());
    }
    if (params.folderUid) {
        query.set("in", params.folderUid);
    }
    if (params.flags?.length) {
        query.set("is", params.flags.join(","));
    }
    if (params.labels?.length) {
        query.set("label", params.labels.join(","));
    }
    if (params.cursor) {
        query.set("cursor", params.cursor);
    }
    if (params.limit) {
        query.set("limit", String(params.limit));
    }
    if (params.mailboxUid) {
        query.set("mailboxUid", params.mailboxUid);
    }
    return query;
}

export function candidates(params: CandidateParams = {}, client?: ApiClient): Promise<CandidateResultPage> {
    return withClient(client, `/mail/search/candidates?${buildCandidateParams(params).toString()}`);
}
