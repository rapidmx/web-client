// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The zero-access index sync, with real CMS sealing (the server's construction) and the API and local index mocked.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromBase64, toBase64 } from "../../../lib/crypto/encoding.js";
import { decryptEnvelopedDataWithKeys, encryptForRecipients } from "../../../lib/crypto/smime.js";
import { ApiRequestError } from "../../../lib/util/api.js";

x509.cryptoProvider.set(crypto);

const api = vi.hoisted(() => ({
    getSearchIndexManifest: vi.fn(),
    getSearchIndexSegment: vi.fn(),
    listSearchIndexEntries: vi.fn(),
    putSearchIndexSegment: vi.fn(),
}));
vi.mock("../../../lib/search/zeroAccessIndexApi.js", () => api);
const rpc = vi.hoisted(() => ({ getIndexedVersions: vi.fn(), getLocalCoverage: vi.fn(), indexLocalEntities: vi.fn(), moveLocalEntity: vi.fn() }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => rpc);
const mail = vi.hoisted(() => ({ getMessage: vi.fn() }));
vi.mock("../../../lib/mail/mailApi.js", () => mail);

const {
    CLIENT_UPLOAD_ATTEMPTS,
    COMPACTION_DELAY_MS,
    MOBILE_COMPACTION_MAX_BYTES,
    clientDocument,
    clientDocumentEntity,
    documentEntity,
    forgetZeroAccessSync,
    importClientSegments,
    isoWeekId,
    MAX_REMEMBERED_METADATA,
    MAX_TAIL_LOOKUPS,
    rememberZeroAccessMetadata,
    shouldCompact,
    syncZeroAccessIndex,
    TAIL_OVERLAP_MS,
    uploadClientDocuments,
} = await import("../../../apps/shared/search/zeroAccessIndexSync.js");

async function zeroAccessKey(fingerprint: string) {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "0a",
        name: "CN=za",
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        keys,
    });
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    return { fingerprint, certDer: new Uint8Array(cert.rawData), privateKey };
}

async function gzipJson(value: unknown): Promise<Uint8Array> {
    const stream = new Blob([new TextEncoder().encode(JSON.stringify(value))]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipJson(bytes: Uint8Array): Promise<any> {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(new TextDecoder().decode(await new Response(stream).arrayBuffer()));
}

const doc = (messageUid: string, extra: object = {}) => ({
    v: 1,
    messageUid,
    subject: `Subject ${messageUid}`,
    body: `Body ${messageUid}`,
    attachmentText: ["pdf text"],
    attachmentNames: ["a.pdf"],
    deferredAttachments: [],
    from: "bob@example.org",
    to: ["me@example.com"],
    cc: [],
    participants: ["bob@example.org", "Bob"],
    dateForSort: Date.UTC(2026, 9, 1),
    ...extra,
});

const sealEntry = async (uid: string, weekId: string, document: object, certDer: Uint8Array) => ({
    uid,
    weekId,
    messageUid: (document as any).messageUid ?? uid,
    createdAt: new Date().toISOString(),
    keyFingerprint: "fp",
    sealed: toBase64(await encryptForRecipients(await gzipJson(document), [certDer])),
});

const sealSegment = async (documents: object[], certDer: Uint8Array) => encryptForRecipients(await gzipJson({ v: 1, documents }), [certDer]);

const segment = (weekId: string, generation: number, etag: string, extra: object = {}) => ({
    weekId,
    generation,
    origin: "zero-access",
    bytes: 1,
    etag,
    schemaVersion: 1,
    keyFingerprint: "fp",
    entryCount: 1,
    ...extra,
});

const indexedUids = (): string[] => rpc.indexLocalEntities.mock.calls.flatMap(([, entities]) => entities.map((e: any) => e.entityUid));

let key: Awaited<ReturnType<typeof zeroAccessKey>>;

beforeEach(async () => {
    key ??= await zeroAccessKey("fp-active");
    localStorage.clear();
    rpc.getLocalCoverage.mockResolvedValue({ indexedCount: 5 });
    rpc.indexLocalEntities.mockResolvedValue({ budgetReached: false });
    rpc.getIndexedVersions.mockResolvedValue({});
    // No live-tail lookup finds anything unless a test says so.
    mail.getMessage.mockRejectedValue(new ApiRequestError("gone", 404));
    api.listSearchIndexEntries.mockResolvedValue({ entries: [] });
    api.getSearchIndexManifest.mockResolvedValue({ mailboxUid: "mb", segments: [], weeks: [] });
});

afterEach(() => {
    vi.clearAllMocks();
});

const storage = new Map<string, string>();
const memoryStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: memoryStorage, configurable: true, writable: true });

