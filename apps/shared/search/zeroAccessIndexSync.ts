///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Keeps this device's local search index (Tier 2) in step with a zero-access mailbox's server index (`specs/search.md` §7-8): the
 * server extracted every message's text at delivery and stores it only encrypted to the mailbox's zero-access key, as one sealed
 * entry per message until a client compacts a closed week into a segment. A sync pass reads the manifest; imports each segment it
 * hasn't imported in its current generation, newest weeks first (the worker's byte budget evicts the oldest); imports the pending entries
 * written since its last pass (the live tail, asked from a little before then, skipping what it has); and compacts a few closed weeks
 * that still have pending entries - it decrypts them and the week's current segment, merges them, seals the result to the mailbox's
 * active zero-access key and uploads it as the next generation. A lost race (`409`) is left to the next pass.
 *
 * A segment (format version 1, `specs/search.md` §16) is gzipped JSON `{ v: 1, documents }` of the same documents the entries carry, so
 * everything is imported through `indexLocalEntities()` - no new storage primitive, on web and on tauri alike.
 *
 * **Client segments (Source C).** End-to-end mail never reaches the server readable, so the server has nothing to index for it: the local
 * index builder (`localIndexBuilder.ts`) decrypts it on one device and uploads what it built with `uploadClientDocuments()`, as `origin:
 * "client"` segments sealed to the same zero-access key, merged into the week's current one. Every device imports them
 * (`importClientSegments()`, run by the builder before it decrypts anything and by each sync pass), so end-to-end mail is decrypted for
 * search once per mailbox rather than once per device - a row imported at the message's current version is not decrypted again.
 *
 * Nothing here ever sends the server anything it can read: entries are decrypted on this device, and a segment is sealed before upload.
 */
import { fromBase64, toBase64 } from "../../../lib/crypto/encoding.js";
import type { UnlockedKeys } from "../../../lib/crypto/keySession.js";
import { decryptEnvelopedDataWithKeys, encryptForRecipients } from "../../../lib/crypto/smime.js";
import {
    getSearchIndexManifest,
    getSearchIndexSegment,
    type IndexSegment,
    listSearchIndexEntries,
    type SegmentManifest,
    putSearchIndexSegment,
    type SealedIndexEntry,
    type ZeroAccessIndexDocument,
} from "../../../lib/search/zeroAccessIndexApi.js";
import { ApiRequestError, type ApiClient } from "../../../lib/util/api.js";
import { getLocalCoverage, indexLocalEntities } from "./localIndexRpcClient.js";
import type { LocalIndexEntity } from "./localIndexSchema.js";

/** The segment format this client writes and reads. */
export const SEGMENT_SCHEMA_VERSION = 1;

/** How far before its last pass the live tail asks again, so an entry committed late is never skipped. */
export const TAIL_OVERLAP_MS = 10 * 60 * 1000;

/** At most this many weeks are compacted per pass, so a large backlog is worked through over several passes. */
export const MAX_COMPACTIONS_PER_PASS = 4;

/** Entities handed to the worker per call. */
const IMPORT_BATCH = 200;

/** How many times `uploadClientDocuments()` re-reads a week's client segment after another device replaced it first. */
export const CLIENT_UPLOAD_ATTEMPTS = 3;

/** What a sync pass remembers between passes, per mailbox (`localStorage`): which segment generations it imported and when its live tail
 * last ran. Forgotten whenever the local index is found empty (a new device, a sign-out, a destroyed index). */
interface SyncState {
    /** `weekId:origin` -> the ETag imported. */
    segments: Record<string, string>;
    /** ISO 8601: when the last live-tail pass started. */
    tailSince?: string;
}

/** What a pass did, for the caller's logging and tests. */
export interface ZeroAccessSyncResult {
    segmentsImported: number;
    /** Client segments (end-to-end mail other devices indexed) imported. */
    clientSegmentsImported: number;
    entriesImported: number;
    weeksCompacted: number;
    /** Entries or segments that wouldn't decrypt with this device's keys (a key it doesn't have) - left as they are. */
    unreadable: number;
}

const stateKey = (mailboxUid: string): string => `rapidmx:za-index-sync:${mailboxUid}`;

function loadState(mailboxUid: string): SyncState {
    try {
        const raw = localStorage.getItem(stateKey(mailboxUid));
        const parsed: unknown = raw ? JSON.parse(raw) : undefined;
        if (parsed && typeof parsed === "object" && typeof (parsed as SyncState).segments === "object") {
            return parsed as SyncState;
        }
    } catch {
        // Storage unavailable or corrupt: start over, which only costs a re-import.
    }
    return { segments: {} };
}

