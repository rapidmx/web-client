///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import type { SendEvent } from "@rapidmx/react-shared/mail/sendEvents.js";

const mocks = vi.hoisted(() => ({
    getMessage: vi.fn(),
    listFolders: vi.fn(),
    cancelScheduledSend: vi.fn(),
    queueMessageSend: vi.fn(),
    listAttachments: vi.fn(),
    loadOriginalMessage: vi.fn(),
    assembleDraft: vi.fn(),
    getUnlockedKeys: vi.fn(),
}));

vi.mock("@rapidmx/react-shared/mail/mailApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/mail/mailApi.js")>()),
    getMessage: mocks.getMessage,
    listFolders: mocks.listFolders,
    cancelScheduledSend: mocks.cancelScheduledSend,
    queueMessageSend: mocks.queueMessageSend,
    listAttachments: mocks.listAttachments,
    assembleDraft: mocks.assembleDraft,
}));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys: mocks.getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/components/mail/compose/quotedBody.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../apps/shared/components/mail/compose/quotedBody.js")>()),
    loadOriginalMessage: mocks.loadOriginalMessage,
}));

import { handleSendEvent } from "../../../apps/shared/mail/outbox/sendOutcomes.js";
import { SendRequest, startSend } from "../../../apps/shared/mail/outbox/sendJob.js";
import { isSendPending } from "../../../apps/shared/mail/outbox/pendingSends.js";
import { registerComposeOpener } from "../../../apps/shared/mail/outbox/composeBridge.js";
import { getNotificationsSnapshot, notify } from "../../../apps/shared/notifications/store.js";

const toasts = () => getNotificationsSnapshot().visible;
const drafts = { uid: "drafts", type: "drafts" };
const message = (overrides: Partial<Message> = {}) =>
    ({ uid: "m1", version: 2, folderUid: "outbox", mailboxUid: "mb1", subject: "Hello", recipients: [], flags: {}, ...overrides }) as unknown as Message;

function event(action: SendEvent["action"], overrides: Partial<SendEvent> = {}): SendEvent {
    return { action, uid: "m1", mailboxUid: "mb1", subject: "Hello", recipients: ["a@example.com"], attempt: 1, ...overrides };
}

beforeEach(() => {
    mocks.getMessage.mockResolvedValue(message());
    mocks.listFolders.mockResolvedValue([drafts, { uid: "outbox", type: "outbox" }]);
    mocks.cancelScheduledSend.mockResolvedValue(message({ folderUid: "drafts" }));
    mocks.queueMessageSend.mockResolvedValue({ queued: true, message: message() });
    mocks.listAttachments.mockResolvedValue([]);
    mocks.loadOriginalMessage.mockResolvedValue({ body: { html: "<p>Body</p>" } });
    mocks.assembleDraft.mockResolvedValue(message({ folderUid: "drafts" }));
    mocks.getUnlockedKeys.mockReturnValue(undefined);
});

afterEach(() => {
    for (const mock of Object.values(mocks)) {
        mock.mockReset();
    }
});

describe("handleSendEvent - succeeded", () => {
    /** A message this tab queued in the background: the request is retained until the server reports how it went. */
    async function queueFromHere(uid: string) {
        startSend({
            draft: message({ uid, folderUid: "drafts" }),
            mailboxUid: "mb1",
            mailbox: undefined,
            policy: undefined,
            toText: "a@example.com",
            ccText: "",
            bccText: "",
            to: [{ address: "a@example.com" }],
            cc: [],
            bcc: [],
            subject: "Hello",
            html: "<p>Typed</p>",
            attachments: [],
            requestReceipt: false,
            signEnabled: false,
            offeredSign: false,
            offeredEncrypt: false,
            encryptRequested: false,
            forcePlaintext: false,
        });
        await vi.waitFor(() => expect(isSendPending(uid)).toBe(false));
    }

    it("is one quiet 'Message sent' for a message this tab sent, counting up rather than stacking, and it resolves the failure and retry pop-ups of that message", async () => {
        for (const uid of ["m1", "m2", "m3"]) {
            await queueFromHere(uid);
        }
        handleSendEvent(event("send-failed", { error: { message: "boom" } }));
        handleSendEvent(event("send-retrying"));
        expect(toasts().map((toast) => toast.id).sort()).toEqual(["send-failed:m1", "send-retry:m1"]);
        handleSendEvent(event("send-succeeded"));
        expect(toasts().map((toast) => toast.title)).toEqual(["Message sent"]);
        handleSendEvent(event("send-succeeded", { uid: "m2" }));
        handleSendEvent(event("send-succeeded", { uid: "m3" }));
        expect(toasts().map((toast) => toast.title)).toEqual(["3 messages sent"]);
        expect(toasts()[0].sticky).toBe(false);
    });

    it("says nothing for a message this tab did not queue - a send-later message going out, another tab's send - but still resolves its failure pop-ups", () => {
        handleSendEvent(event("send-failed", { uid: "long-ago" }));
        handleSendEvent(event("send-succeeded", { uid: "long-ago" }));
        expect(toasts()).toEqual([]);
    });
});

