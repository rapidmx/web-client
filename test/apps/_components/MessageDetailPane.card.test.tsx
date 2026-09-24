// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MessageDetailPane from "../../../apps/shared/components/mail/MessageDetailPane.js";
import { clearViewedOriginal } from "../../../apps/shared/components/mail/reading/viewOriginal.js";

// The card around a message: its header, the actions in it, the bar for what was done with it, the footer, and the "View original" choice. The body -
// its frame, sizing and theming - is `MessageBody`'s, tested with it; here it is a stand-in that shows what the card handed it and lets a test say
// whether "view original" would change anything.
const { bodyProps, openCompose, loadOriginalMessage } = vi.hoisted(() => ({
    bodyProps: { current: undefined as Record<string, any> | undefined },
    openCompose: vi.fn(),
    loadOriginalMessage: vi.fn(),
}));
vi.mock("../../../apps/shared/components/mail/reading/MessageBody.js", () => ({
    default: (props: Record<string, any>) => {
        bodyProps.current = props;
        return (
            <div data-testid="body" data-original={String(!!props.original)}>
                body of {props.messageUid}
            </div>
        );
    },
    BodySkeleton: () => <div data-testid="body-skeleton" />,
}));
vi.mock("../../../apps/shared/components/mail/compose/ComposeContext.js", () => ({ useCompose: () => ({ openCompose }), prefetchComposeWindow: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/compose/quotedBody.js", () => ({ loadOriginalMessage, prefetchOriginalMessage: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys: vi.fn(), subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock: vi.fn() }) }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ moveLocalEntity: vi.fn() }));

function message(overrides: Record<string, unknown> = {}) {
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
        receivedDate: "2026-01-01T12:30:00.000Z",
        bodyPreview: "Hi",
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    } as never;
}

beforeEach(() => {
    loadOriginalMessage.mockResolvedValue({ body: "<p>quoted</p>", recipients: [] });
});

afterEach(() => {
    clearViewedOriginal();
    bodyProps.current = undefined;
    vi.clearAllMocks();
});

describe("the message card", () => {
    it("is a header card with the subject and, under it, one card for the message: initials, sender, recipients, time and the actions", () => {
        const { container } = render(<MessageDetailPane message={message()} attachments={[]} folders={[{ uid: "f5", name: "Receipts", type: "user" }] as never} />);
        expect(screen.getByRole("heading", { level: 1, name: "Hello there" }).closest("header")).not.toBeNull();
        expect(screen.getByText("SO")).toBeInTheDocument();
        expect(screen.getByText(/^From$/)).toHaveTextContent("From Sender One <sender@example.com>");
        expect(screen.getByText("To").parentElement).toHaveTextContent("To Me <u1@example.com>");
        const time = container.querySelector("time")!;
        expect(time).toHaveAttribute("datetime", "2026-01-01T12:30:00.000Z");
        expect(time.textContent).toBe(new Date("2026-01-01T12:30:00.000Z").toLocaleString());
        for (const name of ["Reply", "Reply All", "Forward", "Archive", "Move to"]) {
            expect(screen.getByRole("button", { name })).toBeInTheDocument();
        }
        expect(screen.getByTestId("body")).toHaveTextContent("body of m1");
        // The card is rounded, bordered and lifted, in the app's tokens.
        const card = screen.getByTestId("body").closest(".rounded-lg")!;
        expect(card.className).toContain("bg-surface");
        expect(card.className).toContain("shadow-sm");
    });

    it("hands the body the message, its version, its subject as the accessible title and its attachments", () => {
        const attachments = [{ uid: "a1", filename: "logo.png", sizeBytes: 10 }] as never;
        render(<MessageDetailPane message={message({ version: 4, hasAttachments: true })} attachments={attachments} />);
        expect(bodyProps.current).toMatchObject({ messageUid: "m1", messageVersion: 4, title: "Hello there", attachments, original: false });
        expect(bodyProps.current!.content).toBeUndefined();
    });

    it("shows a placeholder for an encrypted message's body until it has been evaluated, and never asks the server for its ciphertext", () => {
        render(<MessageDetailPane message={message({ encrypted: true })} attachments={[]} />);
        expect(screen.getByTestId("body-skeleton")).toBeInTheDocument();
        expect(screen.queryByTestId("body")).not.toBeInTheDocument();
    });

    it("puts the Back link above the subject card on the standalone page", () => {
        render(<MessageDetailPane message={message()} attachments={[]} backHref="/?folderUid=f1" />);
        const link = screen.getByRole("link", { name: /Back to messages/ });
        expect(link).toHaveAttribute("href", "/?folderUid=f1");
        expect(link.compareDocumentPosition(screen.getByRole("heading", { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    describe("what has been done with the message", () => {
        it.each([
            [{ answered: true, forwarded: false }, "You replied to this message."],
            [{ answered: false, forwarded: true }, "You forwarded this message."],
            [{ answered: true, forwarded: true }, "You replied to and forwarded this message."],
        ])("says so on a slim bar for %j", (flags, text) => {
            render(<MessageDetailPane message={message({ flags: { read: true, flagged: false, ...flags } })} attachments={[]} />);
            expect(screen.getByText(text)).toBeInTheDocument();
        });

        it("has no bar for a message nothing was done with", () => {
            render(<MessageDetailPane message={message()} attachments={[]} />);
            expect(screen.queryByText(/You (replied|forwarded)/)).not.toBeInTheDocument();
        });
    });

    describe("the footer", () => {
        it("has Reply, Reply All and Forward at the foot of a single message's card, which do what the header's do", async () => {
            const user = userEvent.setup();
            render(<MessageDetailPane message={message()} attachments={[]} />);
            const reply = screen.getByRole("button", { name: "Reply to this message" });
            expect(reply).toHaveTextContent("Reply");
            expect(screen.getByRole("button", { name: "Reply all to this message" })).toHaveTextContent("Reply All");
            expect(screen.getByRole("button", { name: "Forward this message" })).toHaveTextContent("Forward");
            // In that order: Reply, Reply All, Forward.
            expect([...reply.closest("div")!.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Reply", "Reply All", "Forward"]);
            expect(reply.closest("div")!.className).toContain("border-t");
            expect(reply.closest("div")!.className).toContain("print:hidden");

            await user.click(reply);
            await vi.waitFor(() => expect(openCompose).toHaveBeenCalledTimes(1));
            expect(openCompose.mock.calls[0][0]).toMatchObject({ subject: "Re: Hello there", to: "Sender One <sender@example.com>" });

            await user.click(screen.getByRole("button", { name: "Reply all to this message" }));
            await vi.waitFor(() => expect(openCompose).toHaveBeenCalledTimes(2));
            expect(openCompose.mock.calls[1][0]).toMatchObject({ subject: "Re: Hello there" });

            await user.click(screen.getByRole("button", { name: "Forward this message" }));
            await vi.waitFor(() => expect(openCompose).toHaveBeenCalledTimes(3));
            expect(openCompose.mock.calls[2][0]).toMatchObject({ subject: "Fwd: Hello there" });
        });

        it("is only where the caller asks for it, in a thread", () => {
            const { rerender } = render(<MessageDetailPane inThread message={message()} attachments={[]} />);
            expect(screen.queryByRole("button", { name: "Reply to this message" })).not.toBeInTheDocument();
            rerender(<MessageDetailPane inThread footer message={message()} attachments={[]} />);
            expect(screen.getByRole("button", { name: "Reply to this message" })).toBeInTheDocument();
            rerender(<MessageDetailPane footer={false} message={message()} attachments={[]} />);
            expect(screen.queryByRole("button", { name: "Reply to this message" })).not.toBeInTheDocument();
        });
    });

    describe("in a thread", () => {
        function header(overrides: Partial<NonNullable<React.ComponentProps<typeof MessageDetailPane>["threadHeader"]>> = {}) {
            return { bodyId: "thread-message-m1", unread: false, onToggle: vi.fn(), buttonRef: vi.fn(), ...overrides };
        }

        it("draws only the card - no subject card, no scroller - with the sender line as the button that collapses it", async () => {
            const user = userEvent.setup();
            const threadHeader = header();
            const { container } = render(<MessageDetailPane inThread threadHeader={threadHeader} message={message()} attachments={[]} />);
            expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
            expect(container.querySelector(".overflow-y-auto")).toBeNull();
            const button = screen.getByRole("button", { name: /^Sender One <sender@example\.com>/ });
            expect(button).toHaveAttribute("aria-expanded", "true");
            expect(button).toHaveAttribute("aria-controls", "thread-message-m1");
            expect(button.parentElement!.tagName).toBe("H2");
            // Body text, not the display face headings get from the stylesheet.
            expect(button.parentElement!.style.fontFamily).toBe("var(--rr-font-family)");
            expect(threadHeader.buttonRef).toHaveBeenCalledWith(button);
            // What the button controls exists: the card's body region.
            expect(container.querySelector("#thread-message-m1")).not.toBeNull();
            await user.click(button);
            expect(threadHeader.onToggle).toHaveBeenCalledTimes(1);
            // There is no separate "From" line: the button is it.
            expect(screen.queryByText(/^From$/)).not.toBeInTheDocument();
        });

        it("marks an unread message with the accent bar, a tint and a word for assistive technology", () => {
            const { container } = render(<MessageDetailPane inThread threadHeader={header({ unread: true })} message={message()} attachments={[]} />);
            expect(screen.getByRole("button", { name: /^Unread\.\s*Sender One/ })).toBeInTheDocument();
            expect(container.querySelector("[data-unread-bar]")).not.toBeNull();
            expect(container.querySelector(".bg-primary\\/\\[0\\.07\\]")).not.toBeNull();
        });

        it("says nothing of a subject that only differs from the thread's by Re:/Fwd: and case", () => {
            for (const subject of ["Re: Project Zeus", "RE: FW: project zeus", "Fwd: Project Zeus ", "AW: Project Zeus", "Project Zeus"]) {
                const { unmount } = render(<MessageDetailPane inThread threadSubject="Project Zeus" message={message({ subject })} attachments={[]} />);
                expect(screen.queryByRole("heading", { level: 3 }), subject).not.toBeInTheDocument();
                unmount();
            }
        });

        it("shows a subject that is really different, as a lower heading under the thread's h1, and one with no subject at all", () => {
            const { rerender } = render(<MessageDetailPane inThread threadSubject="Project Zeus" message={message({ subject: "Budget question" })} attachments={[]} />);
            expect(screen.getByRole("heading", { level: 3, name: "Budget question" })).toBeInTheDocument();
            rerender(<MessageDetailPane inThread threadSubject="Project Zeus" message={message({ subject: "" })} attachments={[]} />);
            expect(screen.getByRole("heading", { level: 3, name: "(no subject)" })).toBeInTheDocument();
            rerender(<MessageDetailPane inThread threadSubject={undefined} message={message({ subject: "Anything" })} attachments={[]} />);
            expect(screen.getByRole("heading", { level: 3, name: "Anything" })).toBeInTheDocument();
        });
    });

    describe("view original", () => {
        it("is not offered until the body says adapting it to the theme changes something", () => {
            render(<MessageDetailPane message={message()} attachments={[]} />);
            expect(screen.queryByRole("button", { name: "View original" })).not.toBeInTheDocument();
            act(() => {
                bodyProps.current!.onAdaptable(false);
            });
            expect(screen.queryByRole("button", { name: "View original" })).not.toBeInTheDocument();
            act(() => {
                bodyProps.current!.onAdaptable(true);
            });
            const toggle = screen.getByRole("button", { name: "View original" });
            expect(toggle).toHaveAttribute("aria-pressed", "false");
            expect(toggle).toHaveAttribute("title", "View original");
        });

        it("flips just this message between following the theme and its author's rendering, and remembers it for the session", async () => {
            const user = userEvent.setup();
            const first = render(<MessageDetailPane message={message()} attachments={[]} />);
            act(() => {
                bodyProps.current!.onAdaptable(true);
            });
            await user.click(screen.getByRole("button", { name: "View original" }));
            expect(screen.getByTestId("body")).toHaveAttribute("data-original", "true");
            const pressed = screen.getByRole("button", { name: "View original" });
            expect(pressed).toHaveAttribute("aria-pressed", "true");
            expect(pressed).toHaveAttribute("title", "Follow the theme");
            first.unmount();

            // Another mount of the same message keeps it - and offers the toggle at once, so it can be undone - but another message follows the theme.
            const again = render(<MessageDetailPane message={message()} attachments={[]} />);
            expect(screen.getByTestId("body")).toHaveAttribute("data-original", "true");
            expect(screen.getByRole("button", { name: "View original" })).toHaveAttribute("aria-pressed", "true");
            again.unmount();
            render(<MessageDetailPane message={message({ uid: "m2" })} attachments={[]} />);
            expect(screen.getByTestId("body")).toHaveAttribute("data-original", "false");
            expect(screen.queryByRole("button", { name: "View original" })).not.toBeInTheDocument();
        });

        it("goes back to following the theme when flipped again", async () => {
            const user = userEvent.setup();
            render(<MessageDetailPane message={message()} attachments={[]} />);
            act(() => {
                bodyProps.current!.onAdaptable(true);
            });
            await user.click(screen.getByRole("button", { name: "View original" }));
            await user.click(screen.getByRole("button", { name: "View original" }));
            expect(screen.getByTestId("body")).toHaveAttribute("data-original", "false");
        });

        it("is withdrawn for a message whose own dark styles the body honours", async () => {
            const user = userEvent.setup();
            render(<MessageDetailPane message={message()} attachments={[]} />);
            act(() => {
                bodyProps.current!.onAdaptable(true);
            });
            await user.click(screen.getByRole("button", { name: "View original" }));
            act(() => {
                bodyProps.current!.onAdaptable(false);
            });
            expect(screen.queryByRole("button", { name: "View original" })).not.toBeInTheDocument();
        });
    });
});
