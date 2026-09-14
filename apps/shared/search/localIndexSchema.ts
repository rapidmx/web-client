///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The Tier 2 local index's SQLite schema (`specs/search.md` §13). One database per mailbox (see
 * `localIndexWorker.ts`), holding both the FTS5 index and the metadata cache in the same store - the
 * spec's own rationale for choosing SQLite over an in-memory JS index in the first place ("the index
 * database also holds the decrypted metadata cache... so there is one local store rather than two").
 *
 * Bumping `SCHEMA_VERSION` is how a schema change invalidates every existing local index (§11
 * "Invalidation... on schema version change") - `localIndexWorker.ts` compares it against `meta`'s
 * stored value on open and discards+rebuilds on a mismatch, the same path a corruption/GCM-auth-failure
 * takes.
 */

/** Bump whenever `CREATE_SCHEMA_SQL` changes in a way existing on-disk databases can't be reconciled
 * with in place. A mismatch deletes and recreates the whole database file (not just its rows), so
 * creation-time-only settings like `auto_vacuum` also apply to upgraded indexes.
 *
 * 2 - added `entities.entity_version` (incremental rebuild skip) and `auto_vacuum=INCREMENTAL`. */
export const SCHEMA_VERSION = 2;

/**
 * `entities` is the real row store (metadata + the plaintext content fields), `entities_fts` is an FTS5
 * *external content* table over it (`content='entities'`) - the standard SQLite pattern for keeping one
 * copy of the text instead of duplicating it into the FTS5 shadow tables, kept in sync via the three
 * triggers below (SQLite's own documented pattern for external-content FTS5 tables; there is no
 * "ON CONFLICT UPDATE re-index" primitive, so update is modeled as delete-then-reinsert into the FTS
 * index specifically, not into `entities` itself).
 *
 * Column order in `entities_fts` (`subject, participants, body, attachment_text`) is load-bearing: every
 * `bm25(entities_fts, 3.0, 2.0, 1.0, 1.0)` call elsewhere in this module family assumes that exact
 * positional order, matching `searchScoring.ts`'s `SEARCH_FIELD_WEIGHTS` (`subject: 3, participants: 2,
 * body: 1, attachmentText: 1`) so Tier 2's local ranking agrees with the Tier 1/Tier 3 re-scoring the
 * spec requires for one consistent ordering across tiers (§7).
 */
export const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS entities (
    rowid INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_uid TEXT NOT NULL UNIQUE,
    mailbox_uid TEXT NOT NULL,
    folder_uid TEXT,
    date_for_sort TEXT NOT NULL,
    participants TEXT,
    flags TEXT,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    subject TEXT,
    body TEXT,
    attachment_text TEXT,
    byte_size INTEGER NOT NULL DEFAULT 0,
    entity_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_entities_date ON entities(date_for_sort);
CREATE INDEX IF NOT EXISTS idx_entities_mailbox ON entities(mailbox_uid);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    subject, participants, body, attachment_text,
    content='entities', content_rowid='rowid', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts(rowid, subject, participants, body, attachment_text)
    VALUES (new.rowid, new.subject, new.participants, new.body, new.attachment_text);
END;

CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, subject, participants, body, attachment_text)
    VALUES ('delete', old.rowid, old.subject, old.participants, old.body, old.attachment_text);
END;

CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, subject, participants, body, attachment_text)
    VALUES ('delete', old.rowid, old.subject, old.participants, old.body, old.attachment_text);
    INSERT INTO entities_fts(rowid, subject, participants, body, attachment_text)
    VALUES (new.rowid, new.subject, new.participants, new.body, new.attachment_text);
END;
`;

/** The exact `bm25()` weight arguments every ranked query against `entities_fts` MUST pass, in column
 * order - see this module's own doc comment on why the order is load-bearing. Centralized here so a
 * future column reorder can't silently desync a query building its own literal weight list. */
export const BM25_WEIGHTS_SQL = "3.0, 2.0, 1.0, 1.0";

/** One message's decrypted content, ready to index - `localIndexBuilder.ts`'s own output shape, built
 * from `Message` + the recovered `MessageSecurityResult` fields the same way `searchTier3.ts` already
 * derives them for its own per-candidate matching. */
export interface LocalIndexEntity {
    entityType: "message";
    entityUid: string;
    mailboxUid: string;
    folderUid?: string;
    /** ISO 8601 - compares correctly as plain text since every value here is UTC. */
    dateForSort: string;
    participants: string;
    /** Comma-delimited, leading/trailing commas included (`,read,flagged,`) - simplest possible substring
     * match (`flags LIKE '%,read,%'`) without needing SQLite's JSON1 extension compiled in. */
    flags: string;
    hasAttachments: boolean;
    subject?: string;
    body?: string;
    attachmentText?: string;
    /** Rough on-disk cost of this entity's own content, in bytes - what `localIndexBuilder.ts`'s
     * byte-budget accounting (spec §11) sums against the configured budget. */
    byteSize: number;
    /** Opaque change marker for the source entity (the builder uses the message's `version` plus its
     * folder) - lets a rebuild skip re-fetching/decrypting anything already indexed unchanged. */
    entityVersion?: string;
}

/** `entity_uid` upsert - `ON CONFLICT` (SQLite's UPSERT syntax) rather than a separate delete-then-insert,
 * so re-indexing an already-present message (a flag changed, a folder move) updates it in place and the
 * `entities_au` trigger keeps `entities_fts` in sync automatically. */
export const UPSERT_ENTITY_SQL = `
INSERT INTO entities (entity_type, entity_uid, mailbox_uid, folder_uid, date_for_sort, participants, flags, has_attachments, subject, body, attachment_text, byte_size, entity_version)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(entity_uid) DO UPDATE SET
    folder_uid = excluded.folder_uid, date_for_sort = excluded.date_for_sort, participants = excluded.participants,
    flags = excluded.flags, has_attachments = excluded.has_attachments, subject = excluded.subject,
    body = excluded.body, attachment_text = excluded.attachment_text, byte_size = excluded.byte_size,
    entity_version = excluded.entity_version
