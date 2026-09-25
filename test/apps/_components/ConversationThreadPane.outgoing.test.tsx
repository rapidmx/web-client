// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import type { Folder, Mailbox, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import type { SendEvent } from "@rapidmx/react-shared/mail/sendEvents.js";
import { jsonResponse, mockFetch } from "../testUtils.js";

// What the thread does with the messages this tab sends: `MessageDetailPane` is drawn by a stand-in (its own tests are elsewhere) and the shell's
// live updates are whatever a test says they are; the background send itself (`startSend()`, `handleSendEvent()`) is real, over a mocked `mailApi`.
const shell: { live: { tick: number; folderUids: ReadonlySet<string> | null } } = vi.hoisted(() => ({ live: { tick: 0, folderUids: null } }));
const api = vi.hoisted(() => ({ assembleDraft: vi.fn(), queueMessageSend: vi.fn(), getMessage: vi.fn(), listFolders: vi.fn(), cancelScheduledSend: vi.fn(), getUnlockedKeys: vi.fn() }));

vi.mock("@rapidmx/react-shared/mail/mailApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/mail/mailApi.js")>()),
    assembleDraft: api.assembleDraft,
    queueMessageSend: api.queueMessageSend,
    getMessage: api.getMessage,
    listFolders: api.listFolders,
    cancelScheduledSend: api.cancelScheduledSend,
}));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys: api.getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/components/mail/layout/MailShell.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../apps/shared/components/mail/layout/MailShell.js")>();
    return { ...actual, useMailShell: () => ({ ...actual.useMailShell(), live: shell.live }) };
});
vi.mock("../../../apps/shared/components/mail/MessageDetailPane.js", () => ({
    default: ({
        message,
        threadHeader,
        footer,
        onArchived,
        onLabelsChanged,
    }: {
        message: Message;
        threadHeader?: { bodyId: string; onToggle: () => void; buttonRef: (node: HTMLButtonElement | null) => void };
        footer?: boolean;
        onArchived: (updated: Message) => void;
        onLabelsChanged: (updated: Message) => void;
    }) => (
        <div data-testid={`detail-${message.uid}`} data-version={message.version}>
            <h2>
                <button type="button" ref={threadHeader!.buttonRef} aria-expanded="true" aria-controls={threadHeader!.bodyId} onClick={threadHeader!.onToggle}>
                    {message.from.displayName}
                </button>
            </h2>
            <span id={threadHeader!.bodyId}>
                body:{message.uid} footer:{String(!!footer)}
            </span>
            <button type="button" onClick={() => onArchived({ ...message, folderUid: "f9" })}>
                archive-{message.uid}
            </button>
            <button type="button" onClick={() => onLabelsChanged({ ...message, version: 9 })}>
                label-{message.uid}
            </button>
        </div>
    ),
}));

import ConversationThreadPane from "../../../apps/shared/components/mail/ConversationThreadPane.js";
import { SendRequest, startSend } from "../../../apps/shared/mail/outbox/sendJob.js";
import { handleSendEvent } from "../../../apps/shared/mail/outbox/sendOutcomes.js";
import { isSendPending } from "../../../apps/shared/mail/outbox/pendingSends.js";
import { failOutgoing, getOutgoingReplies, trackOutgoing } from "../../../apps/shared/mail/outbox/outgoingReplies.js";
import { registerComposeOpener } from "../../../apps/shared/mail/outbox/composeBridge.js";

function folder(uid: string, type: string) {
    return { uid, version: 0, dateCreated: "2026-01-01T00:00:00.000Z", dateModified: "2026-01-01T00:00:00.000Z", mailboxUid: "mb1", name: type, type };
}
const FOLDERS = [folder("f1", "inbox"), folder("f2", "sent_items"), folder("f3", "drafts")] as Folder[];

function message(uid: string, sender: string, overrides: Partial<Message> = {}): Message {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: `${uid}@example.com`,
        subject: "Project Zeus",
        from: { address: `${sender.toLowerCase()}@example.com`, displayName: sender, type: "to" },
        recipients: [],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: `Preview of ${uid}`,
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal",
        hasAttachments: false,
        ...overrides,
    };
}

