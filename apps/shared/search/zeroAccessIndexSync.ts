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
    type IndexWeekEntries,
    listSearchIndexEntries,
    type SegmentManifest,
    putSearchIndexSegment,
    type SealedIndexEntry,
    type ZeroAccessIndexDocument,
} from "../../../lib/search/zeroAccessIndexApi.js";
import { ApiRequestError, type ApiClient } from "../../../lib/util/api.js";
import { clientPlatform, isConstrainedConnection, type ClientPlatform } from "../../../lib/util/clientPlatform.js";
import { getMessage } from "../../../lib/mail/mailApi.js";
import { getIndexedVersions, getLocalCoverage, indexLocalEntities, moveLocalEntity } from "./localIndexRpcClient.js";
import { type LocalIndexEntity, messageRowFlags, messageRowVersion } from "./localIndexSchema.js";
import { forgetZeroAccessSync, zeroAccessSyncEpoch, zeroAccessSyncStateKey } from "./zeroAccessSyncState.js";

export { forgetZeroAccessSync };

/** The segment format this client writes and reads. */
export const SEGMENT_SCHEMA_VERSION = 1;

/** How far before its last pass the live tail asks again, so an entry committed late is never skipped. */
export const TAIL_OVERLAP_MS = 10 * 60 * 1000;

/** At most this many weeks are compacted per pass, so a large backlog is worked through over several passes. */
export const MAX_COMPACTIONS_PER_PASS = 4;

/** How long after a week's `compactableAt` each platform takes it (restapi `specs/search.md` §8 *Who compacts*): a computer first,
 * a phone only when nothing else has for a day. */
export const COMPACTION_DELAY_MS: Record<ClientPlatform, number> = { desktop: 0, web: 6 * 3_600_000, mobile: 24 * 3_600_000 };