describe("syncZeroAccessIndex", () => {
    it("does nothing without unlocked zero-access keys", async () => {
        expect(await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1) })).toEqual({
            segmentsImported: 0,
            clientSegmentsImported: 0,
            entriesImported: 0,
            weeksCompacted: 0,
            unreadable: 0,
        });
        expect(api.getSearchIndexManifest).not.toHaveBeenCalled();
    });

    it("imports each segment generation once, newest week first, and skips formats and files it can't read", async () => {
        const stranger = await zeroAccessKey("other");
        api.getSearchIndexManifest.mockResolvedValue({
            mailboxUid: "mb",
            segments: [segment("2026-W38", 1, "e38"), segment("2026-W40", 2, "e40"), segment("2026-W39", 1, "e39"), segment("2026-W37", 1, "e37", { schemaVersion: 2 }), segment("2026-W41", 1, "c41", { origin: "client" })],
            weeks: [],
        });
        api.getSearchIndexSegment.mockImplementation(async (_mb: string, s: any) =>
            s.weekId === "2026-W39" ? sealSegment([doc("m39")], stranger.certDer) : sealSegment([doc(`m${s.weekId.slice(-2)}`), { junk: true }], key.certDer),
        );

        const first = await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });
        expect(first).toMatchObject({ segmentsImported: 2, unreadable: 2 });
        expect(indexedUids()).toEqual(["m40", "m38"]);

        rpc.indexLocalEntities.mockClear();
        const second = await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });
        expect(second.segmentsImported).toBe(0);
        expect(indexedUids()).toEqual([]);

        // An empty local index (new device, destroyed index) imports everything again.
        rpc.getLocalCoverage.mockResolvedValue({ indexedCount: 0 });
        const third = await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });
        expect(third.segmentsImported).toBe(2);
    });

    it("imports the live tail, asking again from shortly before its last pass", async () => {
        const stranger = await zeroAccessKey("other");
        api.listSearchIndexEntries
            .mockResolvedValueOnce({ entries: [await sealEntry("e1", "2026-W43", doc("m1"), key.certDer)], next: "e1" })
            .mockResolvedValueOnce({ entries: [await sealEntry("e2", "2026-W43", doc("m2"), stranger.certDer)] });

        const first = await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });

        expect(first).toMatchObject({ entriesImported: 1, unreadable: 1 });
        expect(api.listSearchIndexEntries.mock.calls[0][1]).toEqual({});
        expect(api.listSearchIndexEntries.mock.calls[1][1]).toEqual({ after: "e1" });
        expect(indexedUids()).toEqual(["m1"]);

        api.listSearchIndexEntries.mockClear();
        await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });
        const since = new Date(api.listSearchIndexEntries.mock.calls[0][1].since).getTime();
        expect(since).toBeLessThanOrEqual(Date.now() - TAIL_OVERLAP_MS + 5_000);
        expect(since).toBeGreaterThan(Date.now() - TAIL_OVERLAP_MS - 60_000);
    });

    it("gives an imported row the folder and flags the builder saw before the row existed, once", async () => {
        rememberZeroAccessMetadata("mb", "m1", { folderUid: "inbox", entityVersion: "3:inbox", flags: ",read," });
        rememberZeroAccessMetadata("mb", "m1", { folderUid: "archive", entityVersion: "4:archive", flags: ",read,flagged," });
        api.listSearchIndexEntries.mockResolvedValue({ entries: [await sealEntry("e1", "2026-W43", doc("m1"), key.certDer), await sealEntry("e2", "2026-W43", doc("m2"), key.certDer)] });

        await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });
        expect(rpc.moveLocalEntity.mock.calls).toEqual([["mb", "m1", "archive", "4:archive", ",read,flagged,"]]);

        rpc.moveLocalEntity.mockClear();
        localStorage.clear();
        await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });
        expect(rpc.moveLocalEntity).not.toHaveBeenCalled();
    });

    it("gives a live-tail row nothing recorded its folder, version and flags at import, from the message", async () => {
        const message = (uid: string, fields: object = {}) => ({ uid, mailboxUid: "mb", folderUid: "inbox", version: 2, flags: { read: true, flagged: false, answered: true }, ...fields });
        rememberZeroAccessMetadata("mb", "m-remembered", { folderUid: "archive", entityVersion: "1:archive", flags: ",," });
        rpc.getIndexedVersions.mockResolvedValue({ "m-built": "5:inbox" });
        mail.getMessage.mockImplementation(async (uid: string) => {
            if (uid === "m-gone") {
                throw new ApiRequestError("gone", 404);
            }
            return uid === "m-elsewhere" ? message(uid, { mailboxUid: "other" }) : message(uid);
        });
        api.listSearchIndexEntries.mockResolvedValue({
            entries: await Promise.all(
                ["m-new", "m-built", "m-remembered", "m-gone", "m-elsewhere", "m-new"].map((uid, i) => sealEntry(`e${i}`, "2026-W43", doc(uid), key.certDer)),
            ),
        });

        await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] }, { baseUrl: "x" } as any);

        expect(rpc.getIndexedVersions).toHaveBeenCalledWith("mb", ["m-new", "m-built", "m-remembered", "m-gone", "m-elsewhere"]);
        expect(mail.getMessage.mock.calls.map(([uid]) => uid).sort()).toEqual(["m-elsewhere", "m-gone", "m-new"]);
        expect(mail.getMessage.mock.calls[0][1]).toEqual({ baseUrl: "x" });
        expect(rpc.moveLocalEntity.mock.calls).toEqual([
            ["mb", "m-remembered", "archive", "1:archive", ",,"],
            ["mb", "m-new", "inbox", "2:inbox", ",read,answered,"],
        ]);
        // Only after its row was imported.
        expect(rpc.moveLocalEntity.mock.invocationCallOrder[1]).toBeGreaterThan(rpc.indexLocalEntities.mock.invocationCallOrder[0]);
    });

    it(`looks up at most ${MAX_TAIL_LOOKUPS} live-tail rows a pass, and none for an empty tail`, async () => {
        await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });
        expect(rpc.getIndexedVersions).not.toHaveBeenCalled();

        api.listSearchIndexEntries.mockResolvedValue({
            entries: await Promise.all(Array.from({ length: MAX_TAIL_LOOKUPS + 5 }, (_, i) => sealEntry(`e${i}`, "2026-W43", doc(`m${i}`), key.certDer))),
        });
        mail.getMessage.mockImplementation(async (uid: string) => ({ uid, mailboxUid: "mb", folderUid: "inbox", version: 1, flags: {} }));

        await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });

        expect(mail.getMessage).toHaveBeenCalledTimes(MAX_TAIL_LOOKUPS);
        expect(rpc.moveLocalEntity).toHaveBeenCalledTimes(MAX_TAIL_LOOKUPS);
    });

    it("asks which live-tail rows are recorded in batches, only until it has as many as a pass looks up", async () => {
        // A backlog's tail (a whole mailbox's, on a new device) is more than one SQL statement may bind.
        api.listSearchIndexEntries.mockResolvedValue({
            entries: await Promise.all(Array.from({ length: 700 }, (_, i) => sealEntry(`e${i}`, "2026-W43", doc(`m${i}`), key.certDer))),
        });
        // The first batch is all recorded.
        rpc.getIndexedVersions.mockImplementation(async (_mb: string, uids: string[]) => Object.fromEntries(uids.filter((uid) => Number(uid.slice(1)) < 200).map((uid) => [uid, "1:inbox"])));

        const result = await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });

        expect(result.entriesImported).toBe(700);
        const asked: string[][] = rpc.getIndexedVersions.mock.calls.map(([, uids]) => uids);
        expect(asked.map((uids) => uids.length)).toEqual([200, 200, 200, 100]);
        expect(asked.flat()).toEqual(Array.from({ length: 700 }, (_, i) => `m${i}`));

        // None recorded: 600 unrecorded after three batches is more than a pass looks up, so the fourth isn't asked.
        rpc.getIndexedVersions.mockReset().mockResolvedValue({});
        await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });
        expect(rpc.getIndexedVersions).toHaveBeenCalledTimes(3);
    });

    it("forgets what it imported once the local index is destroyed, even after a build filled the new one first", async () => {
        api.getSearchIndexManifest.mockResolvedValue({ mailboxUid: "mb", segments: [segment("2026-W40", 1, "e40")], weeks: [] });
        api.getSearchIndexSegment.mockResolvedValue(await sealSegment([doc("m40")], key.certDer));
        expect((await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] })).segmentsImported).toBe(1);

        // The index is destroyed on a lock; the next build decrypts end-to-end mail into the new one, so it isn't empty.
        forgetZeroAccessSync("mb");
        rpc.getLocalCoverage.mockResolvedValue({ indexedCount: 1 });
        expect((await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] })).segmentsImported).toBe(1);
    });

    it("writes nothing back from a pass that was under way when the local index was destroyed", async () => {
        api.getSearchIndexManifest.mockResolvedValue({ mailboxUid: "mb", segments: [segment("2026-W40", 1, "e40")], weeks: [] });
        api.getSearchIndexSegment.mockResolvedValue(await sealSegment([doc("m40")], key.certDer));
        // Destroyed (a lock) while the pass reads the live tail.
        api.listSearchIndexEntries.mockImplementation(async () => {
            forgetZeroAccessSync("mb");
            return { entries: [] };
        });

        const result = await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });

        expect(result.segmentsImported).toBe(1);
        expect(storage.has("rapidmx:za-index-sync:mb")).toBe(false);
    });

    it("keeps at most so many messages' metadata per mailbox, dropping the oldest", async () => {
        for (let i = 0; i <= MAX_REMEMBERED_METADATA; i++) {
            rememberZeroAccessMetadata("big", `m${i}`, { folderUid: "inbox", entityVersion: "1:inbox", flags: ",," });
        }
        api.listSearchIndexEntries.mockResolvedValue({
            entries: [await sealEntry("e0", "2026-W43", doc("m0"), key.certDer), await sealEntry("e1", "2026-W43", doc("m1"), key.certDer)],
        });
        await syncZeroAccessIndex("big", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });
        expect(rpc.moveLocalEntity.mock.calls.map(([, uid]) => uid)).toEqual(["m1"]);
    });

    it("compacts a closed week: merges its entries into its segment, seals the result to the active key and folds only what it read", async () => {
        const stranger = await zeroAccessKey("other");
        api.getSearchIndexManifest.mockResolvedValue({
            mailboxUid: "mb",
            segments: [segment("2026-W40", 2, "e40")],
            weeks: [
                { weekId: "2026-W40", pendingEntries: 2, latestEntryAt: "", compactable: true },
                { weekId: "2026-W43", pendingEntries: 1, latestEntryAt: "", compactable: false },
            ],
        });
        api.getSearchIndexSegment.mockResolvedValue(await sealSegment([doc("old"), doc("m1", { subject: "stale" })], key.certDer));
        const weekEntries = [await sealEntry("e1", "2026-W40", doc("m1"), key.certDer), await sealEntry("e2", "2026-W40", doc("m2"), stranger.certDer)];
        api.listSearchIndexEntries.mockImplementation(async (_mb: string, filter: any) => ({ entries: filter.week === "2026-W40" ? weekEntries : [] }));
        api.putSearchIndexSegment.mockResolvedValue(segment("2026-W40", 3, "e40-3"));

        const result = await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key, stranger] }, { baseUrl: "x" } as any);

        expect(result.weeksCompacted).toBe(1);
        const [mailbox, week, upload, client] = api.putSearchIndexSegment.mock.calls[0];
        expect([mailbox, week, client]).toEqual(["mb", "2026-W40", { baseUrl: "x" }]);
        expect(upload).toMatchObject({ expectedGeneration: 2, keyFingerprint: "fp-active", schemaVersion: 1, foldedEntryUids: ["e1", "e2"] });
        const bundle = await gunzipJson(await decryptEnvelopedDataWithKeys(fromBase64(upload.segment), [key]));
        expect(bundle.v).toBe(1);
        expect(bundle.documents.map((d: any) => [d.messageUid, d.subject])).toEqual([
            ["old", "Subject old"],
            ["m1", "Subject m1"],
            ["m2", "Subject m2"],
        ]);
    });

    it("leaves a week alone when its segment won't open or none of its entries do, and when another device wins", async () => {
        const stranger = await zeroAccessKey("other");
        api.getSearchIndexManifest.mockResolvedValue({
            mailboxUid: "mb",
            segments: [segment("2026-W40", 1, "e40")],
            weeks: [
                { weekId: "2026-W40", pendingEntries: 1, latestEntryAt: "", compactable: true },
                { weekId: "2026-W41", pendingEntries: 1, latestEntryAt: "", compactable: true },
                { weekId: "2026-W42", pendingEntries: 1, latestEntryAt: "", compactable: true },
            ],
        });
        api.getSearchIndexSegment.mockResolvedValue(await sealSegment([doc("x")], stranger.certDer));
        api.listSearchIndexEntries.mockImplementation(async (_mb: string, filter: any) => ({
            entries:
                filter.week === "2026-W41"
                    ? [await sealEntry("u", "2026-W41", doc("u"), stranger.certDer)]
                    : filter.week === "2026-W42"
                      ? [await sealEntry("k", "2026-W42", doc("k"), key.certDer)]
                      : [],
        }));
        api.putSearchIndexSegment.mockRejectedValue(new ApiRequestError("changed", 409));

        const result = await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });

        expect(result.weeksCompacted).toBe(0);
        expect(api.putSearchIndexSegment.mock.calls.map(([, week]) => week)).toEqual(["2026-W42"]);
    });

    it("waits out this platform's delay after the week became compactable", async () => {
        const now = Date.now();
        api.getSearchIndexManifest.mockResolvedValue({
            mailboxUid: "mb",
            segments: [],
            weeks: [
                // Compactable an hour ago: a computer's browser waits six.
                { weekId: "2026-W41", pendingEntries: 1, latestEntryAt: "", compactable: true, compactableAt: new Date(now - 3_600_000).toISOString(), pendingBytes: 10 },
                { weekId: "2026-W42", pendingEntries: 1, latestEntryAt: "", compactable: true, compactableAt: new Date(now - 7 * 3_600_000).toISOString(), pendingBytes: 10 },
            ],
        });
        api.listSearchIndexEntries.mockImplementation(async (_mb: string, filter: any) => ({
            entries: filter.week ? [await sealEntry(`e-${filter.week}`, filter.week, doc(filter.week), key.certDer)] : [],
        }));
        api.putSearchIndexSegment.mockResolvedValue(segment("2026-W42", 1, "e42"));

        await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] });

        expect(api.putSearchIndexSegment.mock.calls.map(([, week]) => week)).toEqual(["2026-W42"]);
    });

    it("rejects with any other upload failure", async () => {
        api.getSearchIndexManifest.mockResolvedValue({ mailboxUid: "mb", segments: [], weeks: [{ weekId: "2026-W42", pendingEntries: 1, latestEntryAt: "", compactable: true }] });
        api.listSearchIndexEntries.mockImplementation(async (_mb: string, filter: any) => ({
            entries: filter.week ? [await sealEntry("k", "2026-W42", doc("k"), key.certDer)] : [],
        }));
        api.putSearchIndexSegment.mockRejectedValue(new ApiRequestError("boom", 500));

        await expect(syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] })).rejects.toMatchObject({ status: 500 });
    });

    it("works on without storage, and starts over from corrupt state", async () => {
        storage.set("rapidmx:za-index-sync:mb", "{not json");
        expect((await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] })).entriesImported).toBe(0);

        const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); }, clear: () => undefined };
        Object.defineProperty(globalThis, "localStorage", { value: throwing, configurable: true, writable: true });
        try {
            await expect(syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1), zeroAccessKeys: [key] })).resolves.toBeDefined();
            expect(() => forgetZeroAccessSync("mb")).not.toThrow();
        } finally {
            Object.defineProperty(globalThis, "localStorage", { value: memoryStorage, configurable: true, writable: true });
        }
        storage.set("rapidmx:za-index-sync:mb", JSON.stringify({ segments: {} }));
        forgetZeroAccessSync("mb");
        expect(storage.has("rapidmx:za-index-sync:mb")).toBe(false);
    });
});

