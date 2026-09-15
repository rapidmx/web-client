// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Round 6: the real From address next to a signature badge (and address-like display names), the "Subject/To/Cc
// weren't signed" note, attachments of a decrypted message whose signature failed, and the Outbox send lease.
// Mocks mirror MessageDetailPane.round5.test.tsx.
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MessageDetailPane, { checkSenderName } from "../../../apps/shared/components/mail/MessageDetailPane.js";

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
        from: { address: "sender@example.com", displayName: "Sender One", type: "to" as const },
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

const smimeAttachment = {
    uid: "a1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    messageUid: "m1",
    filename: "smime.p7m",
    contentType: "application/pkcs7-mime",
    sizeBytes: 10,
};

function renderSecure(overrides: Record<string, unknown> = {}, attachments: unknown[] = []) {
    mockFetch((url) => (url.endsWith("/raw") ? new Response("raw mime") : new Response("{}")));
    return render(<MessageDetailPane message={messageFixture(overrides) as never} attachments={attachments as never} />);
}

function fromLine(): HTMLElement {
    return screen.getByText(/^From /);
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    evaluateMessageSecurity.mockReset();
    getUnlockedKeys.mockReset();
    getPinnedSignerFingerprints.mockReset();
});

describe("checkSenderName", () => {
    it.each([
        ["no display name", undefined, "x@corp-pay.com", { looksLikeAddress: false, misleading: false }],
        ["a plain name", "Jane Doe", "x@corp-pay.com", { looksLikeAddress: false, misleading: false }],
        ["a different address", "ceo@corp.com", "x@corp-pay.com", { looksLikeAddress: true, misleading: true }],
        ["a fullwidth @ look-alike", "CEO ceo＠corp.com", "x@corp-pay.com", { looksLikeAddress: true, misleading: true }],
        ["a small @ look-alike", "ceo﹫corp.com", "x@corp-pay.com", { looksLikeAddress: true, misleading: true }],
        ["the same address, differently cased", "Sender@Example.com", "sender@example.com", { looksLikeAddress: true, misleading: false }],
        ["an @ that isn't an address", "Bob @ Corp", "bob@corp.com", { looksLikeAddress: true, misleading: false }],
    ])("%s", (_label, name, address, expected) => {
        expect(checkSenderName(name, address)).toEqual(expected);
    });
});

