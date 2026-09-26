// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { clearResolvedFolders, resolveFolderOfType } from "../../../apps/shared/mail/folderOfType.js";

function folder(uid: string, type: string, mailboxUid = "mb1") {
    return { uid, version: 0, dateCreated: "", dateModified: "", mailboxUid, name: type, type, unreadCount: 0, totalCount: 0 };
}

afterEach(() => {
    clearResolvedFolders();
});

describe("resolveFolderOfType", () => {
    it("uses the folder the tree already has for that mailbox, without a request", async () => {
        const fetchMock = mockFetch(() => jsonResponse(500, {}));
        const uid = await resolveFolderOfType("mb1", "junk", "Junk Email", [folder("j2", "junk", "mb2"), folder("j1", "junk")] as never);
        expect(uid).toBe("j1");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("asks the server for a folder the tree lacks, tells the caller about it, and remembers it", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [folder("i1", "inbox", "mb2"), folder("j2", "junk", "mb2")]));
        const onFound = vi.fn();
        // The tree only has another mailbox's Junk - which is not this message's.
        expect(await resolveFolderOfType("mb2", "junk", "Junk Email", [folder("j1", "junk")] as never, onFound)).toBe("j2");
        expect(fetchMock.mock.calls[0][0]).toContain("/api/mail/folders?");
        expect(fetchMock.mock.calls[0][0]).toContain("mailboxUid=mb2");
        expect(onFound).toHaveBeenCalledWith(expect.objectContaining({ uid: "j2" }));
        expect(await resolveFolderOfType("mb2", "junk", "Junk Email")).toBe("j2");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("needs no caller to be told", async () => {
        mockFetch(() => jsonResponse(200, [folder("j1", "junk")]));
        expect(await resolveFolderOfType("mb1", "junk", "Junk Email")).toBe("j1");
    });

    it("makes the folder only when the server has none, and remembers that too", async () => {
        const fetchMock = mockFetch((url, init) =>
            init?.method === "POST" ? jsonResponse(200, folder("j9", "junk")) : jsonResponse(200, [folder("i1", "inbox")]),
        );
        expect(await resolveFolderOfType("mb1", "junk", "Junk Email")).toBe("j9");
        const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
        expect(post[0]).toBe("/api/mail/folders");
        expect(JSON.parse(post[1].body as string)).toMatchObject({ mailboxUid: "mb1", name: "Junk Email", type: "junk" });
        expect(await resolveFolderOfType("mb1", "junk", "Junk Email")).toBe("j9");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
