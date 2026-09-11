// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import ComposeProvider, { useCompose } from "../../../apps/shared/components/mail/compose/ComposeContext.js";

vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: () => <textarea data-testid="html-editor" />,
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
        expect(screen.getByLabelText("To")).toHaveValue("jane@example.com");
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
        await screen.findAllByRole("dialog", { name: "New Message" });

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

        it("minimizing the visible session reveals the previous one, which was not rendered at all until then", async () => {
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
            expect(screen.getAllByTestId("html-editor")).toHaveLength(1);
        });
    });

    it("useCompose()'s default (no enclosing ComposeProvider) is a harmless no-op, not a crash", async () => {
        const user = userEvent.setup();
        render(<Opener mailboxUid="mb1" />);

        await user.click(screen.getByRole("button", { name: "Open mb1" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});
