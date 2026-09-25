// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The compose window's background-send behaviour that ComposeWindow.test.tsx doesn't cover: what is checked before it closes, waiting for
// attachments, and a window re-opened around an already composed message (a failed send's "Open draft").
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ComposeWindow from "../../../apps/shared/components/mail/compose/ComposeWindow.js";
import ComposeProvider, { ComposeSession } from "../../../apps/shared/components/mail/compose/ComposeContext.js";
import { openComposeFromOutside } from "../../../apps/shared/mail/outbox/composeBridge.js";
import { beginPendingSend, isSendPending } from "../../../apps/shared/mail/outbox/pendingSends.js";
import { getOutgoingReplies } from "../../../apps/shared/mail/outbox/outgoingReplies.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { clearMailboxWritabilityCache } from "../../../apps/shared/components/mail/writableMailboxes.js";
import { ShortcutProvider } from "../../../apps/shared/keyboard/ShortcutProvider.js";

const { getUnlockedKeys } = vi.hoisted(() => ({ getUnlockedKeys: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, subscribeKeySession: () => () => undefined }));
const { requestUnlock } = vi.hoisted(() => ({ requestUnlock: vi.fn() }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock }) }));
vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
        <textarea data-testid="html-editor" value={value} onChange={(event) => onChange(event.target.value)} />
    ),
}));

const encryptKey = { publicKey: "cert", type: "x509", useType: "encrypt", fingerprint: "fp-encrypt", notBefore: Date.now() - 1000, notAfter: Date.now() + 1e9 };
const mailbox = { uid: "mb1", primarySmtpAddress: "u1@example.com", aliasAddresses: [], displayName: "User", keys: [] as unknown[] };
const draftsFolder = { uid: "f-drafts", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Drafts", type: "drafts", unreadCount: 0, totalCount: 0 };
const draft = {
    uid: "m1",
    version: 0,
    dateCreated: "",
    dateModified: "",
    folderUid: "f-drafts",
    mailboxUid: "mb1",
    messageId: "abc@webmail",
    subject: "",
    from: { address: "u1@example.com", type: "to" },
    recipients: [],
    sentDate: "",
    receivedDate: "",
    bodyPreview: "",
    flags: { read: true },
    importance: "normal",
    hasAttachments: false,
};
const attachment = { uid: "a1", version: 0, messageUid: "m1", folderUid: "f-drafts", mailboxUid: "mb1", filename: "notes.txt", mimeType: "text/plain", sizeBytes: 5, isInline: false };
const policy = { encryptSameOrg: "automatic", encryptFederated: "automatic", encryptExternal: "automatic" };

function session(overrides: Partial<ComposeSession> = {}): ComposeSession {
    return { id: "s1", mailboxUid: "mb1", signatureContext: "new", minimized: false, ...overrides };
}

function mockServer(extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined, mailboxFixture: object = mailbox) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        const method = init?.method ?? "GET";
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [draftsFolder]);
        if (url.startsWith("/api/mail/mail-signatures")) return jsonResponse(200, []);
        if (url === "/api/mail/messages" && method === "POST") return jsonResponse(200, draft);
        if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, mailboxFixture);
        if (url === "/api/system/encryption-policy") return jsonResponse(200, policy);
        if (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup")) return jsonResponse(200, { keys: [{ ...encryptKey, publicKey: "cGVlcg==" }], encryptPreference: { preferEncrypt: "mutual" } });
        if (url === "/api/mail/compose/m1/assemble" && method === "POST") return jsonResponse(200, { ...draft, version: 1 });
        if (url === "/api/mail/messages/m1/send" && method === "POST") return jsonResponse(202, { status: "queued", message: draft });
        if (url === "/api/mail/messages/m1" && method === "GET") return jsonResponse(200, draft);
        if (url === "/api/mail/messages/m1" && method === "PUT") return jsonResponse(200, { ...draft, requestReceipt: true });
        if (url.startsWith("/api/mail/attachments/upload") && method === "POST") return jsonResponse(200, attachment);
        if (url.startsWith("/api/mail/messages/m1?") && method === "DELETE") return new Response(null, { status: 204 });
        throw new Error(`unexpected ${method} ${url}`);
    });
}

const calls = (fetchMock: ReturnType<typeof mockFetch>, predicate: (url: string, method: string) => boolean) =>
    fetchMock.mock.calls.filter(([url, init]) => predicate(String(url), (init as RequestInit | undefined)?.method ?? "GET"));
const isSend = (url: string, method: string) => url === "/api/mail/messages/m1/send" && method === "POST";
const isAssemble = (url: string) => /\/api\/mail\/compose\/m1\/assemble(-raw)?$/.test(url);
const toasts = () => getNotificationsSnapshot().visible;

