// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// "Attach my contact card" in the compose window: the sender's own vCard, attached like any other file, once. Mocks mirror ComposeWindow.test.tsx.
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseVCards } from "../../../lib/contacts/vcard.js";
import ComposeWindow from "../../../apps/shared/components/mail/compose/ComposeWindow.js";
import type { ComposeSession } from "../../../apps/shared/components/mail/compose/ComposeContext.js";
import { clearMailboxWritabilityCache } from "../../../apps/shared/components/mail/writableMailboxes.js";
import { jsonResponse, mockFetch } from "../testUtils.js";

vi.mock("../../../apps/shared/components/mail/compose/ComposeContext.js", () => ({ useCompose: () => ({ openCompose: vi.fn() }) }));
vi.mock("../../../lib/crypto/keySession.js", () => ({ getUnlockedKeys: vi.fn(), subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock: vi.fn() }) }));
vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({ default: () => <div data-testid="editor" /> }));

afterEach(() => {
    clearMailboxWritabilityCache();
    vi.unstubAllGlobals();
});

const MAILBOX = { uid: "mb1", ownerUserUid: "u1", displayName: "J. Roe", primarySmtpAddress: "jane@example.com", aliasAddresses: [], keys: [], dateCreated: "2026-01-01T00:00:00.000Z" };
const FOLDERS = [
    { uid: "f-drafts", mailboxUid: "mb1", name: "Drafts", type: "drafts" },
    { uid: "c1", mailboxUid: "mb1", name: "Contacts", type: "contacts" },
];
const DRAFT = {
    uid: "m1",
    version: 0,
    folderUid: "f-drafts",
    mailboxUid: "mb1",
    messageId: "abc@webmail",
    subject: "",
    from: { address: "jane@example.com", type: "to" },
    recipients: [],
    flags: { read: true, flagged: false, answered: false, forwarded: false },
    importance: "normal",
    hasAttachments: false,
};
const ME = { uid: "k1", displayName: "Jane Roe", emails: [{ address: "JANE@example.com", type: "work" }], phones: [{ phoneNumber: "+1 555 0100", type: "work" }], addresses: [], company: "Acme", jobTitle: "CTO" };

/** The attachment deletions the server was asked for. */
const removals: string[] = [];

/** Serves a compose session for `MAILBOX`; `upload` answers the attachment upload. Returns what was uploaded. */
function serve(
    upload: (file: File) => Response = () => jsonResponse(200, { uid: "a1", version: 3, filename: "Jane Roe.vcf", mimeType: "text/vcard", sizeBytes: 10 }),
    remove: (url: string) => Response = () => new Response(null, { status: 204 }),
) {
    const uploads: { params: URLSearchParams; file: File }[] = [];
    removals.length = 0;
    mockFetch((url, init) => {
        const path = url.split("?")[0];
        const method = init?.method ?? "GET";
        if (method === "DELETE" && path.startsWith("/api/mail/attachments/")) {
            removals.push(url);
            return remove(url);
        }
        if (path === "/api/mail/attachments/upload") {
            const file = init.body as File;
            uploads.push({ params: new URLSearchParams(url.split("?")[1]), file });
            return upload(file);
        }
        if (path === "/api/mail/folders") return jsonResponse(200, FOLDERS);
        if (path === "/api/mail/mail-signatures") return jsonResponse(200, []);
        if (path === "/api/mail/messages" && method === "POST") return jsonResponse(200, DRAFT);
        if (path === "/api/mail/mailboxes/mb1") return jsonResponse(200, MAILBOX);
        if (path === "/api/mail/mailboxes") return jsonResponse(200, [MAILBOX]);
        if (path === "/api/mail/contacts") return jsonResponse(200, [ME]);
        if (path.startsWith("/api/mail/messages/")) return jsonResponse(200, { ...DRAFT, version: 1 });
        throw new Error(`unexpected ${method} ${url}`);
    });
    return uploads;
}

const session: ComposeSession = { id: "s1", mailboxUid: "mb1", signatureContext: "new", minimized: false };

