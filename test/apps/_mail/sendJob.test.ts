///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { toBase64 } from "@rapidmx/react-shared/crypto/encoding.js";
import type { Mailbox, Message } from "@rapidmx/react-shared/mail/mailApi.js";

const mocks = vi.hoisted(() => ({
    assembleDraft: vi.fn(),
    assembleDraftRaw: vi.fn(),
    getMailbox: vi.fn(),
    getMessage: vi.fn(),
    queueMessageSend: vi.fn(),
    sendMessage: vi.fn(),
    setMessageRequestReceipt: vi.fn(),
    getEncryptionPolicy: vi.fn(),
    lookupKeys: vi.fn(),
    getUnlockedKeys: vi.fn(),
    buildEncryptedMessage: vi.fn(),
    buildSignedOnlyMessage: vi.fn(),
}));

vi.mock("@rapidmx/react-shared/mail/mailApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/mail/mailApi.js")>()),
    assembleDraft: mocks.assembleDraft,
    assembleDraftRaw: mocks.assembleDraftRaw,
    getMailbox: mocks.getMailbox,
    getMessage: mocks.getMessage,
    queueMessageSend: mocks.queueMessageSend,
    sendMessage: mocks.sendMessage,
    setMessageRequestReceipt: mocks.setMessageRequestReceipt,
}));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/crypto/keyvaultApi.js")>()),
    getEncryptionPolicy: mocks.getEncryptionPolicy,
    lookupKeys: mocks.lookupKeys,
}));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys: mocks.getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("@rapidmx/react-shared/crypto/smimeMessage.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/crypto/smimeMessage.js")>()),
    buildEncryptedMessage: mocks.buildEncryptedMessage,
    buildSignedOnlyMessage: mocks.buildSignedOnlyMessage,
}));

import {
    CONTEXT_GRACE_MS,
    SendRequest,
    describeMessage,
    forgetRetainedRequest,
    notifySent,
    openDraftFromRequest,
    registerOutboxCounter,
    retainedRequest,
    retrySend,
    startSend,
} from "../../../apps/shared/mail/outbox/sendJob.js";
import { isSendPending } from "../../../apps/shared/mail/outbox/pendingSends.js";
import { registerComposeOpener, registerUnlockOpener } from "../../../apps/shared/mail/outbox/composeBridge.js";
import { getNotificationsSnapshot, dismissAll } from "../../../apps/shared/notifications/store.js";

