///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    getSearchIndexManifest,
    getSearchIndexSegment,
    listSearchIndexEntries,
    putSearchIndexSegment,
} from "../../../lib/search/zeroAccessIndexApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("zeroAccessIndexApi", () => {
    it("reads the manifest", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { mailboxUid: "m/1", segments: [], weeks: [] }));
        await expect(getSearchIndexManifest("m/1")).resolves.toMatchObject({ mailboxUid: "m/1" });
        expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/mailboxes/m%2F1/search-index/manifest");
    });

    it("lists entries with only the filters given", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { entries: [] }));
        await listSearchIndexEntries("mb");
        await listSearchIndexEntries("mb", { week: "2026-W43", since: "2026-10-23T00:00:00.000Z", after: "e1", limit: 50 });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            "/api/mail/mailboxes/mb/search-index/entries",
            "/api/mail/mailboxes/mb/search-index/entries?week=2026-W43&since=2026-10-23T00%3A00%3A00.000Z&after=e1&limit=50",
        ]);
    });

    it("downloads a segment generation's bytes, naming the origin only for a client segment", async () => {
        const fetchMock = mockFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
        await expect(getSearchIndexSegment("mb", { weekId: "2026-W40", generation: 2, origin: "zero-access" })).resolves.toEqual(new Uint8Array([1, 2, 3]));
        await getSearchIndexSegment("mb", { weekId: "2026-W40", generation: 1, origin: "client" });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            "/api/mail/mailboxes/mb/search-index/segments/2026-W40?generation=2",
            "/api/mail/mailboxes/mb/search-index/segments/2026-W40?generation=1&origin=client",
        ]);
    });

    it("uploads a compaction", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { weekId: "2026-W40", generation: 1 }));
        const upload = { expectedGeneration: 0, segment: "AA==", keyFingerprint: "fp", schemaVersion: 1, foldedEntryUids: ["e1"] };
        await expect(putSearchIndexSegment("mb", "2026-W40", upload)).resolves.toMatchObject({ generation: 1 });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb/search-index/segments/2026-W40",
            expect.objectContaining({ method: "PUT", body: JSON.stringify(upload) }),
        );
    });
});