/** The copy the server files in Sent Items once it has relayed the reply: the draft's uid, the conversation's messages' ids in its threading. */
const sentCopy = (overrides: Partial<Message> = {}) =>
    message("d1", "Me Myself", { folderUid: "f2", messageId: "sent-d1@example.com", subject: "Re: Project Zeus", inReplyTo: "m2@example.com", conversationId: "c1", ...overrides });

const mailbox = { uid: "mb1", primarySmtpAddress: "me@example.com", displayName: "Me Myself" } as unknown as Mailbox;

function replyRequest(overrides: Partial<SendRequest> = {}, uid = "d1"): SendRequest {
    return {
        draft: { uid, version: 1, folderUid: "f3", mailboxUid: "mb1" } as Message,
        mailboxUid: "mb1",
        mailbox,
        policy: undefined,
        toText: "bob@example.com",
        ccText: "",
        bccText: "",
        to: [{ address: "bob@example.com", displayName: "Bob" }],
        cc: [],
        bcc: [],
        subject: "Re: Project Zeus",
        html: "<p>Thanks for the update</p>",
        attachments: [],
        requestReceipt: false,
        signEnabled: false,
        offeredSign: false,
        offeredEncrypt: false,
        encryptRequested: false,
        forcePlaintext: false,
        threading: { inReplyTo: "m2@example.com", references: ["m1@example.com", "m2@example.com"] },
        ...overrides,
    };
}

function sendEvent(action: SendEvent["action"], overrides: Partial<SendEvent> = {}): SendEvent {
    return { action, uid: "d1", mailboxUid: "mb1", subject: "Re: Project Zeus", recipients: ["bob@example.com"], attempt: 1, ...overrides };
}

/** The pane over a thread the (mutable) `server` answers with. */
function renderPane(server: { thread: Message[]; failing?: boolean; hold?: Promise<void> } = { thread: [message("m1", "Alice"), message("m2", "Bob")] }) {
    const fetchMock = mockFetch(async (url) => {
        if (url.startsWith("/api/mail/messages/conversations/")) {
            await server.hold;
            return server.failing ? jsonResponse(500, { message: "down" }) : jsonResponse(200, server.thread);
        }
        throw new Error(`unexpected ${url}`);
    });
    const element = () => (
        <ConversationThreadPane
            conversation={{ conversationId: "c1", subject: "Project Zeus", messageCount: 2 }}
            mailboxUid="mb1"
            selectedUid="m2"
            folders={FOLDERS}
            onMessagePatched={vi.fn()}
            onMessageRemoved={vi.fn()}
        />
    );
    const result = render(element());
    const liveUpdate = (folderUids: ReadonlySet<string> | null) => {
        shell.live = { tick: shell.live.tick + 1, folderUids };
        result.rerender(element());
    };
    const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/mail/messages/conversations/")).length;
    return { ...result, server, fetchMock, liveUpdate, reads };
}

const card = () => document.querySelector("li[data-outgoing]");
const status = () => screen.getByTestId("pending-message-status");
const bodyFrame = () => screen.getByTitle("Message: Re: Project Zeus");
/** The order the pane draws its entries in: a pending card is `outgoing`, a message is its uid. */
const order = () => [...document.querySelectorAll("ul > li")].map((li) => (li.hasAttribute("data-outgoing") ? "outgoing" : li.querySelector("[data-testid]")?.getAttribute("data-testid") ?? li.textContent));

afterEach(() => {
    shell.live = { tick: 0, folderUids: null };
    for (const mock of Object.values(api)) {
        mock.mockReset();
    }
    vi.restoreAllMocks();
});

function queueOk() {
    api.assembleDraft.mockResolvedValue({ uid: "d1", version: 2, folderUid: "f3", mailboxUid: "mb1" });
    api.queueMessageSend.mockResolvedValue({ queued: true, message: { uid: "d1", folderUid: "outbox" } });
    api.getMessage.mockResolvedValue({ uid: "d1", folderUid: "f3" });
    api.getUnlockedKeys.mockReturnValue(undefined);
}

