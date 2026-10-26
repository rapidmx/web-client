///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../../lib/util/api.js";
import { toBase64 } from "../../../lib/crypto/encoding.js";
import type { Mailbox, Message } from "../../../lib/mail/mailApi.js";

const mocks = vi.hoisted(() => ({
    forgetDraftImages: vi.fn(),
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
    createDraft: vi.fn(),
    buildPgpEncryptedMessage: vi.fn(),
    readKeysBase64: vi.fn(),
    armorPublicKey: vi.fn(),
    listFolders: vi.fn(),
    cancelScheduledSend: vi.fn(),
    deleteMessage: vi.fn(),
}));

vi.mock("../../../lib/mail/mailApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/mail/mailApi.js")>()),
    assembleDraft: mocks.assembleDraft,
    assembleDraftRaw: mocks.assembleDraftRaw,
    createDraft: mocks.createDraft,
    forgetDraftImages: mocks.forgetDraftImages,
    getMailbox: mocks.getMailbox,
    getMessage: mocks.getMessage,
    queueMessageSend: mocks.queueMessageSend,
    sendMessage: mocks.sendMessage,
    setMessageRequestReceipt: mocks.setMessageRequestReceipt,
    listFolders: mocks.listFolders,
    cancelScheduledSend: mocks.cancelScheduledSend,
    deleteMessage: mocks.deleteMessage,
}));
vi.mock("../../../lib/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keyvaultApi.js")>()),
    getEncryptionPolicy: mocks.getEncryptionPolicy,
    lookupKeys: mocks.lookupKeys,
}));
vi.mock("../../../lib/crypto/keySession.js", () => ({ getUnlockedKeys: mocks.getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("../../../lib/crypto/smimeMessage.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/smimeMessage.js")>()),
    buildEncryptedMessage: mocks.buildEncryptedMessage,
    buildSignedOnlyMessage: mocks.buildSignedOnlyMessage,
}));

vi.mock("../../../lib/crypto/pgpMessage.js", () => ({ buildPgpEncryptedMessage: mocks.buildPgpEncryptedMessage, readKeysBase64: mocks.readKeysBase64 }));
vi.mock("../../../lib/crypto/openpgp.js", () => ({ armorPublicKey: mocks.armorPublicKey }));

import {
    CONTEXT_GRACE_MS,
    CopyFate,
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
import { handleSendEvent } from "../../../apps/shared/mail/outbox/sendOutcomes.js";
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
        expect(mocks.assembleDraft).toHaveBeenCalledWith("m1", { to: [{ address: "bob@example.com" }], cc: [], bcc: [], subject: "Hello", html: "<p>Hi</p>", intent: "send" }, undefined);
        expect(mocks.queueMessageSend).toHaveBeenCalledWith("m1", undefined);
        expect(toasts()).toEqual([]);
        expect(retainedRequest("m1")).toBeDefined();
        // Queued, it may yet fail on the server and be retried from the same draft, so its pictures are still remembered as attached ...
        expect(mocks.forgetDraftImages).not.toHaveBeenCalled();
        // ... until the message is known to have gone.
        forgetRetainedRequest("m1");
        expect(mocks.forgetDraftImages).toHaveBeenCalledWith("m1");
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
        expect(mocks.forgetDraftImages).toHaveBeenCalledWith("m1");
        notifySent();
        notifySent();
        expect(toasts().map((toast) => toast.title)).toEqual(["3 messages sent"]);
        expect(toasts()[0]).toMatchObject({ kind: "success", sticky: false });
    });

    it("schedules a send-later message and says when it will go", async () => {
        const time = new Date(Date.now() + 3_600_000).toISOString();
        startSend(request({ scheduledSendTime: time }));
        await settle();
        expect(mocks.sendMessage).toHaveBeenCalledWith("m1", { scheduledSendTime: time }, undefined);
        expect(mocks.queueMessageSend).not.toHaveBeenCalled();
        expect(toasts()[0]).toMatchObject({ kind: "success", title: "Message scheduled" });
        expect(retainedRequest("m1")).toBeUndefined();
        expect(mocks.forgetDraftImages).toHaveBeenCalledWith("m1");
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

    it("re-assembles a single-copy message on Retry when nothing went, rather than relaying the stored draft as it is now", async () => {
        mocks.queueMessageSend.mockRejectedValueOnce(new ApiRequestError("Unavailable", 503));
        startSend(request());
        await settle();
        expect(mocks.assembleDraft).toHaveBeenCalledTimes(1);
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry", "Open draft"]);

        toasts()[0].actions[0].onClick!();
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(2));
        await settle();
        expect(mocks.assembleDraft).toHaveBeenCalledTimes(2);
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
        expect(toasts()).toHaveLength(1);
        toasts()[0].actions[1].onClick!();
        // The pop-up goes with it: its Retry must not hand over the draft now being edited.
        expect(toasts()).toEqual([]);
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

    it("refuses, rather than sends plain, when the policy cannot be loaded for a sender with a key", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedEncryption);
        mocks.getEncryptionPolicy.mockRejectedValue(new ApiRequestError("gateway", 502));
        startSend(request({ policy: undefined, mailbox: { ...mailbox, keys: [enrolledKey] } as Mailbox }));
        await settle();
        expect(toasts()[0].message).toContain("encryption keys couldn't be checked");
        expect(toasts()[0].actions.map((action) => action.label)).toContain("Send without encryption");
        expect(mocks.assembleDraft).not.toHaveBeenCalled();
        // The sender's own override sends it.
        toasts()[0].actions.find((action) => action.label === "Send without encryption")!.onClick!();
        await vi.waitFor(() => expect(mocks.assembleDraft).toHaveBeenCalledTimes(1));
    });

    it("refuses, rather than sends plain, when a recipient's key lookup fails and the policy would have encrypted", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedEncryption);
        mocks.lookupKeys.mockRejectedValue(new ApiRequestError("lookup down", 500));
        startSend(request({ policy: AUTO, mailbox: { ...mailbox, keys: [enrolledKey] } as Mailbox }));
        await settle();
        expect(toasts()[0].message).toContain("encryption keys couldn't be checked");
        expect(mocks.assembleDraft).not.toHaveBeenCalled();
        expect(mocks.buildEncryptedMessage).not.toHaveBeenCalled();
    });

    it("loads the mailbox and policy it was not given, in the background, and encrypts when they say so", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedEncryption);
        mocks.getMailbox.mockResolvedValue(mailbox);
        mocks.getEncryptionPolicy.mockResolvedValue(AUTO);
        mocks.lookupKeys.mockResolvedValue({ keys: [peerKey], encryptPreference: { preferEncrypt: "mutual" } });
        startSend(request({ mailbox: undefined, policy: undefined }));
        await settle();
        expect(mocks.getMailbox).toHaveBeenCalledWith("mb1", undefined, undefined);
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
        expect(mocks.assembleDraftRaw).toHaveBeenCalledWith("m1", expect.objectContaining({ subject: "Hello", rawMime: expect.stringContaining("SIGNED"), intent: "send" }), undefined);
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
        await vi.waitFor(() => expect(mocks.lookupKeys).toHaveBeenCalledTimes(2));
        await settle();
        await vi.waitFor(() => expect(toasts()).toHaveLength(1));
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