/** A mobile client declines a week whose pending entries and current segment together are larger than this. */
export const MOBILE_COMPACTION_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Whether this client should compact `week` now: it is compactable, has pending entries, and this platform's delay after its
 * `compactableAt` has passed. A mobile client also declines on a cellular or data-saver connection, and a week larger than
 * `MOBILE_COMPACTION_MAX_BYTES` with `segmentBytes` (its current segment's size) - or of unknown size, or from a server that
 * doesn't say when it became compactable.
 */
export function shouldCompact(
    week: IndexWeekEntries,
    segmentBytes: number,
    platform: ClientPlatform = clientPlatform(),
    now: number = Date.now(),
    constrained: boolean = isConstrainedConnection(),
): boolean {
    if (!week.compactable || week.pendingEntries === 0) {
        return false;
    }
    const since = week.compactableAt ? Date.parse(week.compactableAt) : NaN;
    if (platform === "mobile") {
        if (constrained || Number.isNaN(since) || week.pendingBytes === undefined || week.pendingBytes + segmentBytes > MOBILE_COMPACTION_MAX_BYTES) {
            return false;
        }
    }
    // A server that doesn't say when the week became compactable: compactable is all there is to go on.
    return Number.isNaN(since) || since + COMPACTION_DELAY_MS[platform] <= now;
}

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
    /** Where a live-tail pass that ended early stopped: the listing it was paging through (`since`, absent for a whole one), the page
     * after the last one it imported, and when it started - which the pass that finishes it records as `tailSince`, so nothing written
     * while it was interrupted is skipped. */
    tailCursor?: { since?: string; after: string; start: string };
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

function loadState(mailboxUid: string): SyncState {
    try {
        const raw = localStorage.getItem(zeroAccessSyncStateKey(mailboxUid));
        const parsed: unknown = raw ? JSON.parse(raw) : undefined;
        if (parsed && typeof parsed === "object" && typeof (parsed as SyncState).segments === "object") {
            return parsed as SyncState;
        }
    } catch {
        // Storage unavailable or corrupt: start over, which only costs a re-import.
    }
    return { segments: {} };
}

/** Remembers `state` - unless the mailbox's local index was destroyed since the pass began (`epoch`, `zeroAccessSyncEpoch()` then): what
 * the pass imported went with it, and a new index must not be taken for it. */
function saveState(mailboxUid: string, state: SyncState, epoch: string): void {
    if (zeroAccessSyncEpoch(mailboxUid) !== epoch) {
        return;
    }
    try {
        localStorage.setItem(zeroAccessSyncStateKey(mailboxUid), JSON.stringify(state));
    } catch {
        // Not remembered: the next pass imports again, which is idempotent (entities are upserted).
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

/** What the builder (`localIndexBuilder.ts`) knows of a zero-access message from the message list - none of it is in its document. */
export interface ZeroAccessRowMetadata {
    folderUid: string;
    entityVersion: string;
    /** `,flag,flag,` */
    flags: string;
}

/** At most this many messages' metadata are kept per mailbox for rows not imported yet; the oldest go first. */
export const MAX_REMEMBERED_METADATA = 50_000;

/** Folder, version and flags the builder recorded for zero-access messages, by mailbox and message uid, until their row is imported. */
const rememberedMetadata = new Map<string, Map<string, ZeroAccessRowMetadata>>();

/**
 * Remembers zero-access message `messageUid`'s folder, version and flags for when its row is imported: the builder records them on the row
 * as it walks, which does nothing for a row that isn't there yet (the index started empty - a new device, or after a lock - and this sync
 * imports the rows after the build).
 */
export function rememberZeroAccessMetadata(mailboxUid: string, messageUid: string, metadata: ZeroAccessRowMetadata): void {
    let remembered = rememberedMetadata.get(mailboxUid);
    if (!remembered) {
        remembered = new Map();
        rememberedMetadata.set(mailboxUid, remembered);
    }
    remembered.delete(messageUid);
    remembered.set(messageUid, metadata);
    if (remembered.size > MAX_REMEMBERED_METADATA) {
        remembered.delete(remembered.keys().next().value!);
    }
}

/** Records on the just-imported rows of `messageUids` what the builder remembered of them, once. */
async function applyRememberedMetadata(mailboxUid: string, messageUids: string[]): Promise<void> {
    const remembered = rememberedMetadata.get(mailboxUid);
    for (const uid of messageUids) {
        const metadata = remembered?.get(uid);
        if (metadata) {
            await moveLocalEntity(mailboxUid, uid, metadata.folderUid, metadata.entityVersion, metadata.flags);
            remembered!.delete(uid);
        }
    }
}

/** At most this many live-tail rows a pass looks up (`recordTailMetadata()`); the rest get theirs from the next build pass. */
export const MAX_TAIL_LOOKUPS = 500;

/** How many of those lookups run at once. */
const TAIL_LOOKUP_CONCURRENCY = 4;

/**
 * Gives the live tail's rows that nothing recorded yet (`docs`: rows the builder hasn't seen - mail that arrived after its walk) their
 * folder, version and flags at import, from the message itself, so a folder or flag filter finds them before the next build pass. At
 * most `MAX_TAIL_LOOKUPS`. Best effort: a message that is gone, moved to another mailbox or won't load is left to the builder.
 */
async function recordTailMetadata(mailboxUid: string, messageUids: string[], client?: ApiClient): Promise<void> {
    const queue: string[] = messageUids.slice(0, MAX_TAIL_LOOKUPS);
    const worker = async (): Promise<void> => {
        for (let uid = queue.shift(); uid !== undefined; uid = queue.shift()) {
            try {
                const message = await getMessage(uid, client);
                if (message.mailboxUid === mailboxUid && message.folderUid) {
                    await moveLocalEntity(mailboxUid, uid, message.folderUid, messageRowVersion(message), messageRowFlags(message));
                }
            } catch {
                // Left to the next build pass.
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(TAIL_LOOKUP_CONCURRENCY, queue.length) }, worker));
}

/** A document as a row of the local index. Folder and flags aren't in the document - the builder records them (`localIndexBuilder.ts`,
 * here through `rememberZeroAccessMetadata()` when the row came later; a live-tail row nothing recorded is looked up,
 * `recordTailMetadata()`), and the upsert keeps what is already there. */
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
        const batch = docs.slice(i, i + IMPORT_BATCH);
        await indexLocalEntities(
            mailboxUid,
            batch.map((doc) => documentEntity(mailboxUid, doc)),
        );
        await applyRememberedMetadata(
            mailboxUid,
            batch.map((doc) => doc.messageUid),
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

/**
 * The sync state, started over when the local index is empty (nothing remembered in it is there any more). What was stored is dropped then
 * too: it describes an index that is gone (pruned, or discarded as corrupted, behind this module's back), and a later pass that found this
 * index filled by the build's end-to-end mail would take it up and skip the segments it never got.
 */
async function currentState(mailboxUid: string): Promise<SyncState> {
    if ((await getLocalCoverage(mailboxUid)).indexedCount > 0) {
        return loadState(mailboxUid);
    }
    try {
        localStorage.removeItem(zeroAccessSyncStateKey(mailboxUid));
    } catch {
        // Nothing stored to drop.
    }
    return { segments: {} };
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
    const epoch: string = zeroAccessSyncEpoch(mailboxUid);
    // Read first, while a new index is still empty: its stale state is dropped even when the manifest can't be read.
    const state: SyncState = await currentState(mailboxUid);
    const segments: IndexSegment[] = (manifest ?? (await getSearchIndexManifest(mailboxUid, client))).segments.filter((segment) => segment.origin === "client");
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
        saveState(mailboxUid, state, epoch);
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
        let week = weeks.get(weekId);
        if (!week) {
            week = [];
            weeks.set(weekId, week);
        }
        week.push(clientDocument(entity));
    }
    const epoch: string = zeroAccessSyncEpoch(mailboxUid);
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
                    saveState(mailboxUid, state, epoch);
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

/** Every pending entry of `week`, paged through. */
async function listAllEntries(mailboxUid: string, filter: { week: string }, client?: ApiClient): Promise<SealedIndexEntry[]> {
    const entries: SealedIndexEntry[] = [];
    let after: string | undefined;
    do {
        const page = await listSearchIndexEntries(mailboxUid, { ...filter, ...(after ? { after } : {}) }, client);
        entries.push(...page.entries);
        after = page.next;
    } while (after);
    return entries;
}

/** Per mailbox, the weeks a compaction found it can't fold on this device - a segment it can't read, or pending entries sealed to a key
 * it doesn't hold (an older key a shared mailbox's member hasn't been given yet) - with how many entries were pending then, and the
 * zero-access keys it had. Such a week stays pending, and the oldest weeks come first: without this, a few of them would take every pass's
 * `MAX_COMPACTIONS_PER_PASS` and no other week would ever be compacted here. A week is tried again once its count changes (new entries,
 * or another device folded it), and every week once this device's keys do. */
const stalled = new Map<string, { keys: string; weeks: Map<string, number> }>();

/** The weeks of `mailboxUid` this device found it can't fold with `keys` (see `stalled`). */
function stalledWeeks(mailboxUid: string, keys: ZeroAccessKeys): Map<string, number> {
    const fingerprints: string = keys.map((key) => key.fingerprint).join(",");
    let entry = stalled.get(mailboxUid);
    if (entry?.keys !== fingerprints) {
        entry = { keys: fingerprints, weeks: new Map() };
        stalled.set(mailboxUid, entry);
    }
    return entry.weeks;
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
    const epoch: string = zeroAccessSyncEpoch(mailboxUid);
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
        saveState(mailboxUid, state, epoch);
    }

    // End-to-end mail other devices indexed.
    saveState(mailboxUid, state, epoch);
    result.clientSegmentsImported = await importClientSegments(mailboxUid, unlocked, client, { manifest });
    state = loadState(mailboxUid);

    // The live tail, a page at a time: without a `since` (a new or emptied local index) it is every pending entry of the mailbox, which
    // after zero-access is turned on can be every message it has - never held, opened, all at once. Each page imported is remembered
    // (`tailCursor`), so a pass that ends early is taken up where it stopped rather than from the start.
    const since = state.tailSince ? new Date(new Date(state.tailSince).getTime() - TAIL_OVERLAP_MS).toISOString() : undefined;
    const resumed = state.tailCursor?.since === since ? state.tailCursor : undefined;
    const tailStart: string = resumed?.start ?? new Date().toISOString();
    // Rows nothing has recorded a folder and flags for: not on this device with a version yet (the builder's mark), nor remembered by it.
    // Asked in batches - a backlog's tail can be every message of the mailbox, past what one SQL statement may bind - and only until there
    // are as many as a pass looks up.
    const remembered = rememberedMetadata.get(mailboxUid);
    const asked = new Set<string>();
    const unrecorded: string[] = [];
    let after: string | undefined = resumed?.after;
    do {
        const page = await listSearchIndexEntries(mailboxUid, { ...(since ? { since } : {}), ...(after ? { after } : {}) }, client);
        const tail = await openEntries(page.entries, keys);
        const tailUids: string[] = [...new Set(tail.docs.map((doc) => doc.messageUid))].filter((uid) => !asked.has(uid));
        tailUids.forEach((uid) => asked.add(uid));
        for (let i = 0; i < tailUids.length && unrecorded.length < MAX_TAIL_LOOKUPS; i += IMPORT_BATCH) {
            const batch: string[] = tailUids.slice(i, i + IMPORT_BATCH);
            const recorded: Record<string, string> = await getIndexedVersions(mailboxUid, batch);
            unrecorded.push(...batch.filter((uid) => recorded[uid] === undefined && !remembered?.has(uid)));
        }
        await importDocuments(mailboxUid, tail.docs);
        result.entriesImported += tail.docs.length;
        result.unreadable += tail.unreadable;
        after = page.next;
        if (after) {
            state.tailCursor = { ...(since ? { since } : {}), after, start: tailStart };
            saveState(mailboxUid, state, epoch);
        }
    } while (after);
    await recordTailMetadata(mailboxUid, unrecorded, client);
    state.tailSince = tailStart;
    delete state.tailCursor;
    saveState(mailboxUid, state, epoch);

    // Compaction of closed weeks, passing over those this device found it can't fold (`stalled`) while nothing has changed in them.
    const active = keys[0];
    const stalledHere: Map<string, number> = stalledWeeks(mailboxUid, keys);
    const segmentOf = (weekId: string): IndexSegment | undefined => zeroAccessSegments.find((segment) => segment.weekId === weekId);
    const weeks: IndexWeekEntries[] = manifest.weeks.filter((w) => stalledHere.get(w.weekId) !== w.pendingEntries && shouldCompact(w, segmentOf(w.weekId)?.bytes ?? 0));
    for (const week of weeks.slice(0, MAX_COMPACTIONS_PER_PASS)) {
        const current: IndexSegment | undefined = segmentOf(week.weekId);
        const previous: ZeroAccessIndexDocument[] | undefined = current ? await readSegment(mailboxUid, current, keys, client) : [];
        if (!previous) {
            // A generation this device can't read can't be folded into: leave the week to a device that can.
            stalledHere.set(week.weekId, week.pendingEntries);
            continue;
        }
        const pending = await openEntries(await listAllEntries(mailboxUid, { week: week.weekId }, client), keys);
        if (pending.uids.length === 0) {
            stalledHere.set(week.weekId, week.pendingEntries);
            continue;
        }
        // What this device can't open stays pending once the rest is folded: the week is passed over until that count changes.
        if (pending.unreadable > 0) {
            stalledHere.set(week.weekId, pending.unreadable);
        } else {
            stalledHere.delete(week.weekId);
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
            saveState(mailboxUid, state, epoch);
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
