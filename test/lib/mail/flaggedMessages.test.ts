// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { FLAGGED_FOLDER_CONCURRENCY, FLAGGED_MAX_PAGES_PER_FOLDER, listFlaggedMessages } from "../../../lib/mail/flaggedMessages.js";
import type { ApiClient } from "../../../lib/util/api.js";

function folder(uid: string, type: string) {
    return {
        uid,
        version: 0,
        dateCreated: "",
        dateModified: "",
        mailboxUid: "mb1",
        name: type,
        type,
        unreadCount: 0,
        totalCount: 0,
    };
}

function message(uid: string, flagged: boolean, receivedDate: string) {
    return {
        uid,
        version: 0,
        dateCreated: "",
        dateModified: "",
        folderUid: "f-inbox",
        mailboxUid: "mb1",
        messageId: `${uid}@test`,
        subject: uid,
        from: { address: "a@example.com", type: "to" },
        recipients: [],
        sentDate: receivedDate,
        receivedDate,
        bodyPreview: "",
        flags: { read: true, flagged, answered: false, forwarded: false },
        importance: "normal",
        hasAttachments: false,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listFlaggedMessages", () => {
    it("returns an empty list when the mailbox has no mail folders at all.", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder("f-cal", "calendar")]);
            throw new Error(`unexpected ${url}`);
        });
        const result = await listFlaggedMessages("mb1");
        expect(result).toEqual([]);
    });

    it("returns an empty list when no message in any mail folder is flagged.", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder("f-inbox", "inbox")]);
            if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [message("m1", false, "2026-01-01T00:00:00.000Z")]);
            throw new Error(`unexpected ${url}`);
        });
        const result = await listFlaggedMessages("mb1");
        expect(result).toEqual([]);
    });

    it("fans out across every mail folder (excluding calendar/contacts/tasks/notes), merging flagged messages newest-first.", async () => {
        const folders = [
            folder("f-inbox", "inbox"),
            folder("f-sent", "sent_items"),
            folder("f-cal", "calendar"),
            folder("f-contacts", "contacts"),
            folder("f-tasks", "tasks"),
        ];
        const fetchMock = mockFetch((url) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
            if (url.includes("folderUid=f-inbox")) {
                return jsonResponse(200, [message("older", true, "2026-01-01T00:00:00.000Z"), message("not-flagged", false, "2026-01-05T00:00:00.000Z")]);
            }
            if (url.includes("folderUid=f-sent")) {
                return jsonResponse(200, [message("newer", true, "2026-01-10T00:00:00.000Z")]);
            }
            throw new Error(`unexpected ${url}`);
        });

        const result = await listFlaggedMessages("mb1");

        expect(result.map((m) => m.uid)).toEqual(["newer", "older"]);
        // Only inbox/sent_items should ever have been queried — calendar/contacts/tasks folders excluded.
        expect(fetchMock.mock.calls.filter((c) => (c[0] as string).startsWith("/api/mail/messages"))).toHaveLength(2);
    });

    it("pages through a folder holding more than one 500-message page, and includes archive folders.", async () => {
        const fullPage = Array.from({ length: 500 }, (_, i) => message(`p0-${i}`, false, "2026-01-01T00:00:00.000Z"));
        const fetchMock = mockFetch((url) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder("f-archive", "archive")]);
            if (url.includes("folderUid=f-archive") && url.includes("page=0")) return jsonResponse(200, fullPage);
            if (url.includes("folderUid=f-archive") && url.includes("page=1")) {
                return jsonResponse(200, [message("second-page-flagged", true, "2026-01-02T00:00:00.000Z")]);
            }
            throw new Error(`unexpected ${url}`);
        });

        const result = await listFlaggedMessages("mb1");

        expect(result.map((m) => m.uid)).toEqual(["second-page-flagged"]);
        const messageCalls = fetchMock.mock.calls.map((c) => c[0] as string).filter((u) => u.startsWith("/api/mail/messages"));
        expect(messageCalls).toHaveLength(2);
        expect(messageCalls[0]).toContain("limit=500");
    });
});