const draft = { uid: "m1", version: 3, folderUid: "drafts", mailboxUid: "mb1" } as Message;
const mailbox = {
    uid: "mb1",
    primarySmtpAddress: "me@example.com",
    displayName: "Me",
    aliasAddresses: [],
    encryptPreference: { preferEncrypt: "mutual" },
    keys: [],
} as unknown as Mailbox;
const enrolledKey = { publicKey: "x", type: "x509", useType: "encrypt", fingerprint: "fp", notBefore: 0, notAfter: Date.now() + 1e9 };
const peerKey = { publicKey: toBase64(new TextEncoder().encode("peer-cert")), type: "x509", useType: "encrypt", fingerprint: "fp2", notBefore: 0, notAfter: Date.now() + 1e9 };
const AUTO = { encryptSameOrg: "automatic", encryptFederated: "automatic", encryptExternal: "automatic" } as const;
const OPTIONAL = { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" } as const;

function request(overrides: Partial<SendRequest> = {}): SendRequest {
    return {
        draft,
        mailboxUid: "mb1",
        mailbox,
        policy: OPTIONAL,
        toText: "bob@example.com",
        ccText: "",
        bccText: "",
        to: [{ address: "bob@example.com" }],
        cc: [],
        bcc: [],
        subject: "Hello",
        html: "<p>Hi</p>",
        attachments: [],
        requestReceipt: false,
        signEnabled: false,
        offeredSign: false,
        offeredEncrypt: false,
        encryptRequested: false,
        forcePlaintext: false,
        ...overrides,
    };
}

const toasts = () => getNotificationsSnapshot().visible;
const settle = async () => {
    await vi.waitFor(() => expect(isSendPending("m1")).toBe(false));
};
const unlockedEncryption = { masterKey: new Uint8Array(32), encryptionPrivateKey: {} as CryptoKey, encryptionCertDer: new Uint8Array([1]) };
const unlockedSigning = { masterKey: new Uint8Array(32), signingPrivateKey: {} as CryptoKey, signingCertDer: new Uint8Array([2]) };

beforeEach(() => {
    mocks.getMailbox.mockResolvedValue(mailbox);
    mocks.getEncryptionPolicy.mockResolvedValue(OPTIONAL);
    mocks.getMessage.mockResolvedValue(draft);
    mocks.assembleDraft.mockResolvedValue({ ...draft, version: 4 });
    mocks.assembleDraftRaw.mockResolvedValue({ ...draft, version: 4 });
    mocks.setMessageRequestReceipt.mockImplementation(async (message: Message) => ({ ...message, requestReceipt: true }));
    mocks.queueMessageSend.mockResolvedValue({ queued: true, message: draft });
    mocks.sendMessage.mockResolvedValue(draft);
    mocks.getUnlockedKeys.mockReturnValue(undefined);
    mocks.lookupKeys.mockResolvedValue({ keys: [] });
    mocks.buildEncryptedMessage.mockResolvedValue({ contentType: "application/pkcs7-mime", body: "ENC" });
    mocks.buildSignedOnlyMessage.mockResolvedValue({ contentType: "multipart/signed", body: "SIGNED" });
});

afterEach(() => {
    vi.useRealTimers();
    for (const mock of Object.values(mocks)) {
        mock.mockReset();
    }
});

describe("startSend - the happy path", () => {
    it("returns at once, assembles the plain draft and queues it in the background, leaving no pop-up", async () => {
        expect(startSend(request())).toBe(true);
        expect(isSendPending("m1")).toBe(true);
        await settle();
        expect(mocks.assembleDraft).toHaveBeenCalledWith("m1", { to: [{ address: "bob@example.com" }], cc: [], bcc: [], subject: "Hello", html: "<p>Hi</p>" });
        expect(mocks.queueMessageSend).toHaveBeenCalledWith("m1");
        expect(toasts()).toEqual([]);
        expect(retainedRequest("m1")).toBeDefined();
    });

    it("refuses a second send of the same draft while one is under way, and sets the receipt first when asked", async () => {
        expect(startSend(request({ requestReceipt: true }))).toBe(true);
        expect(startSend(request())).toBe(false);
        await settle();
        expect(mocks.queueMessageSend).toHaveBeenCalledTimes(1);
        expect(mocks.setMessageRequestReceipt).toHaveBeenCalledTimes(1);
    });

    it("waits for the window's saves first, and goes on if one of them failed", async () => {
        let done!: () => void;
        const saved = new Promise<void>((resolve) => (done = resolve));
        startSend(request({ saved }));
        await Promise.resolve();
        expect(mocks.assembleDraft).not.toHaveBeenCalled();
        done();
        await settle();
        expect(mocks.assembleDraft).toHaveBeenCalledTimes(1);
        forgetRetainedRequest("m1");
        startSend(request({ saved: Promise.reject(new Error("save failed")) }));
        await settle();
        expect(mocks.assembleDraft).toHaveBeenCalledTimes(2);
    });

    it("shows a quiet 'Message sent' for a server that relayed before answering, coalescing several into one pop-up", async () => {
        mocks.queueMessageSend.mockResolvedValue({ queued: false, message: draft });
        startSend(request());
        await settle();
        expect(toasts().map((toast) => toast.title)).toEqual(["Message sent"]);
        notifySent();
        notifySent();
        expect(toasts().map((toast) => toast.title)).toEqual(["3 messages sent"]);
        expect(toasts()[0]).toMatchObject({ kind: "success", sticky: false });
    });

    it("schedules a send-later message and says when it will go", async () => {
        const time = new Date(Date.now() + 3_600_000).toISOString();
        startSend(request({ scheduledSendTime: time }));
        await settle();
        expect(mocks.sendMessage).toHaveBeenCalledWith("m1", { scheduledSendTime: time });
        expect(mocks.queueMessageSend).not.toHaveBeenCalled();
        expect(toasts()[0]).toMatchObject({ kind: "success", title: "Message scheduled" });
        expect(retainedRequest("m1")).toBeUndefined();
    });

    it("counts the message in the Outbox at once and settles it when the server has it, reading the folders back", async () => {
        const tracker = { settle: vi.fn(), revert: vi.fn() };
        const onQueued = vi.fn();
        const off = registerOutboxCounter(() => tracker, onQueued);
        startSend(request());
        await settle();
        expect(tracker.settle).toHaveBeenCalledTimes(1);
        expect(tracker.revert).not.toHaveBeenCalled();
        expect(onQueued).toHaveBeenCalledWith("mb1");
        off();
        off();
        startSend(request());
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(2));
    });

    it("bounds what it retains, forgetting the oldest", async () => {
        for (let index = 0; index < 27; index++) {
            startSend(request({ draft: { ...draft, uid: `d${index}` } }));
            await vi.waitFor(() => expect(isSendPending(`d${index}`)).toBe(false));
        }
        expect(retainedRequest("d0")).toBeUndefined();
        expect(retainedRequest("d1")).toBeUndefined();
        expect(retainedRequest("d26")).toBeDefined();
    });
});

