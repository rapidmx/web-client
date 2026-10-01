// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// A reply's compose window opens as a card in the reading pane that holds the message replied to (`OpenComposeInput.inlineFor`), and
// moves to the floating stack - never remounting - when popped out or when the pane goes away.
import React, { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import ComposeProvider, {
    InlineComposeSlot,
    OpenComposeInput,
    COMPOSE_TOP_VAR,
    useCompose,
    useInlineCompose,
} from "../../../apps/shared/components/mail/compose/ComposeContext.js";

// The compose window is a chunk of its own: brought in once up front rather than inside whichever test opens the first window.
beforeAll(async () => {
    await import("../../../apps/shared/components/mail/compose/ComposeWindow.js");
});

vi.mock("../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: () => <textarea data-testid="html-editor" />,
}));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({
    useUnlockPrompt: () => ({ requestUnlock: vi.fn() }),
}));

function mockDraft() {
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
        if (url.startsWith("/api/mail/messages/") && init?.method === "DELETE") {
            return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

/** A reading pane: holds `uids` and draws a slot for each inline window of them. */
function Pane({ uids, onPlaced }: { uids: string[]; onPlaced?: (slot: HTMLLIElement) => void }) {
    const sessions = useInlineCompose(uids);
    return (
        <ul data-testid="pane">
            {sessions.map((session) => (
                <InlineComposeSlot key={session.id} id={session.id} onPlaced={onPlaced} />
            ))}
        </ul>
    );
}

function Opener({ label, input }: { label: string; input: OpenComposeInput }) {
    const { openCompose } = useCompose();
    return (
        <button type="button" onClick={() => openCompose(input)}>
            {label}
        </button>
    );
}

const REPLY: OpenComposeInput = { mailboxUid: "mb1", to: "jane@example.com", subject: "Re: Hi", signatureContext: "reply_forward", inlineFor: "m1" };

/** The pane that can be shown, hidden or given other messages, the way a reader moves between conversations. */
function Reader({ initial = ["m1", "m2"] }: { initial?: string[] }) {
    const [uids, setUids] = useState<string[] | null>(initial);
    return (
        <>
            <button type="button" onClick={() => setUids(null)}>
                leave
            </button>
            <button type="button" onClick={() => setUids(["m1", "m2"])}>
                return
            </button>
            <button type="button" onClick={() => setUids(["m9"])}>
                other
            </button>
            {uids && <Pane uids={uids} />}
        </>
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty(COMPOSE_TOP_VAR);
});

describe("inline compose", () => {
    it("opens a reply as a card in the pane holding the message, not in the floating stack", async () => {
        mockDraft();
        const user = userEvent.setup();
        const onPlaced = vi.fn();
        render(
            <ComposeProvider>
                <Pane uids={["m1", "m2"]} onPlaced={onPlaced} />
                <Opener label="Reply" input={REPLY} />
            </ComposeProvider>,
        );

        await user.click(screen.getByRole("button", { name: "Reply" }));

        const region = await screen.findByRole("region", { name: "Re: Hi" });
        const slot = screen.getByTestId("pane").querySelector("li[data-inline-compose]")!;
        expect(slot).toContainElement(region);
        expect(onPlaced).toHaveBeenCalledTimes(1);
        expect(onPlaced).toHaveBeenCalledWith(slot);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        // No floating stack is drawn, so the pop-ups have nothing to keep clear of.
        expect(document.documentElement.style.getPropertyValue(COMPOSE_TOP_VAR)).toBe("");
        expect(document.querySelector(".fixed.bottom-0")).toBeNull();
        await waitFor(() => expect(screen.getByTestId("html-editor")).toBeInTheDocument());
    });

    it("floats a reply to a message no pane is showing, as it always did", async () => {
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Pane uids={["m2"]} />
                <Opener label="Reply" input={REPLY} />
            </ComposeProvider>,
        );

        await user.click(screen.getByRole("button", { name: "Reply" }));

        expect(await screen.findByRole("dialog", { name: "Re: Hi" })).toBeInTheDocument();
        expect(screen.queryByRole("region")).not.toBeInTheDocument();
        expect(screen.getByTestId("pane")).toBeEmptyDOMElement();
    });

    it("floats a reply when there is no pane at all, and a new message even beside a pane", async () => {
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Pane uids={["m1"]} />
                <Opener label="Reply" input={REPLY} />
                <Opener label="New" input={{ mailboxUid: "mb1", subject: "Fresh" }} />
            </ComposeProvider>,
        );

        await user.click(screen.getByRole("button", { name: "New" }));
        expect(await screen.findByRole("dialog", { name: "Fresh" })).toBeInTheDocument();
        expect(screen.queryByRole("region")).not.toBeInTheDocument();
    });

    it("pops out to the floating stack without remounting, keeping what was typed", async () => {
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Pane uids={["m1"]} />
                <Opener label="Reply" input={REPLY} />
            </ComposeProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Reply" }));
        const region = await screen.findByRole("region", { name: "Re: Hi" });
        await waitFor(() => expect(screen.getByTestId("html-editor")).toBeInTheDocument());
        const editor = screen.getByTestId<HTMLTextAreaElement>("html-editor");
        await user.type(editor, "typed before the pop out");

        await user.click(screen.getByRole("button", { name: "Pop out" }));

        const dialog = await screen.findByRole("dialog", { name: "Re: Hi" });
        expect(dialog).toBe(region);
        expect(screen.getByTestId("pane")).toBeEmptyDOMElement();
        expect(screen.getByTestId("html-editor")).toBe(editor);
        expect(editor.value).toBe("typed before the pop out");
        // Drawn in the floating stack now, which the pop-ups keep clear of.
        expect(dialog.closest(".fixed.bottom-0")).not.toBeNull();
        expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
    });

    it("parks the window in the floating stack, state intact, when the pane goes away - and does not take it back when the pane returns", async () => {
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Reader />
                <Opener label="Reply" input={REPLY} />
            </ComposeProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Reply" }));
        const region = await screen.findByRole("region", { name: "Re: Hi" });
        await waitFor(() => expect(screen.getByTestId("html-editor")).toBeInTheDocument());
        await user.type(screen.getByTestId("html-editor"), "kept");

        await user.click(screen.getByRole("button", { name: "leave" }));

        const dialog = await screen.findByRole("dialog", { name: "Re: Hi" });
        expect(dialog).toBe(region);
        expect(screen.getByTestId<HTMLTextAreaElement>("html-editor").value).toBe("kept");
        expect(dialog.closest(".fixed.bottom-0")).not.toBeNull();

        await user.click(screen.getByRole("button", { name: "return" }));
        expect(screen.getByTestId("pane")).toBeEmptyDOMElement();
        expect(screen.getByRole("dialog", { name: "Re: Hi" })).toBe(region);
    });

    it("parks the window when the pane moves on to a thread without the message", async () => {
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Reader />
                <Opener label="Reply" input={REPLY} />
            </ComposeProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Reply" }));
        await screen.findByRole("region", { name: "Re: Hi" });

        await user.click(screen.getByRole("button", { name: "other" }));

        expect(await screen.findByRole("dialog", { name: "Re: Hi" })).toBeInTheDocument();
        expect(screen.queryByRole("region")).not.toBeInTheDocument();
    });

    it("keeps the window when the pane only re-announces the same messages", async () => {
        mockDraft();
        const user = userEvent.setup();
        function Changing() {
            const [uids, setUids] = useState(["m1", "m2"]);
            return (
                <>
                    <button type="button" onClick={() => setUids([...uids].reverse())}>
                        reorder
                    </button>
                    <Pane uids={uids} />
                </>
            );
        }
        render(
            <ComposeProvider>
                <Changing />
                <Opener label="Reply" input={REPLY} />
            </ComposeProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Reply" }));
        const region = await screen.findByRole("region", { name: "Re: Hi" });

        await user.click(screen.getByRole("button", { name: "reorder" }));

        expect(screen.getByRole("region", { name: "Re: Hi" })).toBe(region);
    });

    it("removes the slot and the window's element when the card is closed", async () => {
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Pane uids={["m1"]} />
                <Opener label="Reply" input={REPLY} />
            </ComposeProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Reply" }));
        const region = await screen.findByRole("region", { name: "Re: Hi" });
        const container = region.parentElement!;
        await waitFor(() => expect(screen.getByTestId("html-editor")).toBeInTheDocument());

        await user.click(screen.getByRole("button", { name: "Close" }));
        // Nothing has been typed, so there is no draft to ask about; the window just goes (its draft is deleted on the way out).
        await waitFor(() => expect(screen.queryByRole("region")).not.toBeInTheDocument());

        expect(screen.getByTestId("pane")).toBeEmptyDOMElement();
        expect(container.isConnected).toBe(false);
    });

    it("forgets a popped-out window when it is closed", async () => {
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Pane uids={["m1"]} />
                <Opener label="Reply" input={REPLY} />
            </ComposeProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Reply" }));
        await screen.findByRole("region", { name: "Re: Hi" });
        await waitFor(() => expect(screen.getByTestId("html-editor")).toBeInTheDocument());
        await user.click(screen.getByRole("button", { name: "Pop out" }));
        await screen.findByRole("dialog", { name: "Re: Hi" });

        await user.click(screen.getByRole("button", { name: "Close" }));

        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(document.querySelector(".fixed.bottom-0")).toBeNull();
    });

    it("keeps an inline card out of the mobile rule that shows one floating window at a time", async () => {
        mockMatchMedia(true);
        mockDraft();
        const user = userEvent.setup();
        render(
            <ComposeProvider>
                <Pane uids={["m1"]} />
                <Opener label="Reply" input={REPLY} />
                <Opener label="New" input={{ mailboxUid: "mb1", subject: "Fresh" }} />
            </ComposeProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Reply" }));
        await screen.findByRole("region", { name: "Re: Hi" });
        await user.click(screen.getByRole("button", { name: "New" }));

        // The new message is the full-screen sheet; the card is still in the pane, neither hidden nor fixed.
        const region = screen.getByRole("region", { name: "Re: Hi" });
        expect(region).toBeVisible();
        expect(region.className).not.toContain("fixed");
        expect(await screen.findByRole("dialog", { name: "Fresh" })).toBeVisible();
    });

    it("drops the elements it made when the provider goes away", async () => {
        mockDraft();
        const user = userEvent.setup();
        const { unmount } = render(
            <ComposeProvider>
                <Pane uids={["m1"]} />
                <Opener label="Reply" input={REPLY} />
            </ComposeProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Reply" }));
        const container = (await screen.findByRole("region", { name: "Re: Hi" })).parentElement!;

        act(() => unmount());

        expect(container.isConnected).toBe(false);
    });

    it("has nothing to hold outside a provider", () => {
        const onPlaced = vi.fn();
        const { container } = render(
            <>
                <Pane uids={["m1"]} />
                <InlineComposeSlot id="nothing" onPlaced={onPlaced} />
                <InlineComposeSlot id="nothing-either" />
            </>,
        );
        expect(container.querySelectorAll("li[data-inline-compose]")).toHaveLength(2);
        expect(onPlaced).toHaveBeenCalledTimes(1);
    });
});
