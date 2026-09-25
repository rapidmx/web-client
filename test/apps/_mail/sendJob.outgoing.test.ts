///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import type { SendEvent } from "@rapidmx/react-shared/mail/sendEvents.js";

const mocks = vi.hoisted(() => ({
    assembleDraft: vi.fn(),
    getMessage: vi.fn(),
    listFolders: vi.fn(),
    cancelScheduledSend: vi.fn(),
    queueMessageSend: vi.fn(),
    listAttachments: vi.fn(),
    loadOriginalMessage: vi.fn(),
    getUnlockedKeys: vi.fn(),
}));

vi.mock("@rapidmx/react-shared/mail/mailApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/mail/mailApi.js")>()),
    assembleDraft: mocks.assembleDraft,
    getMessage: mocks.getMessage,
    listFolders: mocks.listFolders,
    cancelScheduledSend: mocks.cancelScheduledSend,
    queueMessageSend: mocks.queueMessageSend,
    listAttachments: mocks.listAttachments,
}));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys: mocks.getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/components/mail/compose/quotedBody.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../apps/shared/components/mail/compose/quotedBody.js")>()),
    loadOriginalMessage: mocks.loadOriginalMessage,
}));

import { handleSendEvent } from "../../../apps/shared/mail/outbox/sendOutcomes.js";
import { SendRequest, openDraftFromRequest, retrySend, startSend } from "../../../apps/shared/mail/outbox/sendJob.js";
import { isSendPending } from "../../../apps/shared/mail/outbox/pendingSends.js";
import { getOutgoingReplies } from "../../../apps/shared/mail/outbox/outgoingReplies.js";
import { registerComposeOpener } from "../../../apps/shared/mail/outbox/composeBridge.js";

const draft = { uid: "m1", version: 3, folderUid: "drafts", mailboxUid: "mb1" } as Message;
const stored = (overrides: Partial<Message> = {}) => ({ ...draft, folderUid: "outbox", subject: "Re: Hello", recipients: [], flags: {}, ...overrides }) as unknown as Message;

function request(overrides: Partial<SendRequest> = {}): SendRequest {
    return {
        draft,
        mailboxUid: "mb1",
        mailbox: undefined,
        policy: undefined,
        toText: "bob@example.com",
        ccText: "",
        bccText: "",
        to: [{ address: "bob@example.com" }],
        cc: [],
        bcc: [],
        subject: "Re: Hello",
        html: "<p>Thanks</p>",
        attachments: [],
        requestReceipt: false,
        signEnabled: false,
        offeredSign: false,
        offeredEncrypt: false,
        encryptRequested: false,
        forcePlaintext: false,
        threading: { inReplyTo: "orig@example.com", references: ["orig@example.com"] },
        ...overrides,
    };
}

function event(action: SendEvent["action"], overrides: Partial<SendEvent> = {}): SendEvent {
    return { action, uid: "m1", mailboxUid: "mb1", subject: "Re: Hello", recipients: ["bob@example.com"], attempt: 1, ...overrides };
}

const state = () => getOutgoingReplies().map((reply) => [reply.uid, reply.state]);
const settled = () => vi.waitFor(() => expect(isSendPending("m1")).toBe(false));
const action = (label: string) => getOutgoingReplies()[0].actions.find((candidate) => candidate.label === label)!;

beforeEach(() => {
    mocks.assembleDraft.mockResolvedValue({ ...draft, version: 4 });
    mocks.queueMessageSend.mockResolvedValue({ queued: true, message: stored() });
    mocks.getMessage.mockResolvedValue(draft);
    mocks.listFolders.mockResolvedValue([{ uid: "drafts", type: "drafts" }]);
    mocks.cancelScheduledSend.mockResolvedValue({ ...draft, folderUid: "drafts" });
    mocks.listAttachments.mockResolvedValue([]);
    mocks.loadOriginalMessage.mockResolvedValue({ body: { html: "<p>Body</p>" } });
    mocks.getUnlockedKeys.mockReturnValue(undefined);
});

afterEach(() => {
    for (const mock of Object.values(mocks)) {
        mock.mockReset();
    }
});