async function renderCompose() {
    render(<ComposeWindow session={session} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
    const button = await screen.findByRole("button", { name: "Attach my contact card" });
    await waitFor(() => expect(button).toBeEnabled());
    return button;
}

describe("Attach my contact card", () => {
    it("is off until the draft is ready", async () => {
        serve();
        render(<ComposeWindow session={session} userUid="u1" onClose={vi.fn()} onToggleMinimize={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Attach my contact card" })).toBeDisabled();
        await waitFor(() => expect(screen.getByRole("button", { name: "Attach my contact card" })).toBeEnabled());
    });

    it("attaches the sender's vCard, with the phones, company and title of their own contact, once", async () => {
        const uploads = serve();
        const user = userEvent.setup();
        const button = await renderCompose();
        expect(button).toHaveAttribute("aria-pressed", "false");
        await user.click(button);

        expect(await screen.findByText("Jane Roe.vcf")).toBeInTheDocument();
        expect(uploads).toHaveLength(1);
        expect(uploads[0].params.get("filename")).toBe("Jane Roe.vcf");
        expect(uploads[0].params.get("mimeType")).toBe("text/vcard");
        const [card] = parseVCards(await uploads[0].file.text());
        expect(card).toMatchObject({
            displayName: "Jane Roe",
            company: "Acme",
            jobTitle: "CTO",
            emails: [{ address: "jane@example.com", type: "work" }],
            phones: [{ phoneNumber: "+1 555 0100", type: "work" }],
        });

        // Attached: the button says so and cannot attach it a second time.
        await waitFor(() => expect(button).toBeDisabled());
        expect(button).toHaveAttribute("aria-pressed", "true");
        expect(button).toHaveAttribute("title", "Your contact card is attached");
        await user.click(button);
        expect(uploads).toHaveLength(1);
    });

    it("says why it could not be attached, and can be tried again", async () => {
        let fail = true;
        const uploads = serve(() => (fail ? jsonResponse(500, { message: "too large" }) : jsonResponse(200, { uid: "a1", filename: "Jane Roe.vcf", mimeType: "text/vcard", sizeBytes: 10 })));
        const user = userEvent.setup();
        const button = await renderCompose();
        await user.click(button);
        expect(await screen.findByText("too large")).toBeInTheDocument();
        await waitFor(() => expect(button).toBeEnabled());
        expect(button).toHaveAttribute("aria-pressed", "false");

        fail = false;
        await user.click(button);
        expect(await screen.findByText("Jane Roe.vcf")).toBeInTheDocument();
        expect(screen.queryByText("too large")).not.toBeInTheDocument();
        expect(uploads).toHaveLength(2);
    });
});

describe("Removing an attachment from the draft", () => {
    it("takes the attachment off the draft, at its version, and lets the contact card be attached again", async () => {
        serve();
        const user = userEvent.setup();
        const button = await renderCompose();
        await user.click(button);
        await screen.findByText("Jane Roe.vcf");
        await waitFor(() => expect(button).toBeDisabled());

        await user.click(screen.getByRole("button", { name: "Remove Jane Roe.vcf" }));

        await waitFor(() => expect(screen.queryByText("Jane Roe.vcf")).not.toBeInTheDocument());
        expect(removals).toEqual(["/api/mail/attachments/a1?version=3"]);
        await waitFor(() => expect(button).toBeEnabled());
        expect(button).toHaveAttribute("aria-pressed", "false");
    });

    it("holds the chip's button while the server answers", async () => {
        let answer: () => void = () => undefined;
        serve(undefined, () => {
            throw new Error("answered below");
        });
        const user = userEvent.setup();
        const button = await renderCompose();
        await user.click(button);
        await screen.findByText("Jane Roe.vcf");
        const inFlight = new Promise<void>((resolve) => (answer = resolve));
        mockFetch(async (url, init) => {
            if (init?.method === "DELETE") {
                await inFlight;
                return new Response(null, { status: 204 });
            }
            return jsonResponse(200, { ...DRAFT, version: 1 });
        });

        await user.click(screen.getByRole("button", { name: "Remove Jane Roe.vcf" }));
        expect(screen.getByRole("button", { name: "Remove Jane Roe.vcf" })).toBeDisabled();
        answer();
        await waitFor(() => expect(screen.queryByText("Jane Roe.vcf")).not.toBeInTheDocument());
    });

    it("keeps the attachment and says why when the server will not remove it", async () => {
        serve(undefined, () => jsonResponse(409, { message: "This message is being sent." }));
        const user = userEvent.setup();
        await user.click(await renderCompose());
        await screen.findByText("Jane Roe.vcf");

        await user.click(screen.getByRole("button", { name: "Remove Jane Roe.vcf" }));

        expect(await screen.findByText("This message is being sent.")).toBeInTheDocument();
        expect(screen.getByText("Jane Roe.vcf")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Remove Jane Roe.vcf" })).toBeEnabled();
    });

    it("says so plainly when the request itself failed, and leaves the other attachments alone", async () => {
        serve(undefined, () => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        await user.click(await renderCompose());
        await screen.findByText("Jane Roe.vcf");

        await user.click(screen.getByRole("button", { name: "Remove Jane Roe.vcf" }));

        expect(await screen.findByText("Could not remove attachment.")).toBeInTheDocument();
        expect(screen.getByText("Jane Roe.vcf")).toBeInTheDocument();
    });
});
