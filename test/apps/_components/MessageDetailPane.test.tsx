// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch as baseMockFetch } from "../testUtils.js";
import { mockFetchWithServerBody as mockFetch } from "./paneFetch.js";
import MessageDetailPane from "../../../apps/shared/components/mail/MessageDetailPane.js";
import { clearPinnedSignerCache } from "../../../apps/shared/components/mail/pinnedSigners.js";
import ComposeProvider from "../../../apps/shared/components/mail/compose/ComposeContext.js";
import { clearBodyContentCache } from "../../../apps/shared/components/mail/reading/bodyContent.js";
import { clearViewedOriginal } from "../../../apps/shared/components/mail/reading/viewOriginal.js";
import { FRAME_SANDBOX } from "../../../apps/shared/components/mail/reading/frameDocument.js";
import { dismissAll, getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { clearInviteCache } from "../../../apps/shared/components/mail/invite/inviteStore.js";

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
    default: ({ value, autoFocusStart, appendHtml }: { value: string; autoFocusStart?: boolean; appendHtml?: string }) => {
        // Like the real editor, only the value it mounts with counts (an empty one is the editor's own empty paragraph), and
        // `appendHtml` - the quote a reply opened without - is added once at the end.
        const [mountedAutoFocusStart] = React.useState(!!autoFocusStart);
        const [content, setContent] = React.useState(value || "<p></p>");
        React.useEffect(() => {
            if (appendHtml !== undefined) {
                setContent((current) => current + appendHtml);
            }
        }, [appendHtml]);
        return <textarea data-testid="html-editor" data-autofocus-start={String(mountedAutoFocusStart)} value={content} readOnly />;
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

/** Stubs fetch so the body the server would send for any message is `body` (HTML unless `type` says otherwise); anything else is `{}`. */
function mockServerBody(body = "<p>Server body</p>", type = "text/html; charset=utf-8") {
    return baseMockFetch((url) => (url.endsWith("/content") ? new Response(body, { headers: { "content-type": type } }) : jsonResponse(200, {})));
}

// Every test starts with a server that never answers: the pane shows its skeleton and nothing updates after a test that only looks at the card has
// ended. A test that cares about the body (or anything else the server says) stubs its own.
beforeEach(() => {
    baseMockFetch(() => new Promise<Response>(() => undefined));
});

afterEach(() => {
    clearBodyContentCache();
    clearViewedOriginal();
    vi.unstubAllGlobals();
    evaluateMessageSecurity.mockReset();
    getUnlockedKeys.mockReset();
    mailShellOverride.current = undefined;
    // A never-settling contacts fetch from one test must not hold up the next test's pin lookup.
    clearPinnedSignerCache();
    dismissAll();
    clearInviteCache();
});

describe("MessageDetailPane", () => {
    it("shows a placeholder and no back link when no message is given", () => {
        render(<MessageDetailPane message={null} attachments={[]} backHref="/messages/m1" />);
        expect(screen.getByText("Select a message to read it.")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: /Back to messages/ })).not.toBeInTheDocument();
    });

    it("renders the subject card and the message card at once, its body in an isolated frame once the server's sanitized content arrives, and no back link when backHref is absent", async () => {
        const fetchMock = mockServerBody();
        render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);

        // At once, before any body: the subject in a header card of its own, then the message's card with who it is from and to.
        expect(screen.getByRole("heading", { level: 1, name: "Hello there" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 1 }).closest("header")).not.toBeNull();
        expect(screen.getByText(/^From$/)).toHaveTextContent("From Sender One <sender@example.com>");
        expect(screen.getByText("To").parentElement).toHaveTextContent("To Me <u1@example.com>");
        expect(screen.getByRole("status")).toHaveTextContent("Loading the message");

        const frame = await screen.findByTitle("Hello there");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1/content", expect.objectContaining({ credentials: "include" }));
        // Isolated: a document of its own that can run no script, holding the sanitized content - not the server's URL.
        expect(frame).not.toHaveAttribute("src");
        expect(frame).toHaveAttribute("sandbox", FRAME_SANDBOX);
        expect(frame.getAttribute("srcdoc")).toContain("<p>Server body</p>");
        expect(screen.queryByRole("link", { name: /Back to messages/ })).not.toBeInTheDocument();
    });

    it("shows To, Cc and Bcc as separate lines, each recipient with name and address, and leaves out a line with nobody on it", () => {
        const message = messageFixture({
            recipients: [
                { address: "u1@example.com", displayName: "Me", type: "to" as const },
                { address: "amy@example.com", displayName: "Doe, Amy", type: "cc" as const },
                { address: "hidden@example.com", type: "bcc" as const },
            ],
        });
        const { unmount } = render(<MessageDetailPane message={message as any} attachments={[]} />);

        expect(screen.getByText("To").parentElement).toHaveTextContent("To Me <u1@example.com>");
        expect(screen.getByText("Cc").parentElement).toHaveTextContent('Cc "Doe, Amy" <amy@example.com>');
        expect(screen.getByText("Bcc").parentElement).toHaveTextContent("Bcc hidden@example.com");
        unmount();

        render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
        expect(screen.queryByText("Cc")).not.toBeInTheDocument();
        expect(screen.queryByText("Bcc")).not.toBeInTheDocument();
    });

    it("folds a long recipient list behind 'and N more' without hiding any address from the text", async () => {
        const recipients = Array.from({ length: 6 }, (_, i) => ({ address: `r${i}@example.com`, displayName: `Person ${i}`, type: "to" as const }));
        const user = userEvent.setup();
        render(<MessageDetailPane message={messageFixture({ recipients }) as any} attachments={[]} />);

        const line = screen.getByText("To").parentElement!;
        expect(line).toHaveTextContent("Person 2 <r2@example.com> and 3 more");
        expect(line).not.toHaveTextContent("r3@example.com");
        await user.click(screen.getByRole("button", { name: "and 3 more" }));
        expect(line).toHaveTextContent("Person 5 <r5@example.com>");
    });

    it("shows a sender whose name carries a different address with the real address, quoted, last", () => {
        const message = messageFixture({ from: { address: "evil@example.net", displayName: "ceo@bank.com", type: "to" as const } });
        render(<MessageDetailPane message={message as any} attachments={[]} />);
        expect(screen.getByText(/^From$/)).toHaveTextContent('From "ceo@bank.com" <evil@example.net>');
    });

    it("drops the subject to a lower heading inside a thread, where the conversation owns the h1", () => {
        const { rerender } = render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
        expect(screen.getByRole("heading", { level: 1, name: "Hello there" })).toBeInTheDocument();

        rerender(<MessageDetailPane inThread message={messageFixture()} attachments={[]} />);
        expect(screen.getByRole("heading", { level: 3, name: "Hello there" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    });

    it("draws the message as a card exactly as tall as its content, under a subject card that stays put while the card scrolls", async () => {
        // The body frame takes its height from its content (`MessageBody` measures the document it holds), never from a class: no growing
        // child, no `h-` number, no `vh`.
        mockServerBody();
        const { rerender, container } = render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
        const frame = await screen.findByTitle("Hello there");
        expect(frame.className).not.toMatch(/(^| )(flex-1|min-h-0|h-\d|h-\[|h-full)/);
        expect(frame.style.height).toMatch(/^\d+px$/);

        // The pane fills its column and scrolls as a whole: the subject card is pinned above the one growing, scrolling child that holds the card.
        expect(container.firstElementChild!.className).toContain("h-full");
        const subject = screen.getByRole("heading", { level: 1 }).closest("header")!;
        expect(subject.className).toContain("shrink-0");
        const scroller = subject.nextElementSibling as HTMLElement;
        for (const name of ["flex-1", "min-h-0", "overflow-y-auto", "gap-3"]) expect(scroller.className).toContain(name);
        expect(scroller.contains(frame)).toBe(true);

        // Inside a thread only the card is drawn: the thread owns the subject card and the scrolling, and the card is a row of its list.
        rerender(<MessageDetailPane inThread message={messageFixture()} attachments={[]} />);
        expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
        expect(container.firstElementChild!.className).not.toContain("h-full");
        expect(container.querySelector(".overflow-y-auto")).toBeNull();
    });

    it("draws each action as an icon alone, named only for assistive technology", () => {
        render(
            <MessageDetailPane
                message={messageFixture() as any}
                attachments={[]}
                folders={[{ uid: "f5", mailboxUid: "mb1", name: "Receipts", type: "user" }] as never}
            />,
        );
        for (const name of ["Reply", "Reply All", "Forward", "Archive", "Move to"]) {
            const button = screen.getByRole("button", { name });
            expect(button).toHaveAttribute("title", name);
            // The name is the accessible name and the tooltip - never text on screen, at any width.
            expect(button).not.toHaveTextContent(name);
        }
    });

    it("renders a back link when backHref is given", () => {
        render(
            <MessageDetailPane message={messageFixture() as any} attachments={[]} backHref="/?mailboxUid=mb1&folderUid=f1" />,
        );
        expect(screen.getByRole("link", { name: /Back to messages/ })).toHaveAttribute("href", "/?mailboxUid=mb1&folderUid=f1");
    });

    it("falls back to the raw address and '(no subject)' when displayName/subject are absent", async () => {
        mockServerBody();
        const message = messageFixture({
            subject: "",
            from: { address: "sender@example.com", type: "to" as const },
            recipients: [{ address: "u1@example.com", type: "to" as const }],
        });
        render(<MessageDetailPane message={message as any} attachments={[]} />);

        expect(screen.getByRole("heading", { name: "(no subject)" })).toBeInTheDocument();
        expect(screen.getByText(/^From$/)).toHaveTextContent("From sender@example.com");
        expect(screen.getByText("To").parentElement).toHaveTextContent("To u1@example.com");
        expect(await screen.findByTitle("Message content")).toBeInTheDocument();
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

            const writes = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
            expect(writes[1][1].body).toBe(JSON.stringify({ uid: "m1", version: 5, labelUids: ["l2", "l1"] }));
        });
    });

    describe("reply/forward", () => {
        // The compose window is a chunk loaded on demand (and prefetched when the pointer reaches Reply); loading it for the first
        // time - transforming and evaluating its modules, slower still under coverage - can hold the thread for longer than a
        // test's default wait, so it is loaded before the tests that open it.
        beforeAll(async () => {
            await import("../../../apps/shared/components/mail/compose/ComposeWindow.js");
        });

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
            // The window's frame is up on the click; its fields arrive with its code.
            await waitFor(() => expect(recipientChips("To")).toEqual(["Sender One <sender@example.com>"]), { timeout: 5000 });
            const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
            // The editor opens at once; the quote is added under it when the original has been fetched.
            await waitFor(() => expect(body.value.startsWith("<p></p><p></p><p>On ")).toBe(true), { timeout: 5000 });
            expect(body.value).toContain("Sender One &lt;sender@example.com&gt; wrote:");
            expect(body.value).toContain(`${longBody}</blockquote>`);
            expect(body).toHaveAttribute("data-autofocus-start", "true");
        });

        it("opens the compose window on the click, before the original's body has come back, and quotes it when it does", async () => {
            let resolveContent!: (response: Response) => void;
            const content = new Promise<Response>((resolve) => {
                resolveContent = resolve;
            });
            mockComposeDraft((url) => (url === "/api/mail/messages/m1/content" ? (content) : undefined));
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply" }));

            // The window and its editor are there while the body is still on its way; Reply stays disabled meanwhile.
            expect(await screen.findByRole("dialog", { name: "Re: Hello there" })).toBeInTheDocument();
            const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
            expect(body.value).toBe("<p></p>");
            expect(screen.getByRole("button", { name: "Reply" })).toBeDisabled();

            resolveContent(new Response("<p>The original.</p>", { headers: { "content-type": "text/html" } }));
            await waitFor(() => expect(body.value).toContain("<p>The original.</p></blockquote>"));
            await waitFor(() => expect(screen.getByRole("button", { name: "Reply" })).not.toBeDisabled());
        });

        it("fetches what a Reply will quote, and the compose window's code, as the pointer reaches the button", async () => {
            const fetchMock = mockComposeDraft((url) =>
                url === "/api/mail/messages/m1/content" ? new Response("<p>Prefetched.</p>", { headers: { "content-type": "text/html" } }) : undefined,
            );
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );
            const contentRequests = () => fetchMock.mock.calls.filter(([url]) => url === "/api/mail/messages/m1/content").length;

            await user.hover(screen.getByRole("button", { name: "Reply" }));
            await waitFor(() => expect(contentRequests()).toBe(1));

            // The click that follows finds the body already fetched.
            await user.click(screen.getByRole("button", { name: "Reply" }));
            const body = await screen.findByTestId<HTMLTextAreaElement>("html-editor");
            await waitFor(() => expect(body.value).toContain("<p>Prefetched.</p>"));
            expect(contentRequests()).toBe(1);
        });

        it("prefetches with the keyboard too, and for Reply All and Forward", async () => {
            const fetchMock = mockComposeDraft();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );
            act(() => screen.getByRole("button", { name: "Forward" }).focus());
            await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/messages/m1/content")).toBe(true));
            act(() => screen.getByRole("button", { name: "Reply All" }).focus());
        });

        it("records the thread a reply continues on the draft it creates", async () => {
            // Without this the relayed message carries no In-Reply-To/References at all and every mail
            // system - the sender's own Sent Items copy included - files it as a new conversation.
            const fetchMock = mockComposeDraft();
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane
                        message={messageFixture({ references: ["root@example.com"] }) as any}
                        attachments={[]}
                    />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Reply" }));
            await screen.findByRole("dialog", { name: "Re: Hello there" });

            const draftCreated = () =>
                fetchMock.mock.calls.find(([url, init]: any[]) => url === "/api/mail/messages" && init?.method === "POST");
            await waitFor(() => expect(draftCreated()).toBeDefined());
            expect(JSON.parse(draftCreated()![1].body as string)).toMatchObject({
                inReplyTo: "abc@example.com",
                references: ["root@example.com", "abc@example.com"],
            });
        });

        it("records it for a forward too - a forward continues the thread it came from", async () => {
            const fetchMock = mockComposeDraft();
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <MessageDetailPane message={messageFixture() as any} attachments={[]} />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Forward" }));
            await screen.findByRole("dialog", { name: "Fwd: Hello there" });

            const draftCreated = () =>
                fetchMock.mock.calls.find(([url, init]: any[]) => url === "/api/mail/messages" && init?.method === "POST");
            await waitFor(() => expect(draftCreated()).toBeDefined());
            expect(JSON.parse(draftCreated()![1].body as string)).toMatchObject({
                inReplyTo: "abc@example.com",
                references: ["abc@example.com"],
            });
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

    describe("Move to a folder", () => {
        const FOLDERS = [
            { uid: "f1", mailboxUid: "mb1", name: "Inbox", type: "inbox" },
            { uid: "f2", mailboxUid: "mb1", name: "Sent Items", type: "sent_items" },
            { uid: "f5", mailboxUid: "mb1", name: "Receipts", type: "user" },
            { uid: "f9", mailboxUid: "mb1", name: "Outbox", type: "outbox" },
        ] as never;

        const MANY = [
            { uid: "f1", mailboxUid: "mb1", name: "Inbox", type: "inbox" },
            { uid: "f5", mailboxUid: "mb1", name: "Receipts", type: "user" },
            ...Array.from({ length: 8 }, (_, i) => ({ uid: `u${i}`, mailboxUid: "mb1", name: `Project ${i}`, type: "user" })),
        ] as never;

        it("offers nothing to move to when the caller passes no folders", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            expect(screen.queryByRole("button", { name: "Move to" })).not.toBeInTheDocument();
        });

        it("lists the mailbox's message folders, marking the one the message is already in", async () => {
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} />);

            await user.click(screen.getByRole("button", { name: "Move to" }));

            expect(screen.getByRole("button", { name: /^Sent Items/ })).toBeEnabled();
            expect(screen.getByRole("button", { name: /^Receipts/ })).toBeEnabled();
            // Where it already is - shown, but not a destination, so the list keeps its shape per folder.
            expect(screen.getByRole("button", { name: /^Inbox/ })).toBeDisabled();
            // Outbox is the server's own send queue, never a destination.
            expect(screen.queryByRole("button", { name: /^Outbox/ })).not.toBeInTheDocument();
        });

        it("moves the message into the folder that was picked and hands back the server's copy", async () => {
            const moved = messageFixture({ folderUid: "f5", version: 1 });
            const fetchMock = mockFetch((url, init) =>
                url === "/api/mail/messages/m1" && init?.method === "PUT" ? jsonResponse(200, moved) : undefined,
            );
            const onMoved = vi.fn();
            const user = userEvent.setup();
            render(
                <MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} onMoved={onMoved} />,
            );

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /^Receipts/ }));

            await waitFor(() => expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ folderUid: "f5" })));
            const put = fetchMock.mock.calls.find(
                ([url, init]: any) => url === "/api/mail/messages/m1" && init?.method === "PUT",
            )!;
            expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ uid: "m1", version: 0, folderUid: "f5" });
            // Done - the prompt closes rather than leaving the reader in it.
            await waitFor(() => expect(screen.queryByRole("button", { name: /^Receipts/ })).not.toBeInTheDocument());
        });

        it("shows a failed move in the prompt, beside the destination that would retry it", async () => {
            const fetchMock = mockFetch((url, init) =>
                url === "/api/mail/messages/m1" && init?.method === "PUT"
                    ? jsonResponse(409, { message: "changed since read" })
                    : undefined,
            );
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} />);

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /^Receipts/ }));

            expect(await screen.findByText("changed since read")).toBeInTheDocument();
            // The move was really attempted - an early version passed `onMoved?.(await moveMessage(...))`,
            // which with no `onMoved` never evaluated its own argument and moved nothing at all.
            expect(
                fetchMock.mock.calls.some(([url, init]: any) => url === "/api/mail/messages/m1" && init?.method === "PUT"),
            ).toBe(true);
            expect(screen.getByRole("button", { name: /^Receipts/ })).toBeInTheDocument();
        });

        it("says something generic when the move fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} />);

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /^Receipts/ }));

            expect(await screen.findByText("Could not move to that folder.")).toBeInTheDocument();
        });

        it("creates a folder and moves into it in one step, telling the caller about both", async () => {
            const created = { uid: "f7", mailboxUid: "mb1", name: "Trips", type: "user", version: 0 };
            const fetchMock = mockFetch((url, init) => {
                if (url === "/api/mail/folders" && init?.method === "POST") return jsonResponse(200, created);
                if (url === "/api/mail/messages/m1" && init?.method === "PUT") {
                    return jsonResponse(200, messageFixture({ folderUid: "f7", version: 1 }));
                }
                return undefined;
            });
            const onMoved = vi.fn();
            const onFolderCreated = vi.fn();
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture() as any}
                    attachments={[]}
                    folders={FOLDERS}
                    onMoved={onMoved}
                    onFolderCreated={onFolderCreated}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /New folder/ }));
            await user.type(screen.getByLabelText("New folder name"), "Trips");
            await user.click(screen.getByRole("button", { name: "Create and move" }));

            await waitFor(() => expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ folderUid: "f7" })));
            expect(onFolderCreated).toHaveBeenCalledWith(expect.objectContaining({ uid: "f7", name: "Trips" }));
            const post = fetchMock.mock.calls.find(
                ([url, init]: any) => url === "/api/mail/folders" && init?.method === "POST",
            )!;
            // At the top level of the mailbox, typed `user` - never nested under the folder it left.
            expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual(
                expect.objectContaining({ mailboxUid: "mb1", name: "Trips", type: "user" }),
            );
            expect(JSON.parse((post[1] as RequestInit).body as string).parentFolderUid).toBeUndefined();
        });

        it("refuses a name this mailbox already has rather than creating a second folder", async () => {
            const fetchMock = mockFetch(() => undefined);
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} />);

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /New folder/ }));
            await user.type(screen.getByLabelText("New folder name"), "receipts");
            await user.click(screen.getByRole("button", { name: "Create and move" }));

            expect(
                await screen.findByText(
                    'This mailbox already has a folder called "Receipts". Pick it from the list instead.',
                ),
            ).toBeInTheDocument();
            expect(
                fetchMock.mock.calls.some(([url, init]: any) => url === "/api/mail/folders" && init?.method === "POST"),
            ).toBe(false);
        });

        it("refuses an empty name, one with a path separator, and one that is too long", async () => {
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} />);
            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /New folder/ }));

            await user.type(screen.getByLabelText("New folder name"), "   ");
            await user.click(screen.getByRole("button", { name: "Create and move" }));
            expect(await screen.findByText("Enter a name for the new folder.")).toBeInTheDocument();

            await user.clear(screen.getByLabelText("New folder name"));
            await user.type(screen.getByLabelText("New folder name"), "Trips/2026");
            await user.click(screen.getByRole("button", { name: "Create and move" }));
            expect(await screen.findByText("A folder name can't contain / or \\.")).toBeInTheDocument();
        });

        it("shows a failed creation in the prompt and moves nothing", async () => {
            const fetchMock = mockFetch((url, init) =>
                url === "/api/mail/folders" && init?.method === "POST"
                    ? jsonResponse(400, { message: "folder limit reached" })
                    : undefined,
            );
            const onMoved = vi.fn();
            const user = userEvent.setup();
            render(
                <MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} onMoved={onMoved} />,
            );

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /New folder/ }));
            await user.type(screen.getByLabelText("New folder name"), "Trips");
            await user.click(screen.getByRole("button", { name: "Create and move" }));

            expect(await screen.findByText("folder limit reached")).toBeInTheDocument();
            expect(onMoved).not.toHaveBeenCalled();
            expect(
                fetchMock.mock.calls.some(([url, init]: any) => url === "/api/mail/messages/m1" && init?.method === "PUT"),
            ).toBe(false);
        });

        it("says something generic when creating the folder fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} />);

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /New folder/ }));
            await user.type(screen.getByLabelText("New folder name"), "Trips");
            await user.click(screen.getByRole("button", { name: "Create and move" }));

            expect(await screen.findByText("Could not create that folder.")).toBeInTheDocument();
        });

        it("goes back to the destination list from the new-folder form", async () => {
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} />);
            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /New folder/ }));

            await user.click(screen.getByRole("button", { name: "Back" }));

            expect(screen.getByRole("button", { name: /^Receipts/ })).toBeInTheDocument();
        });

        it("offers a filter once the mailbox has more folders than fit a glance, and narrows the list", async () => {
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={MANY} />);
            await user.click(screen.getByRole("button", { name: "Move to" }));

            await user.type(screen.getByLabelText("Filter folders"), "project 3");

            expect(screen.getByRole("button", { name: /^Project 3/ })).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: /^Receipts/ })).not.toBeInTheDocument();

            await user.clear(screen.getByLabelText("Filter folders"));
            await user.type(screen.getByLabelText("Filter folders"), "nothing like this");
            expect(screen.getByText("No folder matches that.")).toBeInTheDocument();
        });

        it("offers no filter for a list short enough to read at a glance", async () => {
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} />);

            await user.click(screen.getByRole("button", { name: "Move to" }));

            expect(screen.queryByLabelText("Filter folders")).not.toBeInTheDocument();
        });

        it("says so when the mailbox has no folder that can hold a message", async () => {
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={messageFixture() as any}
                    attachments={[]}
                    folders={[{ uid: "f9", mailboxUid: "mb1", name: "Outbox", type: "outbox" }] as never}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Move to" }));

            expect(screen.getByText("This mailbox has no folders to move to yet.")).toBeInTheDocument();
        });

        it("closes the prompt from its own close control, moving nothing", async () => {
            const fetchMock = mockFetch(() => undefined);
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} />);
            await user.click(screen.getByRole("button", { name: "Move to" }));

            await user.click(screen.getByRole("button", { name: "Close" }));

            expect(screen.queryByRole("button", { name: /^Receipts/ })).not.toBeInTheDocument();
            expect(fetchMock.mock.calls.some(([, init]: any) => init?.method === "PUT")).toBe(false);
        });

        it("has no Focused/Other control of its own any more - classification is automatic", () => {
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} />);
            expect(screen.queryByRole("button", { name: "Move to Other" })).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Move to Focused" })).not.toBeInTheDocument();
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

    describe("calendar invitation", () => {
        const INVITE_URL = "/api/mail/calendar-events/invite/";

        function attachmentFixture(filename: string, mimeType: string, uid = `a-${filename}`) {
            return { uid, version: 0, dateCreated: "", dateModified: "", messageUid: "m1", folderUid: "f1", mailboxUid: "mb1", filename, mimeType, sizeBytes: 400, isInline: false } as any;
        }

        const ICS = () => [attachmentFixture("invite.ics", "text/calendar")];

        const inviteBody = {
            method: "REQUEST",
            uid: "ical-1",
            sequence: 0,
            summary: "Quarterly planning",
            startDate: "2026-06-16T14:00:00.000Z",
            endDate: "2026-06-16T15:00:00.000Z",
            allDay: false,
            organizer: { address: "boss@example.com", displayName: "The Boss" },
            attendees: [],
            recurring: false,
            isOrganizer: false,
            onCalendar: false,
            outdated: false,
            canRespond: true,
            canAdd: false,
            canRemove: false,
            canPropose: false,
            canAcceptProposal: false,
            conflicts: [],
            schedule: [],
        };

        /** Answers the invite lookup with `lookup`; the message's own body and everything else as the pane needs. */
        function mockInvite(lookup: () => Response | Promise<Response> = () => jsonResponse(200, inviteBody)) {
            return mockFetch((url) => (url.startsWith(INVITE_URL) ? lookup() : url.endsWith("/raw") ? new Response("raw mime") : jsonResponse(200, {})));
        }

        function inviteRequests(fetchMock: ReturnType<typeof mockInvite>) {
            return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(INVITE_URL));
        }

        it("draws an invitation card with Accept, Tentative and Decline between the header and the body for a message with an .ics attachment", async () => {
            const fetchMock = mockInvite();
            render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={ICS()} />);

            const region = await screen.findByRole("region", { name: "Meeting invitation" });
            expect(within(region).getByText("Quarterly planning")).toBeInTheDocument();
            for (const name of ["Accept", "Tentative", "Decline"]) {
                expect(within(region).getByRole("button", { name })).toBeEnabled();
            }
            expect(inviteRequests(fetchMock)).toHaveLength(1);
            expect(inviteRequests(fetchMock)[0][0]).toBe(`${INVITE_URL}m1`);
            // In the pane itself its heading sits under the subject's h1.
            expect(within(region).getByRole("heading", { level: 2 })).toBeInTheDocument();
            // Between the header (the sender) and the body's frame.
            const frame = await screen.findByTitle("Hello there");
            const sender = screen.getByText(/^From$/);
            expect(sender.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            expect(region.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        it.each([
            ["text/calendar", "invite"],
            ["application/ics", "invite"],
            ["application/octet-stream", "Meeting.ICS"],
        ])("recognizes a calendar file by type or name (%s, %s)", async (mimeType, filename) => {
            const fetchMock = mockInvite();
            render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={[attachmentFixture(filename, mimeType)]} />);
            expect(await screen.findByRole("region", { name: "Meeting invitation" })).toBeInTheDocument();
            expect(inviteRequests(fetchMock)).toHaveLength(1);
        });

        it("asks the server nothing for a message without a calendar attachment, or with none at all", async () => {
            const fetchMock = mockInvite();
            const { unmount } = render(<MessageDetailPane message={messageFixture() as any} attachments={[]} />);
            await screen.findByTitle("Hello there");
            unmount();

            render(
                <MessageDetailPane
                    message={messageFixture({ hasAttachments: true }) as any}
                    attachments={[attachmentFixture("report.pdf", "application/pdf"), attachmentFixture("notes.txt", "text/plain")]}
                />,
            );
            await screen.findByTitle("Hello there");
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(inviteRequests(fetchMock)).toHaveLength(0);
            expect(screen.queryByRole("region", { name: /Meeting|Calendar/ })).not.toBeInTheDocument();
        });

        it("asks nothing for an encrypted message, whose calendar file the server cannot read", async () => {
            getUnlockedKeys.mockReturnValue({ encryptionPrivateKey: {} as any, encryptionCertDer: new Uint8Array() });
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", html: "<p>Decrypted</p>" });
            const fetchMock = mockInvite();
            render(<MessageDetailPane message={messageFixture({ encrypted: true, hasAttachments: true }) as any} attachments={ICS()} />);
            await screen.findByText("Encrypted");
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(inviteRequests(fetchMock)).toHaveLength(0);
            expect(screen.queryByRole("region", { name: "Meeting invitation" })).not.toBeInTheDocument();
        });

        it("asks nothing for a message in Drafts or Outbox", async () => {
            const fetchMock = mockInvite();
            const { unmount } = render(
                <MessageDetailPane message={messageFixture({ folderUid: "f-drafts", hasAttachments: true }) as any} attachments={ICS()} draftsFolderUid="f-drafts" />,
            );
            await screen.findByTitle("Hello there");
            unmount();

            render(
                <MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={ICS()} isOutbox draftsFolderUid="f-drafts" />,
            );
            await screen.findByTitle("Hello there");
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(inviteRequests(fetchMock)).toHaveLength(0);
        });

        it("draws nothing when the message has no readable invitation (404)", async () => {
            const fetchMock = mockInvite(() => jsonResponse(404, { message: "No invite" }));
            render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={ICS()} />);
            await waitFor(() => expect(inviteRequests(fetchMock)).toHaveLength(1));
            await screen.findByTitle("Hello there");

            expect(screen.queryByRole("region", { name: /Meeting|Calendar/ })).not.toBeInTheDocument();
        });

        it("keeps the message readable, without the card or a pop-up and without asking again, when the lookup fails", async () => {
            const fetchMock = mockInvite(() => jsonResponse(500, { message: "Boom" }));
            const { rerender } = render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={ICS()} />);
            await waitFor(() => expect(inviteRequests(fetchMock)).toHaveLength(1));

            expect(await screen.findByTitle("Hello there")).toBeInTheDocument();
            expect(screen.getByText(/^From$/)).toHaveTextContent("From Sender One <sender@example.com>");
            expect(screen.getByRole("link", { name: /invite\.ics/ })).toBeInTheDocument();
            expect(screen.queryByRole("region", { name: /Meeting|Calendar/ })).not.toBeInTheDocument();
            expect(getNotificationsSnapshot().visible).toEqual([]);
            // A change to the same message (its version moves on when it is marked read) does not ask again.
            rerender(<MessageDetailPane message={messageFixture({ hasAttachments: true, version: 1 })} attachments={ICS()} />);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(inviteRequests(fetchMock)).toHaveLength(1);
        });

        it("leaves the calendar file out of the attachment list once the invitation card is drawn, and keeps the other attachments", async () => {
            mockInvite();
            render(
                <MessageDetailPane
                    message={messageFixture({ hasAttachments: true }) as any}
                    attachments={[attachmentFixture("invite.ics", "application/octet-stream"), attachmentFixture("agenda.pdf", "application/pdf")]}
                />,
            );
            await screen.findByRole("region", { name: "Meeting invitation" });

            expect(screen.queryByRole("link", { name: /invite.ics/ })).not.toBeInTheDocument();
            expect(screen.getByRole("link", { name: /agenda.pdf/ })).toBeInTheDocument();
        });

        it("draws no attachment list at all when the calendar file was the only attachment", async () => {
            mockInvite();
            const { container } = render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={ICS()} />);
            await screen.findByRole("region", { name: "Meeting invitation" });
            expect(container.querySelector("ul.flex-wrap")).toBeNull();
            expect(screen.queryByRole("link", { name: /invite.ics/ })).not.toBeInTheDocument();
        });

        it("keeps the calendar file listed while the lookup is out, and when there is no card to replace it", async () => {
            const pending = mockInvite(() => new Promise<Response>(() => undefined));
            const first = render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={ICS()} />);
            expect(screen.getByRole("link", { name: /invite.ics/ })).toBeInTheDocument();
            expect(inviteRequests(pending)).toHaveLength(1);
            first.unmount();
            clearInviteCache();

            mockInvite(() => jsonResponse(404, { message: "none" }));
            const second = render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={ICS()} />);
            await screen.findByTitle("Hello there");
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(screen.getByRole("link", { name: /invite.ics/ })).toBeInTheDocument();
            second.unmount();
            clearInviteCache();

            mockInvite(() => jsonResponse(500, { message: "Boom" }));
            render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={ICS()} />);
            await screen.findByTitle("Hello there");
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(screen.getByRole("link", { name: /invite.ics/ })).toBeInTheDocument();
        });

        it("draws a reply's card as one line about who answered", async () => {
            mockInvite(() =>
                jsonResponse(200, {
                    ...inviteBody,
                    method: "REPLY",
                    isOrganizer: true,
                    canRespond: false,
                    reply: { address: "jp@example.com", displayName: "Jean-Philippe Steinmetz", responseStatus: "tentative" },
                }),
            );
            render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={ICS()} />);
            const region = await screen.findByRole("region", { name: "Meeting response" });
            expect(region).toHaveTextContent("Jean-Philippe Steinmetz tentatively accepted.");
            expect(screen.queryByRole("link", { name: /invite.ics/ })).not.toBeInTheDocument();
        });

        it("answers from the card and shows the answer", async () => {
            const user = userEvent.setup();
            const fetchMock = mockFetch((url, init) =>
                !url.startsWith(INVITE_URL)
                    ? jsonResponse(200, {})
                    : init?.method === "POST"
                      ? jsonResponse(200, { ...inviteBody, response: "accepted", onCalendar: true, calendarEventUid: "ev1" })
                      : jsonResponse(200, inviteBody),
            );
            render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={ICS()} />);

            await user.click(await screen.findByRole("button", { name: "Accept" }));

            expect(await screen.findByText("You accepted this meeting.")).toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalledWith(`${INVITE_URL}m1/respond`, expect.objectContaining({ method: "POST" }));
        });

        it("draws the card inside a thread's card, under the sender line, with a lower heading", async () => {
            const fetchMock = mockInvite();
            render(
                <MessageDetailPane
                    inThread
                    message={messageFixture({ hasAttachments: true }) as any}
                    attachments={ICS()}
                    threadSubject="Hello there"
                    threadHeader={{ bodyId: "body-m1", unread: false, onToggle: vi.fn(), buttonRef: vi.fn() }}
                />,
            );

            const region = await screen.findByRole("region", { name: "Meeting invitation" });
            expect(within(region).getByRole("heading", { level: 3, name: "Meeting invitation" })).toBeInTheDocument();
            expect(document.getElementById("body-m1")!.contains(region)).toBe(true);
            expect(inviteRequests(fetchMock)).toHaveLength(1);
        });

        it("does not draw one in a thread for a message without a calendar attachment", async () => {
            const fetchMock = mockInvite();
            render(
                <MessageDetailPane
                    inThread
                    message={messageFixture() as any}
                    attachments={[]}
                    threadSubject="Hello there"
                    threadHeader={{ bodyId: "body-m1", unread: false, onToggle: vi.fn(), buttonRef: vi.fn() }}
                />,
            );
            await screen.findByTitle("Hello there");
            expect(inviteRequests(fetchMock)).toHaveLength(0);
        });
    });

    describe("security indicator", () => {
        // Only a message the server flags `encrypted` (or one carrying attachments - where a detached/opaque
        // S/MIME signature part surfaces) has its raw MIME fetched and evaluated at all.
        function secureFixture(overrides: Record<string, unknown> = {}) {
            return messageFixture({ encrypted: true, ...overrides });
        }

        function mockRawContent(raw = "raw mime text") {
            return mockFetch((url) =>
                url.endsWith("/raw")
                    ? new Response(raw)
                    : url.endsWith("/content")
                      ? new Response("<p>Server body</p>", { headers: { "content-type": "text/html; charset=utf-8" } })
                      : jsonResponse(200, {}),
            );
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

            it("never shows the notice in Sent Items, where the sender's own address is never among the protected recipients it sent to someone else", async () => {
                mailShellOverride.current = { mailboxes: [readerMailbox], mailboxFolders: [] };
                evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<p>Hi</p>", notAddressedToReader: true });
                mockRawContent("signed mime");
                render(<MessageDetailPane message={messageFixture({ hasAttachments: true }) as any} attachments={[]} isSentItems />);

                expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
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
            const fetchMock = mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await screen.findByText("Encrypted & verified");
            const iframe = await screen.findByTitle("Hello there");
            expect(iframe).not.toHaveAttribute("src");
            expect(iframe).toHaveAttribute("sandbox", FRAME_SANDBOX);
            // The content was recovered on this device, so the server is never asked for a body.
            expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/content"))).toBe(false);
            const srcdoc = iframe.getAttribute("srcdoc")!;
            // The no-remote-loads, no-script CSP comes before the content in the document.
            expect(srcdoc).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">`);
            expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("Secret"));
            expect(srcdoc).toContain("<p>Secret</p>");
            expect(srcdoc).not.toContain("<script");
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
            async function renderSrcDoc(html: string, extra: Record<string, unknown> = {}): Promise<string> {
                evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html, ...extra });
                mockRawContent();
                const { unmount } = render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);
                await screen.findByText("Encrypted & verified");
                const srcdoc = (await screen.findByTitle("Hello there")).getAttribute("srcdoc")!;
                unmount();
                return srcdoc;
            }

            it("strips remote and protocol-relative image sources, keeps embedded ones, and shows an inline cid: image from the decrypted part it names - and none whose part is missing", async () => {
                const srcdoc = await renderSrcDoc(
                    '<img id="a" src="https://tracker.example/p.gif"><img id="b" src="//tracker.example/p.gif">' +
                        '<img id="c" src="data:image/png;base64,AAAA"><img id="d" src="cid:logo@x"><img id="e" src="cid:missing@x">',
                    { attachments: [{ contentType: "image/png", disposition: "inline", contentId: "logo@x", decode: () => new Uint8Array([137, 80, 78, 71]) }] },
                );
                expect(srcdoc).not.toContain("tracker.example");
                expect(srcdoc).toContain('src="data:image/png;base64,AAAA"');
                expect(srcdoc).toContain('src="data:image/png;base64,iVBORw=="');
                expect(srcdoc).not.toContain("cid:");
                expect(srcdoc.match(/ src=/g)).toHaveLength(2);
            });

            it("drops every srcset - another way to name an image the frame would have to fetch", async () => {
                const srcdoc = await renderSrcDoc(
                    '<img srcset="data:image/png;base64,AAAA 1x, https://tracker.example/2x.png 2x">' +
                        '<img srcset="cid:lo@x 1x, cid:hi@x 2x">',
                );
                expect(srcdoc).not.toContain("tracker.example");
                expect(srcdoc).not.toContain("srcset");
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
                // Only the two metas the frame document itself opens with survive: its charset and its CSP.
                expect(srcdoc.match(/<meta/g)).toHaveLength(2);
                expect(srcdoc).not.toContain("refresh");
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

        it("shows the server's sanitized content, fetched from /content, when there is no decrypted html", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "unprotected" });
            const fetchMock = mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await screen.findByText("Unprotected");
            const iframe = await screen.findByTitle("Hello there");
            expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/raw"))).toBe(true);
            expect(iframe).toHaveAttribute("srcdoc", expect.stringContaining("<p>Server body</p>"));
            expect(iframe).not.toHaveAttribute("src");
        });

        it("shows why an encrypted message can't be decrypted, beside the badge, in place of a body - and nothing to click, since unlocking wouldn't help", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            const fetchMock = mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            expect(await screen.findByText("This device doesn't have the key needed.")).toBeInTheDocument();
            expect(screen.getByText("This message can\u2019t be decrypted")).toBeInTheDocument();
            expect(screen.getByText("Encrypted")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Unlock to view this message" })).not.toBeInTheDocument();
            // The server only ever had the ciphertext: no frame, and no request for its (empty) body.
            expect(screen.queryByTitle("Hello there")).not.toBeInTheDocument();
            expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/content"))).toBe(false);
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
                const notice = screen.getByText(text);
                expect(notice).toHaveAttribute("role", "status");
                expect(notice).toHaveTextContent("Treat it as unverified.");
                expect(screen.queryByRole("alert")).not.toBeInTheDocument();
                expect(await screen.findByTitle("Hello there")).toHaveAttribute("srcdoc", expect.stringContaining("<p>Server body</p>"));
            });

            it("shows a generic unverified notice when no failure reason is given", async () => {
                evaluateMessageSecurity.mockResolvedValue({ state: "signature_failed" });
                mockRawContent();
                render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

                const notice = await screen.findByText("This message's digital signature couldn't be verified. Treat it as unverified.");
                expect(notice).toHaveAttribute("role", "status");
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
                // No notice - the only live region left is the body's own "Loading the message".
                expect(screen.getAllByRole("status").map((region) => region.textContent)).toEqual(["Loading the message"]);
            });
        });

        it("titles a message whose subject is the encrypted placeholder 'Encrypted message', and one with a real subject by it", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "Locked." });
            mockRawContent();
            const { unmount } = render(<MessageDetailPane message={secureFixture({ subject: "[...]" }) as any} attachments={[]} />);
            expect(await screen.findByRole("heading", { level: 1, name: "Encrypted message" })).toBeInTheDocument();
            unmount();

            render(<MessageDetailPane message={secureFixture({ subject: "Quarterly numbers" }) as any} attachments={[]} />);
            expect(await screen.findByRole("heading", { level: 1, name: "Quarterly numbers" })).toBeInTheDocument();
        });

        it("shows a locked message as a lock, what it is, a hint and an Unlock button, and decrypts it in place once unlocked", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            evaluateMessageSecurity.mockResolvedValueOnce({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            requestUnlock.mockImplementation(async () => {
                getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            });
            mockRawContent();
            const user = userEvent.setup();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);
            expect(await screen.findByText("This message is encrypted")).toBeInTheDocument();
            expect(screen.getByText("Unlock your keys to read it")).toBeInTheDocument();
            // The header - sender, date, the badge - is there while it is locked; the reason isn't (unlocking is what is asked for).
            expect(screen.getByText(/^From$/)).toHaveTextContent("From Sender One <sender@example.com>");
            expect(screen.getByText("Encrypted")).toBeInTheDocument();
            expect(screen.queryByText("This device doesn't have the key needed.")).not.toBeInTheDocument();
            expect(screen.queryByTitle("Hello there")).not.toBeInTheDocument();
            // Its own name says what it does; the words on it are short.
            const unlock = screen.getByRole("button", { name: "Unlock to view this message" });
            expect(unlock).toHaveTextContent("Unlock");

            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>Now decrypted</p>" });
            await user.click(unlock);

            expect(requestUnlock).toHaveBeenCalledWith("mb1", []);
            // Decrypted in place, through the normal pipeline: a frame holding it, the lock and the button gone - and the focus is on the message, not lost.
            await waitFor(() => expect(screen.getByTitle("Hello there")).toHaveAttribute("srcdoc", expect.stringContaining("Now decrypted")));
            expect(screen.queryByText("This message is encrypted")).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Unlock to view this message" })).not.toBeInTheDocument();
            expect(screen.getByText("Encrypted & verified")).toBeInTheDocument();
            expect(document.activeElement).toBe(screen.getByTitle("Hello there").closest("[tabindex='-1']"));
        });

        it("waits on the unlock prompt with the button disabled, and stays locked - the button back, the focus left alone - when it is dismissed", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            let dismiss!: () => void;
            requestUnlock.mockImplementation(() => new Promise((_resolve, reject) => (dismiss = () => reject(new Error("dismissed")))));
            mockRawContent();
            const user = userEvent.setup();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            const unlock = await screen.findByRole("button", { name: "Unlock to view this message" });
            await user.click(unlock);
            await waitFor(() => expect(unlock).toBeDisabled());
            act(() => dismiss());
            await waitFor(() => expect(unlock).toBeEnabled());
            expect(screen.getByText("This message is encrypted")).toBeInTheDocument();
            expect(document.activeElement).toBe(unlock);
        });

        it("says why, with no button, when the message still can't be opened after unlocking, and moves the focus there", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            evaluateMessageSecurity.mockResolvedValueOnce({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            requestUnlock.mockImplementation(async () => {
                getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            });
            mockRawContent();
            const user = userEvent.setup();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "You are not one of this message's recipients." });
            await user.click(await screen.findByRole("button", { name: "Unlock to view this message" }));

            expect(await screen.findByText("You are not one of this message's recipients.")).toBeInTheDocument();
            expect(screen.getByText("This message can\u2019t be decrypted")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Unlock to view this message" })).not.toBeInTheDocument();
            expect(document.activeElement).toBe(screen.getByText("This message can\u2019t be decrypted").closest("[tabindex='-1']"));
        });

        it("decrypts a locked message in place when the keys are unlocked from anywhere else, and ignores unlocks that change nothing for it", async () => {
            getUnlockedKeys.mockReturnValue(undefined);
            evaluateMessageSecurity.mockResolvedValueOnce({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            const fetchMock = mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);
            await screen.findByText("This message is encrypted");
            const raw = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/raw")).length;
            expect(raw()).toBe(1);

            // Another mailbox unlocking is not this one's business.
            emitKeySession({ mailboxUid: "mb-other", state: "unlocked" });
            await act(async () => undefined);
            expect(raw()).toBe(1);

            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>Opened elsewhere</p>" });
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            emitKeySession({ mailboxUid: "mb1", state: "unlocked" });
            await waitFor(() => expect(screen.getByTitle("Hello there")).toHaveAttribute("srcdoc", expect.stringContaining("Opened elsewhere")));
            expect(raw()).toBe(2);
            // Nothing was asking the focus to move: it was not the button that unlocked it.
            expect(document.activeElement).toBe(document.body);

            // Once it is open, an unlock has nothing to re-evaluate.
            emitKeySession({ mailboxUid: "mb1", state: "unlocked" });
            await act(async () => undefined);
            expect(raw()).toBe(2);
        });

        it("draws every encrypted badge with a small lock, and the others without", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted_verified", html: "<p>x</p>" });
            mockRawContent();
            const first = render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);
            expect((await screen.findByText("Encrypted & verified")).querySelector("svg")).not.toBeNull();
            first.unmount();

            evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<p>x</p>", protectedHeaders: { from: "sender@example.com", to: "u1@example.com", subject: "Hello there" } });
            render(<MessageDetailPane message={secureFixture({ uid: "m2" }) as any} attachments={[]} />);
            expect((await screen.findByText("Signed & verified")).querySelector("svg")).toBeNull();
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

            await user.click(await screen.findByRole("button", { name: "Unlock to view this message" }));

            expect(requestUnlock).toHaveBeenCalledWith("mb1", keys);
        });

        it("does not offer to unlock when a decryptError comes from an already-unlocked session (wrong/rotated key)", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
            mockRawContent();
            render(<MessageDetailPane message={secureFixture() as any} attachments={[]} />);

            await screen.findByText("This device doesn't have the key needed.");
            expect(screen.queryByRole("button", { name: "Unlock to view this message" })).not.toBeInTheDocument();
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
                // The frame that held it is gone; the card waits on its skeleton, since the server only ever had the ciphertext.
                expect(screen.queryByTitle("Hello there")).not.toBeInTheDocument();
                expect(screen.getByRole("status")).toHaveTextContent("Loading the message");
                expect(screen.queryByText("Encrypted & verified")).not.toBeInTheDocument();
                expect(document.body.innerHTML).not.toContain("Secret");

                await waitFor(() => expect(resolveNext).toBeDefined());
                expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/raw"))).toHaveLength(2);
                resolveNext!({ state: "encrypted", decryptError: "This device doesn't have the key needed." });
                // Locked again: the lock and the button, not the message.
                expect(await screen.findByText("This message is encrypted")).toBeInTheDocument();
                expect(screen.getByRole("button", { name: "Unlock to view this message" })).toBeInTheDocument();
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

    describe("folder badges", () => {
        const FOLDERS = [
            { uid: "f1", mailboxUid: "mb1", name: "Inbox", type: "inbox" },
            { uid: "f5", mailboxUid: "mb1", name: "Receipts", type: "user" },
        ] as never;

        function shellTracking() {
            const tracker = { settle: vi.fn(), revert: vi.fn() };
            const trackMessageChange = vi.fn(() => tracker);
            mailShellOverride.current = { mailboxes: [], mailboxFolders: [], trackMessageChange };
            return { tracker, trackMessageChange };
        }

        it("tells the shell about a move, so the source and target badges follow, once the server has accepted it", async () => {
            const { tracker, trackMessageChange } = shellTracking();
            const moved = messageFixture({ folderUid: "f5", version: 1 });
            mockFetch((url, init) => (url === "/api/mail/messages/m1" && init?.method === "PUT" ? jsonResponse(200, moved) : undefined) as Response);
            const original = messageFixture() as any;
            const user = userEvent.setup();
            render(<MessageDetailPane message={original} attachments={[]} folders={FOLDERS} onMoved={vi.fn()} />);

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /^Receipts/ }));

            await waitFor(() => expect(trackMessageChange).toHaveBeenCalledWith(original, moved));
            expect(tracker.settle).toHaveBeenCalledTimes(1);
        });

        it("does not count a move the server refused", async () => {
            const { trackMessageChange } = shellTracking();
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(<MessageDetailPane message={messageFixture() as any} attachments={[]} folders={FOLDERS} onMoved={vi.fn()} />);

            await user.click(screen.getByRole("button", { name: "Move to" }));
            await user.click(screen.getByRole("button", { name: /^Receipts/ }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
            expect(trackMessageChange).not.toHaveBeenCalled();
        });

        it("tells the shell about an archive", async () => {
            const { tracker, trackMessageChange } = shellTracking();
            const archived = messageFixture({ folderUid: "f-archive" });
            mockFetch(() => jsonResponse(200, archived));
            const original = messageFixture() as any;
            const user = userEvent.setup();
            render(<MessageDetailPane message={original} attachments={[]} onArchived={vi.fn()} />);

            await user.click(screen.getByRole("button", { name: "Archive" }));

            await waitFor(() => expect(trackMessageChange).toHaveBeenCalledWith(original, archived));
            expect(tracker.settle).toHaveBeenCalledTimes(1);
        });

        it("tells the shell about a scheduled send taken back into Drafts", async () => {
            const { tracker, trackMessageChange } = shellTracking();
            const back = messageFixture({ folderUid: "f-drafts", scheduledSendTime: undefined });
            mockFetch(() => jsonResponse(200, back));
            const original = messageFixture({ scheduledSendTime: "2026-06-01T09:00:00.000Z" }) as any;
            const user = userEvent.setup();
            render(
                <MessageDetailPane
                    message={original}
                    attachments={[]}
                    isOutbox
                    draftsFolderUid="f-drafts"
                    onScheduledSendCanceled={vi.fn()}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Cancel" }));

            await vi.waitFor(() => expect(trackMessageChange).toHaveBeenCalledWith(original, back));
            expect(tracker.settle).toHaveBeenCalledTimes(1);
        });
    });
});
