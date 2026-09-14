// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Round 5: sender pins, the "signer not verified" states, protected Subject, attachments inside the verified
// entity, and a failed scheduled send's error. Mocks mirror MessageDetailPane.test.tsx.
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../testUtils.js";
import MessageDetailPane from "../../../apps/shared/components/mail/MessageDetailPane.js";

const { evaluateMessageSecurity, getUnlockedKeys, getPinnedSignerFingerprints } = vi.hoisted(() => ({
    evaluateMessageSecurity: vi.fn(),
    getUnlockedKeys: vi.fn(),
    getPinnedSignerFingerprints: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/components/mail/pinnedSigners.js", () => ({ getPinnedSignerFingerprints }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock: vi.fn() }) }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ moveLocalEntity: vi.fn() }));

const { mailShellOverride } = vi.hoisted(() => ({ mailShellOverride: { current: undefined as Record<string, unknown> | undefined } }));
vi.mock("../../../apps/shared/components/mail/layout/MailShell.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../apps/shared/components/mail/layout/MailShell.js")>();
    return { ...actual, useMailShell: () => mailShellOverride.current ?? actual.useMailShell() };
});

function messageFixture(overrides: Record<string, unknown> = {}) {
    return {
        uid: "m1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: "abc@example.com",
        subject: "[list] Hello there",
        from: { address: "Sender@Example.com", displayName: "Sender One", type: "to" as const },
        recipients: [{ address: "u1@example.com", displayName: "Me", type: "to" as const }],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "Hi",
        flags: { read: false, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: true,
        ...overrides,
    };
}

const serverAttachment = {
    uid: "a1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    messageUid: "m1",
    filename: "outside.exe",
    contentType: "application/octet-stream",
    sizeBytes: 10,
};

function renderPane(overrides: Record<string, unknown> = {}, attachments: unknown[] = []) {
    mockFetch((url) => (url.endsWith("/raw") ? new Response("raw mime") : new Response("{}")));
    return render(<MessageDetailPane message={messageFixture(overrides) as never} attachments={attachments as never} />);
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    evaluateMessageSecurity.mockReset();
    getUnlockedKeys.mockReset();
    getPinnedSignerFingerprints.mockReset();
    mailShellOverride.current = undefined;
});

describe("MessageDetailPane (round 5)", () => {
    describe("sender pins", () => {
        it("passes the sender's pinned signing fingerprints from the reading mailbox's contacts", async () => {
            getPinnedSignerFingerprints.mockResolvedValue(["pin1", "pin2"]);
            evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<p>Hi</p>" });
            renderPane();

            expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
            expect(getPinnedSignerFingerprints).toHaveBeenCalledWith("mb1", "Sender@Example.com");
            expect(evaluateMessageSecurity).toHaveBeenCalledWith("raw mime", undefined, ["pin1", "pin2"], undefined);
        });

        it("adds the mailbox's own signing keys for mail it sent itself, and passes the pins on alias re-checks too", async () => {
            mailShellOverride.current = {
                mailboxes: [
                    {
                        uid: "mb1",
                        primarySmtpAddress: "me@example.com",
                        aliasAddresses: ["sender@example.com"],
                        keys: [
                            { useType: "sign", fingerprint: "OWN1" },
                            { useType: "sign", fingerprint: "old", revokedAt: 1 },
                            { useType: "encrypt", fingerprint: "enc" },
                        ],
                    },
                ],
                mailboxFolders: [],
            };
            getPinnedSignerFingerprints.mockResolvedValue(["own1", "pin1"]);
            evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<p>Hi</p>", notAddressedToReader: true });
            renderPane();

            await waitFor(() => expect(evaluateMessageSecurity).toHaveBeenCalledTimes(2));
            expect(evaluateMessageSecurity.mock.calls.map((call) => [call[2], call[3]])).toEqual([
                [["own1", "pin1"], "me@example.com"],
                [["own1", "pin1"], "sender@example.com"],
            ]);
        });

        it("passes no pins when the sender has none, or the lookup fails - never treating that as trusted", async () => {
            getPinnedSignerFingerprints.mockRejectedValue(new Error("contacts unavailable"));
            evaluateMessageSecurity.mockResolvedValue({ state: "signed_unverified_signer", html: "<p>Hi</p>" });
            renderPane();

            expect(await screen.findByText("Signed - signer not verified")).toBeInTheDocument();
            expect(evaluateMessageSecurity).toHaveBeenCalledWith("raw mime", undefined, undefined, undefined);
        });
    });

    describe("signer not verified", () => {
        it.each([
            ["signed_unverified_signer", "Signed - signer not verified"],
            ["encrypted_unverified_signer", "Encrypted - signer not verified"],
        ])("shows %s without the green verified badge, naming the certificate's addresses and fingerprint", async (state, label) => {
            getPinnedSignerFingerprints.mockResolvedValue([]);
            evaluateMessageSecurity.mockResolvedValue({
                state,
                html: "<p>Hi</p>",
                signerEmails: ["sender@example.com", "alt@example.com"],
                signerFingerprint: "abcdef0123",
                protectedHeaders: { from: "sender@example.com", to: "u1@example.com", subject: "Signed subject" },
            });
            renderPane();

            const badge = await screen.findByText(label);
            expect(badge).not.toHaveClass("text-success");
            expect(screen.queryByText(/verified$/)).toHaveTextContent(label);
            const notice = screen.getByText(/the signer isn.t a trusted contact key/);
            expect(notice).toHaveTextContent("Certificate for sender@example.com, alt@example.com.");
            expect(notice).toHaveTextContent("Fingerprint abcdef0123.");
            // An unverified signature doesn't vouch for the protected Subject either.
            expect(screen.getByRole("heading", { name: "[list] Hello there" })).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Trust this signer" })).not.toBeInTheDocument();
        });

        it("omits the certificate details the result doesn't carry", async () => {
            getPinnedSignerFingerprints.mockResolvedValue([]);
            evaluateMessageSecurity.mockResolvedValue({ state: "signed_unverified_signer", html: "<p>Hi</p>", signerEmails: [] });
            renderPane();

            const notice = await screen.findByText(/the signer isn.t a trusted contact key/);
            expect(notice).not.toHaveTextContent("Certificate for");
            expect(notice).not.toHaveTextContent("Fingerprint");
        });
    });

    describe("protected Subject", () => {
        it("shows the signed Subject for a verified signed message and notes that the delivered one differs", async () => {
            getPinnedSignerFingerprints.mockResolvedValue(["pin1"]);
            evaluateMessageSecurity.mockResolvedValue({
                state: "signed_verified",
                html: "<p>Hi</p>",
                protectedHeaders: { from: "sender@example.com", to: "u1@example.com", subject: "Hello there" },
            });
            renderPane();

            expect(await screen.findByRole("heading", { name: "Hello there" })).toBeInTheDocument();
            expect(screen.getByText(/differs from the subject this message was delivered with/)).toHaveTextContent("“[list] Hello there”");
        });

        it("shows no difference notice when the signed and delivered Subjects match", async () => {
            getPinnedSignerFingerprints.mockResolvedValue(["pin1"]);
            evaluateMessageSecurity.mockResolvedValue({
                state: "signed_verified",
                html: "<p>Hi</p>",
                protectedHeaders: { from: "sender@example.com", to: "u1@example.com", subject: "[list] Hello there" },
            });
            renderPane();

            expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
            expect(screen.queryByText(/differs from the subject/)).not.toBeInTheDocument();
        });

        it("shows an encrypted message's protected Subject without a difference notice (its outer Subject is obscured)", async () => {
            getPinnedSignerFingerprints.mockResolvedValue(["pin1"]);
            evaluateMessageSecurity.mockResolvedValue({
                state: "encrypted_verified",
                html: "<p>Hi</p>",
                protectedHeaders: { from: "sender@example.com", to: "u1@example.com", subject: "Real subject" },
            });
            renderPane({ subject: "[...]", encrypted: true });

            expect(await screen.findByRole("heading", { name: "Real subject" })).toBeInTheDocument();
            expect(screen.queryByText(/differs from the subject/)).not.toBeInTheDocument();
        });

        it("keeps the delivered Subject for a verified legacy message without protected headers", async () => {
            getPinnedSignerFingerprints.mockResolvedValue(["pin1"]);
            evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<p>Hi</p>" });
            renderPane({ subject: "" });

            expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
            expect(screen.getByRole("heading", { name: "(no subject)" })).toBeInTheDocument();
        });
    });

    describe("attachments", () => {
        function stubDownload() {
            const createObjectURL = vi.fn(() => "blob:att");
            const revokeObjectURL = vi.fn();
            vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
            const clicks: HTMLAnchorElement[] = [];
            vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
                clicks.push(this);
            });
            return { createObjectURL, clicks };
        }

        it("under a verified badge, lists only the attachments inside the signed entity, downloaded as opaque files", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            try {
                const { createObjectURL, clicks } = stubDownload();
                getPinnedSignerFingerprints.mockResolvedValue(["pin1"]);
                const decode = vi.fn(() => new Uint8Array([1, 2, 3]));
                evaluateMessageSecurity.mockResolvedValue({
                    state: "signed_verified",
                    html: "<p>Hi</p>",
                    attachments: [
                        { filename: "report.html", contentType: "text/html", disposition: "attachment", decode },
                        { contentType: "image/png", disposition: "inline", decode: () => undefined },
                    ],
                });
                const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
                renderPane({}, [serverAttachment]);

                await user.click(await screen.findByRole("button", { name: "report.html" }));
                expect(screen.queryByText(/outside\.exe/)).not.toBeInTheDocument();
                expect(decode).toHaveBeenCalled();
                const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
                expect(blob.type).toBe("application/octet-stream");
                expect(clicks[0].download).toBe("report.html");

                await user.click(screen.getByRole("button", { name: "Unnamed image/png attachment" }));
                expect(clicks[1].download).toBe("attachment");
                vi.advanceTimersByTime(60_000);
                expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:att");
            } finally {
                vi.useRealTimers();
            }
        });

        it("shows no attachment list for decrypted content without attachments (the server only saw the encrypted blob)", async () => {
            getPinnedSignerFingerprints.mockResolvedValue([]);
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", html: "<p>Hi</p>", attachments: [] });
            renderPane({ encrypted: true }, [{ ...serverAttachment, filename: "smime.p7m" }]);

            expect(await screen.findByText("Encrypted")).toBeInTheDocument();
            expect(screen.queryByText(/smime\.p7m/)).not.toBeInTheDocument();
        });

        it("lists the decrypted attachments of an encrypted message whose signer isn't verified", async () => {
            getPinnedSignerFingerprints.mockResolvedValue([]);
            evaluateMessageSecurity.mockResolvedValue({
                state: "encrypted_unverified_signer",
                html: "<p>Hi</p>",
                attachments: [{ filename: "inner.pdf", contentType: "application/pdf", disposition: "attachment", decode: () => undefined }],
            });
            renderPane({ encrypted: true }, [{ ...serverAttachment, filename: "smime.p7m" }]);

            expect(await screen.findByRole("button", { name: "inner.pdf" })).toBeInTheDocument();
            expect(screen.queryByText(/smime\.p7m/)).not.toBeInTheDocument();
        });

        it("keeps the server's attachment list for a signed message whose signer isn't verified", async () => {
            getPinnedSignerFingerprints.mockResolvedValue([]);
            evaluateMessageSecurity.mockResolvedValue({
                state: "signed_unverified_signer",
                html: "<p>Hi</p>",
                attachments: [{ filename: "inner.pdf", contentType: "application/pdf", disposition: "attachment", decode: () => undefined }],
            });
            renderPane({}, [serverAttachment]);

            expect(await screen.findByText("Signed - signer not verified")).toBeInTheDocument();
            expect(screen.getByRole("link", { name: /outside\.exe/ })).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "inner.pdf" })).not.toBeInTheDocument();
        });
    });

    describe("failed scheduled send", () => {
        it("shows the send error on an Outbox message, alongside Move to Drafts", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ hasAttachments: false, scheduledSendError: "Recipient domain not found" }) as never}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                />,
            );
            expect(screen.getByText("This message wasn’t sent: Recipient domain not found")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Move to Drafts" })).toBeInTheDocument();
        });

        it("doesn't show a send error outside Outbox", () => {
            render(<MessageDetailPane message={messageFixture({ hasAttachments: false, scheduledSendError: "old error" }) as never} attachments={[]} />);
            expect(screen.queryByText(/wasn.t sent/)).not.toBeInTheDocument();
        });
    });
});