function saveState(mailboxUid: string, state: SyncState): void {
    try {
        localStorage.setItem(stateKey(mailboxUid), JSON.stringify(state));
    } catch {
        // Not remembered: the next pass imports again, which is idempotent (entities are upserted).
    }
}

/** Forgets what a pass remembered for `mailboxUid` (e.g. when its local index is destroyed). */
export function forgetZeroAccessSync(mailboxUid: string): void {
    try {
        localStorage.removeItem(stateKey(mailboxUid));
    } catch {
        // Nothing to forget.
    }
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
    const output = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(output).arrayBuffer());
}

const gunzip = (bytes: Uint8Array): Promise<Uint8Array> => transform(bytes, new DecompressionStream("gzip"));
const gzip = (bytes: Uint8Array): Promise<Uint8Array> => transform(bytes, new CompressionStream("gzip"));

/** The keys that open what the server sealed for this mailbox. */
type ZeroAccessKeys = NonNullable<UnlockedKeys["zeroAccessKeys"]>;

/** Decrypts and gunzips `der` with `keys` and parses the JSON inside - `undefined` when no key opens it or it isn't JSON. */
async function openSealedJson(der: Uint8Array, keys: ZeroAccessKeys): Promise<unknown> {
    try {
        return JSON.parse(new TextDecoder().decode(await gunzip(await decryptEnvelopedDataWithKeys(der, keys))));
    } catch {
        return undefined;
    }
}

function isDocument(value: unknown): value is ZeroAccessIndexDocument {
    const doc = value as ZeroAccessIndexDocument | undefined;
    return !!doc && doc.v === 1 && typeof doc.messageUid === "string" && typeof doc.subject === "string" && typeof doc.body === "string";
}

/** A document as a row of the local index. Folder and flags aren't in the document - the builder records the folder
 * (`localIndexBuilder.ts`), and the upsert keeps what is already there. */
export function documentEntity(mailboxUid: string, doc: ZeroAccessIndexDocument): LocalIndexEntity {
    const participants: string = (doc.participants ?? []).join(" ");
    const attachmentText: string = [...(doc.attachmentNames ?? []), ...(doc.attachmentText ?? [])].join("\n");
    return {
        entityType: "message",
        entityUid: doc.messageUid,
        mailboxUid,
        dateForSort: new Date(Number.isFinite(doc.dateForSort) ? doc.dateForSort : 0).toISOString(),
        participants,
        flags: "",
        hasAttachments: (doc.attachmentNames ?? []).length > 0,
        subject: doc.subject,
        body: doc.body,
        attachmentText,
        byteSize: doc.subject.length + doc.body.length + attachmentText.length + participants.length,
    };
}

async function importDocuments(mailboxUid: string, docs: ZeroAccessIndexDocument[]): Promise<void> {
    for (let i = 0; i < docs.length; i += IMPORT_BATCH) {
        await indexLocalEntities(
            mailboxUid,
            docs.slice(i, i + IMPORT_BATCH).map((doc) => documentEntity(mailboxUid, doc)),
        );
    }
}

/** The documents of a segment generation that pass `accept`, or `undefined` when it won't open or is a format this client doesn't read. */
async function readSegmentAs<T>(
    mailboxUid: string,
    segment: IndexSegment,
    keys: ZeroAccessKeys,
    accept: (value: unknown) => value is T,
    client?: ApiClient,
): Promise<T[] | undefined> {
    if (segment.schemaVersion !== SEGMENT_SCHEMA_VERSION) {
        return undefined;
    }
    const bundle = (await openSealedJson(await getSearchIndexSegment(mailboxUid, segment, client), keys)) as { v?: number; documents?: unknown[] } | undefined;
    return bundle?.v === SEGMENT_SCHEMA_VERSION && Array.isArray(bundle.documents) ? bundle.documents.filter(accept) : undefined;
}

const readSegment = (mailboxUid: string, segment: IndexSegment, keys: ZeroAccessKeys, client?: ApiClient): Promise<ZeroAccessIndexDocument[] | undefined> =>
    readSegmentAs(mailboxUid, segment, keys, isDocument, client);

