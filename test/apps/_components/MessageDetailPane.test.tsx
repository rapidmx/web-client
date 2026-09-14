// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MessageDetailPane from "../../../apps/shared/components/mail/MessageDetailPane.js";
import ComposeProvider from "../../../apps/shared/components/mail/compose/ComposeContext.js";

// The real CMS/S-MIME crypto behind evaluateMessageSecurity() is already exercised end to end (against
// real WebCrypto, under react-shared's own "node" test environment - see that repo's
// test/crypto/messageSecurity.test.ts) - these tests only need to verify MessageDetailPane's own
// responsibility: fetching a message's raw content, handing it to evaluateMessageSecurity(), and
// rendering whichever result comes back. getUnlockedKeys() is stubbed alongside it since
// evaluateMessageSecurity() is mocked anyway and never actually reads its return value here.
const { evaluateMessageSecurity, getUnlockedKeys } = vi.hoisted(() => ({
    evaluateMessageSecurity: vi.fn(),
    getUnlockedKeys: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys }));

// Both MessageDetailPane's own "Unlock to view" affordance and the real ComposeWindow the reply/forward
// tests below pop up (via openCompose()) call useUnlockPrompt() - real UnlockPromptProvider is only
// mounted by AppShell.tsx, not by either component rendered standalone here, so it's stubbed the same
// way keySession.js is above.
const { requestUnlock } = vi.hoisted(() => ({ requestUnlock: vi.fn() }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({
    useUnlockPrompt: () => ({ requestUnlock }),
}));

// Keeping the Tier 2 local index in step with a move is covered in localIndexRpcClient/localIndexWorker tests.
const { moveLocalEntity } = vi.hoisted(() => ({ moveLocalEntity: vi.fn() }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ moveLocalEntity }));

// Lets a test hand MessageDetailPane a MailShell context (e.g. mailboxes with enrolled keys) without
// mounting the whole MailShell - every other test keeps the real, provider-less default.
const { mailShellOverride } = vi.hoisted(() => ({ mailShellOverride: { current: undefined as Record<string, unknown> | undefined } }));
vi.mock("../../../apps/shared/components/mail/layout/MailShell.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../apps/shared/components/mail/layout/MailShell.js")>();
    return {
        ...actual,
        useMailShell: () => {
            const real = actual.useMailShell();
            return mailShellOverride.current ?? real;
        },
    };
});

// `ComposeWindow`'s own exhaustive rendering (draft lifecycle, send, attachments...) is tested in its
// own file — mocked here (`RichTextEditor` only, matching every other compose-adjacent test file's
// convention) so the "reply/forward" tests below only exercise the values `MessageDetailPane` itself
// hands off to `openCompose()`, observed via the real `ComposeWindow` that pops up.
vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: () => <textarea data-testid="html-editor" />,
}));

