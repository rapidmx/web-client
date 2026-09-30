// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The people and the contact cards in the reading pane: sender and recipients open a contact card, a vCard attachment offers "Add to address
// book" and "Download". Mocks mirror MessageDetailPane.round5.test.tsx.
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mailbox } from "../../../lib/mail/mailApi.js";
import ContactCardProvider from "../../../apps/shared/components/contacts/ContactCardProvider.js";
import MessageDetailPane from "../../../apps/shared/components/mail/MessageDetailPane.js";
import { MailConnectionContext, type MailConnection } from "../../../apps/shared/mail/useMailConnection.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { jsonResponse, mockFetch } from "../testUtils.js";

const { evaluateMessageSecurity } = vi.hoisted(() => ({ evaluateMessageSecurity: vi.fn() }));
vi.mock("../../../lib/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));
vi.mock("../../../lib/crypto/keySession.js", () => ({ getUnlockedKeys: vi.fn(), subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/components/mail/pinnedSigners.js", () => ({
    getPinnedSignerFingerprints: async () => [],
    getSignerKeyState: async () => ({ pinned: [], previous: [] }),
    clearPinnedSignerCache: vi.fn(),
}));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock: vi.fn() }) }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ moveLocalEntity: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/reading/MessageBody.js", () => ({
    default: () => <div data-testid="body" />,
    BodySkeleton: () => <div data-testid="body-skeleton" />,
}));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    evaluateMessageSecurity.mockReset();
});

const ME = { uid: "mb1", ownerUserUid: "u1", primarySmtpAddress: "u1@example.com", aliasAddresses: [], displayName: "Me", dateCreated: "2026-01-01T00:00:00.000Z", accessRole: "owner" } as Mailbox;
const CONNECTION = { status: "ready", mailboxes: [ME] } as MailConnection;

function messageFixture(overrides: Record<string, unknown> = {}) {
    return {
        uid: "m1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: "abc@example.com",
        subject: "Hello there",
        from: { address: "sender@other.org", displayName: "Sender One", type: "to" as const },
        recipients: [
            { address: "u1@example.com", displayName: "Me", type: "to" as const },
            { address: "carol@other.org", displayName: "Carol", type: "cc" as const },
            { address: "dave@other.org", displayName: "Dave", type: "bcc" as const },
        ],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "Hi",
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    };
}

const VCARD = "BEGIN:VCARD\nFN:Sender One\nORG:Other Org\nEMAIL:sender@other.org\nEND:VCARD";

function serve() {
    const posted: string[] = [];
    mockFetch((url, init) => {
        const path = url.split("?")[0];
        if (init?.method === "POST") {
            const body = JSON.parse(init.body as string);
            posted.push(body.displayName);
            return jsonResponse(200, { uid: "new", ...body });
        }
        if (path.endsWith("/raw")) {
            return new Response("raw mime");
        }
        if (path === "/api/mail/attachments/a1/content") {
            return new Response(VCARD);
        }
        if (path === "/api/mail/folders") {
            return jsonResponse(200, [{ uid: "c1", mailboxUid: "mb1", type: "contacts", name: "Contacts" }]);
        }
        if (path === "/api/mail/search") {
            return jsonResponse(200, { results: [] });
        }
        return jsonResponse(200, []);
    });
    return posted;
}

function renderPane(props: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}, withCards = true) {
    const pane = <MessageDetailPane message={messageFixture(overrides)} attachments={[]} {...props} />;
    return render(
        withCards ? (
            <MailConnectionContext.Provider value={CONNECTION}>
                <ContactCardProvider userUid="u1">{pane}</ContactCardProvider>
            </MailConnectionContext.Provider>
        ) : (
            pane
        ),
    );
}

const vcfAttachment = { uid: "a1", filename: "sender.vcf", mimeType: "text/vcard", sizeBytes: 120, messageUid: "m1" };
const pdfAttachment = { uid: "a2", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 2048, messageUid: "m1" };

describe("contact cards in the reading pane", () => {
    it("opens the sender's card, with the vCard attached to the message", async () => {
        serve();
        evaluateMessageSecurity.mockResolvedValue({ state: "unprotected" });
        const user = userEvent.setup();
        renderPane({ attachments: [vcfAttachment] }, { hasAttachments: true });
        await user.click(screen.getByRole("button", { name: "Sender One <sender@other.org>" }));
        const dialog = await screen.findByRole("dialog", { name: "Sender One" });
        // What the sender's own vCard says is on the card.
        expect(await within(dialog).findByText("Company")).toBeInTheDocument();
        expect(within(dialog).getAllByText("Other Org")).toHaveLength(2);
    });

    it("opens a recipient's card from the To, Cc and Bcc lines", async () => {
        serve();
        const user = userEvent.setup();
        renderPane();
        for (const [name, title] of [
            ["Me <u1@example.com>", "Me"],
            ["Carol <carol@other.org>", "Carol"],
            ["Dave <dave@other.org>", "Dave"],
        ]) {
            await user.click(screen.getByRole("button", { name }));
            expect(await screen.findByRole("dialog", { name: title })).toBeInTheDocument();
            await user.keyboard("{Escape}");
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        }
    });

    it("makes the sender's name of a thread's message open their contact card, and the rest of the line still collapse it", async () => {
        serve();
        const user = userEvent.setup();
        const toggle = vi.fn();
        renderPane({ inThread: true, threadHeader: { bodyId: "body-m1", unread: false, onToggle: toggle, buttonRef: () => undefined } });
        const header = screen.getByRole("heading", { level: 2 });
        // Two separate buttons, neither inside the other: the collapse button under the line, and the sender's name over it.
        const buttons = within(header).getAllByRole("button");
        expect(buttons).toHaveLength(2);
        expect(buttons[0]).toHaveAttribute("aria-expanded", "true");
        expect(buttons[0]).toHaveAccessibleName("Sender One <sender@other.org>");
        expect(buttons[0]).not.toContainElement(buttons[1]);
        expect(buttons[1]).not.toContainElement(buttons[0]);

        await user.click(within(header).getByRole("button", { name: "Contact card for Sender One <sender@other.org>" }));
        expect(await screen.findByRole("dialog", { name: "Sender One" })).toBeInTheDocument();
        expect(toggle).not.toHaveBeenCalled();
        await user.keyboard("{Escape}");

        await user.click(buttons[0]);
        expect(toggle).toHaveBeenCalledTimes(1);
    });

    it("marks an unread thread message's collapse button as unread", () => {
        serve();
        renderPane({ inThread: true, threadHeader: { bodyId: "body-m1", unread: true, onToggle: vi.fn(), buttonRef: () => undefined } });
        const header = screen.getByRole("heading", { level: 2 });
        expect(within(header).getAllByRole("button")[0]).toHaveAccessibleName("Unread. Sender One <sender@other.org>");
    });

    it("draws the people as plain text outside a contact card provider", () => {
        renderPane({}, {}, false);
        expect(screen.queryByRole("button", { name: /Sender One|Carol/ })).not.toBeInTheDocument();
        expect(screen.getByText("Sender One <sender@other.org>")).toBeInTheDocument();
    });
});