/** `documents` gzipped and sealed to `key` as a segment file, base64. */
async function sealSegment(documents: unknown[], key: ZeroAccessKeys[number]): Promise<string> {
    const file = await gzip(new TextEncoder().encode(JSON.stringify({ v: SEGMENT_SCHEMA_VERSION, documents })));
    return toBase64(await encryptForRecipients(file, [key.certDer]));
}

/** One document of a client segment: a local index row of an end-to-end message, as the device that decrypted it built it. */
export interface ClientIndexDocument {
    v: 1;
    messageUid: string;
    folderUid?: string;
    /** ISO 8601. */
    dateForSort: string;
    participants: string;
    flags: string;
    hasAttachments: boolean;
    subject?: string;
    body?: string;
    attachmentText?: string;
    /** The message's version when it was decrypted (`localIndexBuilder.ts`'s `versionOf()`). */
    entityVersion?: string;
}

function isClientDocument(value: unknown): value is ClientIndexDocument {
    const doc = value as ClientIndexDocument | undefined;
    return !!doc && doc.v === 1 && typeof doc.messageUid === "string" && typeof doc.dateForSort === "string" && typeof doc.participants === "string";
}

/** A local index row as a client segment document. */
export function clientDocument(entity: LocalIndexEntity): ClientIndexDocument {
    return {
        v: 1,
        messageUid: entity.entityUid,
        folderUid: entity.folderUid,
        dateForSort: entity.dateForSort,
        participants: entity.participants,
        flags: entity.flags,
        hasAttachments: entity.hasAttachments,
        subject: entity.subject,
        body: entity.body,
        attachmentText: entity.attachmentText,
        entityVersion: entity.entityVersion,
    };
}

/** A client segment document as a row of the local index. */
export function clientDocumentEntity(mailboxUid: string, doc: ClientIndexDocument): LocalIndexEntity {
    const text: number = [doc.subject, doc.body, doc.attachmentText, doc.participants].reduce((total, value) => total + (value?.length ?? 0), 0);
    return {
        entityType: "message",
        entityUid: doc.messageUid,
        mailboxUid,
        ...(doc.folderUid !== undefined ? { folderUid: doc.folderUid } : {}),
        dateForSort: doc.dateForSort,
        participants: doc.participants,
        flags: typeof doc.flags === "string" ? doc.flags : "",
        hasAttachments: doc.hasAttachments === true,
        ...(doc.subject !== undefined ? { subject: doc.subject } : {}),
        ...(doc.body !== undefined ? { body: doc.body } : {}),
        ...(doc.attachmentText !== undefined ? { attachmentText: doc.attachmentText } : {}),
        byteSize: text,
        ...(doc.entityVersion !== undefined ? { entityVersion: doc.entityVersion } : {}),
    };
}

/** The ISO 8601 week (UTC) of `date`, as `YYYY-Www` - the week a message's segment is filed under (restapi's `isoWeekId()`). */
export function isoWeekId(date: Date): string {
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    // The Thursday of this ISO week decides its year (weeks start on Monday; getUTCDay() has Sunday as 0).
    const weekday: number = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() + 4 - weekday);
    const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
    const week: number = Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
    return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The sync state, started over when the local index is empty (nothing remembered in it is there any more). */
async function currentState(mailboxUid: string): Promise<SyncState> {
    return (await getLocalCoverage(mailboxUid)).indexedCount === 0 ? { segments: {} } : loadState(mailboxUid);
}

/**
 * Imports the client segments of `mailboxUid` (end-to-end mail indexed by another device - see this module's comment) not yet imported in
 * their current generation, newest week first: how many. `manifest` saves reading it again; `generation` is the calling build pass's (see
 * `GenerationParams`). Segments this device can't open are skipped.
 */
export async function importClientSegments(
    mailboxUid: string,
    unlocked: UnlockedKeys,
    client?: ApiClient,
    { manifest, generation }: { manifest?: SegmentManifest; generation?: number } = {},
): Promise<number> {
    const keys: ZeroAccessKeys | undefined = unlocked.zeroAccessKeys;
    if (!keys?.length) {
        return 0;
    }
    const segments: IndexSegment[] = (manifest ?? (await getSearchIndexManifest(mailboxUid, client))).segments.filter((segment) => segment.origin === "client");
    const state: SyncState = await currentState(mailboxUid);
    let imported = 0;
    for (const segment of segments.sort((a, b) => b.weekId.localeCompare(a.weekId))) {
        const key = `${segment.weekId}:${segment.origin}`;
        if (state.segments[key] === segment.etag) {
            continue;
        }
        const docs = await readSegmentAs(mailboxUid, segment, keys, isClientDocument, client);
        if (!docs) {
            continue;
        }
        for (let i = 0; i < docs.length; i += IMPORT_BATCH) {
            await indexLocalEntities(
                mailboxUid,
                docs.slice(i, i + IMPORT_BATCH).map((doc) => clientDocumentEntity(mailboxUid, doc)),
                generation,
            );
        }
        state.segments[key] = segment.etag;
        saveState(mailboxUid, state);
        imported++;
    }
    return imported;
}