// A window rendered under an `ApiClientContext.Provider` (e.g. one account of the native, multi-account `tauri-client`) passes its own
describe("startSend - OpenPGP recipients", () => {
    const pgpKey = { publicKey: "cGdw", type: "openpgp", useType: "encrypt", fingerprint: "pgp-fp", notBefore: 0, notAfter: 8.64e15 };
    const ownPublic = { own: "public" };
    const ownPrivate = { toPublic: () => ownPublic };
    const unlockedOpenPgp = { ...unlockedEncryption, ...unlockedSigning, openPgpKeys: [{ fingerprint: "own-pgp", privateKey: ownPrivate }] };
    const PGP_POLICY = { ...AUTO, allowOpenPgp: true };
    const MUTUAL = { preferEncrypt: "mutual" } as const;
    const send = (overrides: Partial<SendRequest> = {}) =>
        startSend(request({ policy: PGP_POLICY, mailbox: { ...mailbox, keys: [enrolledKey] } as Mailbox, offeredEncrypt: true, ...overrides }));

    beforeEach(() => {
        mocks.buildPgpEncryptedMessage.mockResolvedValue({ contentType: "multipart/encrypted", body: "PGP" });
        mocks.readKeysBase64.mockResolvedValue([{ recipient: "key" }]);
        mocks.armorPublicKey.mockReturnValue("ARMORED");
        mocks.createDraft.mockResolvedValue({ ...draft, uid: "m2" });
        mocks.assembleDraftRaw.mockImplementation(async (uid: string) => ({ ...draft, uid, version: 4 }));
    });

    it("encrypts to a recipient with only an OpenPGP key as PGP/MIME in the draft itself, signed with the sender's OpenPGP key", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockResolvedValue({ keys: [pgpKey], encryptPreference: MUTUAL });
        send({ signEnabled: true, offeredSign: true });
        await settle();

        expect(mocks.buildEncryptedMessage).not.toHaveBeenCalled();
        expect(mocks.readKeysBase64).toHaveBeenCalledWith(["cGdw"]);
        const [, , pgpHeaders, outer, recipients, signingKey, attached] = mocks.buildPgpEncryptedMessage.mock.calls[0];
        expect(pgpHeaders.subject).toBe("Hello");
        expect(pgpHeaders.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
        expect(outer.subject).toBe("[...]");
        expect(recipients).toEqual([ownPublic, { recipient: "key" }]);
        expect(signingKey).toBe(ownPrivate);
        expect(attached).toBe("ARMORED");
        expect(mocks.createDraft).not.toHaveBeenCalled();
        const [uid, input] = mocks.assembleDraftRaw.mock.calls[0];
        expect(uid).toBe("m1");
        expect(input.deliverTo).toBeUndefined();
        expect(mocks.queueMessageSend).toHaveBeenCalledWith("m1", undefined);
    });

    it("prefers S/MIME for a recipient who has both, and sends one copy per format to mixed recipients", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [pgpKey, peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        mocks.queueMessageSend.mockResolvedValueOnce({ queued: true, message: draft }).mockResolvedValueOnce({ queued: false, message: draft });
        send({ cc: [{ address: "pat@proton.example" }], requestReceipt: true });
        await settle();

        const [, , , , certs] = mocks.buildEncryptedMessage.mock.calls[0];
        expect(certs).toHaveLength(2);
        expect(mocks.readKeysBase64).toHaveBeenCalledWith(["cGdw"]);
        // Unsigned: the sender didn't sign, so the OpenPGP copy isn't either - but it still carries the sender's key.
        expect(mocks.buildPgpEncryptedMessage.mock.calls[0][5]).toBeUndefined();
        expect(mocks.createDraft).toHaveBeenCalledWith("mb1", "drafts", undefined, undefined);
        expect(mocks.assembleDraftRaw.mock.calls.map(([uid, input]) => [uid, input.deliverTo])).toEqual([
            ["m1", ["bob@example.com"]],
            ["m2", ["pat@proton.example"]],
        ]);
        expect(mocks.setMessageRequestReceipt).toHaveBeenCalledTimes(2);
        expect(mocks.queueMessageSend.mock.calls.map(([uid]) => uid)).toEqual(["m1", "m2"]);
    });

    it("says only some recipients got it when one copy went and the other didn't, and Retry hands over only the other", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        mocks.queueMessageSend.mockResolvedValueOnce({ queued: true, message: draft }).mockRejectedValueOnce(new ApiRequestError("Unavailable", 503));
        send({ cc: [{ address: "pat@proton.example" }] });
        await settle();

        expect(toasts()[0].message).toContain("Only some of its recipients were sent it");
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry"]);
        expect(mocks.queueMessageSend.mock.calls.map(([uid]) => uid)).toEqual(["m1", "m2"]);

        // m1 is on its way; m2 is still a draft. Retry hands over m2 alone, without building or creating anything again.
        mocks.getMessage.mockImplementation(async (uid: string) => ({ ...draft, uid, folderUid: uid === "m1" ? "outbox" : "drafts" }));
        toasts()[0].actions[0].onClick!();
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(3));
        await settle();
        expect(mocks.queueMessageSend.mock.calls[2][0]).toBe("m2");
        // Asked whether it went already: by the Retry, and by the attempt before it hands it over.
        expect(mocks.getMessage.mock.calls.map(([uid]) => uid)).toEqual(["m2", "m2"]);
        expect(mocks.createDraft).toHaveBeenCalledTimes(1);
        expect(mocks.buildPgpEncryptedMessage).toHaveBeenCalledTimes(1);
        expect(toasts().filter((toast) => toast.kind === "error")).toEqual([]);

        // Once every copy is out, a Retry says it is already on its way.
        mocks.getMessage.mockImplementation(async (uid: string) => ({ ...draft, uid, folderUid: "outbox" }));
        await retrySend(request({ pendingCopies: [{ ...draft, uid: "m2" }] }));
        expect(toasts().some((toast) => toast.title === "This message is already on its way")).toBe(true);
    });

    it("still says only some recipients got it, offering no Open draft, when the Retry of the copy that didn't go fails again", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        mocks.queueMessageSend
            .mockResolvedValueOnce({ queued: true, message: draft })
            .mockRejectedValueOnce(new ApiRequestError("Unavailable", 503))
            .mockRejectedValueOnce(new ApiRequestError("Still unavailable", 503))
            .mockRejectedValueOnce(new ApiRequestError("Unavailable again", 503));
        mocks.getMessage.mockImplementation(async (uid: string) => ({ ...draft, uid, folderUid: uid === "m1" ? "outbox" : "drafts" }));
        send({ cc: [{ address: "pat@proton.example" }] });
        await settle();
        expect(toasts()[0].message).toContain("Only some of its recipients were sent it");

        // The OpenPGP copy fails again, first of what this attempt hands over - and again on the Retry after that.
        for (const [call, reason] of [[3, "Still unavailable"], [4, "Unavailable again"]] as const) {
            toasts()[0].actions[0].onClick!();
            await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(call));
            await settle();
            expect(mocks.queueMessageSend.mock.calls[call - 1][0]).toBe("m2");
            expect(toasts()[0].message).toContain("Only some of its recipients were sent it");
            expect(toasts()[0].message).toContain(reason);
            expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry"]);
        }
    });

    it("counts a copy whose request never answered but which landed as gone, and keeps both copies for a retry when the first didn't go", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        mocks.queueMessageSend.mockResolvedValueOnce({ queued: false, message: draft }).mockRejectedValueOnce(new TypeError("network down"));
        mocks.getMessage.mockImplementation(async (uid: string) => ({ ...draft, uid, folderUid: "outbox" }));
        send({ cc: [{ address: "pat@proton.example" }] });
        await settle();
        expect(toasts().filter((toast) => toast.kind === "error")).toEqual([]);

        // Nothing went: a plain failure, with the copies already built kept for the retry.
        forgetRetainedRequest("m1");
        mocks.createDraft.mockClear();
        mocks.getMessage.mockImplementation(async (uid: string) => ({ ...draft, uid }));
        mocks.queueMessageSend.mockReset().mockRejectedValueOnce(new ApiRequestError("Unavailable", 503)).mockResolvedValue({ queued: true, message: draft });
        send({ cc: [{ address: "pat@proton.example" }], scheduledSendTime: undefined });
        await settle();
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry", "Open draft"]);
        toasts()[0].actions[0].onClick!();
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(3));
        await settle();
        expect(mocks.queueMessageSend.mock.calls.map(([uid]) => uid)).toEqual(["m1", "m1", "m2"]);
        expect(mocks.createDraft).toHaveBeenCalledTimes(1);
    });

    it("leaves out of a Retry a copy whose request never answered but which went after all, so the other copy goes and Open draft isn't offered", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        // The S/MIME copy's request lands, but its answer is lost - and so is the check after it.
        mocks.queueMessageSend.mockRejectedValueOnce(new TypeError("network down"));
        mocks.getMessage.mockRejectedValue(new TypeError("network down"));
        send({ cc: [{ address: "pat@proton.example" }] });
        await settle();
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry", "Open draft"]);

        // The server relayed it; the OpenPGP copy is still a draft. Retry hands over only that one - which fails, as only some recipients'.
        mocks.getMessage.mockImplementation(async (uid: string) => ({ ...draft, uid, folderUid: uid === "m1" ? "sent" : "drafts" }));
        mocks.queueMessageSend.mockReset().mockRejectedValueOnce(new ApiRequestError("Unavailable", 503)).mockResolvedValue({ queued: true, message: draft });
        toasts()[0].actions[0].onClick!();
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(1));
        await settle();
        expect(mocks.queueMessageSend.mock.calls.map(([uid]) => uid)).toEqual(["m2"]);
        expect(toasts()[0].message).toContain("Only some of its recipients were sent it");
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry"]);

        // The next Retry hands it over. The request is kept under it alone - the S/MIME copy went long ago, its report come and gone - so the
        // OpenPGP copy's report confirms the message.
        toasts()[0].actions[0].onClick!();
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(2));
        await settle();
        expect(mocks.queueMessageSend.mock.calls.map(([uid]) => uid)).toEqual(["m2", "m2"]);
        expect(retainedRequest("m1")).toBeUndefined();
        expect(retainedRequest("m2")?.copyUids).toEqual(["m1", "m2"]);
        handleSendEvent({ action: "send-succeeded", uid: "m2", mailboxUid: "mb1", subject: "Hello", recipients: ["pat@proton.example"], attempt: 1 });
        expect(toasts().map((toast) => toast.title)).toEqual(["Message sent"]);
        expect(retainedRequest("m2")).toBeUndefined();
    });

    it("hands nothing over when every copy still to go went between the Retry's check and the attempt", async () => {
        const pendingCopies = [draft, { ...draft, uid: "m2" }];
        for (const scheduledSendTime of [undefined, new Date(Date.now() + 1e6).toISOString()]) {
            // The Retry finds the S/MIME copy still a draft; by the time the attempt asks, both have gone.
            let asked = 0;
            mocks.getMessage.mockImplementation(async (uid: string) => ({ ...draft, uid, folderUid: asked++ === 0 ? "drafts" : "outbox" }));
            const copyFates = new Map<string, CopyFate>([
                ["m1", "unsent"],
                ["m2", "unsent"],
            ]);
            await retrySend(request({ pendingCopies, copyUids: ["m1", "m2"], copyFates, scheduledSendTime }));
            await settle();
            expect(mocks.queueMessageSend).not.toHaveBeenCalled();
            expect(mocks.sendMessage).not.toHaveBeenCalled();
            expect(toasts().filter((toast) => toast.kind === "error")).toEqual([]);
        }
        expect(toasts().some((toast) => toast.title === "Message scheduled")).toBe(true);
        // Neither copy is waited for: their reports have most likely come and gone. The message is confirmed at once.
        expect(toasts().some((toast) => toast.title === "Message sent")).toBe(true);
        expect(retainedRequest("m1")).toBeUndefined();
        expect(retainedRequest("m2")).toBeUndefined();
    });

    it("confirms a partly-sent message once its retried copy goes, though the first copy went before the Retry (#619)", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        mocks.queueMessageSend.mockResolvedValueOnce({ queued: true, message: draft }).mockRejectedValueOnce(new ApiRequestError("Unavailable", 503));
        mocks.getMessage.mockImplementation(async (uid: string) => ({ ...draft, uid, folderUid: uid === "m1" ? "outbox" : "drafts" }));
        send({ cc: [{ address: "pat@proton.example" }] });
        await settle();
        expect(toasts()[0].message).toContain("Only some of its recipients were sent it");

        // The S/MIME copy is relayed while the failure is showing; then the Retry hands over the OpenPGP copy, which is relayed in turn.
        handleSendEvent({ action: "send-succeeded", uid: "m1", mailboxUid: "mb1", subject: "Hello", recipients: ["bob@example.com"], attempt: 1 });
        expect(toasts().some((toast) => toast.title === "Message sent")).toBe(false);
        toasts()[0].actions[0].onClick!();
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(3));
        await settle();
        expect(retainedRequest("m1")).toBeUndefined();
        handleSendEvent({ action: "send-succeeded", uid: "m2", mailboxUid: "mb1", subject: "Hello", recipients: ["pat@proton.example"], attempt: 1 });
        expect(toasts().map((toast) => toast.title)).toEqual(["Message sent"]);
        expect(retainedRequest("m2")).toBeUndefined();
    });

    it("finds the message's other copy when a copy's report comes while the next is still being handed over (#621)", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        let handOverSecond: (value: unknown) => void = () => undefined;
        mocks.queueMessageSend
            .mockResolvedValueOnce({ queued: true, message: draft })
            .mockImplementationOnce(() => new Promise((resolve) => (handOverSecond = resolve)));
        send({ cc: [{ address: "pat@proton.example" }] });
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(2));

        // The S/MIME copy is refused for good while the OpenPGP one is still on its way to the server: only Retry.
        handleSendEvent({ action: "send-failed", uid: "m1", mailboxUid: "mb1", subject: "Hello", recipients: ["bob@example.com"], attempt: 1, error: { message: "No such user." } });
        expect(toasts()[0].message).toContain("the others' copy is sent on its own");
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry"]);
        handOverSecond({ queued: true, message: draft });
        await settle();
        expect(retainedRequest("m2")?.copyUids).toEqual(["m1", "m2"]);
        expect(retainedRequest("m1")).toBe(retainedRequest("m2"));
    });

    it("counts a copy's success reported while the next is still being handed over, confirming the message once the last goes", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        let handOverSecond: (value: unknown) => void = () => undefined;
        mocks.queueMessageSend
            .mockResolvedValueOnce({ queued: true, message: draft })
            .mockImplementationOnce(() => new Promise((resolve) => (handOverSecond = resolve)));
        send({ cc: [{ address: "pat@proton.example" }] });
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(2));
        handleSendEvent({ action: "send-succeeded", uid: "m1", mailboxUid: "mb1", subject: "Hello", recipients: ["bob@example.com"], attempt: 1 });
        handleSendEvent({ action: "send-succeeded", uid: "m1", mailboxUid: "mb1", subject: "Hello", recipients: ["bob@example.com"], attempt: 1 });
        handOverSecond({ queued: true, message: draft });
        await settle();
        expect(retainedRequest("m1")).toBeUndefined();
        expect(toasts()).toEqual([]);
        handleSendEvent({ action: "send-succeeded", uid: "m2", mailboxUid: "mb1", subject: "Hello", recipients: ["pat@proton.example"], attempt: 1 });
        expect(toasts().map((toast) => toast.title)).toEqual(["Message sent"]);
    });

    it("confirms a message whose every copy a server with no queue relayed before answering, once", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        // The first copy's report comes before the server answers; the second copy is relayed before it answers too.
        mocks.queueMessageSend
            .mockImplementationOnce(async () => {
                handleSendEvent({ action: "send-succeeded", uid: "m1", mailboxUid: "mb1", subject: "Hello", recipients: ["bob@example.com"], attempt: 1 });
                return { queued: false, message: draft };
            })
            .mockImplementationOnce(async () => {
                handleSendEvent({ action: "send-succeeded", uid: "m2", mailboxUid: "mb1", subject: "Hello", recipients: ["pat@proton.example"], attempt: 1 });
                return { queued: false, message: draft };
            });
        send({ cc: [{ address: "pat@proton.example" }] });
        await settle();
        expect(toasts().map((toast) => toast.title)).toEqual(["Message sent"]);
        expect(retainedRequest("m1")).toBeUndefined();
        expect(retainedRequest("m2")).toBeUndefined();
    });

    it("confirms a message whose every copy a server with no queue relayed before answering, reporting none, from the send itself", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        mocks.queueMessageSend.mockResolvedValue({ queued: false, message: draft });
        send({ cc: [{ address: "pat@proton.example" }] });
        await settle();
        expect(toasts().map((toast) => toast.title)).toEqual(["Message sent"]);
        expect(retainedRequest("m1")).toBeUndefined();
        expect(retainedRequest("m2")).toBeUndefined();
    });

    it("offers only Retry when the server fails to relay one copy of a mixed-format message, and confirms it once every copy went", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        send({ cc: [{ address: "pat@proton.example" }] });
        await settle();

        // The OpenPGP copy is relayed; the S/MIME one is refused for good.
        handleSendEvent({ action: "send-succeeded", uid: "m2", mailboxUid: "mb1", subject: "Hello", recipients: ["pat@proton.example"], attempt: 1 });
        expect(toasts()).toEqual([]);
        handleSendEvent({ action: "send-failed", uid: "m1", mailboxUid: "mb1", subject: "Hello", recipients: ["bob@example.com"], attempt: 3, error: { message: "Mailbox full." } });
        expect(toasts()[0].message).toBe('To bob@example.com - "Hello": The copy for some of its recipients didn\'t go - the others\' copy is sent on its own. Mailbox full.');
        expect(toasts()[0].actions.map((action) => action.label)).toEqual(["Retry"]);

        // Retried, it goes: now the message is confirmed.
        handleSendEvent({ action: "send-succeeded", uid: "m1", mailboxUid: "mb1", subject: "Hello", recipients: ["bob@example.com"], attempt: 1 });
        expect(toasts().map((toast) => toast.title)).toEqual(["Message sent"]);
    });

    describe("when the server fails every copy of a mixed-format message", () => {
        const failed = (uid: string, recipient: string) =>
            handleSendEvent({ action: "send-failed", uid, mailboxUid: "mb1", subject: "Hello", recipients: [recipient], attempt: 3, error: { message: "Over quota." } });
        const errors = () => toasts().filter((toast) => toast.kind === "error");
        const sendMixed = async () => {
            mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
            mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
            send({ cc: [{ address: "pat@proton.example" }] });
            await settle();
        };
        const settleBoth = async () => {
            await vi.waitFor(() => expect(isSendPending("m1") || isSendPending("m2")).toBe(false));
        };

        it("says the whole message failed, in one pop-up whose Retry hands every copy over again and which offers Open draft (#620)", async () => {
            await sendMixed();
            failed("m2", "pat@proton.example");
            expect(errors()[0].actions.map((action) => action.label)).toEqual(["Retry"]);
            failed("m1", "bob@example.com");
            expect(errors()).toHaveLength(1);
            expect(errors()[0].message).toBe('To bob@example.com - "Hello": Over quota.');
            expect(errors()[0].actions.map((action) => action.label)).toEqual(["Retry", "Open draft"]);

            // Retry hands both over: the S/MIME copy is refused at once, the OpenPGP one relayed before the server answered.
            mocks.queueMessageSend.mockReset().mockImplementation(async (uid: string) => {
                if (uid === "m1") {
                    throw new ApiRequestError("Unavailable", 503);
                }
                return { queued: false, message: draft };
            });
            errors()[0].actions[0].onClick!();
            await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(2));
            await settleBoth();
            expect(mocks.queueMessageSend.mock.calls.map(([uid]) => uid).sort()).toEqual(["m1", "m2"]);
            // One copy went, so the message isn't confirmed - and a failure of the other is one copy's again.
            expect(toasts().some((toast) => toast.title === "Message sent")).toBe(false);
            expect(retainedRequest("m2")).toBeUndefined();
            failed("m1", "bob@example.com");
            expect(errors().find((toast) => toast.message?.includes("Over quota."))?.actions.map((action) => action.label)).toEqual(["Retry"]);
        });

        it("writes the whole message again from Open draft, removing the extra OpenPGP copy (#620)", async () => {
            const open = vi.fn();
            const off = registerComposeOpener(open);
            await sendMixed();
            failed("m1", "bob@example.com");
            failed("m2", "pat@proton.example");
            mocks.getMessage.mockImplementation(async (uid: string) => ({ ...draft, uid, version: 7, folderUid: "outbox" }));
            mocks.listFolders.mockResolvedValue([{ uid: "drafts", type: "drafts" }]);
            mocks.cancelScheduledSend.mockImplementation(async (message: Message, folderUid: string) => ({ ...message, folderUid }));
            mocks.deleteMessage.mockResolvedValue(undefined);
            errors()[0].actions[1].onClick!();
            await vi.waitFor(() => expect(open).toHaveBeenCalled());
            expect(open.mock.calls[0][0].resume.draft).toMatchObject({ uid: "m1", folderUid: "drafts" });
            expect(open.mock.calls[0][0].resume.to).toBe("bob@example.com");
            expect(mocks.deleteMessage.mock.calls).toEqual([["m2", 7, undefined]]);
            expect(errors()).toEqual([]);
            expect(retainedRequest("m1")).toBeUndefined();
            expect(retainedRequest("m2")).toBeUndefined();
            off();
        });

        it("won't write the message again from an Open draft offered earlier, once a copy is on its way again (#621)", async () => {
            const open = vi.fn();
            const off = registerComposeOpener(open);
            await sendMixed();
            failed("m1", "bob@example.com");
            failed("m2", "pat@proton.example");
            const [retry, openDraft] = errors()[0].actions;
            retry.onClick!();
            await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(4));
            await settleBoth();
            openDraft.onClick!();
            await vi.waitFor(() => expect(toasts().some((toast) => toast.title === "Only this copy didn't go")).toBe(true));
            expect(mocks.listFolders).not.toHaveBeenCalled();
            expect(mocks.cancelScheduledSend).not.toHaveBeenCalled();
            expect(open).not.toHaveBeenCalled();
            off();
        });
    });

    it("waits for the first copy's report when the copy a Retry was for turns out to have gone already", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        mocks.queueMessageSend.mockResolvedValueOnce({ queued: true, message: draft }).mockRejectedValueOnce(new TypeError("network down"));
        mocks.getMessage.mockRejectedValue(new TypeError("network down"));
        send({ cc: [{ address: "pat@proton.example" }] });
        await settle();
        expect(toasts()[0].message).toContain("Only some of its recipients were sent it");

        // The Retry finds the OpenPGP copy still a draft; by the time the attempt asks, it has gone.
        let asked = 0;
        mocks.getMessage.mockImplementation(async (uid: string) => ({ ...draft, uid, folderUid: asked++ === 0 ? "drafts" : "outbox" }));
        toasts()[0].actions[0].onClick!();
        await vi.waitFor(() => expect(asked).toBe(2));
        await settle();
        expect(mocks.queueMessageSend).toHaveBeenCalledTimes(2);
        expect(toasts().some((toast) => toast.title === "Message sent")).toBe(false);
        handleSendEvent({ action: "send-succeeded", uid: "m1", mailboxUid: "mb1", subject: "Hello", recipients: ["bob@example.com"], attempt: 1 });
        expect(toasts().map((toast) => toast.title)).toEqual(["Message sent"]);
    });

    it("says only some recipients will get a send-later message when one copy couldn't be scheduled", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        mocks.sendMessage.mockResolvedValueOnce(draft).mockRejectedValueOnce(new ApiRequestError("Unavailable", 503));
        send({ cc: [{ address: "pat@proton.example" }], scheduledSendTime: new Date(Date.now() + 1e6).toISOString() });
        await settle();
        expect(toasts()[0].message).toContain("Only some of its recipients will get it");
    });

    it("schedules every copy of a send-later message", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockImplementation(async (_mailboxUid: string, address: string) => ({ keys: address === "bob@example.com" ? [peerKey] : [pgpKey], encryptPreference: MUTUAL }));
        send({ cc: [{ address: "pat@proton.example" }], scheduledSendTime: 5_000_000_000_000 });
        await settle();
        expect(mocks.sendMessage.mock.calls.map(([uid, input]) => [uid, input])).toEqual([
            ["m1", { scheduledSendTime: 5_000_000_000_000 }],
            ["m2", { scheduledSendTime: 5_000_000_000_000 }],
        ]);
    });

    it("can't encrypt to an OpenPGP recipient while the sender's own OpenPGP key isn't unlocked", async () => {
        mocks.getUnlockedKeys.mockReturnValue({ ...unlockedEncryption, ...unlockedSigning });
        mocks.lookupKeys.mockResolvedValue({ keys: [pgpKey], encryptPreference: MUTUAL });
        send({ encryptRequested: true });
        await settle();
        expect(mocks.buildPgpEncryptedMessage).not.toHaveBeenCalled();
        expect(mocks.queueMessageSend).not.toHaveBeenCalled();
    });

    it("encrypts with S/MIME to a recipient who prefers OpenPGP but also has a certificate, when the sender has no OpenPGP key unlocked", async () => {
        mocks.getUnlockedKeys.mockReturnValue({ ...unlockedEncryption, ...unlockedSigning });
        mocks.lookupKeys.mockResolvedValue({ keys: [pgpKey, peerKey], encryptPreference: MUTUAL, preferredFormat: "openpgp" });
        send();
        await settle();
        expect(mocks.buildPgpEncryptedMessage).not.toHaveBeenCalled();
        expect(mocks.buildEncryptedMessage).toHaveBeenCalled();
        expect(mocks.queueMessageSend).toHaveBeenCalledWith("m1", undefined);
    });

    it("asks for the unlock, rather than sending plain, to an OpenPGP recipient while the mailbox is locked", async () => {
        mocks.getUnlockedKeys.mockReturnValue(undefined);
        mocks.lookupKeys.mockResolvedValue({ keys: [pgpKey], encryptPreference: MUTUAL });
        send();
        await settle();
        expect(mocks.assembleDraft).not.toHaveBeenCalled();
        expect(mocks.queueMessageSend).not.toHaveBeenCalled();
    });

    it("ignores a recipient's OpenPGP key when the server doesn't allow OpenPGP", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedOpenPgp);
        mocks.lookupKeys.mockResolvedValue({ keys: [pgpKey], encryptPreference: MUTUAL });
        send({ policy: AUTO });
        await settle();
        expect(mocks.buildPgpEncryptedMessage).not.toHaveBeenCalled();
        expect(mocks.assembleDraft).toHaveBeenCalled();
    });
});

