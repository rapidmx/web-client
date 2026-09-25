// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import ComposeProvider, { ComposeLateInput, useCompose } from "../../../apps/shared/components/mail/compose/ComposeContext.js";

// The compose window is a chunk of its own, imported when the first window opens; the first render to need it transforms it on demand, which
// takes seconds on a busy machine. It is brought in here, once, rather than inside whichever test happens to open the first window.
beforeAll(async () => {
    await import("../../../apps/shared/components/mail/compose/ComposeWindow.js");
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: () => <textarea data-testid="html-editor" />,
}));

// ComposeWindow's on-demand unlock affordance calls useUnlockPrompt() - real UnlockPromptProvider is
// only mounted by AppShell.tsx, which this file's plain <ComposeProvider> tests never render, so it's
// stubbed the same way RichTextEditor is above.
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({
    useUnlockPrompt: () => ({ requestUnlock: vi.fn() }),
}));

function Opener({ mailboxUid, to }: { mailboxUid: string; to?: string }) {
    const { openCompose } = useCompose();
    return (
        <button type="button" onClick={() => openCompose({ mailboxUid, to })}>
            Open {mailboxUid}
        </button>
    );
}

function mockDraft() {
    return mockFetch((url, init) => {
        if (url.startsWith("/api/mail/folders")) {
            const mailboxUid = new URL(url, "http://localhost").searchParams.get("mailboxUid");
            return jsonResponse(200, [
                {
                    uid: `f-drafts-${mailboxUid}`,
                    version: 0,
                    dateCreated: "2026-01-01T00:00:00.000Z",
                    dateModified: "2026-01-01T00:00:00.000Z",
                    mailboxUid,
                    name: "Drafts",
                    type: "drafts",
                    unreadCount: 0,
                    totalCount: 0,
                },
            ]);
        }
        if (url === "/api/mail/messages" && (init?.method ?? "GET") === "POST") {
            return jsonResponse(200, {
                uid: "m1",
                version: 0,
                dateCreated: "2026-01-01T00:00:00.000Z",
                dateModified: "2026-01-01T00:00:00.000Z",
                folderUid: "f-drafts",
                mailboxUid: "mb1",
                messageId: "abc@webmail",
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

/** The recipients a compose field shows as chips. */
function recipientChips(label: string): (string | null)[] {
    return within(screen.getByRole("list", { name: `${label} recipients` }))
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("title"));
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ComposeProvider / useCompose", () => {
    it("renders no window stack at all when nothing has been opened", () => {
        render(
            <ComposeProvider>
                <span>content</span>
            </ComposeProvider>,
        );
        expect(screen.getByText("content")).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens a Compose window prefilled from openCompose's input", async () => {
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Opener mailboxUid="mb1" to="jane@example.com" />
            </ComposeProvider>,
        );

        await user.click(screen.getByRole("button", { name: "Open mb1" }));

        const dialog = await screen.findByRole("dialog", { name: "New Message" });
        expect(dialog).toBeInTheDocument();
        // The window's frame is up on the click; its fields arrive with its code.
        await waitFor(() => expect(recipientChips("To")).toEqual(["jane@example.com"]));
    });

    it("stacks multiple compose windows side by side when opened more than once", async () => {
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Opener mailboxUid="mb1" />
                <Opener mailboxUid="mb2" />
            </ComposeProvider>,
        );

        await user.click(screen.getByRole("button", { name: "Open mb1" }));
        await user.click(screen.getByRole("button", { name: "Open mb2" }));

        expect(await screen.findAllByRole("dialog", { name: "New Message" })).toHaveLength(2);
    });

    it("closing one window leaves the other open", async () => {
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Opener mailboxUid="mb1" />
                <Opener mailboxUid="mb2" />
            </ComposeProvider>,
        );

        await user.click(screen.getByRole("button", { name: "Open mb1" }));
        await user.click(screen.getByRole("button", { name: "Open mb2" }));
        expect(await screen.findAllByRole("dialog", { name: "New Message" })).toHaveLength(2);

        const [closeButton] = screen.getAllByRole("button", { name: "Close" });
        await user.click(closeButton);

        expect(await screen.findAllByRole("dialog", { name: "New Message" })).toHaveLength(1);
    });

    it("minimizing one window doesn't affect another's state", async () => {
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Opener mailboxUid="mb1" />
                <Opener mailboxUid="mb2" />
            </ComposeProvider>,
        );

        await user.click(screen.getByRole("button", { name: "Open mb1" }));
        await user.click(screen.getByRole("button", { name: "Open mb2" }));
        // A window is a dialog (a placeholder one) while the compose window's code is still being imported: it is the editors that say both
        // windows are really up, and only then is there an editor for minimizing to take away.
        await waitFor(() => expect(screen.getAllByTestId("html-editor")).toHaveLength(2));

        const [minimizeFirst] = screen.getAllByRole("button", { name: "Minimize" });
        await user.click(minimizeFirst);

        // One window collapsed to its compact bar (no more editor for it); the other still has one.
        expect(screen.getAllByTestId("html-editor")).toHaveLength(1);
        expect(screen.getAllByRole("dialog", { name: "New Message" })).toHaveLength(2);
    });

    describe("on mobile", () => {
        it("renders only the most recently opened non-minimized session, not both stacked", async () => {
            mockMatchMedia(true);
            mockDraft();
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <Opener mailboxUid="mb1" />
                    <Opener mailboxUid="mb2" />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Open mb1" }));
            await user.click(screen.getByRole("button", { name: "Open mb2" }));

            expect(await screen.findAllByRole("dialog", { name: "New Message" })).toHaveLength(1);
        });

        it("keeps a session hidden behind a newer one mounted, so what was typed into it survives", async () => {
            mockMatchMedia(true);
            mockDraft();
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <Opener mailboxUid="mb1" />
                    <Opener mailboxUid="mb2" />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Open mb1" }));
            await user.type(await screen.findByLabelText("To"), "first@example.com");
            await user.click(screen.getByRole("button", { name: "Open mb2" }));
            // Both windows stay in the DOM; only the newest is exposed (the older one is `hidden`).
            await waitFor(() => expect(screen.getAllByLabelText("To")).toHaveLength(2));
            expect(screen.getByRole("combobox", { name: "To" })).toHaveValue("");
            expect(screen.queryByRole("list", { name: "To recipients" })).not.toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Minimize" }));

            await screen.findByRole("list", { name: "To recipients" });
            expect(recipientChips("To")).toEqual(["first@example.com"]);
        });

        it("minimizing the visible session reveals the previous one, which was hidden until then", async () => {
            mockMatchMedia(true);
            mockDraft();
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <Opener mailboxUid="mb1" />
                    <Opener mailboxUid="mb2" />
                </ComposeProvider>,
            );

            await user.click(screen.getByRole("button", { name: "Open mb1" }));
            await user.click(screen.getByRole("button", { name: "Open mb2" }));
            await screen.findAllByRole("dialog", { name: "New Message" });

            const [minimizeVisible] = screen.getAllByRole("button", { name: "Minimize" });
            await user.click(minimizeVisible);

            // The newly-minimized session's chip, plus the earlier session now shown full-screen.
            expect(await screen.findAllByRole("dialog", { name: "New Message" })).toHaveLength(2);
            await waitFor(() => expect(screen.getAllByTestId("html-editor")).toHaveLength(1));
        });
    });

    describe("a reply that opens before its quoted original is known (pending)", () => {
        function PendingOpener({ pending }: { pending: () => Promise<ComposeLateInput | undefined> }) {
            const { openCompose } = useCompose();
            return (
                <button type="button" onClick={() => openCompose({ mailboxUid: "mb1", to: "sender@example.com", subject: "Re: Hi", signatureContext: "reply_forward", pending: pending() })}>
                    Reply
                </button>
            );
        }

        it("opens the window and its editor at once, says the original is loading, then takes the better recipients when they arrive", async () => {
            mockDraft();
            const user = userEvent.setup();
            const late = deferred<ComposeLateInput | undefined>();
            render(
                <ComposeProvider>
                    <PendingOpener pending={() => late.promise} />
                </ComposeProvider>,
            );
            await user.click(screen.getByRole("button", { name: "Reply" }));
            expect(await screen.findByRole("dialog", { name: "Re: Hi" })).toBeInTheDocument();
            expect(await screen.findByTestId("html-editor")).toBeInTheDocument();
            expect(await screen.findByText(/Loading the original message/)).toBeInTheDocument();

            late.resolve({ quotedHtml: "<blockquote>Original</blockquote>", to: "alice@example.com" });
            await waitFor(() => expect(recipientChips("To")).toEqual(["alice@example.com"]));
            expect(screen.queryByText(/Loading the original message/)).not.toBeInTheDocument();
        });

        it("carries on without the quote when what it was waiting for never arrives", async () => {
            mockDraft();
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <PendingOpener pending={() => Promise.reject(new Error("no body"))} />
                </ComposeProvider>,
            );
            await user.click(screen.getByRole("button", { name: "Reply" }));
            expect(await screen.findByTestId("html-editor")).toBeInTheDocument();
            await waitFor(() => expect(screen.queryByText(/Loading the original message/)).not.toBeInTheDocument());
            expect(recipientChips("To")).toEqual(["sender@example.com"]);
        });

        it("leaves another open window alone when what one was waiting for arrives", async () => {
            mockDraft();
            const user = userEvent.setup();
            const late = deferred<ComposeLateInput | undefined>();
            render(
                <ComposeProvider>
                    <PendingOpener pending={() => late.promise} />
                    <Opener mailboxUid="mb2" to="other@example.com" />
                </ComposeProvider>,
            );
            await user.click(screen.getByRole("button", { name: "Reply" }));
            await user.click(screen.getByRole("button", { name: "Open mb2" }));
            await screen.findAllByRole("dialog");

            late.resolve({ quotedHtml: "<blockquote>Original</blockquote>", to: "alice@example.com" });
            await waitFor(() => expect(screen.queryByText(/Loading the original message/)).not.toBeInTheDocument());
            expect(screen.getAllByRole("dialog").length).toBeGreaterThanOrEqual(1);
        });

        it("ignores what arrives for a window that was closed meanwhile", async () => {
            mockDraft();
            const user = userEvent.setup();
            const late = deferred<ComposeLateInput | undefined>();
            render(
                <ComposeProvider>
                    <PendingOpener pending={() => late.promise} />
                </ComposeProvider>,
            );
            await user.click(screen.getByRole("button", { name: "Reply" }));
            await screen.findByRole("dialog", { name: "Re: Hi" });
            await user.click(screen.getByRole("button", { name: "Close" }));
            await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
            late.resolve({ quotedHtml: "<blockquote>Original</blockquote>" });
            await act(async () => undefined);
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
    });

    describe("keeping the pop-ups clear of the windows", () => {
        const top = () => document.documentElement.style.getPropertyValue("--rr-compose-top");

        it("publishes where the open windows start as --rr-compose-top, follows their size and the window's, and takes it away when they are closed", async () => {
            mockDraft();
            const callbacks: (() => void)[] = [];
            const disconnect = vi.fn();
            vi.stubGlobal(
                "ResizeObserver",
                class {
                    constructor(callback: () => void) {
                        callbacks.push(callback);
                    }
                    observe() {
                        // Nothing to observe in jsdom.
                    }
                    disconnect = disconnect;
                },
            );
            const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 380 } as DOMRect);
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <Opener mailboxUid="mb1" />
                </ComposeProvider>,
            );
            expect(top()).toBe("");

            await user.click(screen.getByRole("button", { name: "Open mb1" }));
            await waitFor(() => expect(top()).toBe("380px"));
            rect.mockReturnValue({ top: 300 } as DOMRect);
            act(() => callbacks[0]());
            expect(top()).toBe("300px");
            rect.mockReturnValue({ top: 250 } as DOMRect);
            act(() => {
                window.dispatchEvent(new Event("resize"));
            });
            expect(top()).toBe("250px");

            await user.click(screen.getByRole("button", { name: "Close" }));
            await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
            expect(top()).toBe("");
            expect(disconnect).toHaveBeenCalled();
            rect.mockRestore();
        });

        it("still publishes it where there is no ResizeObserver", async () => {
            mockDraft();
            vi.stubGlobal("ResizeObserver", undefined);
            const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 512 } as DOMRect);
            const user = userEvent.setup();
            render(
                <ComposeProvider>
                    <Opener mailboxUid="mb1" />
                </ComposeProvider>,
            );
            await user.click(screen.getByRole("button", { name: "Open mb1" }));
            await waitFor(() => expect(top()).toBe("512px"));
            rect.mockRestore();
        });
    });

    it("useCompose()'s default (no enclosing ComposeProvider) is a harmless no-op, not a crash", async () => {
        const user = userEvent.setup();
        render(<Opener mailboxUid="mb1" />);

        await user.click(screen.getByRole("button", { name: "Open mb1" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});