/**
 * Uploads end-to-end messages this device just decrypted and indexed (`entities`) to `mailboxUid`'s client segments, one per ISO week of
 * `dateForSort`, each merged by message into the week's current segment and sealed to the active zero-access key: how many weeks were
 * written. A week whose current segment this device can't read is left alone (merging would drop what is in it), as is one that already
 * holds every document at the same version. Another device replacing a week first (`409`) is retried with its generation, up to
 * `CLIENT_UPLOAD_ATTEMPTS` times. Does nothing without unlocked zero-access keys.
 */
export async function uploadClientDocuments(mailboxUid: string, unlocked: UnlockedKeys, entities: LocalIndexEntity[], client?: ApiClient): Promise<number> {
    const keys: ZeroAccessKeys | undefined = unlocked.zeroAccessKeys;
    if (!keys?.length || entities.length === 0) {
        return 0;
    }
    const weeks = new Map<string, ClientIndexDocument[]>();
    for (const entity of entities) {
        const weekId: string = isoWeekId(new Date(entity.dateForSort));
        weeks.set(weekId, [...(weeks.get(weekId) ?? []), clientDocument(entity)]);
    }
    const state: SyncState = loadState(mailboxUid);
    let written = 0;
    let manifest: SegmentManifest | undefined;
    for (const [weekId, docs] of weeks) {
        for (let attempt = 0; attempt < CLIENT_UPLOAD_ATTEMPTS; attempt++) {
            manifest ??= await getSearchIndexManifest(mailboxUid, client);
            const current: IndexSegment | undefined = manifest.segments.find((segment) => segment.origin === "client" && segment.weekId === weekId);
            const previous: ClientIndexDocument[] | undefined = current ? await readSegmentAs(mailboxUid, current, keys, isClientDocument, client) : [];
            if (!previous) {
                break;
            }
            const merged = new Map<string, ClientIndexDocument>(previous.map((doc) => [doc.messageUid, doc]));
            if (docs.every((doc) => merged.has(doc.messageUid) && merged.get(doc.messageUid)!.entityVersion === doc.entityVersion)) {
                break;
            }
            for (const doc of docs) {
                merged.set(doc.messageUid, doc);
            }
            try {
                const stored = await putSearchIndexSegment(
                    mailboxUid,
                    weekId,
                    {
                        expectedGeneration: current?.generation ?? 0,
                        segment: await sealSegment([...merged.values()], keys[0]),
                        keyFingerprint: keys[0].fingerprint,
                        schemaVersion: SEGMENT_SCHEMA_VERSION,
                        origin: "client",
                    },
                    client,
                );
                // This device already holds every document of the new generation only if it held the previous one.
                if (current && state.segments[`${weekId}:client`] === current.etag) {
                    state.segments[`${weekId}:client`] = stored.etag;
                    saveState(mailboxUid, state);
                }
                written++;
                break;
            } catch (err) {
                if (!(err instanceof ApiRequestError && err.status === 409)) {
                    throw err;
                }
                manifest = undefined;
            }
        }
    }
    return written;
}

/** Every pending entry of `week` (or, without one, written since `since`), paged through. */
async function listAllEntries(mailboxUid: string, filter: { week?: string; since?: string }, client?: ApiClient): Promise<SealedIndexEntry[]> {
    const entries: SealedIndexEntry[] = [];
    let after: string | undefined;
    do {
        const page = await listSearchIndexEntries(mailboxUid, { ...filter, ...(after ? { after } : {}) }, client);
        entries.push(...page.entries);
        after = page.next;
    } while (after);
    return entries;
}

/** The documents of `entries` that open, with the uids of those entries; how many didn't. */
async function openEntries(entries: SealedIndexEntry[], keys: ZeroAccessKeys): Promise<{ docs: ZeroAccessIndexDocument[]; uids: string[]; unreadable: number }> {
    const docs: ZeroAccessIndexDocument[] = [];
    const uids: string[] = [];
    let unreadable = 0;
    for (const entry of entries) {
        const doc = await openSealedJson(fromBase64(entry.sealed), keys);
        if (isDocument(doc)) {
            docs.push(doc);
            uids.push(entry.uid);
        } else {
            unreadable++;
        }
    }
    return { docs, uids, unreadable };
}