// `useApiClient()` value as `startSend()`/`retrySend()`'s trailing `client` argument (see `ComposeWindow.tsx`'s `submit()`); every REST call
// `sendJob.ts` makes along the way must forward that same instance rather than falling back to the default global cookie-based session. Every
// test above calls `startSend()`/`retrySend()` with no client at all, proving the other half: that path is untouched, `client` staying
// `undefined` all the way down to each mocked REST function's own trailing parameter.
describe("startSend/retrySend - an explicit ApiClient is threaded through", () => {
    const client = { fetch: vi.fn(), setUnauthorizedObserver: vi.fn() };

    it("passes it to every call the plain-message path makes", async () => {
        expect(startSend(request(), client)).toBe(true);
        await settle();
        expect(mocks.assembleDraft).toHaveBeenCalledWith("m1", expect.anything(), client);
        expect(mocks.queueMessageSend).toHaveBeenCalledWith("m1", client);
    });

    it("passes it to the mailbox/policy/recipient-key lookups a send fills in for itself", async () => {
        mocks.getUnlockedKeys.mockReturnValue(unlockedEncryption);
        mocks.getEncryptionPolicy.mockResolvedValue(AUTO);
        mocks.lookupKeys.mockResolvedValue({ keys: [peerKey], encryptPreference: { preferEncrypt: "mutual" } });
        startSend(request({ mailbox: undefined, policy: undefined }), client);
        await settle();
        expect(mocks.getMailbox).toHaveBeenCalledWith("mb1", undefined, client);
        expect(mocks.getEncryptionPolicy).toHaveBeenCalledWith(client);
        expect(mocks.lookupKeys).toHaveBeenCalledWith("mb1", "bob@example.com", client);
        expect(mocks.assembleDraftRaw).toHaveBeenCalledWith("m1", expect.anything(), client);
    });

    it("passes it to the receipt flag and a send-later's own call", async () => {
        startSend(request({ requestReceipt: true }), client);
        await settle();
        expect(mocks.setMessageRequestReceipt).toHaveBeenCalledWith(expect.anything(), true, client);
        forgetRetainedRequest("m1");
        const time = new Date(Date.now() + 3_600_000).toISOString();
        startSend(request({ scheduledSendTime: time }), client);
        await settle();
        expect(mocks.sendMessage).toHaveBeenCalledWith("m1", { scheduledSendTime: time }, client);
    });

    it("passes it to retrySend's own already-accepted check and the send it starts", async () => {
        mocks.getMessage.mockResolvedValue({ ...draft, folderUid: "sent" });
        await retrySend(request(), client);
        expect(mocks.getMessage).toHaveBeenCalledWith("m1", client);
        expect(mocks.queueMessageSend).not.toHaveBeenCalled();

        mocks.getMessage.mockResolvedValue(draft);
        await retrySend(request(), client);
        await settle();
        expect(mocks.queueMessageSend).toHaveBeenCalledWith("m1", client);
    });

    it("passes it to Retry clicked from the failure pop-up", async () => {
        mocks.queueMessageSend.mockRejectedValueOnce(new ApiRequestError("Relay down", 500));
        startSend(request(), client);
        await settle();
        toasts()[0].actions[0].onClick!();
        await vi.waitFor(() => expect(mocks.queueMessageSend).toHaveBeenCalledTimes(2));
        expect(mocks.queueMessageSend).toHaveBeenLastCalledWith("m1", client);
        await settle();
        expect(mocks.getMessage).toHaveBeenCalledWith("m1", client);
    });
});