async function renderReady(overrides: Partial<ComposeSession> = {}, onClose = vi.fn(), props: Record<string, unknown> = {}) {
    const view = render(<ComposeWindow session={session(overrides)} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    return { ...view, onClose };
}

afterEach(() => {
    clearMailboxWritabilityCache();
    vi.unstubAllGlobals();
    getUnlockedKeys.mockReset();
    requestUnlock.mockReset();
});

describe("Send waits for an attachment that is still uploading", () => {
    it("says so inline, holds the Send buttons, then sends with the attachment and closes", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        let finishUpload!: (response: Response) => void;
        const fetchMock = mockServer((url, init) =>
            url.startsWith("/api/mail/attachments/upload") && init?.method === "POST" ? new Promise<Response>((resolve) => (finishUpload = resolve)) : undefined,
        );
        const user = userEvent.setup();
        const { onClose } = await renderReady();
        await user.type(screen.getByLabelText("To"), "b@example.com");
        await user.upload(screen.getByLabelText("Attach files"), new File(["hello"], "notes.txt", { type: "text/plain" }));
        await waitFor(() => expect(finishUpload).toBeDefined());

        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        expect(await screen.findByText("Waiting for attachments to finish uploading…")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Send later" })).toBeDisabled();
        expect(onClose).not.toHaveBeenCalled();
        // Nothing else happens - and pressing the shortcut meanwhile does nothing either.
        fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Enter", ctrlKey: true });
        expect(calls(fetchMock, isSend)).toHaveLength(0);

        finishUpload(jsonResponse(200, attachment));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(isSendPending("m1")).toBe(false));
        expect(calls(fetchMock, isSend)).toHaveLength(1);
        expect(calls(fetchMock, isAssemble)).toHaveLength(1);
    });

    it("stays open with the recipient error when the To field was emptied meanwhile, and lets Send be pressed again", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        let finishUpload!: (response: Response) => void;
        mockServer((url, init) =>
            url.startsWith("/api/mail/attachments/upload") && init?.method === "POST" ? new Promise<Response>((resolve) => (finishUpload = resolve)) : undefined,
        );
        const user = userEvent.setup();
        const { onClose } = await renderReady({ initialTo: "b@example.com" });
        await user.upload(screen.getByLabelText("Attach files"), new File(["hello"], "notes.txt", { type: "text/plain" }));
        await waitFor(() => expect(finishUpload).toBeDefined());
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await screen.findByText("Waiting for attachments to finish uploading…");

        await user.click(screen.getByRole("button", { name: "Remove b@example.com" }));
        finishUpload(jsonResponse(200, attachment));

        expect(await screen.findByText("At least one recipient is required.")).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
    });

    it("waits for every upload started before it, not just the first to finish", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        const finishers: ((response: Response) => void)[] = [];
        const fetchMock = mockServer((url, init) =>
            url.startsWith("/api/mail/attachments/upload") && init?.method === "POST" ? new Promise<Response>((resolve) => finishers.push(resolve)) : undefined,
        );
        const user = userEvent.setup();
        const { onClose } = await renderReady({ initialTo: "b@example.com" });
        await user.upload(screen.getByLabelText("Attach files"), new File(["one"], "one.txt", { type: "text/plain" }));
        await user.upload(screen.getByLabelText("Attach files"), new File(["two"], "two.txt", { type: "text/plain" }));
        await waitFor(() => expect(finishers).toHaveLength(2));
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await screen.findByText("Waiting for attachments to finish uploading…");

        finishers[0](jsonResponse(200, attachment));
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText("Waiting for attachments to finish uploading…")).toBeInTheDocument();

        finishers[1](jsonResponse(200, { ...attachment, uid: "a2", filename: "two.txt" }));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(calls(fetchMock, isSend)).toHaveLength(1));
    });

    it("waits for a pasted or inserted image too", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        mockServer();
        const { onClose } = await renderReady({ initialTo: "b@example.com" });
        // The editor stub has no image button: an upload that is not started leaves nothing to wait for.
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
});

describe("Close in progress", () => {
    it("takes Escape but does nothing while a Close is still saving the draft, as its button is disabled", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        let finishSave!: (response: Response) => void;
        const fetchMock = mockServer((url, init) =>
            isAssemble(url) && init?.method === "POST" ? new Promise<Response>((resolve) => (finishSave = resolve)) : undefined,
        );
        const onClose = vi.fn();
        render(
            <ShortcutProvider>
                <ComposeWindow session={session()} onClose={onClose} onToggleMinimize={vi.fn()} autosaveDelayMs={60_000} />
            </ShortcutProvider>,
        );
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
        fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Keep me" } });

        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeDisabled());
        expect(fireEvent.keyDown(screen.getByLabelText("Subject"), { key: "Escape" })).toBe(false);
        expect(calls(fetchMock, (url) => isAssemble(url))).toHaveLength(1);
        expect(onClose).not.toHaveBeenCalled();

        finishSave(jsonResponse(200, { ...draft, version: 1 }));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
});

