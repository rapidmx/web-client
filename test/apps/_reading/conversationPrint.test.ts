// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../../lib/util/api.js";

const { getUnlockedKeys, listConversationMessages, getMessageRawContent, listAttachments, fetchBodyContent, evaluateMessageSecurity } = vi.hoisted(() => ({
    getUnlockedKeys: vi.fn(),
    listConversationMessages: vi.fn(),
    getMessageRawContent: vi.fn(),
    listAttachments: vi.fn(),
    fetchBodyContent: vi.fn(),
    evaluateMessageSecurity: vi.fn(),
}));
vi.mock("../../../lib/crypto/keySession.js", () => ({ getUnlockedKeys }));
vi.mock("../../../lib/mail/conversationsApi.js", () => ({ listConversationMessages }));
vi.mock("../../../lib/mail/mailApi.js", () => ({ getMessageRawContent, listAttachments }));
vi.mock("../../../apps/shared/components/mail/reading/bodyContent.js", () => ({ fetchBodyContent }));
vi.mock("../../../lib/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));

import { olderConversationMessages, printHeaders, printableOlderMessage } from "../../../apps/shared/components/mail/reading/conversationPrint.js";

function message(overrides: Record<string, unknown> = {}): any {
    return {
        uid: "m1",
        mailboxUid: "mb1",
        folderUid: "f1",
        version: 3,
        subject: "Plans",
        encrypted: false,
        conversationId: "c1",
        receivedDate: "2026-01-02T00:00:00Z",
        from: { displayName: "Ann", address: "ann@x.com" },
        recipients: [
            { address: "me@x.com", type: "to" },
            { address: "cc@x.com", type: "cc" },
            { address: "bcc@x.com", type: "bcc" },
        ],
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    listAttachments.mockResolvedValue([{ uid: "a1" }]);
    fetchBodyContent.mockResolvedValue({ kind: "text", text: "body" });
    getMessageRawContent.mockResolvedValue("raw");
    getUnlockedKeys.mockReturnValue(undefined);
});

describe("printHeaders", () => {
    it("lists the sender, the to and cc recipients (never bcc) and the date", () => {
        const headers = printHeaders(message(), "Ann <ann@x.com>");
        expect(headers.map((h) => h.name)).toEqual(["From", "To", "Cc", "Date"]);
        expect(headers[1].value).toBe("me@x.com");
        expect(headers[2].value).toBe("cc@x.com");
    });
});

describe("olderConversationMessages", () => {
    it("is empty for a message with no conversation", async () => {
        expect(await olderConversationMessages(message({ conversationId: undefined }))).toEqual([]);
        expect(listConversationMessages).not.toHaveBeenCalled();
    });

    it("is the messages before this one, newest first, without this one or later ones", async () => {
        listConversationMessages.mockResolvedValue([
            message({ uid: "a", receivedDate: "2026-01-01T00:00:00Z" }),
            message({ uid: "b", receivedDate: "2025-12-30T00:00:00Z" }),
            message({ uid: "m1", receivedDate: "2026-01-02T00:00:00Z" }),
            message({ uid: "z", receivedDate: "2026-01-03T00:00:00Z" }),
        ]);
        const older = await olderConversationMessages(message());
        expect(older.map((m) => m.uid)).toEqual(["a", "b"]);
        expect(listConversationMessages).toHaveBeenCalledWith("mb1", "c1", { limit: 500 }, undefined);
    });
});

describe("printableOlderMessage", () => {
    it("is a plain message's server body, subject and attachments", async () => {
        const printable = await printableOlderMessage(message());
        expect(printable).toMatchObject({ subject: "Plans", content: { kind: "text", text: "body" }, attachments: [{ uid: "a1" }] });
        expect(fetchBodyContent).toHaveBeenCalledWith("m1", 3);
        expect((await printableOlderMessage(message({ subject: "" }))).subject).toBe("(no subject)");
    });

    it("prints a message whose attachments can't be listed without them", async () => {
        listAttachments.mockRejectedValue(new Error("no"));
        expect((await printableOlderMessage(message())).attachments).toEqual([]);
    });

    it("decrypts an encrypted message when its mailbox is unlocked", async () => {
        getUnlockedKeys.mockReturnValue({ k: 1 });
        evaluateMessageSecurity.mockResolvedValue({ subject: "Real", html: "<p>secret</p>", attachments: [{ id: 1 }] });
        const printable = await printableOlderMessage(message({ encrypted: true, subject: "[...]" }));
        expect(printable).toMatchObject({ subject: "Real", content: { kind: "html", html: "<p>secret</p>" }, inlineParts: [{ id: 1 }] });
        expect(fetchBodyContent).not.toHaveBeenCalled();
    });

    it("uses a decrypted text body, and keeps a real outer subject", async () => {
        getUnlockedKeys.mockReturnValue({ k: 1 });
        evaluateMessageSecurity.mockResolvedValue({ subject: "Inner", text: "secret text" });
        const printable = await printableOlderMessage(message({ encrypted: true, subject: "Outer" }));
        expect(printable).toMatchObject({ subject: "Outer", content: { kind: "text", text: "secret text" } });
    });

    it("falls back to \"(no subject)\" for a decrypted message whose own subject is empty", async () => {
        getUnlockedKeys.mockReturnValue({ k: 1 });
        evaluateMessageSecurity.mockResolvedValue({ text: "secret text" });
        const printable = await printableOlderMessage(message({ encrypted: true, subject: "" }));
        expect(printable.subject).toBe("(no subject)");
    });

    it("asks for its attachments, body and raw source through an explicit client", async () => {
        const client = createApiClient({ baseUrl: "https://acct-a.example.com", getAccessToken: async () => "tok-a" });
        await printableOlderMessage(message(), client);
        expect(listAttachments).toHaveBeenCalledWith("f1", "m1", client);
        expect(fetchBodyContent).toHaveBeenCalledWith("m1", 3, undefined, client);
        getUnlockedKeys.mockReturnValue({ k: 1 });
        evaluateMessageSecurity.mockResolvedValue({ text: "secret" });
        await printableOlderMessage(message({ encrypted: true, subject: "[...]" }), client);
        expect(getMessageRawContent).toHaveBeenCalledWith("m1", client);
    });

    it("says so when an encrypted message is locked or cannot be opened", async () => {
        const locked = await printableOlderMessage(message({ encrypted: true, subject: "[...]" }));
        expect(locked.content).toMatchObject({ kind: "text", text: expect.stringContaining("could not be decrypted") });
        expect(locked.subject).toBe("Encrypted message");
        getUnlockedKeys.mockReturnValue({ k: 1 });
        evaluateMessageSecurity.mockResolvedValue({});
        const unreadable = await printableOlderMessage(message({ encrypted: true, subject: "" }));
        expect(unreadable.content).toMatchObject({ text: expect.stringContaining("could not be decrypted") });
        expect(unreadable.subject).toBe("(no subject)");
    });
});