describe("startSend - failures", () => {
    it("is a sticky pop-up with the reason, the technical lines, Retry and Open draft - and takes the optimistic count back", async () => {
        const tracker = { settle: vi.fn(), revert: vi.fn() };
        registerOutboxCounter(() => tracker, vi.fn());
        mocks.assembleDraft.mockRejectedValue(new ApiRequestError("Some recipients were refused.", 502, "api-1", { details: [{ recipient: "bob@example.com", code: 550 }] }));
        startSend(request({ cc: [{ address: "c@example.com" }], subject: "" }));
        await settle();
        expect(tracker.revert).toHaveBeenCalledTimes(1);
        expect(toasts()).toHaveLength(1);
        expect(toasts()[0]).toMatchObject({ kind: "error", title: "This message wasn't sent", sticky: true, id: "send-failed:m1" });
        expect(toasts()[0].message).toBe("To bob@example.com and c@example.com: Some recipients were refused.");
        expect(toasts()[0].details).toEqual(["detail 1: recipient=bob@example.com code=550"]);
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry", "Open draft"]);
    });

    it("says the message when the failure has no details, names others when there are many recipients, and 'could not schedule' for a scheduled one", async () => {
        mocks.assembleDraft.mockRejectedValue(new TypeError("network down"));
        startSend(request({ to: [{ address: "a@x.com" }, { address: "b@x.com" }, { address: "c@x.com" }] }));
        await settle();
        expect(toasts()[0].message).toBe('To a@x.com and 2 others - "Hello": Could not send this message.');
        dismissAll();
        startSend(request({ scheduledSendTime: new Date(Date.now() + 1e6).toISOString(), to: [] }));
        await settle();
        expect(toasts()[0].message).toBe('Message - "Hello": Could not schedule this message.');
        expect(describeMessage("", "")).toBe("Message");
    });

    it("Retry sends again, resolving the failure; and a request that landed although it never answered is not sent twice", async () => {
        mocks.queueMessageSend.mockRejectedValueOnce(new ApiRequestError("Relay down", 500));
        startSend(request());
        await settle();
        expect(toasts()[0].message).toContain("Relay down");
        toasts()[0].actions[0].onClick!();
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(2));
        await settle();
        expect(mocks.getMessage).toHaveBeenCalledTimes(1);

        // The POST that timed out did reach the server: the message is out of Drafts.
        forgetRetainedRequest("m1");
        mocks.queueMessageSend.mockRejectedValueOnce(new TypeError("network down"));
        mocks.getMessage.mockResolvedValueOnce({ ...draft, folderUid: "outbox", scheduledSendLeaseExpiresAt: "2099-01-01T00:00:00.000Z" });
        startSend(request());
        await settle();
        expect(toasts().filter((toast) => toast.kind === "error")).toEqual([]);
        expect(retainedRequest("m1")).toBeDefined();
        // ... and so is a scheduled one.
        mocks.sendMessage.mockRejectedValueOnce(new TypeError("network down"));
        mocks.getMessage.mockResolvedValueOnce({ ...draft, folderUid: "outbox" });
        startSend(request({ scheduledSendTime: new Date(Date.now() + 1e6).toISOString() }));
        await settle();
        expect(toasts().some((toast) => toast.kind === "error")).toBe(false);
    });

    it("does not send again on Retry when the server already has the message, and says so", async () => {
        mocks.getMessage.mockResolvedValue({ ...draft, folderUid: "sent" });
        await retrySend(request());
        expect(mocks.queueMessageSend).not.toHaveBeenCalled();
        expect(toasts()[0]).toMatchObject({ kind: "info", title: "This message is already on its way" });
        // A check that cannot be made counts as not sent yet.
        mocks.getMessage.mockRejectedValue(new Error("boom"));
        await retrySend(request());
        await settle();
        expect(mocks.queueMessageSend).toHaveBeenCalledTimes(1);
    });

    it("a network failure whose message state cannot be read is a failure", async () => {
        mocks.queueMessageSend.mockRejectedValue(new TypeError("network down"));
        mocks.getMessage.mockRejectedValue(new Error("still down"));
        startSend(request());
        await settle();
        expect(toasts()[0].message).toContain("Could not send this message.");
    });

    it("re-opens the compose window around the request, exactly as typed, from 'Open draft'", async () => {
        const open = vi.fn();
        const off = registerComposeOpener(open);
        mocks.assembleDraft.mockRejectedValue(new ApiRequestError("Nope", 500));
        startSend(request({ ccText: "c@example.com", bccText: "d@example.com", requestReceipt: true, signEnabled: true, encryptRequested: true }));
        await settle();
        toasts()[0].actions[1].onClick!();
        expect(open).toHaveBeenCalledWith({
            mailboxUid: "mb1",
            resume: expect.objectContaining({ draft, to: "bob@example.com", cc: "c@example.com", bcc: "d@example.com", subject: "Hello", html: "<p>Hi</p>", requestReceipt: true, signEnabled: true, encryptRequested: true }),
        });
        off();
        expect(openDraftFromRequest(request())).toBe(false);
    });
});