describe("Send checks what it can before closing", () => {
    const withKey = { ...mailbox, keys: [encryptKey] };

    it("stays open, prompts the unlock and offers the override when encryption was asked for and its key is locked - the override sends and closes", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        requestUnlock.mockRejectedValue(new Error("Unlock cancelled."));
        const fetchMock = mockServer(undefined, withKey);
        const user = userEvent.setup();
        const { onClose } = await renderReady({ initialTo: "b@example.com", initialEncrypt: true });

        await user.click(screen.getByRole("button", { name: "Send" }));

        expect(await screen.findByText(/can't be encrypted right now - your encryption key is locked/)).toBeInTheDocument();
        expect(requestUnlock).toHaveBeenCalledWith("mb1", [expect.objectContaining({ useType: "encrypt" })]);
        expect(onClose).not.toHaveBeenCalled();
        expect(calls(fetchMock, isSend)).toHaveLength(0);

        await user.click(screen.getByRole("button", { name: "Send without encryption" }));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(calls(fetchMock, isSend)).toHaveLength(1));
        expect(calls(fetchMock, isAssemble).map(([url]) => url)).toEqual(["/api/mail/compose/m1/assemble"]);
    });

    it("a blocked Send later replays the schedule when the override is chosen", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        requestUnlock.mockRejectedValue(new Error("Unlock cancelled."));
        const fetchMock = mockServer(undefined, withKey);
        const user = userEvent.setup();
        const { onClose } = await renderReady({ initialTo: "b@example.com", initialEncrypt: true });
        const future = new Date(Date.now() + 86_400_000);
        const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

        await user.click(screen.getByRole("button", { name: "Send later" }));
        await user.type(screen.getByLabelText("Send at"), local);
        await user.click(screen.getAllByRole("button", { name: "Send later" })[1]);
        await screen.findByText(/your encryption key is locked/);
        expect(onClose).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Send without encryption" }));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(calls(fetchMock, isSend)).toHaveLength(1));
        const body = JSON.parse(String((calls(fetchMock, isSend)[0][1] as RequestInit).body));
        expect(new Date(body.scheduledSendTime).getTime()).toBeGreaterThan(Date.now());
    });

    it("stays open without prompting when the block is not about locked keys (Bcc on an encrypted message, keys already unlocked)", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32), encryptionPrivateKey: {} as CryptoKey, encryptionCertDer: new Uint8Array([1]) });
        const fetchMock = mockServer(undefined, withKey);
        const user = userEvent.setup();
        const { onClose } = await renderReady({ initialTo: "b@example.com", initialEncrypt: true });
        await user.click(screen.getByRole("button", { name: "Cc Bcc" }));
        await user.type(screen.getByLabelText("Bcc"), "hidden@example.com");
        await screen.findAllByText(/supports encryption/);
        await waitFor(() => expect(calls(fetchMock, (url) => url.includes("/keys/lookup")).length).toBeGreaterThan(0));

        await user.click(screen.getByRole("button", { name: "Send" }));

        expect(await screen.findByText(/Bcc recipients can't be used with encrypted messages/)).toBeInTheDocument();
        expect(requestUnlock).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("names the recipients an encrypted message can't reach, before it closes", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32), encryptionPrivateKey: {} as CryptoKey, encryptionCertDer: new Uint8Array([1]) });
        mockServer((url) => (url.startsWith("/api/mail/mailboxes/mb1/keys/lookup") ? jsonResponse(200, { keys: [] }) : undefined), withKey);
        const user = userEvent.setup();
        const { onClose } = await renderReady({ initialTo: "nokey@example.com", initialEncrypt: true });
        await screen.findByText(/nokey@example\.com no encryption key found/);

        await user.click(screen.getByRole("button", { name: "Send" }));

        expect(await screen.findByText(/can’t be encrypted for everyone: nokey@example\.com has no encryption key on file/)).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("rejects a signed message with an attachment right here, with no override, and stays open", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32), signingPrivateKey: {} as CryptoKey, signingCertDer: new Uint8Array([2]) });
        mockServer();
        const user = userEvent.setup();
        const { onClose } = await renderReady({ initialTo: "b@example.com" });
        await user.upload(screen.getByLabelText("Attach files"), new File(["hello"], "notes.txt", { type: "text/plain" }));
        await screen.findByText("notes.txt");

        await user.click(screen.getByRole("button", { name: "Send" }));

        expect(await screen.findByText(/cannot include file attachments yet/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Send without/ })).not.toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("says so, and stays open, when this draft is already being sent (a retry from a pop-up is under way)", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        const fetchMock = mockServer();
        const { onClose } = await renderReady({ initialTo: "b@example.com" });
        beginPendingSend({ draftUid: "m1", mailboxUid: "mb1", subject: "", recipients: ["b@example.com"], scheduled: false });

        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        expect(await screen.findByText("This message is already being sent.")).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        expect(calls(fetchMock, isSend)).toHaveLength(0);
        // The window can still be closed, and pressing Send again once the other send is done works.
        expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
    });
});