function mockComposeDraft() {
    return mockFetch((url, init) => {
        if (url.startsWith("/api/mail/folders")) {
            return jsonResponse(200, [
                {
                    uid: "f-drafts",
                    version: 0,
                    dateCreated: "2026-01-01T00:00:00.000Z",
                    dateModified: "2026-01-01T00:00:00.000Z",
                    mailboxUid: "mb1",
                    name: "Drafts",
                    type: "drafts",
                    unreadCount: 0,
                    totalCount: 0,
                },
            ]);
        }
        if (url.startsWith("/api/mail/mail-signatures")) return jsonResponse(200, []);
        if (url === "/api/mail/messages" && (init?.method ?? "GET") === "POST") {
            return jsonResponse(200, {
                uid: "draft1",
                version: 0,
                dateCreated: "2026-01-01T00:00:00.000Z",
                dateModified: "2026-01-01T00:00:00.000Z",
                folderUid: "f-drafts",
                mailboxUid: "mb1",
                messageId: "draft1@webmail",
                subject: "",
                from: { address: "u1@example.com", type: "to" },
                recipients: [],
                sentDate: "2026-01-01T00:00:00.000Z",
                receivedDate: "2026-01-01T00:00:00.000Z",
                bodyPreview: "",
                flags: { read: true, flagged: false, answered: false, forwarded: false },
                importance: "normal",
                hasAttachments: false,
            });
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

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
        bodyPreview: "Hi there, just checking in.",
        flags: { read: false, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    evaluateMessageSecurity.mockReset();
    getUnlockedKeys.mockReset();
    mailShellOverride.current = undefined;
});

describe("MessageDetailPane", () => {
    it("shows a placeholder and no back link when no message is given", () => {
        render(<MessageDetailPane message={null} attachments={[]} backHref="/messages/m1" />);
        expect(screen.getByText("Select a message to read it.")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: /Back to messages/ })).not.toBeInTheDocument();
    });

    it("renders the message header, iframe, and no back link when backHref is absent", () => {
        render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

        expect(screen.getByRole("heading", { name: "Hello there" })).toBeInTheDocument();
        expect(screen.getByText(/From Sender One/)).toBeInTheDocument();
        expect(screen.getByText("To Me")).toBeInTheDocument();
        expect(screen.getByTitle("Hello there")).toHaveAttribute("src", "/api/mail/messages/m1/content");
        expect(screen.queryByRole("link", { name: /Back to messages/ })).not.toBeInTheDocument();
    });

    it("renders a back link when backHref is given", () => {
        render(
            <MessageDetailPane message={messageFixture() as any} attachments={[]} backHref="/?mailboxUid=mb1&folderUid=f1" />,
        );
        expect(screen.getByRole("link", { name: /Back to messages/ })).toHaveAttribute("href", "/?mailboxUid=mb1&folderUid=f1");
    });

    it("falls back to the raw address and '(no subject)' when displayName/subject are absent", () => {
        const message = messageFixture({
            subject: "",
            from: { address: "sender@example.com", type: "to" as const },
            recipients: [{ address: "u1@example.com", type: "to" as const }],
        });
        render(<MessageDetailPane message={message as any} attachments={[]} />);

        expect(screen.getByRole("heading", { name: "(no subject)" })).toBeInTheDocument();
        expect(screen.getByText(/From sender@example\.com/)).toBeInTheDocument();
        expect(screen.getByText("To u1@example.com")).toBeInTheDocument();
        expect(screen.getByTitle("Message content")).toBeInTheDocument();
    });

    it("lists and links to attachments when present", () => {
        const attachment = {
            uid: "a1",
            version: 0,
            dateCreated: "2026-01-01T00:00:00.000Z",
            dateModified: "2026-01-01T00:00:00.000Z",
            messageUid: "m1",
            folderUid: "f1",
            mailboxUid: "mb1",
            filename: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 2_500_000,
            isInline: false,
        };
        render(<MessageDetailPane message={messageFixture() as any} attachments={[attachment]} />);

        const link = screen.getByRole("link", { name: /report\.pdf/ });
        expect(link).toHaveAttribute("href", "/api/mail/attachments/a1/content");
        expect(link.textContent).toContain("2.5 MB");
    });

    it("renders no attachment list when there are none", () => {
        render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
        expect(screen.queryByRole("link", { name: /pdf|txt/ })).not.toBeInTheDocument();
    });

    it("formats attachment sizes across byte/KB/MB tiers", () => {
        const attachments = [
            { uid: "a1", version: 0, dateCreated: "", dateModified: "", messageUid: "m1", folderUid: "f1", mailboxUid: "mb1", filename: "tiny.txt", mimeType: "text/plain", sizeBytes: 500, isInline: false },
            { uid: "a2", version: 0, dateCreated: "", dateModified: "", messageUid: "m1", folderUid: "f1", mailboxUid: "mb1", filename: "medium.txt", mimeType: "text/plain", sizeBytes: 2_500, isInline: false },
            { uid: "a3", version: 0, dateCreated: "", dateModified: "", messageUid: "m1", folderUid: "f1", mailboxUid: "mb1", filename: "big.pdf", mimeType: "application/pdf", sizeBytes: 2_500_000, isInline: false },
        ];
        render(<MessageDetailPane message={messageFixture() as any} attachments={attachments} />);

        expect(screen.getByText(/tiny\.txt \(500 B\)/)).toBeInTheDocument();
        expect(screen.getByText(/medium\.txt \(2\.5 KB\)/)).toBeInTheDocument();
        expect(screen.getByText(/big\.pdf \(2\.5 MB\)/)).toBeInTheDocument();
    });

    describe("recall", () => {
        it("shows neither the button nor the indicator when isSentItems is not set", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            expect(screen.queryByRole("button", { name: "Recall this message" })).not.toBeInTheDocument();
            expect(screen.queryByText("Recall requested")).not.toBeInTheDocument();
        });

        it("shows neither the button nor the indicator when isSentItems is false", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems={false} />);
            expect(screen.queryByRole("button", { name: "Recall this message" })).not.toBeInTheDocument();
            expect(screen.queryByText("Recall requested")).not.toBeInTheDocument();
        });

        it("shows the Recall button when isSentItems is true and recallRequestedAt is unset", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems />);
            expect(screen.getByRole("button", { name: "Recall this message" })).toBeInTheDocument();
            expect(screen.queryByText("Recall requested")).not.toBeInTheDocument();
        });

        it("shows the 'Recall requested' indicator instead of the button once recallRequestedAt is set", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ recallRequestedAt: "2026-01-02T00:00:00.000Z" }) as any}
                    attachments={[]}
                    isSentItems
                />,
            );
            expect(screen.getByText("Recall requested")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Recall this message" })).not.toBeInTheDocument();
        });

        it("opens the confirmation modal, and Cancel closes it without calling the API", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, {}));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems />);

            await user.click(screen.getByRole("button", { name: "Recall this message" }));
            expect(screen.getByRole("dialog", { name: "Recall this message?" })).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            // Rendering any message always triggers its own security-evaluation fetch (unrelated to
            // recall) - this test's own concern is that opening/closing the confirmation modal never
            // calls the recall endpoint itself.
            expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/recall"))).toBe(false);
        });

        it("also closes via the modal's own close button (Modal's onClose, distinct from the Cancel button)", async () => {
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems />);

            await user.click(screen.getByRole("button", { name: "Recall this message" }));
            await user.click(screen.getByRole("button", { name: "Close" }));

            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });

        it("recalls the message, closes the modal, and calls onRecalled with the server's updated copy", async () => {
            const updated = messageFixture({ recallRequestedAt: "2026-01-02T00:00:00.000Z" });
            const fetchMock = mockFetch(() => jsonResponse(200, updated));
            const onRecalled = vi.fn();
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems onRecalled={onRecalled} />);

            await user.click(screen.getByRole("button", { name: "Recall this message" }));
            await user.click(screen.getByRole("button", { name: "Recall message" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/recall",
                expect.objectContaining({ method: "POST" }),
            );
            expect(await screen.findByRole("button", { name: "Recall this message" })).toBeInTheDocument(); // dialog closed, re-rendered with the still-unset prop
            expect(onRecalled).toHaveBeenCalledWith(updated);
        });

        it("shows an error message and keeps the modal open when recall fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems />);

            await user.click(screen.getByRole("button", { name: "Recall this message" }));
            await user.click(screen.getByRole("button", { name: "Recall message" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
            expect(screen.getByRole("dialog", { name: "Recall this message?" })).toBeInTheDocument();
        });

        it("shows a generic error message when recall fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems />);

            await user.click(screen.getByRole("button", { name: "Recall this message" }));
            await user.click(screen.getByRole("button", { name: "Recall message" }));

            expect(await screen.findByText("Could not recall this message.")).toBeInTheDocument();
        });
    });

    describe("archive", () => {
        it("shows the Archive button for an ordinary message", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
        });

        it("hides the Archive button for an Outbox message", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isOutbox />);
            expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
        });

        it("hides the Archive button for a message currently in Drafts", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ folderUid: "f-drafts" }) as any}
                    attachments={[]}
                    draftsFolderUid="f-drafts"
                />,
            );
            expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
        });

        it("archives the message and calls onArchived with the server's updated copy", async () => {
            const updated = messageFixture({ folderUid: "f-archive" });
            const fetchMock = mockFetch(() => jsonResponse(200, updated));
            const onArchived = vi.fn();
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} onArchived={onArchived} />);

            await user.click(screen.getByRole("button", { name: "Archive" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/archive",
                expect.objectContaining({ method: "POST" }),
            );
            await waitFor(() => expect(onArchived).toHaveBeenCalledWith(updated));
            expect(moveLocalEntity).toHaveBeenCalledWith("mb1", "m1", "f-archive");
        });

        it("shows an error message when archiving fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await user.click(screen.getByRole("button", { name: "Archive" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
        });

        it("shows a generic error message when archiving fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await user.click(screen.getByRole("button", { name: "Archive" }));

            expect(await screen.findByText("Could not archive this message.")).toBeInTheDocument();
        });
    });

    describe("labels", () => {
        const labels = [
            { uid: "l1", version: 0, dateCreated: "2026-01-01T00:00:00.000Z", dateModified: "2026-01-01T00:00:00.000Z", mailboxUid: "mb1", name: "Important", color: "#e11d48" },
            { uid: "l2", version: 0, dateCreated: "2026-01-01T00:00:00.000Z", dateModified: "2026-01-01T00:00:00.000Z", mailboxUid: "mb1", name: "Later", color: "#0ea5e9" },
        ];

        it("hides the Labels button and chip row when no labels are passed", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            expect(screen.queryByRole("button", { name: "Labels" })).not.toBeInTheDocument();
        });

        it("shows the Labels button when labels exist, even if none are applied to this message yet", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} labels={labels} />);
            expect(screen.getByRole("button", { name: "Labels" })).toBeInTheDocument();
        });

        it("renders a chip for each applied label, in labelUids order, and none for an unapplied label", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ labelUids: ["l2", "l1"] }) as any}
                    attachments={[]}
                    labels={labels}
                />,
            );
            const chips = screen.getAllByText(/Important|Later/);
            expect(chips.map((el) => el.textContent)).toEqual(["Later", "Important"]);
        });

        it("falls back to the default label color for a label with no color, in both the chip and the Labels modal", async () => {
            const uncolored = { ...labels[0], uid: "l3", name: "Uncolored", color: undefined };
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture({ labelUids: ["l3"] }) as any} attachments={[]} labels={[uncolored]} />);

            const chipSwatch = screen.getByText("Uncolored").querySelector("span")!;
            expect(chipSwatch).toHaveStyle({ backgroundColor: "#6366f1" });

            await user.click(screen.getByRole("button", { name: "Labels" }));
            const modalSwatch = screen.getByRole("checkbox", { name: /Uncolored/ }).nextElementSibling!;
            expect(modalSwatch).toHaveStyle({ backgroundColor: "#6366f1" });
        });

        it("shows no chip row at all when the message has no labelUids", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} labels={labels} />);
            expect(screen.queryByText("Important")).not.toBeInTheDocument();
        });

        it("opens the Labels modal, checking only the boxes for labels already applied", async () => {
            const user = userEvent.setup();
            render(
                <MessageDetailPane message={messageFixture({ labelUids: ["l1"] }) as any} attachments={[]} labels={labels} />,
            );

            await user.click(screen.getByRole("button", { name: "Labels" }));

            expect(screen.getByRole("dialog", { name: "Labels" })).toBeInTheDocument();
            expect(screen.getByRole("checkbox", { name: /Important/ })).toBeChecked();
            expect(screen.getByRole("checkbox", { name: /Later/ })).not.toBeChecked();
        });

        it("checking a label's box adds it and calls onLabelsChanged with the server's updated copy", async () => {
            const updated = messageFixture({ labelUids: ["l2"] });
            const fetchMock = mockFetch(() => jsonResponse(200, updated));
            const onLabelsChanged = vi.fn();
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture() as any}
                    attachments={[]}
                    labels={labels}
                    onLabelsChanged={onLabelsChanged}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("checkbox", { name: /Later/ }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1",
                expect.objectContaining({
                    method: "PUT",
                    body: JSON.stringify({ uid: "m1", version: 0, labelUids: ["l2"] }),
                }),
            );
            await waitFor(() => expect(onLabelsChanged).toHaveBeenCalledWith(updated));
        });

        it("unchecking an applied label's box removes only that uid", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, messageFixture({ labelUids: [] })));
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ labelUids: ["l1", "l2"] }) as any}
                    attachments={[]}
                    labels={labels}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("checkbox", { name: /Important/ }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1",
                expect.objectContaining({ body: JSON.stringify({ uid: "m1", version: 0, labelUids: ["l2"] }) }),
            );
        });

        it("shows an error message in the modal when toggling a label fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} labels={labels} />);

            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("checkbox", { name: /Important/ }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
        });

        it("shows a generic error message when toggling a label fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} labels={labels} />);

            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("checkbox", { name: /Important/ }));

            expect(await screen.findByText("Could not update this message's labels.")).toBeInTheDocument();
        });

        it("closes the Labels modal via its own close button", async () => {
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} labels={labels} />);

            await user.click(screen.getByRole("button", { name: "Labels" }));
            expect(screen.getByRole("dialog", { name: "Labels" })).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Close" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
    });

    describe("reply/forward", () => {
        it("Reply opens Compose prefilled with the sender's address, a 'Re:' subject, and a quoted body", async () => {
            mockComposeDraft();
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply" }));

            expect(await screen.findByRole("dialog", { name: "Re: Hello there" })).toBeInTheDocument();
            expect(screen.getByLabelText("To")).toHaveValue("sender@example.com");
        });

        it("Reply All prefills To with the sender and Cc with every other recipient, excluding bcc", async () => {
            mockComposeDraft();
            const user = userEvent.setup();
            const message = messageFixture({
                recipients: [
                    { address: "u1@example.com", displayName: "Me", type: "to" },
                    { address: "other@example.com", type: "cc" },
                    { address: "hidden@example.com", type: "bcc" },
                ],
            });
            render(
                <ComposeProvider>
                    <MessageDetailPane message={message as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply All" }));

            await screen.findByRole("dialog", { name: "Re: Hello there" });
            expect(screen.getByLabelText("To")).toHaveValue("sender@example.com");
            expect(screen.getByLabelText("Cc")).toHaveValue("u1@example.com, other@example.com");
        });

        it("Forward opens Compose with a 'Fwd:' subject and no prefilled recipient", async () => {
            mockComposeDraft();
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Forward" }));

            expect(await screen.findByRole("dialog", { name: "Fwd: Hello there" })).toBeInTheDocument();
            expect(screen.getByLabelText("To")).toHaveValue("");
        });

        it("does not double-prefix Re:/Fwd: on a subject that already carries one", async () => {
            mockComposeDraft();
            const user = userEvent.setup();
            const message = messageFixture({ subject: "Re: Hello there" });
            render(
                <ComposeProvider>
                    <MessageDetailPane message={message as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply" }));
            expect(await screen.findByRole("dialog", { name: "Re: Hello there" })).toBeInTheDocument();
        });

        // A list that appends a footer after signing invalidates the signature (specs/
        // end-to-end_encryption.md's "Mailing lists" note under Digital Signatures) - Reply/Reply All
        // default the new compose window's Sign toggle off when the message being replied to carries a
        // List-Unsubscribe header, via isLikelyMailingList(). The Sign checkbox itself only renders once
        // a signing key is unlocked, so these tests supply one via the shared getUnlockedKeys() mock.
        describe("mailing-list signature suppression", () => {
            function mockSigningKeyUnlocked() {
                getUnlockedKeys.mockReturnValue({ signingPrivateKey: {} as any, signingCertDer: new Uint8Array() });
            }

            it("Reply to a message with a List-Unsubscribe header defaults the Sign checkbox off", async () => {
                mockComposeDraft();
                mockSigningKeyUnlocked();
                const user = userEvent.setup();
                const message = messageFixture({ listUnsubscribeHeader: "<mailto:list-unsubscribe@example.com>" });
                render(
                    <ComposeProvider>
                        <MessageDetailPane message={message as any} attachments={[]} />
                    </ComposeProvider>,
                );

                await user.click(screen.getByRole("button", { name: "Reply" }));

                expect(await screen.findByRole("dialog", { name: "Re: Hello there" })).toBeInTheDocument();
                expect(screen.getByRole("checkbox", { name: "Digitally sign this message" })).not.toBeChecked();
            });

            it("Reply All to a message with a List-Unsubscribe header defaults the Sign checkbox off", async () => {
                mockComposeDraft();
                mockSigningKeyUnlocked();
                const user = userEvent.setup();
                const message = messageFixture({ listUnsubscribeHeader: "<https://example.com/unsubscribe>" });
                render(
                    <ComposeProvider>
                        <MessageDetailPane message={message as any} attachments={[]} />
                    </ComposeProvider>,
                );

                await user.click(screen.getByRole("button", { name: "Reply All" }));

                expect(await screen.findByRole("dialog", { name: "Re: Hello there" })).toBeInTheDocument();
                expect(screen.getByRole("checkbox", { name: "Digitally sign this message" })).not.toBeChecked();
            });

            it("Reply to an ordinary message (no List-Unsubscribe) leaves the Sign checkbox on", async () => {
                mockComposeDraft();
                mockSigningKeyUnlocked();
                const user = userEvent.setup();
                render(
                    <ComposeProvider>
                        <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                    </ComposeProvider>,
                );

                await user.click(screen.getByRole("button", { name: "Reply" }));

                expect(await screen.findByRole("dialog", { name: "Re: Hello there" })).toBeInTheDocument();
                expect(screen.getByRole("checkbox", { name: "Digitally sign this message" })).toBeChecked();
            });
        });
    });

    describe("scheduled send cancellation", () => {
        it("shows neither the pill nor Cancel when isOutbox is not set", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) as any}
                    attachments={[]}
                />,
            );
            expect(screen.queryByText(/Scheduled for/)).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
        });

        it("shows neither when isOutbox is true but scheduledSendTime is unset", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isOutbox />);
            expect(screen.queryByText(/Scheduled for/)).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
        });

        it("shows the scheduled-time pill and a Cancel button when both isOutbox and scheduledSendTime are set", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) as any}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                />,
            );
            expect(screen.getByText(/Scheduled for/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
        });

        it("cancels the scheduled send and calls onScheduledSendCanceled with the server's updated copy", async () => {
            const updated = messageFixture({ folderUid: "f-drafts", scheduledSendTime: undefined });
            const fetchMock = mockFetch(() => jsonResponse(200, updated));
            const onScheduledSendCanceled = vi.fn();
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) as any}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                    onScheduledSendCanceled={onScheduledSendCanceled}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Cancel" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1",
                expect.objectContaining({
                    method: "PUT",
                    body: JSON.stringify({ uid: "m1", version: 0, scheduledSendTime: null, folderUid: "f-drafts" }),
                }),
            );
            await vi.waitFor(() => expect(onScheduledSendCanceled).toHaveBeenCalledWith(updated));
            expect(moveLocalEntity).toHaveBeenCalledWith("mb1", "m1", "f-drafts");
        });

        it("shows an error message and keeps the pill/button when canceling fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) as any}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                />,
            );

            await user.click(screen.getByRole("button", { name: "Cancel" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
        });

        it("shows a generic error message when canceling fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) as any}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                />,
            );

            await user.click(screen.getByRole("button", { name: "Cancel" }));

            expect(await screen.findByText("Could not cancel this scheduled send.")).toBeInTheDocument();
        });
    });

    describe("classify", () => {
        it("shows neither the button nor the sender checkbox when isInbox is not set", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            expect(screen.queryByRole("button", { name: /Move to/ })).not.toBeInTheDocument();
            expect(screen.queryByText("Always for this sender")).not.toBeInTheDocument();
        });

        it("shows 'Move to Other' when the message has no inferenceClassification (defaults to Focused)", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isInbox />);
            expect(screen.getByRole("button", { name: "Move to Other" })).toBeInTheDocument();
        });

        it("shows 'Move to Focused' when the message is classified Other", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ inferenceClassification: "other" }) as any}
                    attachments={[]}
                    isInbox
                />,
            );
            expect(screen.getByRole("button", { name: "Move to Focused" })).toBeInTheDocument();
        });

        it("classifies the message and calls onClassified with the server's updated copy", async () => {
            const updated = messageFixture({ inferenceClassification: "other" });
            const fetchMock = mockFetch(() => jsonResponse(200, updated));
            const onClassified = vi.fn();
            const user = userEvent.setup();
            render(
                <MessageDetailPane message={messageFixture() as any} attachments={[]} isInbox onClassified={onClassified} />,
            );

            await user.click(screen.getByRole("button", { name: "Move to Other" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/classify",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ classifyAs: "other", applyToSender: false }),
                }),
            );
            await vi.waitFor(() => expect(onClassified).toHaveBeenCalledWith(updated));
        });

        it("classifies back to Focused when the message is currently Other", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, messageFixture({ inferenceClassification: "focused" })));
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ inferenceClassification: "other" }) as any}
                    attachments={[]}
                    isInbox
                />,
            );

            await user.click(screen.getByRole("button", { name: "Move to Focused" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/classify",
                expect.objectContaining({ body: JSON.stringify({ classifyAs: "focused", applyToSender: false }) }),
            );
        });

        it("includes applyToSender when the checkbox is checked", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, messageFixture()));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isInbox />);

            await user.click(screen.getByLabelText("Always for this sender"));
            await user.click(screen.getByRole("button", { name: "Move to Other" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/classify",
                expect.objectContaining({ body: JSON.stringify({ classifyAs: "other", applyToSender: true }) }),
            );
        });

        it("shows an error message when classifying fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isInbox />);

            await user.click(screen.getByRole("button", { name: "Move to Other" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
        });

        it("shows a generic error message when classifying fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isInbox />);

            await user.click(screen.getByRole("button", { name: "Move to Other" }));

            expect(await screen.findByText("Could not reclassify this message.")).toBeInTheDocument();
        });
    });

    describe("receipts", () => {
        it("shows no banner when neither receipt is pending", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            expect(screen.queryByRole("button", { name: "Send receipt" })).not.toBeInTheDocument();
        });

        it("shows a delivery-receipt banner when deliveryReceiptPending is set", () => {
            render(
                <MessageDetailPane message={messageFixture({ deliveryReceiptPending: true }) as any} attachments={[]} />,
            );
            expect(screen.getByText(/requested a delivery receipt/)).toBeInTheDocument();
        });

        it("falls back to the raw sender address when displayName is absent", () => {
            const message = messageFixture({
                deliveryReceiptPending: true,
                from: { address: "sender@example.com", type: "to" as const },
            });
            render(<MessageDetailPane message={message as any} attachments={[]} />);
            expect(screen.getByText(/sender@example\.com requested a delivery receipt/)).toBeInTheDocument();
        });

        it("shows both banners when both delivery and read receipts are pending", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ deliveryReceiptPending: true, readReceiptPending: true }) as any}
                    attachments={[]}
                />,
            );
            expect(screen.getByText(/requested a delivery receipt/)).toBeInTheDocument();
            expect(screen.getByText(/requested a read receipt/)).toBeInTheDocument();
        });

        it("approves a pending receipt and calls onReceiptHandled with the server's updated copy", async () => {
            const updated = messageFixture({ deliveryReceiptPending: false });
            const fetchMock = mockFetch(() => jsonResponse(200, updated));
            const onReceiptHandled = vi.fn();
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ deliveryReceiptPending: true }) as any}
                    attachments={[]}
                    onReceiptHandled={onReceiptHandled}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Send receipt" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/receipt/approve",
                expect.objectContaining({ method: "POST", body: JSON.stringify({ type: "delivery" }) }),
            );
            await vi.waitFor(() => expect(onReceiptHandled).toHaveBeenCalledWith(updated));
        });

        it("declines a pending receipt", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, messageFixture({ readReceiptPending: false })));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture({ readReceiptPending: true }) as any} attachments={[]} />);

            await user.click(screen.getByRole("button", { name: "Decline" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1/receipt/decline",
                expect.objectContaining({ method: "POST", body: JSON.stringify({ type: "read" }) }),
            );
        });

        it("shows an error message when handling a receipt fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture({ deliveryReceiptPending: true }) as any} attachments={[]} />);

            await user.click(screen.getByRole("button", { name: "Send receipt" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
        });

        it("shows a generic error message when handling a receipt fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture({ deliveryReceiptPending: true }) as any} attachments={[]} />);

            await user.click(screen.getByRole("button", { name: "Send receipt" }));

            expect(await screen.findByText("Could not handle this receipt request.")).toBeInTheDocument();
        });
    });

    describe("security indicator", () => {
        function mockRawContent(raw = "raw mime text") {
            return mockFetch((url) => (url === "/api/mail/messages/m1/raw" ? new Response(raw) : jsonResponse(200, {})));
        }

        it("shows no indicator until evaluateMessageSecurity resolves", async () => {
            let resolveSecurity: ((result: { state: string }) => void) | undefined;
            evaluateMessageSecurity.mockImplementation(() => new Promise((resolve) => (resolveSecurity = resolve)));
            mockRawContent();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await waitFor(() => expect(resolveSecurity).toBeDefined());
            expect(screen.queryByText("Unprotected")).not.toBeInTheDocument();

            resolveSecurity!({ state: "unprotected" });
            expect(await screen.findByText("Unprotected")).toBeInTheDocument();
        });

        it.each([
            ["unprotected", "Unprotected"],
            ["encrypted", "Encrypted"],
            ["signed_verified", "Signed & verified"],
            ["encrypted_verified", "Encrypted & verified"],
            ["signature_failed", "Signature failed"],
        ] as const)("renders the %s state as '%s'", async (state, label) => {
            evaluateMessageSecurity.mockResolvedValue({ state });
            mockRawContent();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            expect(await screen.findByText(label)).toBeInTheDocument();
        });

        it("renders the decrypted, sanitized body via srcDoc instead of the server's /content URL", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>Secret</p><script>evil()</script>" });
            mockRawContent();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await screen.findByText("Encrypted & verified");
            const iframe = screen.getByTitle("Hello there");
            expect(iframe).not.toHaveAttribute("src");
            expect(iframe.getAttribute("srcdoc")).toContain("<p>Secret</p>");
            expect(iframe.getAttribute("srcdoc")).not.toContain("<script>");
        });

        it("keeps using the server's /content URL when there is no decrypted html", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "unprotected" });
            mockRawContent();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await screen.findByText("Unprotected");
            const iframe = screen.getByTitle("Hello there");
            expect(iframe).toHaveAttribute("src", "/api/mail/messages/m1/content");
            expect(iframe).not.toHaveAttribute("srcdoc");
        });

        it("shows a decryptError alongside the indicator, still using the server's /content URL", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            mockRawContent();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            expect(await screen.findByText("This device doesn't have the key needed.")).toBeInTheDocument();
            expect(screen.getByText("Encrypted")).toBeInTheDocument();
            expect(screen.getByTitle("Hello there")).toHaveAttribute("src", "/api/mail/messages/m1/content");
        });

        it("offers to unlock when a decryptError means this device has no unlocked session at all, and re-evaluates once unlocked", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            evaluateMessageSecurity.mockResolvedValueOnce({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            requestUnlock.mockImplementation(async () => {
                getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            });
            mockRawContent();
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            await screen.findByText("This device doesn't have the key needed.");
            const unlockLink = screen.getByText("Unlock to view this message");

            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>Now decrypted</p>" });
            await user.click(unlockLink);

            expect(requestUnlock).toHaveBeenCalledWith("mb1", []);
            expect(await screen.findByTitle("Hello there")).toHaveAttribute(
                "srcdoc",
                expect.stringContaining("Now decrypted"),
            );
            expect(screen.queryByText("Unlock to view this message")).not.toBeInTheDocument();
        });

        it("passes the message's own mailbox's enrolled keys to the unlock prompt", async () => {
            const keys = [{ uid: "k1", purpose: "signing" }];
            mailShellOverride.current = { mailboxes: [{ uid: "mb-other", keys: [] }, { uid: "mb1", keys }], mailboxFolders: [] };
            getUnlockedKeys.mockReturnValue(undefined);
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            requestUnlock.mockRejectedValue(new Error("dismissed"));
            mockRawContent();
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await user.click(await screen.findByText("Unlock to view this message"));

            expect(requestUnlock).toHaveBeenCalledWith("mb1", keys);
        });

        it("does not offer to unlock when a decryptError comes from an already-unlocked session (wrong/rotated key)", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            mockRawContent();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await screen.findByText("This device doesn't have the key needed.");
            expect(screen.queryByText("Unlock to view this message")).not.toBeInTheDocument();
        });

        // RFC 9788's own "MUST visually distinguish" requirement for a message whose outer envelope
        // disagrees with what was actually signed/encrypted (HP-Outer tamper detection) - deliberately a
        // separate banner from the 5-state SecurityIndicator badge above, not a 6th state, since this can
        // co-occur with any of the encrypted/encrypted_verified/signature_failed states.
        it("shows a header-tamper warning banner when headerTamperDetected is true", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>hi</p>", headerTamperDetected: true });
            mockRawContent();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await screen.findByText("Encrypted & verified");
            expect(screen.getByText(/don't match what the sender actually signed or encrypted/)).toBeInTheDocument();
        });

        it("shows no header-tamper banner when headerTamperDetected is false", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>hi</p>", headerTamperDetected: false });
            mockRawContent();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await screen.findByText("Encrypted & verified");
            expect(screen.queryByText(/don't match what the sender actually signed or encrypted/)).not.toBeInTheDocument();
        });

        it("shows no header-tamper banner when headerTamperDetected is undefined (nothing to compare)", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", html: "<p>hi</p>" });
            mockRawContent();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await screen.findByText("Encrypted");
            expect(screen.queryByText(/don't match what the sender actually signed or encrypted/)).not.toBeInTheDocument();
        });

        it("degrades to unprotected, with no error shown, when fetching the raw content fails", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            expect(await screen.findByText("Unprotected")).toBeInTheDocument();
            expect(evaluateMessageSecurity).not.toHaveBeenCalled();
        });

        it("does not update state after unmounting before evaluateMessageSecurity settles", async () => {
            let resolveSecurity: ((result: { state: string }) => void) | undefined;
            evaluateMessageSecurity.mockImplementation(() => new Promise((resolve) => (resolveSecurity = resolve)));
            mockRawContent();
            const { unmount } = render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await waitFor(() => expect(resolveSecurity).toBeDefined());
            unmount();
            resolveSecurity!({ state: "unprotected" });
            // No assertion beyond "this doesn't throw/warn" - see KeyEnrollmentGate.test.tsx's identical
            // pattern for why: a regression here surfaces as a React console.error, not a thrown exception.
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        it("does not update state after unmounting before a failed raw-content fetch settles", async () => {
            let rejectFetch: ((err: Error) => void) | undefined;
            mockFetch(() => new Promise((_resolve, reject) => (rejectFetch = reject)));
            const { unmount } = render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await waitFor(() => expect(rejectFetch).toBeDefined());
            unmount();
            rejectFetch!(new Error("network error"));
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        it("falls back to 'Message content' as the iframe title when a decrypted message has no subject", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>Secret</p>" });
            mockRawContent();
            render(<MessageDetailPane message={messageFixture({ subject: "" }) as any} attachments={[]} />);

            expect(await screen.findByTitle("Message content")).toHaveAttribute("srcdoc");
        });

        it("resets to no indicator when switching to a different message", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<p>Signed</p>" });
            mockRawContent();
            const { rerender } = render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            await screen.findByText("Signed & verified");

            let resolveNext: ((result: { state: string }) => void) | undefined;
            evaluateMessageSecurity.mockImplementation(() => new Promise((resolve) => (resolveNext = resolve)));
            rerender(<MessageDetailPane message={messageFixture({ uid: "m2", subject: "Other" })} attachments={[]} />);

            await waitFor(() => expect(resolveNext).toBeDefined());
            expect(screen.queryByText("Signed & verified")).not.toBeInTheDocument();
        });
    });
});