describe("a reply on its way to the conversation", () => {
    it("is there the moment Send is pressed, stays sending while the server queues it, and is sent when the server says it relayed it", async () => {
        expect(startSend(request())).toBe(true);
        expect(state()).toEqual([["m1", "sending"]]);

        await settled();
        expect(state()).toEqual([["m1", "sending"]]);

        handleSendEvent(event("send-succeeded"));
        expect(state()).toEqual([["m1", "sent"]]);
    });

    it("is sent at once when the server relayed it before answering", async () => {
        mocks.queueMessageSend.mockResolvedValue({ queued: false, message: stored({ folderUid: "sent" }) });

        startSend(request());
        await vi.waitFor(() => expect(state()).toEqual([["m1", "sent"]]));
    });

    it("is not there for a new message, or one that is scheduled", async () => {
        startSend(request({ threading: undefined }));
        await settled();
        expect(state()).toEqual([]);

        startSend(request({ scheduledSendTime: "2030-01-01T00:00:00.000Z" }));
        await settled();
        expect(state()).toEqual([]);
    });

    it("shows a failure on this side with the pop-up's own ways out, and Retry sends it again", async () => {
        mocks.queueMessageSend.mockRejectedValueOnce(new ApiRequestError("Relay down", 500));
        startSend(request());
        await vi.waitFor(() => expect(state()).toEqual([["m1", "failed"]]));
        expect(getOutgoingReplies()[0].failure).toBeTruthy();
        expect(getOutgoingReplies()[0].actions.map((candidate) => candidate.label)).toEqual(["Retry", "Open draft"]);

        action("Retry").onClick!();
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(2));
        await settled();
        expect(state()).toEqual([["m1", "sending"]]);
    });

    it("goes back to sending when Retry finds the server already has the message", async () => {
        mocks.queueMessageSend.mockRejectedValueOnce(new ApiRequestError("Relay down", 500));
        startSend(request());
        await vi.waitFor(() => expect(state()).toEqual([["m1", "failed"]]));
        // The request that seemed to fail did land: the message is out of Drafts.
        mocks.getMessage.mockResolvedValue(stored());

        action("Retry").onClick!();

        await vi.waitFor(() => expect(state()).toEqual([["m1", "sending"]]));
        expect(mocks.queueMessageSend).toHaveBeenCalledTimes(1);
    });

    it("shows the server's own failure too, and Retry queues it again", async () => {
        startSend(request());
        await settled();

        handleSendEvent(event("send-retrying", { attempt: 1 }));
        expect(state()).toEqual([["m1", "sending"]]);
        handleSendEvent(event("send-failed", { error: { message: "Recipient refused." } }));
        expect(state()).toEqual([["m1", "failed"]]);
        expect(getOutgoingReplies()[0].failure).toBe("Recipient refused.");

        action("Retry").onClick!();
        expect(state()).toEqual([["m1", "sending"]]);
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(2));
        await settled();
    });

    it("is not shown any more once the message is opened as a draft again - from either failure", async () => {
        const open = vi.fn();
        const unregister = registerComposeOpener(open);
        startSend(request());
        await settled();
        handleSendEvent(event("send-failed", { error: { message: "Recipient refused." } }));

        action("Open draft").onClick!();
        await vi.waitFor(() => expect(getOutgoingReplies()).toEqual([]));
        expect(open).toHaveBeenCalled();

        // A failure on this side: the request is still here.
        mocks.queueMessageSend.mockRejectedValueOnce(new ApiRequestError("Relay down", 500));
        startSend(request());
        await vi.waitFor(() => expect(state()).toEqual([["m1", "failed"]]));
        action("Open draft").onClick!();
        expect(getOutgoingReplies()).toEqual([]);
        unregister();
    });

    it("stays where it is when there is no compose window to open the draft in", async () => {
        mocks.queueMessageSend.mockRejectedValueOnce(new ApiRequestError("Relay down", 500));
        startSend(request());
        await vi.waitFor(() => expect(state()).toEqual([["m1", "failed"]]));

        expect(openDraftFromRequest(request())).toBe(false);

        expect(state()).toEqual([["m1", "failed"]]);
    });

    it("is left to the pop-up when the request of a retry is refused for a message already on its way", async () => {
        mocks.getMessage.mockResolvedValue(stored());
        await retrySend(request());

        expect(state()).toEqual([]);
    });
});