describe("documentEntity", () => {
    it("maps a document to a local index row without folder or flags, and copes with a missing date", () => {
        expect(documentEntity("mb", doc("m1") as any)).toMatchObject({
            entityType: "message",
            entityUid: "m1",
            mailboxUid: "mb",
            dateForSort: "2026-10-01T00:00:00.000Z",
            participants: "bob@example.org Bob",
            flags: "",
            hasAttachments: true,
            subject: "Subject m1",
            body: "Body m1",
            attachmentText: "a.pdf\npdf text",
        });
        const bare = documentEntity("mb", { ...doc("m2"), dateForSort: Number.NaN, participants: undefined, attachmentNames: undefined, attachmentText: undefined } as any);
        expect(bare).toMatchObject({ dateForSort: "1970-01-01T00:00:00.000Z", participants: "", hasAttachments: false, attachmentText: "" });
    });
});

/** A local index row of an end-to-end message, as the builder makes it. */
const entity = (uid: string, extra: object = {}) => ({
    entityType: "message" as const,
    entityUid: uid,
    mailboxUid: "mb",
    folderUid: "inbox",
    dateForSort: "2026-10-21T12:00:00.000Z",
    participants: "alice@example.com",
    flags: ",read,",
    hasAttachments: false,
    subject: `Subject ${uid}`,
    body: `Body ${uid}`,
    byteSize: 10,
    entityVersion: `1:inbox`,
    ...extra,
});

