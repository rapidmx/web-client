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
const rpc = vi.hoisted(() => ({ getLocalCoverage: vi.fn(), indexLocalEntities: vi.fn() }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => rpc);

const { documentEntity, forgetZeroAccessSync, syncZeroAccessIndex, TAIL_OVERLAP_MS } = await import("../../../apps/shared/search/zeroAccessIndexSync.js");

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
        expect(await syncZeroAccessIndex("mb", { masterKey: new Uint8Array(1) })).toEqual({ segmentsImported: 0, entriesImported: 0, weeksCompacted: 0, unreadable: 0 });
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