describe("MessageDetailPane (round 6)", () => {
    describe("the From address next to a signature badge", () => {
        it("shows the signed From address beside the name, and warns when the name poses as another address", async () => {
            getPinnedSignerFingerprints.mockResolvedValue(["pin1"]);
            evaluateMessageSecurity.mockResolvedValue({
                state: "signed_verified",
                html: "<p>Pay this</p>",
                protectedHeaders: { from: '"ceo@corp.com" <X@Corp-Pay.com>', to: "u1@example.com", subject: "Hello there" },
            });
            renderSecure({ from: { address: "x@corp-pay.com", displayName: "ceo@corp.com", type: "to" } });

            expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
            expect(fromLine()).toHaveTextContent("From ceo@corp.com <x@corp-pay.com>");
            expect(screen.getByText(/looks like an email address, but this message was/)).toHaveTextContent(
                "The sender’s name “ceo@corp.com” looks like an email address, but this message was sent from x@corp-pay.com.",
            );
        });

        it.each(["signed_unverified_signer", "encrypted_unverified_signer", "encrypted_verified", "signature_failed"])(
            "shows the outer From address beside an ordinary name for %s when there are no usable protected headers",
            async (state) => {
                getPinnedSignerFingerprints.mockResolvedValue([]);
                evaluateMessageSecurity.mockResolvedValue({
                    state,
                    html: "<p>Hi</p>",
                    // A protected From without an address can't name the signer - the outer address is shown.
                    ...(state === "encrypted_verified" ? { protectedHeaders: { from: "undisclosed", to: "", subject: "Hello there" } } : {}),
                });
                renderSecure({ encrypted: state !== "signed_unverified_signer" });

                await waitFor(() => expect(evaluateMessageSecurity).toHaveBeenCalled());
                await screen.findAllByText(/verified|failed/);
                expect(fromLine()).toHaveTextContent("From Sender One <sender@example.com>");
                expect(screen.queryByText(/looks like an email address/)).not.toBeInTheDocument();
            },
        );

        it("shows just the address when a signed message has no display name", async () => {
            getPinnedSignerFingerprints.mockResolvedValue(["pin1"]);
            evaluateMessageSecurity.mockResolvedValue({
                state: "signed_verified",
                html: "<p>Hi</p>",
                protectedHeaders: { from: "sender@example.com", to: "u1@example.com", subject: "Hello there" },
            });
            renderSecure({ from: { address: "sender@example.com", type: "to" } });

            await screen.findByText("Signed & verified");
            expect(fromLine()).toHaveTextContent(/^From sender@example\.com ·/);
        });

        it("keeps just the name for an unprotected or encrypted-only message with an ordinary name", async () => {
            render(<MessageDetailPane message={messageFixture({ hasAttachments: false }) as never} attachments={[]} />);
            expect(fromLine()).toHaveTextContent(/^From Sender One ·/);
        });

        it("shows the address, with a warning, for any message whose name uses a look-alike @", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ hasAttachments: false, from: { address: "x@corp-pay.com", displayName: "ceo＠corp.com", type: "to" }, deliveryReceiptPending: true }) as never}
                    attachments={[]}
                />,
            );
            expect(fromLine()).toHaveTextContent("From ceo＠corp.com <x@corp-pay.com>");
            expect(screen.getByText(/looks like an email address/)).toHaveTextContent("sent from x@corp-pay.com");
            // The receipt banner names the sender the same way.
            expect(screen.getByText(/requested a delivery receipt/)).toHaveTextContent("ceo＠corp.com <x@corp-pay.com> requested a delivery receipt");
        });

        it("shows the address without a warning when an @ in the name isn't another address", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ hasAttachments: false, from: { address: "bob@corp.com", displayName: "Bob @ Corp", type: "to" } }) as never}
                    attachments={[]}
                />,
            );
            expect(fromLine()).toHaveTextContent("From Bob @ Corp <bob@corp.com>");
            expect(screen.queryByText(/looks like an email address/)).not.toBeInTheDocument();
        });
    });

    describe("headers the signature doesn't cover", () => {
        it.each(["signed_verified", "encrypted_verified"])("notes that Subject/To/Cc weren't signed for %s without protected headers", async (state) => {
            getPinnedSignerFingerprints.mockResolvedValue(["pin1"]);
            evaluateMessageSecurity.mockResolvedValue({ state, html: "<p>Hi</p>" });
            renderSecure({ encrypted: state === "encrypted_verified" });

            expect(await screen.findByText(/The signature covers this message.s content and attachments only/)).toHaveTextContent(
                "Its Subject, To and Cc weren’t signed",
            );
            expect(screen.getByRole("heading", { name: "Hello there" })).toBeInTheDocument();
        });

        it("has no such note when protected headers were signed, or the signer isn't verified", async () => {
            getPinnedSignerFingerprints.mockResolvedValue(["pin1"]);
            evaluateMessageSecurity.mockResolvedValueOnce({
                state: "signed_verified",
                html: "<p>Hi</p>",
                protectedHeaders: { from: "sender@example.com", to: "u1@example.com", subject: "Hello there" },
            });
            const { unmount } = renderSecure();
            await screen.findByText("Signed & verified");
            expect(screen.queryByText(/content and attachments only/)).not.toBeInTheDocument();
            unmount();

            evaluateMessageSecurity.mockResolvedValueOnce({ state: "signed_unverified_signer", html: "<p>Hi</p>" });
            renderSecure();
            await screen.findByText("Signed - signer not verified");
            expect(screen.queryByText(/content and attachments only/)).not.toBeInTheDocument();
        });
    });

    describe("attachments of a decrypted message whose signature failed", () => {
        it("lists the decrypted attachments with a warning, not the server's smime.p7m", async () => {
            getPinnedSignerFingerprints.mockResolvedValue([]);
            evaluateMessageSecurity.mockResolvedValue({
                state: "signature_failed",
                signatureFailureReason: "untrusted_signer",
                html: "<p>Hi</p>",
                attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", disposition: "attachment", decode: () => undefined }],
            });
            renderSecure({ encrypted: true }, [smimeAttachment]);

            expect(await screen.findByRole("button", { name: "invoice.pdf" })).toBeInTheDocument();
            expect(screen.queryByText(/smime\.p7m/)).not.toBeInTheDocument();
            expect(screen.getByText(/These attachments come from a message whose signature couldn.t be verified/)).toBeInTheDocument();
        });

        it("shows no warning and no list when the decrypted message had no attachments", async () => {
            getPinnedSignerFingerprints.mockResolvedValue([]);
            evaluateMessageSecurity.mockResolvedValue({ state: "signature_failed", html: "<p>Hi</p>", attachments: [] });
            renderSecure({ encrypted: true }, [smimeAttachment]);

            await screen.findByText("Signature failed");
            expect(screen.queryByText(/smime\.p7m/)).not.toBeInTheDocument();
            expect(screen.queryByText(/These attachments come from/)).not.toBeInTheDocument();
        });

        it("keeps the server's list for a signed-only failure, which recovers no attachments", async () => {
            getPinnedSignerFingerprints.mockResolvedValue([]);
            evaluateMessageSecurity.mockResolvedValue({ state: "signature_failed", signatureFailureReason: "invalid_signature" });
            renderSecure({}, [{ ...smimeAttachment, filename: "report.pdf" }]);

            await screen.findByText("Signature failed");
            expect(screen.getByRole("link", { name: /report\.pdf/ })).toBeInTheDocument();
            expect(screen.queryByText(/These attachments come from/)).not.toBeInTheDocument();
        });
    });

    describe("Outbox send lease", () => {
        const inOneMinute = () => new Date(Date.now() + 60_000).toISOString();

        function renderOutbox(overrides: Record<string, unknown>, props: Record<string, unknown> = {}) {
            return render(
                <MessageDetailPane
                    message={messageFixture({ hasAttachments: false, ...overrides }) as never}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                    {...props}
                />,
            );
        }

        it("shows Sending… instead of the schedule, Cancel and Move to Drafts while the lease is live", () => {
            mockFetch(() => jsonResponse(200, {}));
            const { unmount } = renderOutbox({ scheduledSendTime: "2026-06-01T09:00:00.000Z", scheduledSendLeaseExpiresAt: inOneMinute() });
            expect(screen.getByText("Sending…")).toBeInTheDocument();
            expect(screen.queryByText(/Scheduled for/)).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
            unmount();

            renderOutbox({ scheduledSendTime: null, scheduledSendLeaseExpiresAt: inOneMinute() });
            expect(screen.getByText("Sending…")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Move to Drafts" })).not.toBeInTheDocument();
        });

        it("ignores an expired lease, and a lease outside Outbox", () => {
            const { unmount } = renderOutbox({ scheduledSendTime: "2026-06-01T09:00:00.000Z", scheduledSendLeaseExpiresAt: "2020-01-01T00:00:00.000Z" });
            expect(screen.queryByText("Sending…")).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
            unmount();

            render(<MessageDetailPane message={messageFixture({ hasAttachments: false, scheduledSendLeaseExpiresAt: inOneMinute() }) as never} attachments={[]} />);
            expect(screen.queryByText("Sending…")).not.toBeInTheDocument();
        });

        it("re-reads the message when the lease runs out, leaving Outbox once it was sent", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            const fetchMock = mockFetch((url, init) =>
                url === "/api/mail/messages/m1" && (init?.method ?? "GET") === "GET"
                    ? jsonResponse(200, messageFixture({ hasAttachments: false, folderUid: "f-sent", version: 1 }))
                    : jsonResponse(500, {}),
            );
            renderOutbox({ scheduledSendTime: "2026-06-01T09:00:00.000Z", scheduledSendLeaseExpiresAt: new Date(Date.now() + 5_000).toISOString() });
            expect(screen.getByText("Sending…")).toBeInTheDocument();
            expect(fetchMock).not.toHaveBeenCalled();

            await act(() => vi.advanceTimersByTimeAsync(5_001));
            expect(await screen.findByRole("button", { name: "Archive" })).toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1", expect.anything());
            expect(screen.queryByText("Sending…")).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
        });

        it("keeps the current view when that re-read fails", async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true });
            const fetchMock = mockFetch(() => jsonResponse(500, { message: "down" }));
            renderOutbox({ scheduledSendTime: "2026-06-01T09:00:00.000Z", scheduledSendLeaseExpiresAt: new Date(Date.now() + 5_000).toISOString() });

            await act(() => vi.advanceTimersByTimeAsync(5_001));
            await waitFor(() => expect(fetchMock).toHaveBeenCalled());
            // The lease is over, so the schedule's own controls come back.
            expect(await screen.findByRole("button", { name: "Cancel" })).toBeInTheDocument();
        });

        it("re-reads the message after a 409 on Cancel, then shows Sending… for a lease claimed meanwhile", async () => {
            const leased = messageFixture({
                hasAttachments: false,
                version: 1,
                scheduledSendTime: "2026-06-01T09:00:00.000Z",
                scheduledSendLeaseExpiresAt: inOneMinute(),
            });
            const fetchMock = mockFetch((url, init) => {
                if (init?.method === "PUT") return jsonResponse(409, { message: "This message is being sent." });
                if (url === "/api/mail/messages/m1") return jsonResponse(200, leased);
                throw new Error(`unexpected ${url}`);
            });
            const user = userEvent.setup();
            renderOutbox({ scheduledSendTime: "2026-06-01T09:00:00.000Z" });

            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(await screen.findByText("Sending…")).toBeInTheDocument();
            expect(screen.getByText("This message is being sent.")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
            expect(fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === "GET")).toHaveLength(1);
        });

        it("re-reads after a 403 on Move to Drafts, keeping the controls when the re-read fails", async () => {
            const fetchMock = mockFetch((_url, init) =>
                init?.method === "PUT" ? jsonResponse(403, { message: "Forbidden" }) : jsonResponse(500, { message: "down" }),
            );
            const user = userEvent.setup();
            renderOutbox({ scheduledSendTime: null });

            await user.click(screen.getByRole("button", { name: "Move to Drafts" }));
            expect(await screen.findByText("Forbidden")).toBeInTheDocument();
            await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
            expect(screen.getByRole("button", { name: "Move to Drafts" })).toBeInTheDocument();
        });

        it("doesn't re-read after any other failure", async () => {
            const fetchMock = mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            renderOutbox({ scheduledSendTime: "2026-06-01T09:00:00.000Z" });

            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(await screen.findByText("boom")).toBeInTheDocument();
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("prefers a newer copy from the caller over the re-read one", async () => {
            const reread = messageFixture({ hasAttachments: false, version: 1, scheduledSendTime: null });
            mockFetch((url, init) => {
                if (init?.method === "PUT") return jsonResponse(409, { message: "Conflict" });
                if (url === "/api/mail/messages/m1") return jsonResponse(200, reread);
                throw new Error(`unexpected ${url}`);
            });
            const user = userEvent.setup();
            const { rerender } = renderOutbox({ scheduledSendTime: "2026-06-01T09:00:00.000Z" });

            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(await screen.findByRole("button", { name: "Move to Drafts" })).toBeInTheDocument();

            rerender(
                <MessageDetailPane
                    message={messageFixture({ hasAttachments: false, version: 2, scheduledSendTime: "2026-07-01T09:00:00.000Z" })}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                />,
            );
            expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Move to Drafts" })).not.toBeInTheDocument();
        });
    });
});