const clientSegment = (weekId: string, generation: number, etag: string) => segment(weekId, generation, etag, { origin: "client" });

describe("client segments (Source C)", () => {
    const unlocked = () => ({ masterKey: new Uint8Array(1), zeroAccessKeys: [key] });

    it("imports each client segment generation once, newest week first, with its folder, flags and version, under the caller's generation", async () => {
        const stranger = await zeroAccessKey("other");
        api.getSearchIndexManifest.mockResolvedValue({
            mailboxUid: "mb",
            segments: [clientSegment("2026-W41", 1, "c41"), clientSegment("2026-W43", 2, "c43"), clientSegment("2026-W42", 1, "c42"), segment("2026-W43", 1, "z43")],
            weeks: [],
        });
        api.getSearchIndexSegment.mockImplementation(async (_mb: string, s: any) =>
            s.weekId === "2026-W42"
                ? sealSegment([clientDocument(entity("x"))], stranger.certDer)
                : sealSegment([clientDocument(entity(`m${s.weekId.slice(-2)}`)), { v: 1, junk: true }], key.certDer),
        );

        expect(await importClientSegments("mb", unlocked(), undefined, { generation: 7 })).toBe(2);
        expect(indexedUids()).toEqual(["m43", "m41"]);
        const [, rows, generation] = rpc.indexLocalEntities.mock.calls[0];
        expect(generation).toBe(7);
        expect(rows[0]).toMatchObject({ entityUid: "m43", mailboxUid: "mb", folderUid: "inbox", flags: ",read,", entityVersion: "1:inbox", subject: "Subject m43" });

        rpc.indexLocalEntities.mockClear();
        expect(await importClientSegments("mb", unlocked())).toBe(0);
        expect(await importClientSegments("mb", { masterKey: new Uint8Array(1) })).toBe(0);
        expect(indexedUids()).toEqual([]);
    });

    it("drops the stored state of an index that is gone when a build starts on an empty one, even when the manifest can't be read", async () => {
        // A sync pass of the index that was pruned (or discarded as corrupted) remembered its segments.
        storage.set("rapidmx:za-index-sync:mb", JSON.stringify({ segments: { "2026-W43:zero-access": "z43" } }));
        rpc.getLocalCoverage.mockResolvedValue({ indexedCount: 0 });
        api.getSearchIndexManifest.mockRejectedValueOnce(new Error("offline"));

        await expect(importClientSegments("mb", unlocked())).rejects.toThrow("offline");
        expect(storage.has("rapidmx:za-index-sync:mb")).toBe(false);

        // The build then fills the index with end-to-end mail: the next pass imports the zero-access segment it never got.
        rpc.getLocalCoverage.mockResolvedValue({ indexedCount: 3 });
        api.getSearchIndexManifest.mockResolvedValue({ mailboxUid: "mb", segments: [segment("2026-W43", 1, "z43")], weeks: [] });
        api.getSearchIndexSegment.mockResolvedValue(await sealSegment([doc("m1")], key.certDer));
        expect((await syncZeroAccessIndex("mb", unlocked())).segmentsImported).toBe(1);
    });

    it("starts over on an empty index where storage can't be written", async () => {
        rpc.getLocalCoverage.mockResolvedValue({ indexedCount: 0 });
        const removeItem = vi.spyOn(memoryStorage, "removeItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(await importClientSegments("mb", unlocked())).toBe(0);
        expect(removeItem).toHaveBeenCalled();
        removeItem.mockRestore();
    });

    it("imports client segments in a sync pass too, from the manifest it already read", async () => {
        api.getSearchIndexManifest.mockResolvedValue({ mailboxUid: "mb", segments: [clientSegment("2026-W43", 1, "c43")], weeks: [] });
        api.getSearchIndexSegment.mockResolvedValue(await sealSegment([clientDocument(entity("m1"))], key.certDer));

        const result = await syncZeroAccessIndex("mb", unlocked());

        expect(result.clientSegmentsImported).toBe(1);
        expect(api.getSearchIndexManifest).toHaveBeenCalledTimes(1);
        expect(indexedUids()).toEqual(["m1"]);
    });

    it("uploads what was decrypted per week, merged into the week's segment and sealed to the active key, leaving unchanged weeks alone", async () => {
        const older = await zeroAccessKey("fp-older");
        api.getSearchIndexManifest.mockResolvedValue({ mailboxUid: "mb", segments: [clientSegment("2026-W43", 3, "c43"), clientSegment("2026-W40", 1, "c40")], weeks: [] });
        api.getSearchIndexSegment.mockImplementation(async (_mb: string, s: any) =>
            sealSegment(s.weekId === "2026-W43" ? [clientDocument(entity("kept")), clientDocument(entity("same"))] : [clientDocument(entity("w40"))], key.certDer),
        );
        api.putSearchIndexSegment.mockImplementation(async (_mb: string, weekId: string) => ({ weekId, origin: "client", etag: `new-${weekId}` }));
        // This device imported week 43's current generation, so the new one is already in its index.
        await importClientSegments("mb", unlocked());

        const written = await uploadClientDocuments(
            "mb",
            { masterKey: new Uint8Array(1), zeroAccessKeys: [key, older] },
            [entity("same"), entity("new", { entityVersion: "2:inbox" }), entity("w40", { dateForSort: "2026-10-01T00:00:00.000Z" }), entity("w44", { dateForSort: "2026-10-26T00:00:00.000Z" })],
        );

        expect(written).toBe(2);
        expect(api.putSearchIndexSegment.mock.calls.map(([, weekId, upload]) => [weekId, upload.expectedGeneration, upload.origin, upload.keyFingerprint])).toEqual([
            ["2026-W43", 3, "client", "fp-active"],
            ["2026-W44", 0, "client", "fp-active"],
        ]);
        const bundle = await gunzipJson(await decryptEnvelopedDataWithKeys(fromBase64(api.putSearchIndexSegment.mock.calls[0][2].segment), [key]));
        expect(bundle.documents.map((d: any) => d.messageUid)).toEqual(["kept", "same", "new"]);
        expect(bundle.documents[2]).toEqual(clientDocument(entity("new", { entityVersion: "2:inbox" })));

        // The new week 43 generation is remembered; week 44's (never imported here) isn't, so the next import reads it.
        rpc.indexLocalEntities.mockClear();
        api.getSearchIndexManifest.mockResolvedValue({ mailboxUid: "mb", segments: [clientSegment("2026-W43", 4, "new-2026-W43"), clientSegment("2026-W44", 1, "new-2026-W44")], weeks: [] });
        api.getSearchIndexSegment.mockResolvedValue(await sealSegment([clientDocument(entity("w44"))], key.certDer));
        expect(await importClientSegments("mb", unlocked())).toBe(1);
    });

    it("retries a week another device replaced first, leaves one it can't read, and rethrows any other failure", async () => {
        const stranger = await zeroAccessKey("other");
        api.getSearchIndexManifest
            .mockResolvedValueOnce({ mailboxUid: "mb", segments: [], weeks: [] })
            .mockResolvedValue({ mailboxUid: "mb", segments: [clientSegment("2026-W43", 1, "c43")], weeks: [] });
        api.getSearchIndexSegment.mockResolvedValue(await sealSegment([clientDocument(entity("theirs"))], key.certDer));
        api.putSearchIndexSegment.mockRejectedValueOnce(new ApiRequestError("conflict", 409)).mockResolvedValue({ weekId: "2026-W43", origin: "client", etag: "e" });

        expect(await uploadClientDocuments("mb", unlocked(), [entity("mine")])).toBe(1);
        expect(api.putSearchIndexSegment.mock.calls.map(([, , upload]) => upload.expectedGeneration)).toEqual([0, 1]);

        // Lost every race.
        api.putSearchIndexSegment.mockReset().mockRejectedValue(new ApiRequestError("conflict", 409));
        expect(await uploadClientDocuments("mb", unlocked(), [entity("mine2")])).toBe(0);
        expect(api.putSearchIndexSegment).toHaveBeenCalledTimes(CLIENT_UPLOAD_ATTEMPTS);

        api.getSearchIndexSegment.mockResolvedValue(await sealSegment([clientDocument(entity("theirs"))], stranger.certDer));
        api.putSearchIndexSegment.mockClear();
        expect(await uploadClientDocuments("mb", unlocked(), [entity("mine3")])).toBe(0);
        expect(api.putSearchIndexSegment).not.toHaveBeenCalled();

        api.getSearchIndexManifest.mockResolvedValue({ mailboxUid: "mb", segments: [], weeks: [] });
        api.putSearchIndexSegment.mockRejectedValue(new ApiRequestError("boom", 500));
        await expect(uploadClientDocuments("mb", unlocked(), [entity("mine4")])).rejects.toMatchObject({ status: 500 });

        expect(await uploadClientDocuments("mb", unlocked(), [])).toBe(0);
        expect(await uploadClientDocuments("mb", { masterKey: new Uint8Array(1) }, [entity("x")])).toBe(0);
    });

    it("maps rows to documents and back, and names ISO weeks across a year boundary", () => {
        const bare = { ...entity("b"), folderUid: undefined, subject: undefined, body: undefined, entityVersion: undefined };
        expect(clientDocumentEntity("mb", JSON.parse(JSON.stringify(clientDocument(bare))))).toEqual({
            entityType: "message",
            entityUid: "b",
            mailboxUid: "mb",
            dateForSort: bare.dateForSort,
            participants: "alice@example.com",
            flags: ",read,",
            hasAttachments: false,
            byteSize: "alice@example.com".length,
        });
        const full = clientDocumentEntity("mb", { ...clientDocument(entity("f", { attachmentText: "pdf" })), flags: undefined, hasAttachments: "yes" } as any);
        expect(full).toMatchObject({ flags: "", hasAttachments: false, attachmentText: "pdf", folderUid: "inbox", entityVersion: "1:inbox" });

        expect(isoWeekId(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
        expect(isoWeekId(new Date("2026-12-31T23:00:00Z"))).toBe("2026-W53");
        expect(isoWeekId(new Date("2027-01-03T12:00:00Z"))).toBe("2026-W53");
        expect(isoWeekId(new Date("2027-01-04T00:00:00Z"))).toBe("2027-W01");
    });
});

describe("shouldCompact", () => {
    const NOW = Date.UTC(2026, 9, 24, 12);
    const week = (fields: Record<string, unknown> = {}) => ({
        weekId: "2026-W42",
        pendingEntries: 3,
        latestEntryAt: "",
        compactable: true,
        compactableAt: new Date(NOW - 2 * 86_400_000).toISOString(),
        pendingBytes: 1000,
        ...fields,
    });
    const at = (hoursAfter: number) => ({ compactableAt: new Date(NOW - hoursAfter * 3_600_000).toISOString() });

    it("lets a desktop take a week at once, a browser after six hours and a phone after a day", () => {
        expect(COMPACTION_DELAY_MS).toEqual({ desktop: 0, web: 6 * 3_600_000, mobile: 24 * 3_600_000 });
        expect(shouldCompact(week(at(0)), 0, "desktop", NOW, false)).toBe(true);
        expect(shouldCompact(week(at(5)), 0, "web", NOW, false)).toBe(false);
        expect(shouldCompact(week(at(6)), 0, "web", NOW, false)).toBe(true);
        expect(shouldCompact(week(at(23)), 0, "mobile", NOW, false)).toBe(false);
        expect(shouldCompact(week(at(24)), 0, "mobile", NOW, false)).toBe(true);
    });

    it("never takes a week that isn't compactable or has nothing pending", () => {
        expect(shouldCompact(week({ compactable: false }), 0, "desktop", NOW, false)).toBe(false);
        expect(shouldCompact(week({ pendingEntries: 0 }), 0, "desktop", NOW, false)).toBe(false);
    });

    it("has a phone decline a large week, a cellular or data-saver connection, and a week of unknown size or start", () => {
        expect(shouldCompact(week({ pendingBytes: MOBILE_COMPACTION_MAX_BYTES - 100 }), 100, "mobile", NOW, false)).toBe(true);
        expect(shouldCompact(week({ pendingBytes: MOBILE_COMPACTION_MAX_BYTES - 100 }), 101, "mobile", NOW, false)).toBe(false);
        expect(shouldCompact(week(), 0, "mobile", NOW, true)).toBe(false);
        expect(shouldCompact(week({ pendingBytes: undefined }), 0, "mobile", NOW, false)).toBe(false);
        expect(shouldCompact(week({ compactableAt: undefined }), 0, "mobile", NOW, false)).toBe(false);
        // Size and connection don't matter to a computer.
        expect(shouldCompact(week({ pendingBytes: 10 * MOBILE_COMPACTION_MAX_BYTES }), 0, "web", NOW, true)).toBe(true);
    });

    it("compacts as before on a server that doesn't say when a week became compactable", () => {
        expect(shouldCompact(week({ compactableAt: undefined, pendingBytes: undefined }), 0, "web", NOW, false)).toBe(true);
        expect(shouldCompact(week({ compactableAt: undefined }), 0, "desktop", NOW, false)).toBe(true);
    });
});
