// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { CONVERSATION_SCAN_LIMIT, listConversationMessages, listConversations } from "../../../lib/mail/conversationsApi.js";

const conversation = {
    conversationId: "c1",
    subject: "Hello there",
    messageUids: ["m1", "m2"],
    folderUids: ["f1"],
    messageCount: 2,
    unreadCount: 1,
    latestDate: "2026-01-01T00:00:00.000Z",
    participants: [{ address: "sender@example.com", displayName: "Sender One", type: "to" }],
    hasAttachments: false,
    flagged: true,
    latestMessageUid: "m2",
    latestFrom: { address: "sender@example.com", type: "to" },
    latestPreview: "Sounds good",
    latestFolderUid: "f1",
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listConversations", () => {
    it("fetches with the mailboxUid query param, no pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [conversation]));
        const result = await listConversations("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/conversations?mailboxUid=mb1", expect.anything());
        expect(result).toEqual([conversation]);
    });

    it("encodes the mailboxUid", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listConversations("mb/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/conversations?mailboxUid=mb%2F1", expect.anything());
    });

    it("passes folderUid, filter and paging through when they are set", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listConversations("mb1", { folderUid: "f/1", filter: "unread", limit: CONVERSATION_SCAN_LIMIT, page: 2 });
        expect(fetchMock).toHaveBeenCalledWith(
            `/api/mail/messages/conversations?mailboxUid=mb1&folderUid=f%2F1&filter=unread&limit=${CONVERSATION_SCAN_LIMIT}&page=2`,
            expect.anything(),
        );
    });

    it("leaves out an unset or empty optional param rather than sending a blank one", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listConversations("mb1", { folderUid: "", filter: undefined, page: 0 });
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/conversations?mailboxUid=mb1&page=0", expect.anything());
    });

    it("sends a label selection as one comma-separated labelUids value, and an empty one not at all", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listConversations("mb1", { filter: "unread", labelUids: ["lbl-red", "lbl-blue"] });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/conversations?mailboxUid=mb1&filter=unread&labelUids=lbl-red%2Clbl-blue",
            expect.anything(),
        );

        await listConversations("mb1", { labelUids: [] });
        expect(fetchMock).toHaveBeenLastCalledWith("/api/mail/messages/conversations?mailboxUid=mb1", expect.anything());
    });
});

describe("listConversationMessages", () => {
    it("fetches one conversation's messages, encoding both ids", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listConversationMessages("mb/1", "root@example.com");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/conversations/root%40example.com?mailboxUid=mb%2F1",
            expect.anything(),
        );
    });

    it("passes paging through", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listConversationMessages("mb1", "c1", { limit: 50, page: 1 });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/messages/conversations/c1?mailboxUid=mb1&limit=50&page=1",
            expect.anything(),
        );
    });
});
