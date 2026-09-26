// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The phone's message page opened from a conversation (`?conversation=`): a reply sent from it is drawn in the thread at once and replaced by the
// real message once the server has filed it - the same thread pane as the desktop's reading pane, in the page that hosts it here.
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MessageDetailPageBase from "../../../apps/www/messages/[uid].js";
import { withTestRouter } from "../routerTestUtils.js";
import { SendRequest, startSend } from "../../../apps/shared/mail/outbox/sendJob.js";
import { handleSendEvent } from "../../../apps/shared/mail/outbox/sendOutcomes.js";
import { getOutgoingReplies } from "../../../apps/shared/mail/outbox/outgoingReplies.js";

const { getUnlockedKeys } = vi.hoisted(() => ({ getUnlockedKeys: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../apps/shared/search/localIndexRpcClient.js")>()),
    moveLocalEntity: vi.fn(),
}));

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const MessageDetailPage = withTestRouter(MessageDetailPageBase);

const stamp = { version: 0, dateCreated: "2026-01-01T00:00:00.000Z", dateModified: "2026-01-01T00:00:00.000Z" };
const mailbox = { uid: "mb1", ...stamp, ownerUserUid: "u1", primarySmtpAddress: "u1@example.com", aliasAddresses: [], displayName: "My Mail", timezone: "UTC", quotaBytes: 1, usedBytes: 0 };
const folders = [
    { uid: "f1", ...stamp, mailboxUid: "mb1", name: "Inbox", type: "inbox", unreadCount: 0, totalCount: 1 },
    { uid: "f2", ...stamp, mailboxUid: "mb1", name: "Sent Items", type: "sent_items", unreadCount: 0, totalCount: 0 },
];
const read = { read: true, flagged: false, answered: false, forwarded: false };
const first = {
    uid: "m1",
    ...stamp,
    folderUid: "f1",
    mailboxUid: "mb1",
    messageId: "first@example.com",
    subject: "Hello there",
    from: { address: "sender@example.com", displayName: "Sender One", type: "to" },
    recipients: [],
    sentDate: "2026-01-01T00:00:00.000Z",
    receivedDate: "2026-01-01T00:00:00.000Z",
    bodyPreview: "Hi there.",
    flags: read,
    importance: "normal",
    hasAttachments: false,
} as unknown as Message;
const second = { ...first, uid: "m2", messageId: "second@example.com", bodyPreview: "Thanks for writing.", receivedDate: "2026-01-02T00:00:00.000Z" };
/** The reply as the server files it in Sent Items once it has relayed it. */
const sentCopy = {
    ...first,
    uid: "d1",
    folderUid: "f2",
    messageId: "sent@example.com",
    subject: "Re: Hello there",
    from: { address: "u1@example.com", displayName: "My Mail", type: "to" },
    bodyPreview: "Glad to help.",
    receivedDate: "2026-01-03T00:00:00.000Z",
    inReplyTo: "second@example.com",
} as Message;

const reply: SendRequest = {
    draft: { uid: "d1", version: 1, folderUid: "f3", mailboxUid: "mb1" } as Message,
    mailboxUid: "mb1",
    mailbox: mailbox,
    policy: undefined,
    toText: "sender@example.com",
    ccText: "",
    bccText: "",
    to: [{ address: "sender@example.com", displayName: "Sender One" }],
    cc: [],
    bcc: [],
    subject: "Re: Hello there",
    html: "<p>Glad to help.</p>",
    attachments: [],
    requestReceipt: false,
    signEnabled: false,
    offeredSign: false,
    offeredEncrypt: false,
    encryptRequested: false,
    forcePlaintext: false,
    threading: { inReplyTo: "second@example.com", references: ["first@example.com", "second@example.com"] },
};

beforeAll(async () => {
    await import("../../../apps/shared/components/mail/MessageDetailPane.js");
    await import("../../../apps/shared/components/mail/ConversationThreadPane.js");
});
beforeEach(() => {
    window.history.pushState({}, "", "/messages/m2?conversation=c1");
    getUnlockedKeys.mockReturnValue(undefined);
});
afterEach(() => {
    window.history.pushState({}, "", "/");
    vi.unstubAllGlobals();
    getUnlockedKeys.mockReset();
});

describe("the message page opened from a conversation", () => {
    it("draws a reply sent from it at the top of the thread at once, and shows the real message once the server has filed it", async () => {
        let filed = false;
        mockFetch((url, init) => {
            const method = init?.method ?? "GET";
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
            if (url.startsWith("/api/mail/labels")) return jsonResponse(200, []);
            if (url === "/api/mail/messages/m2" && method === "GET") return jsonResponse(200, second);
            if (url.startsWith("/api/mail/messages/conversations/c1?")) return jsonResponse(200, filed ? [first, second, sentCopy] : [first, second]);
            if (url === "/api/mail/compose/d1/assemble" && method === "POST") return jsonResponse(200, { ...reply.draft, version: 2 });
            if (url === "/api/mail/messages/d1/send" && method === "POST") return jsonResponse(202, { status: "queued", message: { ...reply.draft, folderUid: "outbox" } });
            if (url.endsWith("/content")) return new Response("<p>Body</p>", { headers: { "content-type": "text/html" } });
            throw new Error(`unexpected ${method} ${url}`);
        });
        render(<MessageDetailPage userUid="u1" params={{ uid: "m2" }} />);
        expect(await screen.findByText("2 messages")).toBeInTheDocument();

        act(() => void startSend(reply));

        expect(await screen.findByTestId("pending-message-status")).toHaveTextContent("Sending…");
        expect(screen.getByText("3 messages")).toBeInTheDocument();
        expect(screen.getByTitle("Message: Re: Hello there").getAttribute("srcdoc")).toContain("Glad to help.");
        await waitFor(() => expect(getOutgoingReplies()[0].state).toBe("sending"));

        filed = true;
        act(() => handleSendEvent({ action: "send-succeeded", uid: "d1", mailboxUid: "mb1", subject: "Re: Hello there", recipients: ["sender@example.com"], attempt: 1 }));

        await waitFor(() => expect(screen.queryByTestId("pending-message-status")).toBeNull());
        expect(screen.getByText("3 messages")).toBeInTheDocument();
        // One card for the reply - the real one, expanded - and the older message still folded.
        expect(await screen.findAllByRole("heading", { name: /My Mail/ })).toHaveLength(1);
        await waitFor(() => expect(getOutgoingReplies()).toEqual([]));
    });
});
