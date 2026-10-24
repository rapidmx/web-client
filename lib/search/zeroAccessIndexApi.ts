///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrappers over `@rapidmx/restapi`'s zero-access search index (`/mail/mailboxes/:id/search-index`, `specs/search.md` §7-8): the
 * sealed index entries the server writes at delivery and the weekly segments clients compact them into. Everything here is
 * ciphertext encrypted to the mailbox's zero-access key - `apps/shared/search/zeroAccessIndexSync.ts` decrypts and imports it.
 */
import { type ApiClient, withClient, withClientBlob } from "../util/api.js";

export type SegmentOrigin = "zero-access" | "client";

/** A compacted segment as the manifest lists it. */
export interface IndexSegment {
    weekId: string;
    generation: number;
    origin: SegmentOrigin;
    bytes: number;
    etag: string;
    schemaVersion: number;
    keyFingerprint: string;
    entryCount: number;
}

/** A week's entries not yet compacted. */
export interface IndexWeekEntries {
    weekId: string;
    pendingEntries: number;
    latestEntryAt: string;
    /** The week has closed and its grace period has passed: a client may compact it. */
    compactable: boolean;
    /** When the week becomes (or became) compactable - where the platform stagger starts. Absent from a server before it. */
    compactableAt?: string;
    /** Size of the week's pending sealed entries (bytes of base64). Absent from a server before it. */
    pendingBytes?: number;
}

export interface SegmentManifest {
    mailboxUid: string;
    segments: IndexSegment[];
    weeks: IndexWeekEntries[];
}

/** One pending entry: `sealed` is base64 CMS `EnvelopedData` of a gzipped JSON `ZeroAccessIndexDocument`. */
export interface SealedIndexEntry {
    uid: string;
    weekId: string;
    messageUid: string;
    createdAt: string;
    keyFingerprint: string;
    sealed: string;
}

export interface SealedIndexEntryPage {
    entries: SealedIndexEntry[];
    next?: string;
}

/** What a sealed entry (and each document of a segment) decrypts to - restapi's `ZeroAccessIndexDocument`. */
export interface ZeroAccessIndexDocument {
    v: 1;
    messageUid: string;
    subject: string;
    body: string;
    attachmentText: string[];
    attachmentNames: string[];
    deferredAttachments: string[];
    from: string;
    to: string[];
    cc: string[];
    participants: string[];
    dateForSort: number;
}

/** `PUT .../segments/:weekId`. */
export interface SegmentUpload {
    expectedGeneration: number;
    /** Base64 of the sealed file. */
    segment: string;
    keyFingerprint: string;
    schemaVersion: number;
    origin?: SegmentOrigin;
    foldedEntryUids?: string[];
}

const base = (mailboxUid: string): string => `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/search-index`;

export function getSearchIndexManifest(mailboxUid: string, client?: ApiClient): Promise<SegmentManifest> {
    return withClient(client, `${base(mailboxUid)}/manifest`);
}

/** One page of pending entries: of `week` when given, written at or after `since` when given, after uid `after`. */
export function listSearchIndexEntries(
    mailboxUid: string,
    options: { week?: string; since?: string; after?: string; limit?: number } = {},
    client?: ApiClient,
): Promise<SealedIndexEntryPage> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
        if (value !== undefined) {
            query.set(key, String(value));
        }
    }
    const search = query.toString();
    return withClient(client, `${base(mailboxUid)}/entries${search ? `?${search}` : ""}`);
}

/** The sealed file of a week's segment generation. */
export async function getSearchIndexSegment(
    mailboxUid: string,
    segment: Pick<IndexSegment, "weekId" | "generation" | "origin">,
    client?: ApiClient,
): Promise<Uint8Array> {
    const query = `generation=${segment.generation}${segment.origin === "client" ? "&origin=client" : ""}`;
    const blob = await withClientBlob(client, `${base(mailboxUid)}/segments/${encodeURIComponent(segment.weekId)}?${query}`, "Could not download a search index segment.");
    return new Uint8Array(await blob.arrayBuffer());
}

/** Stores a compaction. Rejects with a `409` when the week's segment changed since `upload.expectedGeneration` was read. */
export function putSearchIndexSegment(mailboxUid: string, weekId: string, upload: SegmentUpload, client?: ApiClient): Promise<IndexSegment> {
    return withClient(client, `${base(mailboxUid)}/segments/${encodeURIComponent(weekId)}`, { method: "PUT", body: JSON.stringify(upload) });
}