describe("a reply sent from the open conversation", () => {
    it("is at the top at once, as what was composed and by whom, and is replaced by the real message without a duplicate", async () => {
        queueOk();
        const pane = renderPane();
        await screen.findByTestId("detail-m2");

        act(() => void startSend(replyRequest()));

        // At once: sending, at the top of the thread, from the sending mailbox, to who it went to, with the composed body in the reading frame.
        expect(await screen.findByTestId("pending-message-status")).toHaveTextContent("Sending…");
        expect(order()).toEqual(["outgoing", "detail-m2", expect.any(String)]);
        expect(screen.getByRole("heading", { name: /Me Myself/ })).toBeInTheDocument();
        expect(card()).toHaveTextContent("To Bob <bob@example.com>");
        expect(bodyFrame().getAttribute("srcdoc")).toContain("Thanks for the update");
        expect(screen.getByText("3 messages")).toBeInTheDocument();
        // The focus goes to the new card: the compose window it was sent from has closed.
        await waitFor(() => expect(screen.getByRole("heading", { name: /Me Myself/ })).toHaveFocus());
        // The server has queued it, and the thread still holds only the messages it had.
        await waitFor(() => expect(isSendPending("d1")).toBe(false));
        expect(status()).toHaveTextContent("Sending…");
        expect(pane.reads()).toBe(1);

        // The server relays it and files the copy in Sent Items; the pane reads the thread again at once.
        pane.server.thread.push(sentCopy());
        act(() => handleSendEvent(sendEvent("send-succeeded")));

        // Replaced, expanded as the card was, by the one message - not next to it - and still where the focus is.
        const real = await screen.findByTestId("detail-d1");
        expect(card()).toBeNull();
        expect(screen.getAllByTestId("detail-d1")).toHaveLength(1);
        expect(order()).toEqual(["detail-d1", "detail-m2", expect.any(String)]);
        expect(screen.getByText("3 messages")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Me Myself/ })).toHaveFocus();
        expect(real).toHaveAttribute("data-version", "0");
        await waitFor(() => expect(getOutgoingReplies()).toEqual([]));
        // The reader's own expansion is not touched: the older message is still folded.
        expect(screen.queryByTestId("detail-m1")).toBeNull();
    });

    it("does not take the focus from the new message when it was not there, and leaves the card where it is for a second message", async () => {
        queueOk();
        renderPane();
        await screen.findByTestId("detail-m2");

        act(() => void startSend(replyRequest()));
        await screen.findByTestId("pending-message-status");
        act(() => void startSend(replyRequest({}, "d2")));

        await waitFor(() => expect(document.querySelectorAll("li[data-outgoing]")).toHaveLength(2));
        // The newest sits on top, and it is the one that has the view and the focus.
        await waitFor(() => expect(document.querySelector("li[data-outgoing]")!.querySelector("h2")).toHaveFocus());
        expect(getOutgoingReplies().map((reply) => reply.uid)).toEqual(["d1", "d2"]);
    });

    it("shows the sent state until the thread has it, and gives up on a message the server filed in a conversation of its own", async () => {
        queueOk();
        const pane = renderPane();
        await screen.findByTestId("detail-m2");
        act(() => void startSend(replyRequest()));
        await screen.findByTestId("pending-message-status");
        await waitFor(() => expect(isSendPending("d1")).toBe(false));

        // Relayed, but the thread read does not have it: it says so, and reads again on the next live update.
        act(() => handleSendEvent(sendEvent("send-succeeded")));
        await waitFor(() => expect(status()).toHaveTextContent("Sent"));
        await waitFor(() => expect(pane.reads()).toBe(2));

        pane.liveUpdate(null);
        await waitFor(() => expect(card()).toBeNull());
        expect(pane.reads()).toBe(3);
        expect(screen.queryByTestId("detail-d1")).toBeNull();
        expect(screen.getByText("2 messages")).toBeInTheDocument();
    });
});