`;

/** Bind values for `UPSERT_ENTITY_SQL`, in column order - kept alongside it so the two can never drift
 * out of sync with each other. */
export function entityBindValues(entity: LocalIndexEntity): (string | number)[] {
    return [
        entity.entityType,
        entity.entityUid,
        entity.mailboxUid,
        entity.folderUid ?? null!,
        entity.dateForSort,
        entity.participants,
        entity.flags,
        entity.hasAttachments ? 1 : 0,
        entity.subject ?? null!,
        entity.body ?? null!,
        entity.attachmentText ?? null!,
        entity.byteSize,
        entity.entityVersion ?? null!,
    ];
}

/** A parsed query's structured (non-free-text) fields - the subset of `ParsedSearchQuery`
 * (`react-shared`'s `queryGrammar.ts`) this module's predicate builder reads. Typed locally rather than
 * importing `ParsedSearchQuery` itself so this Worker-bundled module has no dependency on `@rapidmx/
 * react-shared` beyond what it actually uses - `localIndexBuilder.ts`/`searchTier2.ts` (main-thread side)
 * pass the real `ParsedSearchQuery` in, which structurally satisfies this. */
export interface LocalSearchPredicateFields {
    from?: string;
    to?: string;
    cc?: string;
    subject?: string;
    hasAttachment?: boolean;
    before?: Date;
    after?: Date;
    folderUid?: string;
    flags?: string[];
}

/**
 * Builds the SQL `WHERE` predicate (and its bind params) for every *structured* operator this local
 * index can actually evaluate. **Known simplification**: unlike Tier 1's server-side `SearchDocument`
 * (which splits `from`/`to`/`cc` into distinct fields - confirmed already implemented server-side), this
 * local schema keeps only the combined `participants` field (see `CREATE_SCHEMA_SQL`'s own doc comment) -
 * `from:`/`to:`/`cc:` are therefore evaluated here as a substring match against that combined field
 * rather than a precise per-role match. Reasonable for a bounded, best-effort recent-window cache
 * (Tier 1 already serves the precise version for anything it indexes), but a real gap if Tier 2 is later
 * extended to distinguish them - flagged here rather than left silently approximate.
 */
export function buildSearchPredicates(parsed: LocalSearchPredicateFields, mailboxUid: string): { where: string; params: (string | number)[] } {
    const clauses: string[] = ["e.mailbox_uid = ?"];
    const params: (string | number)[] = [mailboxUid];
    if (parsed.folderUid) {
        clauses.push("e.folder_uid = ?");
        params.push(parsed.folderUid);
    }
    if (parsed.before) {
        clauses.push("e.date_for_sort < ?");
        params.push(parsed.before.toISOString());
    }
    if (parsed.after) {
        clauses.push("e.date_for_sort > ?");
        params.push(parsed.after.toISOString());
    }
    if (parsed.hasAttachment !== undefined) {
        clauses.push("e.has_attachments = ?");
        params.push(parsed.hasAttachment ? 1 : 0);
    }
    for (const flag of parsed.flags ?? []) {
        clauses.push("e.flags LIKE ?");
        params.push(`%,${flag},%`);
    }
    for (const participant of [parsed.from, parsed.to, parsed.cc]) {
        if (participant) {
            clauses.push("e.participants LIKE ?");
            params.push(`%${participant}%`);
        }
    }
    return { where: clauses.join(" AND "), params };
}

/** Escapes a free-text fragment for safe embedding inside an FTS5 `MATCH` phrase - FTS5's own quoting
 * rule for a `"..."` phrase is doubling an embedded `"`, mirroring SQL string-literal escaping. */
function escapeFtsPhrase(value: string): string {
    return value.replace(/"/g, '""');
}

/**
 * Builds the FTS5 `MATCH` expression for a parsed query's free-text and `subject:` portions, or
 * `undefined` when there's nothing to match on text at all (a pure operator/structured-filter query -
 * `buildSearchPredicates()`'s `WHERE` clause alone already narrows that case correctly, no `MATCH`
 * needed). `parsed.text` is passed through close to verbatim (quoted phrases, `OR`, `-` negation - FTS5's
 * own query syntax supports the same shape `queryGrammar.ts`'s own doc comment says every provider's
 * free-text engine is expected to), wrapped only enough to combine it with a `subject:`-scoped clause
 * when both are present.
 */
export function buildMatchExpression(parsed: { text: string; subject?: string }): string | undefined {
    const parts: string[] = [];
    if (parsed.subject) {
        parts.push(`subject:"${escapeFtsPhrase(parsed.subject)}"`);
    }
    if (parsed.text.trim()) {
        parts.push(parsed.subject ? `(${parsed.text})` : parsed.text);
    }
    if (parts.length === 0) {
        return undefined;
    }
    return parts.join(" AND ");
}