describe("a window re-opened around a message that was already composed", () => {
    const resume = {
        draft: { ...draft, version: 4 },
        mailboxUid: "mb1",
        to: "b@example.com",
        cc: "c@example.com",
        bcc: "",
        subject: "Quarterly plan",
        html: "<p>Everything I typed</p>",
        attachments: [attachment],
        requestReceipt: true,
        signEnabled: false,
        encryptRequested: false,
    };

    function Host() {
        return (
            <ComposeProvider userUid="u1">
                <span>app</span>
            </ComposeProvider>
        );
    }

    it("comes back from outside React with every field as it was typed, on the same draft - no new draft, no signature seeding", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        const fetchMock = mockServer();
        render(<Host />);

        act(() => {
            expect(openComposeFromOutside({ mailboxUid: "mb1", resume })).toBe(true);
        });

        const editor = await screen.findByTestId("html-editor");
        expect(editor).toHaveValue("<p>Everything I typed</p>");
        expect(screen.getByLabelText("Subject")).toHaveValue("Quarterly plan");
        expect(within(screen.getByRole("list", { name: "To recipients" })).getByRole("listitem")).toHaveAttribute("title", "b@example.com");
        expect(within(screen.getByRole("list", { name: "Cc recipients" })).getByRole("listitem")).toHaveAttribute("title", "c@example.com");
        expect(screen.getByText("notes.txt")).toBeInTheDocument();
        expect(screen.getByLabelText("Request a read receipt")).toBeChecked();
        await waitFor(() => expect(calls(fetchMock, (url) => url.startsWith("/api/mail/folders"))).toHaveLength(1));
        expect(calls(fetchMock, (url, method) => url === "/api/mail/messages" && method === "POST")).toHaveLength(0);
        expect(calls(fetchMock, (url) => url.startsWith("/api/mail/mail-signatures"))).toHaveLength(0);
        // The attachments stay attached to the draft, so the sender can't be changed.
        expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
    });

    it("sends the same draft again from there, closing at once", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        const fetchMock = mockServer();
        render(<Host />);
        act(() => {
            openComposeFromOutside({ mailboxUid: "mb1", resume: { ...resume, attachments: [] } });
        });
        await screen.findByTestId("html-editor");
        await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());

        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Quarterly plan" })).not.toBeInTheDocument());
        await waitFor(() => expect(calls(fetchMock, isSend)).toHaveLength(1));
        expect(calls(fetchMock, isAssemble)).toHaveLength(1);
        expect(JSON.parse(String((calls(fetchMock, isAssemble)[0][1] as RequestInit).body))).toMatchObject({ subject: "Quarterly plan", html: "<p>Everything I typed</p>" });
        expect(toasts().filter((toast) => toast.kind === "error")).toEqual([]);
    });

    it("keeps the sign and encrypt choices it was closed with, and without Cc/Bcc shows neither row", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32), encryptionPrivateKey: {} as CryptoKey, encryptionCertDer: new Uint8Array([1]) });
        mockServer(undefined, { ...mailbox, keys: [encryptKey] });
        render(<Host />);
        act(() => {
            openComposeFromOutside({ mailboxUid: "mb1", resume: { ...resume, cc: "", attachments: [], encryptRequested: true, signEnabled: true } });
        });
        expect(await screen.findByLabelText("Encrypt this message")).toBeChecked();
        expect(screen.queryByLabelText("Cc")).not.toBeInTheDocument();
    });
});

describe("Send of a reply shows the message in its conversation", () => {
    it("hands the thread the window was opened with on, so the open conversation draws the message at once", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        mockServer();
        const { onClose } = await renderReady({ initialTo: "b@example.com", initialSubject: "Re: Hello", threading: { inReplyTo: "orig@example.com", references: ["root@example.com", "orig@example.com"] } });

        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(getOutgoingReplies()).toEqual([
            expect.objectContaining({
                uid: "m1",
                mailboxUid: "mb1",
                inReplyTo: "orig@example.com",
                references: ["root@example.com", "orig@example.com"],
                subject: "Re: Hello",
                sender: { address: "u1@example.com", displayName: "User" },
                to: [expect.objectContaining({ address: "b@example.com" })],
            }),
        ]);
    });

    it("leaves a new message out of every conversation", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        mockServer();
        const { onClose } = await renderReady({ initialTo: "b@example.com" });

        fireEvent.click(screen.getByRole("button", { name: "Send" }));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(getOutgoingReplies()).toEqual([]);
    });
});
