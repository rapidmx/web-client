// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MessageDetailPane from "../../../apps/shared/components/mail/MessageDetailPane.js";
import { clearPinnedSignerCache } from "../../../apps/shared/components/mail/pinnedSigners.js";
import ComposeProvider from "../../../apps/shared/components/mail/compose/ComposeContext.js";

// The real CMS/S-MIME crypto behind evaluateMessageSecurity() is already exercised end to end (against
// real WebCrypto, under react-shared's own "node" test environment - see that repo's
// test/crypto/messageSecurity.test.ts) - these tests only need to verify MessageDetailPane's own
// responsibility: fetching a message's raw content, handing it to evaluateMessageSecurity(), and
// rendering whichever result comes back. getUnlockedKeys() is stubbed alongside it since
// evaluateMessageSecurity() is mocked anyway and never actually reads its return value here.
// subscribeKeySession() is a hand-rolled listener registry so a test can fire lock/unlock events.
const { evaluateMessageSecurity, getUnlockedKeys, keySessionListeners } = vi.hoisted(() => ({
    evaluateMessageSecurity: vi.fn(),
    getUnlockedKeys: vi.fn(),
    keySessionListeners: new Set<(event: { mailboxUid: string; state: "locked" | "unlocked" }) => void>(),
}));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({
    getUnlockedKeys,
    subscribeKeySession: (listener: (event: { mailboxUid: string; state: "locked" | "unlocked" }) => void) => {
        keySessionListeners.add(listener);
        return () => keySessionListeners.delete(listener);
    },
}));

function emitKeySession(event: { mailboxUid: string; state: "locked" | "unlocked" }) {
    act(() => {
        for (const listener of [...keySessionListeners]) listener(event);
    });
}

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
    default: ({ value, autoFocusStart }: { value: string; autoFocusStart?: boolean }) => {
        // Like the real editor, only the value it mounts with counts.
        const [mountedAutoFocusStart] = React.useState(!!autoFocusStart);
        return <textarea data-testid="html-editor" data-autofocus-start={String(mountedAutoFocusStart)} value={value} readOnly />;
    },
}));

/** Compose's own endpoints; `extra` answers anything else first (e.g. the message body a reply quotes). */
function mockComposeDraft(extra?: (url: string) => Response | Promise<Response> | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url);
        if (custom) return custom;
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

/** The recipients a compose field shows as chips. */
function recipientChips(label: string): (string | null)[] {
    return within(screen.getByRole("list", { name: `${label} recipients` }))
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("title"));
}