describe("handleSendEvent - retrying", () => {
    it("is one subtle info pop-up that says which attempt is next and when, replaced by later attempts, and goes by itself", () => {
        handleSendEvent(event("send-retrying", { attempt: 1, nextAttemptAt: "2026-09-21T10:15:00.000Z", error: { message: "Connection refused", details: ["a: b"] } }));
        expect(toasts()).toHaveLength(1);
        expect(toasts()[0]).toMatchObject({ kind: "info", title: "Retrying to send", sticky: false, id: "send-retry:m1", details: ["detail 1: a: b"] });
        expect(toasts()[0].message).toMatch(/^To a@example.com - "Hello" \(attempt 2, at .+\)\. Connection refused$/);
        handleSendEvent(event("send-retrying", { attempt: 2 }));
        expect(toasts()).toHaveLength(1);
        expect(toasts()[0].message).toMatch(/^To a@example.com - "Hello" \(attempt 3\)\. The server couldn't send this message yet\.$/);
        expect(toasts()[0].count).toBe(1);
    });

    it("names the first two recipients, or the first and how many others", () => {
        handleSendEvent(event("send-retrying", { recipients: ["a@x.com", "b@x.com"] }));
        expect(toasts()[0].message).toContain("To a@x.com and b@x.com");
        handleSendEvent(event("send-retrying", { recipients: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"] }));
        expect(toasts()[0].message).toContain("To a@x.com and 3 others");
    });
});

describe("handleSendEvent - failed", () => {
    it("is a sticky pop-up with the server's reason and technical details, Retry and Open draft, replacing a retry notice", () => {
        handleSendEvent(event("send-retrying"));
        handleSendEvent(event("send-failed", { error: { message: "Recipient refused.", details: [{ recipient: "a@example.com", code: 550 }] } }));
        expect(toasts()).toHaveLength(1);
        expect(toasts()[0]).toMatchObject({ kind: "error", title: "This message wasn't sent", sticky: true, id: "send-failed:m1" });
        expect(toasts()[0].message).toBe('To a@example.com - "Hello": Recipient refused.');
        expect(toasts()[0].details).toEqual(["detail 1: recipient=a@example.com code=550"]);
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry", "Open draft"]);
        handleSendEvent(event("send-failed", { uid: "m9" }));
        expect(toasts().find((toast) => toast.id === "send-failed:m9")!.message).toContain("The server couldn't send this message.");
    });

    it("Retry is the same send call again - a failed message stays in Outbox and the server queues it afresh - resolving the failure and counting it while it goes", async () => {
        handleSendEvent(event("send-failed"));
        toasts()[0].actions[0].onClick!();
        expect(isSendPending("m1")).toBe(true);
        await vi.waitFor(() => expect(isSendPending("m1")).toBe(false));
        expect(mocks.queueMessageSend).toHaveBeenCalledWith("m1");
        expect(mocks.cancelScheduledSend).not.toHaveBeenCalled();
        expect(mocks.getMessage).not.toHaveBeenCalled();
        expect(toasts()).toEqual([]);
    });

    it("Retry against a server that relays at once says Sent", async () => {
        mocks.queueMessageSend.mockResolvedValue({ queued: false, message: message() });
        handleSendEvent(event("send-failed"));
        toasts()[0].actions[0].onClick!();
        await vi.waitFor(() => expect(isSendPending("m1")).toBe(false));
        expect(toasts().map((toast) => toast.title)).toEqual(["Message sent"]);
    });

    it("Retry that fails again shows the server's message as a failure of its own, and never runs twice at once", async () => {
        mocks.queueMessageSend.mockRejectedValue(new ApiRequestError("Still down", 503));
        handleSendEvent(event("send-failed", { mailboxUid: undefined }));
        const retry = toasts()[0].actions[0].onClick!;
        retry();
        retry();
        await vi.waitFor(() => expect(isSendPending("m1")).toBe(false));
        expect(mocks.queueMessageSend).toHaveBeenCalledTimes(1);
        expect(toasts()[0]).toMatchObject({ kind: "error", title: "This message wasn't sent", message: "Still down" });
    });

    it("Open draft moves the message back and re-opens compose around what this tab still has of it", async () => {
        const open = vi.fn();
        const off = registerComposeOpener(open);
        mocks.getMessage.mockResolvedValue(message({ folderUid: "drafts" }));
        const request = {
            draft: message({ folderUid: "drafts" }),
            mailboxUid: "mb1",
            mailbox: undefined,
            policy: undefined,
            toText: "a@example.com",
            ccText: "",
            bccText: "",
            to: [{ address: "a@example.com" }],
            cc: [],
            bcc: [],
            subject: "Hello",
            html: "<p>Typed</p>",
            attachments: [],
            requestReceipt: false,
            signEnabled: false,
            offeredSign: false,
            offeredEncrypt: false,
            encryptRequested: false,
            forcePlaintext: false,
        } as SendRequest;
        mocks.queueMessageSend.mockResolvedValue({ queued: true, message: message() });
        mocks.assembleDraft.mockResolvedValue(message({ folderUid: "drafts" }));
        startSend(request);
        await vi.waitFor(() => expect(isSendPending("m1")).toBe(false));
        mocks.getMessage.mockResolvedValue(message());
        handleSendEvent(event("send-failed"));
        toasts()[0].actions[1].onClick!();
        await vi.waitFor(() => expect(open).toHaveBeenCalled());
        expect(open.mock.calls[0][0].resume).toMatchObject({ draft: message({ folderUid: "drafts" }), html: "<p>Typed</p>", to: "a@example.com" });
        expect(mocks.loadOriginalMessage).not.toHaveBeenCalled();
        off();
    });

    it("Open draft from a message this tab knows nothing about reads the plain content back from the server", async () => {
        const open = vi.fn();
        const off = registerComposeOpener(open);
        mocks.cancelScheduledSend.mockResolvedValue(
            message({
                folderUid: "drafts",
                subject: "From the server",
                requestReceipt: true,
                recipients: [
                    { address: "a@example.com", displayName: "Alice", type: "to" },
                    { address: "c@example.com", type: "cc" },
                    { address: "b@example.com", type: "bcc" },
                ] as Message["recipients"],
            }),
        );
        mocks.listAttachments.mockResolvedValue([{ uid: "att1" }]);
        handleSendEvent(event("send-failed"));
        toasts()[0].actions[1].onClick!();
        await vi.waitFor(() => expect(open).toHaveBeenCalled());
        expect(open.mock.calls[0][0]).toMatchObject({
            mailboxUid: "mb1",
            resume: { to: "Alice <a@example.com>", cc: "c@example.com", bcc: "b@example.com", subject: "From the server", html: "<p>Body</p>", attachments: [{ uid: "att1" }], requestReceipt: true },
        });
        off();
    });

    it("Open draft turns a plain-text body into paragraphs, tolerates unreadable attachments and no subject, and an empty body", async () => {
        const open = vi.fn();
        const off = registerComposeOpener(open);
        mocks.loadOriginalMessage.mockResolvedValue({ body: { text: "Line <1>\nLine 2 & more" } });
        mocks.listAttachments.mockRejectedValue(new Error("nope"));
        mocks.cancelScheduledSend.mockResolvedValue(message({ folderUid: "drafts", subject: undefined }));
        handleSendEvent(event("send-failed", { subject: "Event subject" }));
        toasts()[0].actions[1].onClick!();
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
        expect(open.mock.calls[0][0].resume).toMatchObject({ subject: "Event subject", html: "<p>Line &lt;1&gt;<br>Line 2 &amp; more</p>", attachments: [], requestReceipt: false });
        mocks.loadOriginalMessage.mockResolvedValue({ body: {} });
        handleSendEvent(event("send-failed"));
        toasts().find((toast) => toast.id === "send-failed:m1")!.actions[1].onClick!();
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
        expect(open.mock.calls[1][0].resume.html).toBe("");
        off();
    });

    it("Open draft explains an encrypted message can only be edited where it was written, and reports a failure to move it", async () => {
        mocks.cancelScheduledSend.mockResolvedValue(message({ folderUid: "drafts", encrypted: true }));
        handleSendEvent(event("send-failed"));
        toasts()[0].actions[1].onClick!();
        await vi.waitFor(() => expect(toasts().some((toast) => toast.id === "open-draft:m1")).toBe(true));
        expect(toasts().find((toast) => toast.id === "open-draft:m1")).toMatchObject({ kind: "info", title: "This message is encrypted" });

        mocks.getMessage.mockRejectedValue(new ApiRequestError("Not found", 404));
        handleSendEvent(event("send-failed", { uid: "m2" }));
        toasts().find((toast) => toast.id === "send-failed:m2")!.actions[1].onClick!();
        await vi.waitFor(() => expect(toasts().some((toast) => toast.title === "Couldn't open this draft")).toBe(true));
    });

    it("Open draft with no compose window to open does nothing more", async () => {
        mocks.getMessage.mockResolvedValue(message({ folderUid: "drafts" }));
        handleSendEvent(event("send-failed", { mailboxUid: undefined }));
        toasts()[0].actions[1].onClick!();
        await vi.waitFor(() => expect(mocks.loadOriginalMessage).toHaveBeenCalled());
        notify({ kind: "info", title: "settle" });
    });
});