describe("a message that is not a reply to the open conversation", () => {
    it("is never added to it - a new message, a reply to another conversation, or one sent from another mailbox", async () => {
        queueOk();
        const pane = renderPane();
        await screen.findByTestId("detail-m2");

        act(() => {
            startSend(replyRequest({ threading: undefined }, "n1"));
            startSend(replyRequest({ threading: { inReplyTo: "elsewhere@example.com", references: ["elsewhere@example.com"] } }, "n2"));
            startSend(replyRequest({ mailboxUid: "mb2" }, "n3"));
        });
        await waitFor(() => expect(["n1", "n2", "n3"].some((uid) => isSendPending(uid))).toBe(false));

        expect(card()).toBeNull();
        // What was tracked for another conversation or mailbox is only not drawn here.
        expect(getOutgoingReplies().map((reply) => reply.uid)).toEqual(["n2", "n3"]);
        expect(screen.getByText("2 messages")).toBeInTheDocument();
        expect(pane.reads()).toBe(1);
    });

    it("is not drawn while the thread is loading, or when it has no conversation", async () => {
        queueOk();
        const server = { thread: [message("m1", "Alice"), message("m2", "Bob")], hold: new Promise<void>(() => undefined) };
        renderPane(server);

        act(() => void startSend(replyRequest()));
        await waitFor(() => expect(isSendPending("d1")).toBe(false));

        expect(card()).toBeNull();
        expect(screen.getByRole("status")).toHaveTextContent("Loading the message");
    });
});

describe("a reply that could not be sent", () => {
    it("shows why under the message with the pop-up's own ways out, sends again on Retry and is gone on Open draft", async () => {
        queueOk();
        api.queueMessageSend.mockRejectedValueOnce(new ApiRequestError("Relay down", 500));
        const open = vi.fn();
        registerComposeOpener(open);
        renderPane();
        await screen.findByTestId("detail-m2");
        const user = userEvent.setup();

        act(() => void startSend(replyRequest()));

        expect(await screen.findByRole("alert")).toHaveTextContent(/^Not sent: .+/);
        expect(card()).toHaveTextContent("Not sent");
        // A failure does not take the view again.
        await user.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(api.queueMessageSend).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(status()).toHaveTextContent("Sending…"));
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

        // The server's own failure comes to the same place, and Open draft takes the card away.
        act(() => handleSendEvent(sendEvent("send-failed", { error: { message: "Recipient refused." } })));
        expect(await screen.findByRole("alert")).toHaveTextContent("Not sent: Recipient refused.");
        const back = { uid: "d1", version: 5, folderUid: "f3", mailboxUid: "mb1", recipients: [], flags: {} };
        api.getMessage.mockResolvedValue({ ...back, folderUid: "outbox" });
        api.listFolders.mockResolvedValue(FOLDERS);
        api.cancelScheduledSend.mockResolvedValue(back);
        await user.click(screen.getByRole("button", { name: "Open draft" }));
        await waitFor(() => expect(card()).toBeNull());
    });

    it("is not moved to when it was already there as the thread was opened", async () => {
        queueOk();
        trackOutgoing(replyRequest());
        failOutgoing("d1", "Relay down", []);

        renderPane();

        expect(await screen.findByRole("alert")).toHaveTextContent("Not sent: Relay down");
        // The reader opened the second message; that is where the focus is.
        await screen.findByTestId("detail-m2");
        await waitFor(() => expect(screen.getByRole("button", { name: /Bob/ })).toHaveFocus());
    });

    it("is drawn as the real message when the thread already holds it as it opens", async () => {
        trackOutgoing(replyRequest());

        renderPane({ thread: [message("m1", "Alice"), message("m2", "Bob"), sentCopy()] });

        await screen.findByRole("button", { name: /Me Myself/ });
        expect(card()).toBeNull();
        expect(getOutgoingReplies()).toEqual([]);
    });
});