afterEach(() => {
    vi.unstubAllGlobals();
    evaluateMessageSecurity.mockReset();
    getUnlockedKeys.mockReset();
    mailShellOverride.current = undefined;
    // A never-settling contacts fetch from one test must not hold up the next test's pin lookup.
    clearPinnedSignerCache();
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

        it("falls back to the default label color for a label with no color", () => {
            render(
                <MessageDetailPane
                    message={messageFixture({ labelUids: ["l3"] }) as any}
                    attachments={[]}
                    labels={[...labels, { ...labels[0], uid: "l3", name: "Uncolored", color: undefined }]}
                />,
            );
            const swatch = screen.getByText("Uncolored").parentElement!.querySelector("span[style]") as HTMLElement;
            expect(swatch).toHaveStyle({ backgroundColor: "rgb(99, 102, 241)" });
        });

        it("shows no chip row at all when the message has no labelUids", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} labels={labels} />);
            expect(screen.queryByText("Important")).not.toBeInTheDocument();
        });

        it("opens the Labels menu with only the applied labels ticked, and Apply held until something changes", async () => {
            const user = userEvent.setup();
            render(
                <MessageDetailPane message={messageFixture({ labelUids: ["l1"] }) as any} attachments={[]} labels={labels} />,
            );

            await user.click(screen.getByRole("button", { name: "Labels" }));

            expect(screen.getByRole("menu", { name: "Labels" })).toBeInTheDocument();
            expect(screen.getByRole("menuitemcheckbox", { name: "Important" })).toHaveAttribute("aria-checked", "true");
            expect(screen.getByRole("menuitemcheckbox", { name: "Later" })).toHaveAttribute("aria-checked", "false");
            expect(screen.getByRole("menuitem", { name: "Apply" })).toBeDisabled();
        });

        it("ticks several labels with the menu staying open and applies them in one request", async () => {
            const updated = messageFixture({ labelUids: ["l1", "l2"] });
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
            await user.click(screen.getByRole("menuitemcheckbox", { name: "Important" }));
            // Still open, with the first tick remembered.
            expect(screen.getByRole("menu", { name: "Labels" })).toBeInTheDocument();
            await user.click(screen.getByRole("menuitemcheckbox", { name: "Later" }));
            expect(screen.getByRole("menuitemcheckbox", { name: "Important" })).toHaveAttribute("aria-checked", "true");
            await user.click(screen.getByRole("menuitem", { name: "Apply" }));

            const puts = fetchMock.mock.calls.filter(([url]: [string]) => url === "/api/mail/messages/m1");
            expect(puts).toHaveLength(1);
            expect(puts[0][1].body).toBe(JSON.stringify({ uid: "m1", version: 0, labelUids: ["l1", "l2"] }));
            await waitFor(() => expect(onLabelsChanged).toHaveBeenCalledWith(updated));
        });

        it("unticking an applied label removes only that uid", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, messageFixture({ labelUids: ["l2"] })));
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture({ labelUids: ["l1", "l2"] }) as any}
                    attachments={[]}
                    labels={labels}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("menuitemcheckbox", { name: "Important" }));
            await user.click(screen.getByRole("menuitem", { name: "Apply" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1",
                expect.objectContaining({ body: JSON.stringify({ uid: "m1", version: 0, labelUids: ["l2"] }) }),
            );
        });

        it("removes every label at once", async () => {
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
            await user.click(screen.getByRole("menuitem", { name: "Remove all labels" }));
            await user.click(screen.getByRole("menuitem", { name: "Apply" }));

            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/messages/m1",
                expect.objectContaining({ body: JSON.stringify({ uid: "m1", version: 0, labelUids: [] }) }),
            );
        });

        it("throws the draft away when the menu is dismissed instead of applied", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, messageFixture()));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} labels={labels} />);

            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("menuitemcheckbox", { name: "Important" }));
            await user.keyboard("{Escape}");
            await user.click(screen.getByRole("button", { name: "Labels" }));

            expect(screen.getByRole("menuitemcheckbox", { name: "Important" })).toHaveAttribute("aria-checked", "false");
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("shows an error message when saving labels fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} labels={labels} />);

            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("menuitemcheckbox", { name: "Important" }));
            await user.click(screen.getByRole("menuitem", { name: "Apply" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
        });

        it("shows a generic error message when saving labels fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} labels={labels} />);

            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("menuitemcheckbox", { name: "Important" }));
            await user.click(screen.getByRole("menuitem", { name: "Apply" }));

            expect(await screen.findByText("Could not update this message's labels.")).toBeInTheDocument();
        });

        it("builds a follow-up save on the previous save's server response even when the caller never patches the message", async () => {
            let call = 0;
            const fetchMock = mockFetch(() => {
                call += 1;
                return jsonResponse(200, messageFixture({ version: call, labelUids: call === 1 ? ["l1"] : ["l1", "l2"] }));
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} labels={labels} />);

            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("menuitemcheckbox", { name: "Important" }));
            await user.click(screen.getByRole("menuitem", { name: "Apply" }));
            await screen.findByText("Important");

            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("menuitemcheckbox", { name: "Later" }));
            await user.click(screen.getByRole("menuitem", { name: "Apply" }));

            // The second save carries the version the first one came back with, and both labels.
            expect(fetchMock.mock.calls[1][1].body).toBe(JSON.stringify({ uid: "m1", version: 1, labelUids: ["l1", "l2"] }));
        });

        it("prefers a newer message copy from the caller over the menu's own last-saved copy", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, messageFixture({ version: 1, labelUids: ["l1"] })));
            const user = userEvent.setup();
            const { rerender } = render(
                <MessageDetailPane message={messageFixture() as any} attachments={[]} labels={labels} />,
            );

            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("menuitemcheckbox", { name: "Important" }));
            await user.click(screen.getByRole("menuitem", { name: "Apply" }));
            await screen.findByText("Important");

            rerender(
                <MessageDetailPane
                    message={messageFixture({ version: 5, labelUids: ["l2"] })}
                    attachments={[]}
                    labels={labels}
                />,
            );
            await user.click(screen.getByRole("button", { name: "Labels" }));
            await user.click(screen.getByRole("menuitemcheckbox", { name: "Important" }));
            await user.click(screen.getByRole("menuitem", { name: "Apply" }));

            expect(fetchMock.mock.calls[1][1].body).toBe(JSON.stringify({ uid: "m1", version: 5, labelUids: ["l2", "l1"] }));
        });
    });

    describe("reply/forward", () => {
        it("Reply opens Compose prefilled with the sender (name and address), a 'Re:' subject, and the quoted full body above an empty first line", async () => {
            const longBody = `<p>${"All the words of a long message. ".repeat(40)}</p><p>The very end.</p>`;
            mockComposeDraft((url) =>
                url === "/api/mail/messages/m1/content" ? new Response(longBody, { headers: { "content-type": "text/html; charset=utf-8" } }) : undefined,
            );
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply" }));

            expect(await screen.findByRole("dialog", { name: "Re: Hello there" })).toBeInTheDocument();
            expect(recipientChips("To")).toEqual(["Sender One <sender@example.com>"]);
            const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
            expect(body.value.startsWith("<p></p><p>On ")).toBe(true);
            expect(body.value).toContain("Sender One &lt;sender@example.com&gt; wrote:");
            expect(body.value).toContain(`${longBody}</blockquote>`);
            expect(body).toHaveAttribute("data-autofocus-start", "true");
        });

        it("disables Reply, Reply All and Forward while the body to quote is loading", async () => {
            let resolveContent: ((response: Response) => void) | undefined;
            mockComposeDraft((url) =>
                url === "/api/mail/messages/m1/content" ? new Promise<Response>((resolve) => (resolveContent = resolve)) : undefined,
            );
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Forward" }));
            await waitFor(() => expect(resolveContent).toBeDefined());
            for (const name of ["Reply", "Reply All", "Forward"]) {
                expect(screen.getByRole("button", { name })).toBeDisabled();
            }
            resolveContent!(new Response("<p>Body</p>", { headers: { "content-type": "text/html" } }));

            expect(await screen.findByRole("dialog", { name: "Fwd: Hello there" })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Reply" })).not.toBeDisabled();
        });

        it("quotes the text part of the raw message in full when the server has no HTML body (its /content is just the preview)", async () => {
            const fullText = `${"A long plain-text line. ".repeat(30)}\n\nSecond paragraph <not a tag>.`;
            const raw = `Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${fullText}\r\n--b--\r\n`;
            const fetchMock = mockComposeDraft((url) => {
                if (url === "/api/mail/messages/m1/content") return new Response("A long plain", { headers: { "content-type": "text/plain" } });
                if (url === "/api/mail/messages/m1/raw") return new Response(raw);
                return undefined;
            });
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture({ bodyPreview: "A long plain" }) as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply" }));

            const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
            expect(body.value).toContain(`<p>${"A long plain-text line. ".repeat(30)}</p><p>&nbsp;</p><p>Second paragraph &lt;not a tag&gt;.</p>`);
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1/raw", expect.anything());
        });

        it("sanitizes the quoted HTML body, dropping scripts and remote images", async () => {
            mockComposeDraft((url) =>
                url === "/api/mail/messages/m1/content"
                    ? new Response('<p onclick="x()">Hello</p><script>evil()</script><img src="https://tracker.example/p.gif">', {
                          headers: { "content-type": "text/html" },
                      })
                    : undefined,
            );
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply" }));

            const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
            expect(body.value).toContain("<p>Hello</p></blockquote>");
            expect(body.value).not.toMatch(/script|onclick|tracker\.example/);
        });

        it("falls back to the body preview when the body can't be loaded", async () => {
            mockComposeDraft();
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply" }));

            const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
            expect(body.value).toContain("<p>Hi there, just checking in.</p></blockquote>");
        });

        it("falls back to the preview when the raw message has no text part either", async () => {
            mockComposeDraft((url) => {
                if (url === "/api/mail/messages/m1/content") return new Response("Preview", { headers: { "content-type": "text/plain" } });
                if (url === "/api/mail/messages/m1/raw") return new Response("Content-Type: image/png\r\n\r\nPNG");
                return undefined;
            });
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture({ bodyPreview: "Preview" }) as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Forward" }));

            const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
            expect(body.value).toContain("<p>Preview</p></blockquote>");
        });

        it("quotes the raw message's HTML part when /content isn't HTML", async () => {
            const raw = 'Content-Type: text/html; charset=utf-8\r\n\r\n<p>Raw <b>html</b></p>';
            mockComposeDraft((url) => {
                if (url === "/api/mail/messages/m1/content") return jsonResponse(404, { message: "gone" });
                if (url === "/api/mail/messages/m1/raw") return new Response(raw);
                return undefined;
            });
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply" }));

            const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
            expect(body.value).toContain("<p>Raw <b>html</b></p></blockquote>");
        });

        describe("replying to signed or encrypted mail", () => {
            function mockSecureCompose(extra?: (url: string) => Response | undefined) {
                return mockComposeDraft((url) => extra?.(url) ?? (url.endsWith("/raw") ? new Response("raw mime") : undefined));
            }

            it("quotes the decrypted content the pane shows, never fetching the server body, and starts the reply encrypted", async () => {
                getUnlockedKeys.mockReturnValue({ encryptionPrivateKey: {} as any, encryptionCertDer: new Uint8Array() });
                evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", html: "<p>Decrypted secret</p><script>evil()</script>" });
                const fetchMock = mockSecureCompose();
                const user = userEvent.setup();
                render(
                    <ComposeProvider>
                        <MessageDetailPane message={messageFixture({ encrypted: true, bodyPreview: "" }) as any} attachments={[]} />
                    </ComposeProvider>,
                );
                await screen.findByText("Encrypted");

                await user.click(screen.getByRole("button", { name: "Reply" }));

                const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
                expect(body.value).toContain("<p>Decrypted secret</p></blockquote>");
                expect(body.value).not.toContain("script");
                expect(screen.getByRole("checkbox", { name: "Encrypt this message" })).toBeChecked();
                expect(fetchMock).not.toHaveBeenCalledWith("/api/mail/messages/m1/content", expect.anything());
            });

            it("quotes a recovered plain-text body as escaped text", async () => {
                evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<pre>x</pre>", text: "Signed <b>text</b>" });
                mockSecureCompose();
                const user = userEvent.setup();
                render(
                    <ComposeProvider>
                        <MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={[]} />
                    </ComposeProvider>,
                );
                await screen.findByText("Signed & verified");

                await user.click(screen.getByRole("button", { name: "Reply" }));

                const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
                expect(body.value).toContain("<p>Signed &lt;b&gt;text&lt;/b&gt;</p></blockquote>");
                expect(screen.queryByRole("checkbox", { name: "Encrypt this message" })).not.toBeInTheDocument();
            });

            it("quotes no ciphertext for an encrypted message this device couldn't open, and still starts the forward encrypted", async () => {
                getUnlockedKeys.mockReturnValue({ encryptionPrivateKey: {} as any, encryptionCertDer: new Uint8Array() });
                evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "No key." });
                const fetchMock = mockSecureCompose();
                const user = userEvent.setup();
                render(
                    <ComposeProvider>
                        <MessageDetailPane message={messageFixture({ encrypted: true, bodyPreview: "" }) as any} attachments={[]} />
                    </ComposeProvider>,
                );
                await screen.findByText("No key.");

                await user.click(screen.getByRole("button", { name: "Forward" }));

                const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
                expect(body.value).toMatch(/<blockquote[^>]*><p>&nbsp;<\/p><\/blockquote>$/);
                expect(screen.getByRole("checkbox", { name: "Encrypt this message" })).toBeChecked();
                expect(fetchMock.mock.calls.filter(([url]) => url === "/api/mail/messages/m1/content" || url === "/api/mail/messages/m1/raw")).toHaveLength(1);
            });
        });

        describe("recipients", () => {
            const readerMailbox = { uid: "mb1", keys: [], primarySmtpAddress: "me@example.com", aliasAddresses: ["Alias@Example.com"] };

            async function replyWith(button: "Reply" | "Reply All", message: Record<string, unknown>, extra?: (url: string) => Response | undefined) {
                const fetchMock = mockComposeDraft(extra);
                const user = userEvent.setup();
                render(
                    <ComposeProvider>
                        <MessageDetailPane message={messageFixture(message) as any} attachments={[]} />
                    </ComposeProvider>,
                );
                await user.click(screen.getByRole("button", { name: button }));
                await screen.findByRole("dialog", { name: "Re: Hello there" });
                return fetchMock;
            }

            function ccChips(): (string | null)[] {
                return screen.queryByRole("list", { name: "Cc recipients" }) ? recipientChips("Cc") : [];
            }

            it("Reply All leaves the mailbox's own address and aliases out of To and Cc, and repeats nobody", async () => {
                mailShellOverride.current = { mailboxes: [readerMailbox], mailboxFolders: [] };
                await replyWith("Reply All", {
                    recipients: [
                        { address: "ME@example.com", displayName: "Me", type: "to" },
                        { address: "bob@example.com", displayName: "Bob, Jr.", type: "to" },
                        { address: "alias@example.com", type: "cc" },
                        { address: "Bob@example.com", type: "cc" },
                        { address: "carol@example.com", displayName: "Carol", type: "cc" },
                        { address: "hidden@example.com", type: "bcc" },
                    ],
                });

                expect(recipientChips("To")).toEqual(["Sender One <sender@example.com>", '"Bob, Jr." <bob@example.com>']);
                expect(ccChips()).toEqual(["Carol <carol@example.com>"]);
            });

            it("Reply All to a message the mailbox sent goes to the original recipients, not back to the mailbox", async () => {
                mailShellOverride.current = { mailboxes: [readerMailbox], mailboxFolders: [] };
                await replyWith("Reply All", {
                    from: { address: "me@example.com", displayName: "Me", type: "to" },
                    recipients: [
                        { address: "bob@example.com", type: "to" },
                        { address: "carol@example.com", type: "cc" },
                        { address: "alias@example.com", type: "cc" },
                        { address: "hidden@example.com", type: "bcc" },
                    ],
                });

                expect(recipientChips("To")).toEqual(["bob@example.com"]);
                expect(ccChips()).toEqual(["carol@example.com"]);
            });

            it("Reply to a message the mailbox sent goes to its original To recipient", async () => {
                mailShellOverride.current = { mailboxes: [readerMailbox], mailboxFolders: [] };
                await replyWith("Reply", {
                    from: { address: "alias@example.com", type: "to" },
                    recipients: [
                        { address: "bob@example.com", displayName: "Bob", type: "to" },
                        { address: "carol@example.com", type: "cc" },
                    ],
                });

                expect(recipientChips("To")).toEqual(["Bob <bob@example.com>"]);
                expect(ccChips()).toEqual([]);
            });

            it("looks the mailbox up for its addresses when the mail shell hasn't listed it", async () => {
                const fetchMock = await replyWith(
                    "Reply All",
                    { recipients: [{ address: "me@example.com", type: "to" }, { address: "carol@example.com", type: "cc" }] },
                    (url) => (url === "/api/mail/mailboxes/mb1" ? jsonResponse(200, { ...readerMailbox, aliasAddresses: undefined }) : undefined),
                );

                expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1", expect.anything());
                expect(recipientChips("To")).toEqual(["Sender One <sender@example.com>"]);
                expect(ccChips()).toEqual(["carol@example.com"]);
            });

            // A delivered message's own `recipients` hold only the envelope recipient this mailbox received at
            // (restapi's ScanQueueJob), so Reply All recovers the rest from the message's own To/Cc headers.
            it("Reply All recovers the original To and Cc from the message's headers", async () => {
                mailShellOverride.current = { mailboxes: [readerMailbox], mailboxFolders: [] };
                const raw = [
                    "From: Bob Allen <bob@partner.test>",
                    'To: "Diaz, Dave" <dave@partner.test>, me@example.com',
                    "Cc: Carol Cruz <carol@partner.test>, Alias <alias@example.com>",
                    "Content-Type: text/html; charset=utf-8",
                    "",
                    "<p>Body</p>",
                    "",
                ].join("\r\n");
                await replyWith(
                    "Reply All",
                    {
                        from: { address: "bob@partner.test", displayName: '"Bob Allen" <bob@partner.test>', type: "to" },
                        recipients: [{ address: "me@example.com", type: "to" }],
                    },
                    (url) => (url === "/api/mail/messages/m1/raw" ? new Response(raw) : undefined),
                );

                expect(recipientChips("To")).toEqual(["Bob Allen <bob@partner.test>", '"Diaz, Dave" <dave@partner.test>']);
                expect(ccChips()).toEqual(["Carol Cruz <carol@partner.test>"]);
            });

            it("keeps the message's own recipients when its headers can't be read", async () => {
                mailShellOverride.current = { mailboxes: [readerMailbox], mailboxFolders: [] };
                await replyWith("Reply All", {
                    recipients: [
                        { address: "me@example.com", type: "to" },
                        { address: "dave@partner.test", type: "to" },
                    ],
                });

                expect(recipientChips("To")).toEqual(["Sender One <sender@example.com>", "dave@partner.test"]);
            });

            it("doesn't read the raw message for a plain Reply", async () => {
                mailShellOverride.current = { mailboxes: [readerMailbox], mailboxFolders: [] };
                const fetchMock = await replyWith("Reply", { recipients: [{ address: "me@example.com", type: "to" }] }, (url) =>
                    url === "/api/mail/messages/m1/content" ? new Response("<p>Body</p>", { headers: { "content-type": "text/html" } }) : undefined,
                );

                expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain("/api/mail/messages/m1/raw");
                expect(recipientChips("To")).toEqual(["Sender One <sender@example.com>"]);
            });
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

        describe("round 5: an Outbox message with no active schedule (a failed or refused scheduled send)", () => {
            it("offers Move to Drafts, which moves it back to Drafts", async () => {
                const updated = messageFixture({ folderUid: "f-drafts" });
                const fetchMock = mockFetch(() => jsonResponse(200, updated));
                const onScheduledSendCanceled = vi.fn();
                const user = userEvent.setup();
                render(
                    <MessageDetailPane
                        message={messageFixture({ scheduledSendTime: null }) as any}
                        attachments={[]}
                        isOutbox
                        draftsFolderUid="f-drafts"
                        onScheduledSendCanceled={onScheduledSendCanceled}
                    />,
                );
                expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
                expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();

                await user.click(screen.getByRole("button", { name: "Move to Drafts" }));

                expect(fetchMock).toHaveBeenCalledWith(
                    "/api/mail/messages/m1",
                    expect.objectContaining({ method: "PUT", body: JSON.stringify({ uid: "m1", version: 0, scheduledSendTime: null, folderUid: "f-drafts" }) }),
                );
                await vi.waitFor(() => expect(onScheduledSendCanceled).toHaveBeenCalledWith(updated));
            });

            it("doesn't offer Move to Drafts outside Outbox, while scheduled, or without a Drafts folder", () => {
                const { rerender } = render(<MessageDetailPane message={messageFixture() as any} attachments={[]} draftsFolderUid="f-drafts" />);
                expect(screen.queryByRole("button", { name: "Move to Drafts" })).not.toBeInTheDocument();
                rerender(
                    <MessageDetailPane
                        message={messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" })}
                        attachments={[]}
                        isOutbox
                        draftsFolderUid="f-drafts"
                    />,
                );
                expect(screen.queryByRole("button", { name: "Move to Drafts" })).not.toBeInTheDocument();
                rerender(<MessageDetailPane message={messageFixture()} attachments={[]} isOutbox />);
                expect(screen.queryByRole("button", { name: "Move to Drafts" })).not.toBeInTheDocument();
            });

            it("shows a move-specific message when moving fails with a non-API error", async () => {
                mockFetch(() => {
                    throw new TypeError("network down");
                });
                const user = userEvent.setup();
                render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isOutbox draftsFolderUid="f-drafts" />);

                await user.click(screen.getByRole("button", { name: "Move to Drafts" }));

                expect(await screen.findByText("Could not move this message to Drafts.")).toBeInTheDocument();
            });
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
        // Only a message the server flags `encrypted` (or one carrying attachments - where a detached/opaque
        // S/MIME signature part surfaces) has its raw MIME fetched and evaluated at all.
        function secureFixture(overrides: Record<string, unknown> = {}) {
            return messageFixture({ encrypted: true, ...overrides });
        }

        function mockRawContent(raw = "raw mime text") {
            return mockFetch((url) => (url.endsWith("/raw") ? new Response(raw) : jsonResponse(200, {})));
        }

        describe("not addressed to the reader (round 4)", () => {
            const readerMailbox = { uid: "mb1", keys: [], primarySmtpAddress: "me@example.com", aliasAddresses: ["alias1@example.com", "alias2@example.com"] };

            it("passes the viewing mailbox's address and says so when the protected recipients don't include any of its addresses", async () => {
                mailShellOverride.current = { mailboxes: [readerMailbox], mailboxFolders: [] };
                const unlocked = { masterKey: new Uint8Array(32) };
                getUnlockedKeys.mockReturnValue(unlocked);
                evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<p>Hi</p>", notAddressedToReader: true });
                mockRawContent("signed mime");
                render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={[]} />);

                expect(await screen.findByText(/don.t include this mailbox/)).toBeInTheDocument();
                expect(evaluateMessageSecurity.mock.calls.map((call) => call[3])).toEqual(["me@example.com", "alias1@example.com", "alias2@example.com"]);
                expect(evaluateMessageSecurity).toHaveBeenCalledWith("signed mime", unlocked, undefined, "me@example.com");
            });

            it("shows nothing once one of the mailbox's aliases is among the recipients, without trying the rest", async () => {
                mailShellOverride.current = { mailboxes: [readerMailbox], mailboxFolders: [] };
                evaluateMessageSecurity.mockImplementation(async (_raw: string, _keys: unknown, _pin: unknown, reader: string) => ({
                    state: "signed_verified",
                    html: "<p>Hi</p>",
                    notAddressedToReader: reader !== "alias1@example.com",
                }));
                mockRawContent();
                render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={[]} />);

                expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
                await waitFor(() => expect(evaluateMessageSecurity).toHaveBeenCalledTimes(2));
                expect(screen.queryByText(/don.t include this mailbox/)).not.toBeInTheDocument();
            });

            it("checks just the primary address of a mailbox listed without aliases", async () => {
                mailShellOverride.current = { mailboxes: [{ uid: "mb1", keys: [], primarySmtpAddress: "me@example.com" }], mailboxFolders: [] };
                evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<p>Hi</p>", notAddressedToReader: false });
                mockRawContent();
                render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={[]} />);

                expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
                expect(evaluateMessageSecurity).toHaveBeenCalledTimes(1);
                expect(screen.queryByText(/don.t include this mailbox/)).not.toBeInTheDocument();
            });
        });

        it("shows no indicator until evaluateMessageSecurity resolves", async () => {
            let resolveSecurity: ((result: { state: string }) => void) | undefined;
            evaluateMessageSecurity.mockImplementation(() => new Promise((resolve) => (resolveSecurity = resolve)));
            mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await waitFor(() => expect(resolveSecurity).toBeDefined());
            expect(screen.queryByText("Unprotected")).not.toBeInTheDocument();

            resolveSecurity!({ state: "unprotected" });
            expect(await screen.findByText("Unprotected")).toBeInTheDocument();
        });

        it("never fetches the raw content of a message that is neither encrypted nor carries attachments", async () => {
            const fetchMock = mockRawContent();
            render(<MessageDetailPane message={messageFixture({ encrypted: false }) as any} attachments={[]} />);

            expect(await screen.findByText("Unprotected")).toBeInTheDocument();
            expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/raw"))).toBe(false);
            expect(evaluateMessageSecurity).not.toHaveBeenCalled();
        });

        it("fetches and evaluates the raw content of an unencrypted message with attachments (a possible S/MIME signature)", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<p>Signed</p>" });
            const fetchMock = mockRawContent("signed mime");
            render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={[]} />);

            expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1/raw", expect.anything());
            expect(evaluateMessageSecurity).toHaveBeenCalledWith("signed mime", undefined, undefined, undefined);
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
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            expect(await screen.findByText(label)).toBeInTheDocument();
        });

        it("renders the decrypted, sanitized body via srcDoc behind a no-remote-loads CSP instead of the server's /content URL", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>Secret</p><script>evil()</script>" });
            mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await screen.findByText("Encrypted & verified");
            const iframe = screen.getByTitle("Hello there");
            expect(iframe).not.toHaveAttribute("src");
            const srcdoc = iframe.getAttribute("srcdoc")!;
            expect(srcdoc.startsWith(
                "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'\">",
            )).toBe(true);
            expect(srcdoc).toContain("<p>Secret</p>");
            expect(srcdoc).not.toContain("<script>");
        });

        it("renders a plain-text body as escaped text in a <pre>, not as HTML", async () => {
            evaluateMessageSecurity.mockResolvedValue({
                state: "signed_verified",
                html: "<pre>&lt;b&gt;hi&lt;/b&gt;</pre>",
                text: "<b>hi</b>\nsecond line",
            });
            mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await screen.findByText("Signed & verified");
            const body = screen.getByLabelText("Hello there");
            expect(body.tagName).toBe("PRE");
            expect(body.textContent).toBe("<b>hi</b>\nsecond line");
            expect(body.querySelector("b")).toBeNull();
            expect(screen.queryByTitle("Hello there")).not.toBeInTheDocument();
        });

        it("falls back to 'Message content' as the plain-text body's label when there is no subject", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", html: "<pre>x</pre>", text: "x" });
            mockRawContent();
            render(<MessageDetailPane message={secureFixture({ subject: "" }) as any} attachments={[]} />);

            expect((await screen.findByLabelText("Message content")).tagName).toBe("PRE");
        });

        describe("client-rendered body sanitization", () => {
            async function renderSrcDoc(html: string): Promise<string> {
                evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html });
                mockRawContent();
                const { unmount } = render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);
                await screen.findByText("Encrypted & verified");
                const srcdoc = screen.getByTitle("Hello there").getAttribute("srcdoc")!;
                unmount();
                return srcdoc;
            }

            it("strips remote and protocol-relative image sources but keeps data: and cid: ones", async () => {
                const srcdoc = await renderSrcDoc(
                    '<img id="a" src="https://tracker.example/p.gif"><img id="b" src="//tracker.example/p.gif">' +
                        '<img id="c" src="data:image/png;base64,AAAA"><img id="d" src="cid:logo@x">',
                );
                expect(srcdoc).not.toContain("tracker.example");
                expect(srcdoc).toContain('src="data:image/png;base64,AAAA"');
                expect(srcdoc).toContain('src="cid:logo@x"');
            });

            it("drops a srcset unless every candidate is embedded", async () => {
                const srcdoc = await renderSrcDoc(
                    '<img srcset="data:image/png;base64,AAAA 1x, https://tracker.example/2x.png 2x">' +
                        '<img srcset="cid:lo@x 1x, cid:hi@x 2x">',
                );
                expect(srcdoc).not.toContain("tracker.example");
                expect(srcdoc).toContain('srcset="cid:lo@x 1x, cid:hi@x 2x"');
            });

            it("strips remote background/poster attributes and non-link hrefs, but keeps ordinary link hrefs", async () => {
                const srcdoc = await renderSrcDoc(
                    '<table background="https://tracker.example/bg.png"><tr><td>x</td></tr></table>' +
                        '<video poster="https://tracker.example/poster.png"></video>' +
                        '<svg><feImage href="https://tracker.example/fe.png"></feImage></svg>' +
                        '<a href="https://example.com/page">link</a>',
                );
                expect(srcdoc).not.toContain("tracker.example");
                expect(srcdoc).toContain('href="https://example.com/page"');
            });

            it("removes <link> and <meta> elements from the body", async () => {
                const srcdoc = await renderSrcDoc(
                    '<p>x</p><link rel="stylesheet" href="https://tracker.example/s.css"><meta http-equiv="refresh" content="0;url=https://tracker.example/">',
                );
                expect(srcdoc).not.toContain("tracker.example");
                // Only the CSP meta this component itself prepends survives.
                expect(srcdoc.match(/<meta/g)).toHaveLength(1);
            });

            it("neutralizes remote url()s in style attributes while keeping embedded ones", async () => {
                const srcdoc = await renderSrcDoc(
                    '<div style="background: url(\'https://tracker.example/a.png\'); color: red">a</div>' +
                        '<div style="background-image: url(data:image/png;base64,AAAA)">b</div>',
                );
                expect(srcdoc).not.toContain("tracker.example");
                expect(srcdoc).toContain("color: red");
                expect(srcdoc).toContain("url(data:image/png;base64,AAAA)");
            });

            it("strips @import and remote/escaped url()s and image-set() strings from <style> elements", async () => {
                const srcdoc = await renderSrcDoc(
                    "<p>x</p><style>@import 'https://tracker.example/i.css'; " +
                        ".a { background: \\75 rl(https://tracker.example/esc.png) } " +
                        ".b { background: u\\rl(\"https://tracker.example/esc2.png\") } " +
                        ".c { background-image: image-set(\"https://tracker.example/set.png\" 1x) } " +
                        ".d { background-image: -webkit-image-set(\"data:image/png;base64,AAAA\" 1x) } " +
                        ".e { color: blue }</style>",
                );
                expect(srcdoc).not.toContain("tracker.example");
                expect(srcdoc).toContain('-webkit-image-set("data:image/png;base64,AAAA" 1x)');
                expect(srcdoc).toContain("color: blue");
            });
        });

        it("keeps using the server's /content URL when there is no decrypted html", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "unprotected" });
            mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await screen.findByText("Unprotected");
            const iframe = screen.getByTitle("Hello there");
            expect(iframe).toHaveAttribute("src", "/api/mail/messages/m1/content");
            expect(iframe).not.toHaveAttribute("srcdoc");
        });

        it("shows a decryptError alongside the indicator, still using the server's /content URL", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            expect(await screen.findByText("This device doesn't have the key needed.")).toBeInTheDocument();
            expect(screen.getByText("Encrypted")).toBeInTheDocument();
            expect(screen.getByTitle("Hello there")).toHaveAttribute("src", "/api/mail/messages/m1/content");
        });

        describe("signature failures", () => {
            it.each([
                ["invalid_signature", /digital signature couldn't be verified - it may be malformed/],
                ["untrusted_signer", /doesn't match the sender's known key/],
                ["signer_identity_mismatch", /doesn't belong to the sender shown in From/],
                ["header_mismatch", /don't match its visible From\/To, or it repeats a From, To, Cc or Sender header/],
            ] as const)("explains a %s failure as unverified while keeping the body visible", async (reason, text) => {
                evaluateMessageSecurity.mockResolvedValue({ state: "signature_failed", signatureFailureReason: reason });
                mockRawContent();
                render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={[]} />);

                expect(await screen.findByText("Signature failed")).toBeInTheDocument();
                const notice = screen.getByRole("status");
                expect(notice).toHaveTextContent(text);
                expect(notice).toHaveTextContent("Treat it as unverified.");
                expect(screen.queryByRole("alert")).not.toBeInTheDocument();
                expect(screen.getByTitle("Hello there")).toHaveAttribute("src", "/api/mail/messages/m1/content");
            });

            it("shows a generic unverified notice when no failure reason is given", async () => {
                evaluateMessageSecurity.mockResolvedValue({ state: "signature_failed" });
                mockRawContent();
                render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

                expect(await screen.findByRole("status")).toHaveTextContent(
                    "This message's digital signature couldn't be verified. Treat it as unverified.",
                );
            });

            it("renders the recovered plaintext of a decrypted message whose signature failed", async () => {
                evaluateMessageSecurity.mockResolvedValue({
                    state: "signature_failed",
                    signatureFailureReason: "signer_identity_mismatch",
                    html: "<p>Still readable</p>",
                });
                mockRawContent();
                render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

                await screen.findByRole("status");
                expect(screen.getByTitle("Hello there").getAttribute("srcdoc")).toContain("<p>Still readable</p>");
            });

            it("shows no signature notice for a non-failed state", async () => {
                // Protected headers present, so round 6's "Subject/To/Cc weren't signed" note doesn't apply either.
                evaluateMessageSecurity.mockResolvedValue({
                    state: "signed_verified",
                    html: "<p>ok</p>",
                    protectedHeaders: { from: "sender@example.com", to: "u1@example.com", subject: "Hello there" },
                });
                mockRawContent();
                render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

                await screen.findByText("Signed & verified");
                expect(screen.queryByRole("status")).not.toBeInTheDocument();
            });
        });

        it("offers to unlock when a decryptError means this device has no unlocked session at all, and re-evaluates once unlocked", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            evaluateMessageSecurity.mockResolvedValueOnce({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            requestUnlock.mockImplementation(async () => {
                getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            });
            mockRawContent();
            const user = userEvent.setup();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);
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
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await user.click(await screen.findByText("Unlock to view this message"));

            expect(requestUnlock).toHaveBeenCalledWith("mb1", keys);
        });

        it("does not offer to unlock when a decryptError comes from an already-unlocked session (wrong/rotated key)", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await screen.findByText("This device doesn't have the key needed.");
            expect(screen.queryByText("Unlock to view this message")).not.toBeInTheDocument();
        });

        describe("key session lock", () => {
            it("clears the decrypted body the moment this mailbox's keys are locked, then re-evaluates", async () => {
                evaluateMessageSecurity.mockResolvedValueOnce({ state: "encrypted_verified", html: "<p>Secret</p>" });
                const fetchMock = mockRawContent();
                render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);
                await screen.findByText("Encrypted & verified");

                let resolveNext: ((result: { state: string; decryptError?: string }) => void) | undefined;
                evaluateMessageSecurity.mockImplementation(() => new Promise((resolve) => (resolveNext = resolve)));
                emitKeySession({ mailboxUid: "mb1", state: "locked" });

                // Cleared synchronously - no decrypted content remains while re-evaluation is in flight.
                expect(screen.getByTitle("Hello there")).toHaveAttribute("src", "/api/mail/messages/m1/content");
                expect(screen.queryByText("Encrypted & verified")).not.toBeInTheDocument();
                expect(document.body.innerHTML).not.toContain("Secret");

                await waitFor(() => expect(resolveNext).toBeDefined());
                expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/raw"))).toHaveLength(2);
                resolveNext!({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
                expect(await screen.findByText("This device doesn't have the key needed.")).toBeInTheDocument();
            });

            it("clears a decrypted plain-text body on lock too", async () => {
                evaluateMessageSecurity.mockResolvedValueOnce({ state: "encrypted", html: "<pre>Secret text</pre>", text: "Secret text" });
                mockRawContent();
                render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);
                await screen.findByText("Secret text");

                evaluateMessageSecurity.mockImplementation(() => new Promise(() => undefined));
                emitKeySession({ mailboxUid: "mb1", state: "locked" });

                expect(screen.queryByText("Secret text")).not.toBeInTheDocument();
            });

            it("ignores a lock for a different mailbox and an unlock event for this one", async () => {
                evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>Secret</p>" });
                const fetchMock = mockRawContent();
                render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);
                await screen.findByText("Encrypted & verified");

                emitKeySession({ mailboxUid: "mb-other", state: "locked" });
                emitKeySession({ mailboxUid: "mb1", state: "unlocked" });

                expect(screen.getByText("Encrypted & verified")).toBeInTheDocument();
                expect(screen.getByTitle("Hello there").getAttribute("srcdoc")).toContain("Secret");
                expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/raw"))).toHaveLength(1);
            });

            it("unsubscribes from the key session on unmount", async () => {
                evaluateMessageSecurity.mockResolvedValue({ state: "unprotected" });
                mockRawContent();
                const { unmount } = render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);
                await screen.findByText("Unprotected");
                // pinnedSigners.ts also holds one module-wide subscription (made on first use, never removed).
                const mounted = keySessionListeners.size;
                expect(mounted).toBeGreaterThanOrEqual(1);

                unmount();
                expect(keySessionListeners.size).toBe(mounted - 1);
            });
        });

        // RFC 9788's own "MUST visually distinguish" requirement for a message whose outer envelope
        // disagrees with what was actually signed/encrypted (HP-Outer tamper detection) - deliberately a
        // separate banner from the 5-state SecurityIndicator badge above, not a 6th state, since this can
        // co-occur with any of the encrypted/encrypted_verified/signature_failed states.
        it("shows a header-tamper warning banner when headerTamperDetected is true", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>hi</p>", headerTamperDetected: true });
            mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await screen.findByText("Encrypted & verified");
            expect(screen.getByText(/don't match what the sender actually signed or encrypted/)).toBeInTheDocument();
        });

        it("shows no header-tamper banner when headerTamperDetected is false", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>hi</p>", headerTamperDetected: false });
            mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await screen.findByText("Encrypted & verified");
            expect(screen.queryByText(/don't match what the sender actually signed or encrypted/)).not.toBeInTheDocument();
        });

        it("shows no header-tamper banner when headerTamperDetected is undefined (nothing to compare)", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", html: "<p>hi</p>" });
            mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await screen.findByText("Encrypted");
            expect(screen.queryByText(/don't match what the sender actually signed or encrypted/)).not.toBeInTheDocument();
        });

        it("degrades an unencrypted message to unprotected, with no error shown, when fetching the raw content fails", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={[]} />);

            expect(await screen.findByText("Unprotected")).toBeInTheDocument();
            expect(evaluateMessageSecurity).not.toHaveBeenCalled();
            expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        });

        it("keeps a server-flagged encrypted message labeled Encrypted, with an explanation, when fetching its raw content fails", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            mockFetch(() => {
                throw new TypeError("network down");
            });
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            expect(await screen.findByText("Couldn't load this message's encrypted content.")).toBeInTheDocument();
            expect(screen.getByText("Encrypted")).toBeInTheDocument();
            expect(screen.queryByText("Unprotected")).not.toBeInTheDocument();
        });

        it("does not update state after unmounting before evaluateMessageSecurity settles", async () => {
            let resolveSecurity: ((result: { state: string }) => void) | undefined;
            evaluateMessageSecurity.mockImplementation(() => new Promise((resolve) => (resolveSecurity = resolve)));
            mockRawContent();
            const { unmount } = render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await waitFor(() => expect(resolveSecurity).toBeDefined());
            unmount();
            resolveSecurity!({ state: "unprotected" });
            // No assertion beyond "this doesn't throw/warn" - see KeyEnrollmentGate.test.tsx's identical
            // pattern for why: a regression here surfaces as a React console.error, not a thrown exception.
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        it("never evaluates a raw-content response that arrives after the message was switched away from", async () => {
            let resolveRaw: ((response: Response) => void) | undefined;
            mockFetch((url) =>
                url === "/api/mail/messages/m1/raw" ? new Promise<Response>((resolve) => (resolveRaw = resolve)) : jsonResponse(200, {}),
            );
            const { unmount } = render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await waitFor(() => expect(resolveRaw).toBeDefined());
            unmount();
            resolveRaw!(new Response("late raw mime"));
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(evaluateMessageSecurity).not.toHaveBeenCalled();
        });

        it("does not update state after unmounting before a failed raw-content fetch settles", async () => {
            let rejectFetch: ((err: Error) => void) | undefined;
            mockFetch(() => new Promise((_resolve, reject) => (rejectFetch = reject)));
            const { unmount } = render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await waitFor(() => expect(rejectFetch).toBeDefined());
            unmount();
            rejectFetch!(new Error("network error"));
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        it("falls back to 'Message content' as the iframe title when a decrypted message has no subject", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>Secret</p>" });
            mockRawContent();
            render(<MessageDetailPane message={secureFixture({ subject: "" }) as any} attachments={[]} />);

            expect(await screen.findByTitle("Message content")).toHaveAttribute("srcdoc");
        });

        it("resets to no indicator when switching to a different message", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<p>Signed</p>" });
            mockRawContent();
            const { rerender } = render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);
            await screen.findByText("Signed & verified");

            let resolveNext: ((result: { state: string }) => void) | undefined;
            evaluateMessageSecurity.mockImplementation(() => new Promise((resolve) => (resolveNext = resolve)));
            rerender(<MessageDetailPane message={secureFixture({ uid: "m2", subject: "Other" })} attachments={[]} />);

            await waitFor(() => expect(resolveNext).toBeDefined());
            expect(screen.queryByText("Signed & verified")).not.toBeInTheDocument();
        });
    });

    describe("per-message state reset", () => {
        it("resets open modals and errors when the message uid changes in place", async () => {
            mockFetch(() => jsonResponse(500, { message: "archive boom" }));
            const user = userEvent.setup();
            const { rerender } = render(<MessageDetailPane message={messageFixture() as any} attachments={[]} isSentItems />);

            await user.click(screen.getByRole("button", { name: "Archive" }));
            expect(await screen.findByText("archive boom")).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Recall this message" }));
            expect(screen.getByRole("dialog", { name: "Recall this message?" })).toBeInTheDocument();

            rerender(<MessageDetailPane message={messageFixture({ uid: "m2", subject: "Other" })} attachments={[]} isSentItems />);

            expect(screen.queryByText("archive boom")).not.toBeInTheDocument();
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });

        it("keeps per-message state when the same message is re-rendered with an updated copy", async () => {
            mockFetch(() => jsonResponse(500, { message: "archive boom" }));
            const user = userEvent.setup();
            const { rerender } = render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

            await user.click(screen.getByRole("button", { name: "Archive" }));
            expect(await screen.findByText("archive boom")).toBeInTheDocument();

            rerender(<MessageDetailPane message={messageFixture({ version: 1, subject: "Renamed" })} attachments={[]} />);
            expect(screen.getByText("archive boom")).toBeInTheDocument();
        });
    });
});