describe("startSend - encryption and signing", () => {
    it("fails open: no policy, no mailbox keys, nothing asked for - it just goes, without waiting on anything", async () => {
        mocks.getMailbox.mockRejectedValue(new ApiRequestError("gateway", 502));
        mocks.getEncryptionPolicy.mockRejectedValue(new ApiRequestError("gateway", 502));
        startSend(request({ mailbox: undefined, policy: undefined }));
        await settle();
        expect(mocks.assembleDraft).toHaveBeenCalledTimes(1);
        expect(toasts()).toEqual([]);
    });

    it("loads the mailbox and policy it was not given, in the background, and encrypts when they say so", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedEncryption);
        mocks.getMailbox.mockResolvedValue(mailbox);
        mocks.getEncryptionPolicy.mockResolvedValue(AUTO);
        mocks.lookupKeys.mockResolvedValue({ keys: [peerKey], encryptPreference: { preferEncrypt: "mutual" } });
        startSend(request({ mailbox: undefined, policy: undefined }));
        await settle();
        expect(mocks.getMailbox).toHaveBeenCalledWith("mb1");
        expect(mocks.buildEncryptedMessage).toHaveBeenCalledTimes(1);
        expect(mocks.assembleDraftRaw).toHaveBeenCalledTimes(1);
        expect(mocks.assembleDraft).not.toHaveBeenCalled();
        expect(toasts()).toEqual([]);
    });

    it("gives up on a load that hangs after the grace period and sends unencrypted", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        mocks.getMailbox.mockReturnValue(new Promise(() => undefined));
        mocks.getEncryptionPolicy.mockReturnValue(new Promise(() => undefined));
        startSend(request({ mailbox: undefined, policy: undefined }));
        await vi.advanceTimersByTimeAsync(CONTEXT_GRACE_MS - 1);
        expect(mocks.assembleDraft).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2);
        await vi.waitFor(() => expect(mocks.assembleDraft).toHaveBeenCalledTimes(1));
    });

    it("looks the policy up only when a mailbox key could use it", async () => {
        mocks.getEncryptionPolicy.mockResolvedValue(OPTIONAL);
        startSend(request({ policy: undefined }));
        await settle();
        expect(mocks.getEncryptionPolicy).not.toHaveBeenCalled();
        forgetRetainedRequest("m1");
        startSend(request({ policy: undefined, mailbox: { ...mailbox, keys: [enrolledKey] } as Mailbox }));
        await settle();
        expect(mocks.getEncryptionPolicy).toHaveBeenCalledTimes(1);
    });

    it("assembles a signed message with the mailbox's display name, dropping one the server would refuse, and falls back to a localhost Message-ID domain", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedSigning);
        startSend(request({ signEnabled: true, offeredSign: true, cc: [{ address: "c@example.com" }] }));
        await settle();
        expect(mocks.buildSignedOnlyMessage).toHaveBeenCalledWith(
            'text/html; charset="utf-8"',
            "<p>Hi</p>",
            expect.objectContaining({ from: '"Me" <me@example.com>', to: "bob@example.com", cc: "c@example.com", subject: "Hello" }),
            unlockedSigning.signingCertDer,
            unlockedSigning.signingPrivateKey,
        );
        expect(mocks.assembleDraftRaw).toHaveBeenCalledWith("m1", expect.objectContaining({ subject: "Hello", rawMime: expect.stringContaining("SIGNED") }));
        forgetRetainedRequest("m1");
        startSend(request({ signEnabled: true, offeredSign: true, mailbox: { ...mailbox, displayName: "a@b", primarySmtpAddress: "me" } }));
        await settle();
        expect(mocks.buildSignedOnlyMessage).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ from: "me", messageId: expect.stringMatching(/@localhost>$/) }),
            expect.anything(),
            expect.anything(),
        );
        forgetRetainedRequest("m1");
        startSend(request({ signEnabled: true, offeredSign: true, mailbox: { ...mailbox, displayName: undefined } as Mailbox }));
        await settle();
        expect(mocks.buildSignedOnlyMessage).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ from: "me@example.com" }), expect.anything(), expect.anything());
    });

    it("encrypts to everyone and to the sender, signing too when it can, with the outer subject obscured", async () => {
        mocks.getUnlockedKeys.mockReturnValue({ ...unlockedEncryption, ...unlockedSigning });
        mocks.lookupKeys.mockResolvedValue({ keys: [peerKey], encryptPreference: { preferEncrypt: "mutual" } });
        startSend(request({ policy: AUTO, mailbox: { ...mailbox, keys: [enrolledKey] } as Mailbox, signEnabled: true, offeredSign: true, offeredEncrypt: true, cc: [{ address: "c@example.com" }] }));
        await settle();
        const [, , protectedHeaders, outerHeaders, certs, signing] = mocks.buildEncryptedMessage.mock.calls[0];
        expect(protectedHeaders.subject).toBe("Hello");
        expect(outerHeaders.subject).toBe("[...]");
        expect(certs).toHaveLength(3);
        expect(certs[0]).toBe(unlockedEncryption.encryptionCertDer);
        expect(signing).toEqual({ certDer: unlockedSigning.signingCertDer, privateKey: unlockedSigning.signingPrivateKey });
    });

    it("refuses an encrypted message that cannot be encrypted (keys locked), offering Unlock and the override, and retries after unlocking", async () => {
        mocks.getUnlockedKeys.mockReturnValue(undefined);
        mocks.lookupKeys.mockResolvedValue({ keys: [peerKey], encryptPreference: { preferEncrypt: "mutual" } });
        const unlock = vi.fn().mockResolvedValue(undefined);
        const off = registerUnlockOpener(unlock);
        const withKey = { ...mailbox, keys: [enrolledKey] } as Mailbox;
        startSend(request({ policy: AUTO, mailbox: withKey }));
        await settle();
        expect(toasts()[0].message).toContain("your encryption key is locked");
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Unlock", "Send without encryption", "Open draft"]);
        expect(mocks.assembleDraft).not.toHaveBeenCalled();
        toasts()[0].actions[0].onClick!();
        await vi.waitFor(() => expect(unlock).toHaveBeenCalledWith("mb1", [enrolledKey]));
        await vi.waitFor(() => expect(mocks.getMessage).toHaveBeenCalled());
        // Unlocked (by the mock) but the keys are still not there: the retry is refused again, and the failure is back.
        await vi.waitFor(() => expect(toasts()).toHaveLength(1));
        await settle();
        // The override sends it plain.
        toasts()[0].actions[1].onClick!();
        await vi.waitFor(() => expect(mocks.assembleDraft).toHaveBeenCalledTimes(1));
        off();
    });

    it("does not offer Unlock when the unlock prompt is dismissed, and a refusal without keys to unlock has only the override and Open draft", async () => {
        mocks.getUnlockedKeys.mockReturnValue(undefined);
        mocks.lookupKeys.mockResolvedValue({ keys: [peerKey], encryptPreference: { preferEncrypt: "mutual" } });
        const off = registerUnlockOpener(() => Promise.reject(new Error("cancelled")));
        startSend(request({ policy: AUTO, mailbox: { ...mailbox, keys: [enrolledKey] } as Mailbox }));
        await settle();
        toasts()[0].actions[0].onClick!();
        await Promise.resolve();
        await Promise.resolve();
        expect(mocks.getMessage).not.toHaveBeenCalled();
        off();
        dismissAll();
        startSend(request({ encryptRequested: true, offeredEncrypt: true, mailbox: { ...mailbox, keys: [] } }));
        await settle();
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Send without encryption", "Open draft"]);
    });

    it("rejects what cannot be signed or encrypted and has no override - the message has to change", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedSigning);
        startSend(request({ signEnabled: true, offeredSign: true, attachments: [{ uid: "a1" } as never] }));
        await settle();
        expect(toasts()[0].message).toContain("cannot include file attachments");
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry", "Open draft"]);
    });

    it("refuses a requested encryption when a recipient's key lookup fails - the sender asked for it and it cannot be delivered", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedEncryption);
        mocks.lookupKeys.mockRejectedValue(new ApiRequestError("lookup down", 500));
        startSend(request({ encryptRequested: true, offeredEncrypt: true }));
        await settle();
        expect(toasts()[0].message).toContain("encryption keys couldn't be checked");
        expect(mocks.assembleDraft).not.toHaveBeenCalled();
    });

    it("tells the mailbox could not be loaded when encryption was asked for", async () => {
        mocks.getMailbox.mockRejectedValue(new ApiRequestError("gateway", 502));
        mocks.getEncryptionPolicy.mockRejectedValue(new ApiRequestError("gateway", 502));
        startSend(request({ mailbox: undefined, policy: undefined, encryptRequested: true }));
        await settle();
        expect(toasts()[0].message).toContain("mailbox details couldn't be loaded");
    });

    it("encrypts a requested message without a policy, treating every tier as open, and the override never encrypts nor checks", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedEncryption);
        mocks.lookupKeys.mockResolvedValue({ keys: [peerKey] });
        mocks.getEncryptionPolicy.mockRejectedValue(new ApiRequestError("gateway", 502));
        startSend(request({ policy: undefined, encryptRequested: true, offeredEncrypt: true }));
        await settle();
        expect(mocks.buildEncryptedMessage).toHaveBeenCalledTimes(1);
        forgetRetainedRequest("m1");
        mocks.buildEncryptedMessage.mockClear();
        startSend(request({ forcePlaintext: true, encryptRequested: true, offeredEncrypt: true }));
        await settle();
        expect(mocks.buildEncryptedMessage).not.toHaveBeenCalled();
        expect(mocks.lookupKeys).toHaveBeenCalledTimes(1);
    });
});