describe("live updates for the open conversation", () => {
    it("add a message that arrived, collapsed, at the top, leaving what the reader has open as it was", async () => {
        const pane = renderPane();
        await screen.findByTestId("detail-m2");

        pane.server.thread.push(message("m3", "Carol", { flags: { read: false, flagged: false, answered: false, forwarded: false } }));
        pane.liveUpdate(new Set(["f1"]));

        expect(await screen.findByRole("button", { name: /Carol/ })).toHaveAttribute("aria-expanded", "false");
        expect(screen.getByText("3 messages")).toBeInTheDocument();
        expect(order().slice(0, 2)).toEqual([expect.any(String), "detail-m2"]);
        expect(screen.getByTestId("detail-m2")).toBeInTheDocument();
        expect(screen.queryByTestId("detail-m3")).toBeNull();
    });

    it("read the thread only for a change to one of the mailbox's folders, or one that does not say which", async () => {
        const pane = renderPane();
        await screen.findByTestId("detail-m2");

        pane.liveUpdate(new Set(["some-other-mailboxs-folder"]));
        pane.liveUpdate(new Set(["f2"]));
        await waitFor(() => expect(pane.reads()).toBe(2));
        pane.liveUpdate(null);
        await waitFor(() => expect(pane.reads()).toBe(3));
    });

    it("leave the pane alone when nothing in the thread changed, keep a newer copy the reader made here, and keep what was moved away", async () => {
        const pane = renderPane();
        await screen.findByTestId("detail-m2");
        const user = userEvent.setup();

        pane.liveUpdate(null);
        await waitFor(() => expect(pane.reads()).toBe(2));
        expect(screen.getByTestId("detail-m2")).toHaveAttribute("data-version", "0");

        // A change made here whose copy the read (issued before it landed) does not have yet.
        await user.click(screen.getByRole("button", { name: "label-m2" }));
        expect(screen.getByTestId("detail-m2")).toHaveAttribute("data-version", "9");
        pane.liveUpdate(null);
        await waitFor(() => expect(pane.reads()).toBe(3));
        expect(screen.getByTestId("detail-m2")).toHaveAttribute("data-version", "9");

        // Archived here: the thread read again still lists it (a conversation spans folders), but it stays out of the pane.
        await user.click(screen.getByRole("button", { name: "archive-m2" }));
        expect(screen.queryByTestId("detail-m2")).toBeNull();
        pane.liveUpdate(null);
        await waitFor(() => expect(pane.reads()).toBe(4));
        expect(screen.queryByTestId("detail-m2")).toBeNull();
        expect(screen.getByText("1 message")).toBeInTheDocument();
    });

    it("say nothing when the read fails, and wait for the first read to finish rather than start another", async () => {
        let release: () => void = () => undefined;
        const pane = renderPane({ thread: [message("m1", "Alice"), message("m2", "Bob")], hold: new Promise<void>((resolve) => (release = resolve)) });
        pane.liveUpdate(null);
        expect(pane.reads()).toBe(1);
        release();
        await screen.findByTestId("detail-m2");

        pane.server.failing = true;
        pane.liveUpdate(null);
        await waitFor(() => expect(pane.reads()).toBe(2));
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByTestId("detail-m2")).toBeInTheDocument();
    });

    it("drop a read that a switch to another conversation has overtaken", async () => {
        let release: () => void = () => undefined;
        let answered = false;
        let reads = 0;
        mockFetch(async (url) => {
            if (!url.startsWith("/api/mail/messages/conversations/c1")) {
                return jsonResponse(200, [message("n1", "Nina")]);
            }
            reads += 1;
            if (reads === 1) {
                return jsonResponse(200, [message("m1", "Alice"), message("m2", "Bob")]);
            }
            await new Promise<void>((resolve) => (release = resolve));
            answered = true;
            return jsonResponse(200, [message("m1", "Alice"), message("m2", "Bob"), message("m3", "Carol")]);
        });
        const element = (conversationId: string, selectedUid: string) => (
            <ConversationThreadPane
                conversation={{ conversationId, subject: "Project Zeus", messageCount: 1 }}
                mailboxUid="mb1"
                selectedUid={selectedUid}
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />
        );
        const { rerender } = render(element("c1", "m2"));
        await screen.findByTestId("detail-m2");
        shell.live = { tick: 1, folderUids: null };
        rerender(element("c1", "m2"));
        await waitFor(() => expect(reads).toBe(2));

        rerender(element("c2", "n1"));
        await screen.findByTestId("detail-n1");
        release();
        await waitFor(() => expect(answered).toBe(true));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(screen.queryByRole("button", { name: /Carol/ })).toBeNull();
        expect(screen.getByText("1 message")).toBeInTheDocument();
    });

    it("are not answered by a pane with no conversation", async () => {
        const fetchMock = mockFetch(async () => {
            throw new Error("nothing should be read");
        });
        const element = () => (
            <ConversationThreadPane conversation={null} mailboxUid="mb1" selectedUid={null} folders={FOLDERS} onMessagePatched={vi.fn()} onMessageRemoved={vi.fn()} />
        );
        const { rerender } = render(element());

        shell.live = { tick: 1, folderUids: null };
        rerender(element());

        expect(screen.getByText("Select a conversation to read it.")).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