/**
 * One sync pass for `mailboxUid` (see this module's comment). Does nothing without unlocked zero-access keys. Rejects when the manifest
 * can't be read; any later failure ends the pass early with what it had done so far remembered.
 */
export async function syncZeroAccessIndex(mailboxUid: string, unlocked: UnlockedKeys, client?: ApiClient): Promise<ZeroAccessSyncResult> {
    const result: ZeroAccessSyncResult = { segmentsImported: 0, clientSegmentsImported: 0, entriesImported: 0, weeksCompacted: 0, unreadable: 0 };
    const keys: ZeroAccessKeys | undefined = unlocked.zeroAccessKeys;
    if (!keys?.length) {
        return result;
    }
    const manifest = await getSearchIndexManifest(mailboxUid, client);
    let state: SyncState = await currentState(mailboxUid);

    // Segments, newest week first.
    const zeroAccessSegments: IndexSegment[] = manifest.segments.filter((segment) => segment.origin === "zero-access");
    for (const segment of [...zeroAccessSegments].sort((a, b) => b.weekId.localeCompare(a.weekId))) {
        const key = `${segment.weekId}:${segment.origin}`;
        if (state.segments[key] === segment.etag) {
            continue;
        }
        const docs = await readSegment(mailboxUid, segment, keys, client);
        if (!docs) {
            result.unreadable++;
            continue;
        }
        await importDocuments(mailboxUid, docs);
        state.segments[key] = segment.etag;
        result.segmentsImported++;
        saveState(mailboxUid, state);
    }

    // End-to-end mail other devices indexed.
    saveState(mailboxUid, state);
    result.clientSegmentsImported = await importClientSegments(mailboxUid, unlocked, client, { manifest });
    state = loadState(mailboxUid);

    // The live tail.
    const tailStart = new Date().toISOString();
    const since = state.tailSince ? new Date(new Date(state.tailSince).getTime() - TAIL_OVERLAP_MS).toISOString() : undefined;
    const tail = await openEntries(await listAllEntries(mailboxUid, since ? { since } : {}, client), keys);
    await importDocuments(mailboxUid, tail.docs);
    result.entriesImported += tail.docs.length;
    result.unreadable += tail.unreadable;
    state.tailSince = tailStart;
    saveState(mailboxUid, state);

    // Compaction of closed weeks.
    const active = keys[0];
    for (const week of manifest.weeks.filter((w) => w.compactable && w.pendingEntries > 0).slice(0, MAX_COMPACTIONS_PER_PASS)) {
        const current: IndexSegment | undefined = zeroAccessSegments.find((segment) => segment.weekId === week.weekId);
        const previous: ZeroAccessIndexDocument[] | undefined = current ? await readSegment(mailboxUid, current, keys, client) : [];
        if (!previous) {
            // A generation this device can't read can't be folded into: leave the week to a device that can.
            continue;
        }
        const pending = await openEntries(await listAllEntries(mailboxUid, { week: week.weekId }, client), keys);
        if (pending.uids.length === 0) {
            continue;
        }
        const merged = new Map<string, ZeroAccessIndexDocument>(previous.map((doc) => [doc.messageUid, doc]));
        for (const doc of pending.docs) {
            merged.set(doc.messageUid, doc);
        }
        try {
            const stored = await putSearchIndexSegment(
                mailboxUid,
                week.weekId,
                {
                    expectedGeneration: current?.generation ?? 0,
                    segment: await sealSegment([...merged.values()], active),
                    keyFingerprint: active.fingerprint,
                    schemaVersion: SEGMENT_SCHEMA_VERSION,
                    foldedEntryUids: pending.uids,
                },
                client,
            );
            // This device already holds every document of the new generation.
            await importDocuments(mailboxUid, pending.docs);
            state.segments[`${stored.weekId}:${stored.origin}`] = stored.etag;
            saveState(mailboxUid, state);
            result.weeksCompacted++;
        } catch (err) {
            // Another device compacted the week first: the next pass imports its generation.
            if (!(err instanceof ApiRequestError && err.status === 409)) {
                throw err;
            }
        }
    }
    return result;
}