describe("listFlaggedMessages paging safety (round-4 review)", () => {
    it("stops at the per-folder page cap when a server ignores page and never returns a short page, deduping by uid", async () => {
        let pageCounter = 0;
        const fetchMock = mockFetch((url) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder("f-inbox", "inbox")]);
            // Every page is full and new, so only the hard cap can end the loop.
            const page = pageCounter++;
            return jsonResponse(
                200,
                Array.from({ length: 500 }, (_, i) => message(`p${page}-${i}`, i === 0, "2026-01-01T00:00:00.000Z")),
            );
        });
        const result = await listFlaggedMessages("mb1");
        expect(fetchMock.mock.calls.filter((c) => (c[0] as string).startsWith("/api/mail/messages"))).toHaveLength(FLAGGED_MAX_PAGES_PER_FOLDER);
        expect(result).toHaveLength(FLAGGED_MAX_PAGES_PER_FOLDER);
    });

    it("stops as soon as a full page repeats already-seen messages, and lists a message found in two folders once", async () => {
        const fullPage = Array.from({ length: 500 }, (_, i) => message(`m${i}`, i < 2, `2026-01-0${(i % 9) + 1}T00:00:00.000Z`));
        const fetchMock = mockFetch((url) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder("f-inbox", "inbox"), folder("f-archive", "archive")]);
            if (url.includes("folderUid=f-inbox")) return jsonResponse(200, fullPage);
            return jsonResponse(200, [message("m1", true, "2026-01-02T00:00:00.000Z")]);
        });
        const result = await listFlaggedMessages("mb1");
        expect(result.map((m) => m.uid)).toEqual(["m1", "m0"]);
        expect(fetchMock.mock.calls.filter((c) => (c[0] as string).includes("folderUid=f-inbox"))).toHaveLength(2);
    });

    it("pages through at most FLAGGED_FOLDER_CONCURRENCY folders at once", async () => {
        const folders = Array.from({ length: 10 }, (_, i) => folder(`f${i}`, "user"));
        let inFlight = 0;
        let maxInFlight = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 5));
                inFlight--;
                return jsonResponse(200, [message(url, true, "2026-01-01T00:00:00.000Z")]);
            }),
        );
        expect(await listFlaggedMessages("mb1")).toHaveLength(10);
        expect(maxInFlight).toBe(FLAGGED_FOLDER_CONCURRENCY);
    });
});

describe("listFlaggedMessages explicit ApiClient", () => {
    it("asks the default global fetch when no client is given (unchanged behavior)", async () => {
        const fetchMock = mockFetch((url) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder("f-inbox", "inbox")]);
            if (url.startsWith("/api/mail/messages")) return jsonResponse(200, [message("m1", true, "2026-01-01T00:00:00.000Z")]);
            throw new Error(`unexpected ${url}`);
        });
        const result = await listFlaggedMessages("mb1");
        expect(result.map((m) => m.uid)).toEqual(["m1"]);
        expect(fetchMock).toHaveBeenCalled();
    });

    it("routes both listFolders and listMessages through the given ApiClient instead of the global fetch", async () => {
        const fetchMock = mockFetch(() => jsonResponse(500, {}));
        const clientFetch = vi.fn().mockImplementation(async (path: string) => {
            if (path.startsWith("/mail/folders")) return [folder("f-inbox", "inbox")];
            if (path.startsWith("/mail/messages")) return [message("m1", true, "2026-01-01T00:00:00.000Z")];
            throw new Error(`unexpected ${path}`);
        });
        const client: ApiClient = { fetch: clientFetch, setUnauthorizedObserver: vi.fn() };

        const result = await listFlaggedMessages("mb1", client);

        expect(result.map((m) => m.uid)).toEqual(["m1"]);
        expect(clientFetch.mock.calls.some((c) => c[0].startsWith("/mail/folders"))).toBe(true);
        expect(clientFetch.mock.calls.some((c) => c[0].startsWith("/mail/messages"))).toBe(true);
        // The default global fetch was never touched.
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
