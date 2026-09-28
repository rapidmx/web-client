// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { findWellKnownFolderUid } from "../../../apps/shared/mail/findWellKnownFolderUid.js";
import type { ApiClient } from "../../../lib/util/api.js";

function folder(uid: string, type: string, mailboxUid = "mb1") {
    return { uid, version: 0, dateCreated: "", dateModified: "", mailboxUid, name: type, type, unreadCount: 0, totalCount: 0 };
}

describe("findWellKnownFolderUid", () => {
    it("resolves the folder of that type through the default global fetch when no client is given", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [folder("f1", "inbox"), folder("f2", "tasks")]));
        expect(await findWellKnownFolderUid("mb1", "tasks")).toBe("f2");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toContain("mailboxUid=mb1");
    });

    it("resolves undefined for a mailbox with no folder of that type", async () => {
        mockFetch(() => jsonResponse(200, [folder("f1", "inbox")]));
        expect(await findWellKnownFolderUid("mb1", "tasks")).toBeUndefined();
    });

    it("asks the given ApiClient instead of the global fetch when one is given", async () => {
        const fetchMock = mockFetch(() => jsonResponse(500, {}));
        const clientFetch = vi.fn().mockResolvedValue([folder("f9", "contacts")]);
        const client: ApiClient = { fetch: clientFetch, setUnauthorizedObserver: vi.fn() };

        expect(await findWellKnownFolderUid("mb1", "contacts", client)).toBe("f9");
        expect(clientFetch).toHaveBeenCalledTimes(1);
        expect(clientFetch.mock.calls[0][0]).toContain("mailboxUid=mb1");
        // The default global fetch was never touched.
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