describe("vCard attachments in the reading pane", () => {
    it("offers a menu on a vCard and leaves other attachments as links", async () => {
        const posted = serve();
        evaluateMessageSecurity.mockResolvedValue({ state: "unprotected" });
        const user = userEvent.setup();
        renderPane({ attachments: [vcfAttachment, pdfAttachment] }, { hasAttachments: true });
        expect(await screen.findByRole("link", { name: /report\.pdf/ })).toHaveAttribute("href", "/api/mail/attachments/a2/content");
        await user.click(screen.getByRole("button", { name: /sender\.vcf.*contact card actions/ }));
        await user.click(await screen.findByRole("menuitem", { name: "Add to address book" }));
        await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "success", message: "1 contact added to your address book." }]));
        expect(posted).toEqual(["Sender One"]);
    });

    it("downloads a vCard from its menu", async () => {
        serve();
        evaluateMessageSecurity.mockResolvedValue({ state: "unprotected" });
        const clicked: HTMLAnchorElement[] = [];
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            clicked.push(this);
        });
        const user = userEvent.setup();
        renderPane({ attachments: [vcfAttachment] }, { hasAttachments: true });
        await user.click(await screen.findByRole("button", { name: /sender\.vcf.*contact card actions/ }));
        await user.click(await screen.findByRole("menuitem", { name: "Download" }));
        expect(clicked).toHaveLength(1);
        expect(clicked[0].getAttribute("href")).toBe("/api/mail/attachments/a1/content");
        expect(clicked[0].download).toBe("sender.vcf");
    });

    it("is a plain download without a contact card provider", async () => {
        serve();
        evaluateMessageSecurity.mockResolvedValue({ state: "unprotected" });
        const clicked: HTMLAnchorElement[] = [];
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            clicked.push(this);
        });
        renderPane({ attachments: [vcfAttachment] }, { hasAttachments: true }, false);
        await userEvent.setup().click(await screen.findByRole("button", { name: "sender.vcf (120 B)" }));
        expect(clicked).toHaveLength(1);
    });

    it("handles a vCard recovered from inside a signed or encrypted message the same way", async () => {
        const posted = serve();
        const bytes = new TextEncoder().encode(VCARD);
        evaluateMessageSecurity.mockResolvedValue({
            state: "encrypted_unverified_signer",
            html: "<p>Hi</p>",
            attachments: [
                { filename: "inner.vcf", contentType: "text/vcard", disposition: "attachment", decode: () => bytes },
                { filename: "empty.vcf", contentType: "text/x-vcard", disposition: "attachment", decode: () => undefined },
                { contentType: "text/vcard", disposition: "attachment", decode: () => bytes },
                { filename: "inner.pdf", contentType: "application/pdf", disposition: "attachment", decode: () => undefined },
            ],
        });
        URL.createObjectURL = vi.fn(() => "blob:card");
        URL.revokeObjectURL = vi.fn();
        const clicked: HTMLAnchorElement[] = [];
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            clicked.push(this);
        });
        const user = userEvent.setup();
        renderPane({}, { encrypted: true, hasAttachments: true });
        expect(await screen.findByRole("button", { name: "inner.pdf" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "inner.vcf, contact card actions" }));
        await user.click(await screen.findByRole("menuitem", { name: "Add to address book" }));
        await waitFor(() => expect(posted).toEqual(["Sender One"]));

        await user.click(screen.getByRole("button", { name: "empty.vcf, contact card actions" }));
        await user.click(await screen.findByRole("menuitem", { name: "Add to address book" }));
        await waitFor(() => expect(getNotificationsSnapshot().visible.map((n) => n.title)).toContain("No contacts found"));

        await user.click(screen.getByRole("button", { name: "inner.vcf, contact card actions" }));
        await user.click(await screen.findByRole("menuitem", { name: "Download" }));
        expect(clicked).toHaveLength(1);
        expect(clicked[0].download).toBe("inner.vcf");
        expect(screen.getByRole("button", { name: /Unnamed text\/vcard attachment, contact card actions/ })).toBeInTheDocument();
    });
});
