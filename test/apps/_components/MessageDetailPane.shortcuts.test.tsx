// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../testUtils.js";
import { mockFetchWithServerBody as mockFetch } from "./paneFetch.js";
import MessageDetailPane from "../../../apps/shared/components/mail/MessageDetailPane.js";
import { ShortcutProvider } from "../../../apps/shared/keyboard/ShortcutProvider.js";

// The keyboard shortcuts of the reading pane (Reply, Reply all, Forward, Archive, Move to): each calls the handler its button calls. The
// compose window, the original message's quote and the crypto are stand-ins - `MessageDetailPane.test.tsx` covers what those do; this file covers
// what the keys do to them.
const { openCompose, loadOriginalMessage, prefetchOriginalMessage } = vi.hoisted(() => ({
    openCompose: vi.fn(),
    loadOriginalMessage: vi.fn(),
    prefetchOriginalMessage: vi.fn(),
}));
vi.mock("../../../apps/shared/components/mail/compose/ComposeContext.js", () => ({
    useCompose: () => ({ openCompose }),
    prefetchComposeWindow: vi.fn(),
}));
vi.mock("../../../apps/shared/components/mail/compose/quotedBody.js", () => ({ loadOriginalMessage, prefetchOriginalMessage }));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys: vi.fn(), subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock: vi.fn() }) }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ moveLocalEntity: vi.fn() }));

const mailbox = {
    uid: "mb1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "Me",
};

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
        recipients: [
            { address: "u1@example.com", displayName: "Me", type: "to" as const },
            { address: "other@example.com", displayName: "Other", type: "cc" as const },
        ],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "Hi",
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    };
}

const FOLDERS = [
    { uid: "f1", mailboxUid: "mb1", name: "Inbox", type: "inbox" },
    { uid: "f5", mailboxUid: "mb1", name: "Receipts", type: "user" },
] as never;

const CTRL = { ctrlKey: true };
const CTRL_SHIFT = { ctrlKey: true, shiftKey: true };
const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) => fireEvent.keyDown(target, { key, ...init });

function renderPane(props: Record<string, unknown> = {}) {
    return render(
        <ShortcutProvider>
            <MessageDetailPane message={messageFixture() as any} attachments={[]} shortcuts {...props} />
        </ShortcutProvider>,
    );
}

let platform: { mockRestore(): void } | undefined;

beforeEach(() => {
    loadOriginalMessage.mockResolvedValue({ body: "<p>The original.</p>", recipients: [] });
    mockFetch((url) => (url.startsWith("/api/mail/mailboxes/") ? jsonResponse(200, mailbox) : jsonResponse(200, {})));
});

afterEach(() => {
    vi.unstubAllGlobals();
    // Not `restoreAllMocks()`: the stand-ins above are `vi.fn()`s whose resolved values `beforeEach` sets afresh, and this one spy is all
    // that has to be undone.
    platform?.mockRestore();
    platform = undefined;
});

describe("MessageDetailPane keyboard shortcuts", () => {
    it("Ctrl+R replies, the way the Reply button does, and the browser is not left to reload", async () => {
        renderPane();

        expect(press("r", CTRL)).toBe(false);

        await waitFor(() => expect(openCompose).toHaveBeenCalledTimes(1));
        expect(openCompose.mock.calls[0][0]).toMatchObject({
            mailboxUid: "mb1",
            to: "Sender One <sender@example.com>",
            subject: "Re: Hello there",
            signatureContext: "reply_forward",
        });
        expect(openCompose.mock.calls[0][0].cc).toBeUndefined();
    });

    it("Ctrl+Shift+R replies to everyone, and Ctrl+Shift+F forwards", async () => {
        renderPane();

        expect(press("R", CTRL_SHIFT)).toBe(false);
        await waitFor(() => expect(openCompose).toHaveBeenCalledTimes(1));
        expect(openCompose.mock.calls[0][0]).toMatchObject({ subject: "Re: Hello there", cc: "Other <other@example.com>" });

        expect(press("F", CTRL_SHIFT)).toBe(false);
        await waitFor(() => expect(openCompose).toHaveBeenCalledTimes(2));
        expect(openCompose.mock.calls[1][0]).toMatchObject({ subject: "Fwd: Hello there", signatureContext: "reply_forward" });
        expect(openCompose.mock.calls[1][0].to).toBeUndefined();
    });

    it("takes no key for a pane that is not the one the keyboard acts on - told so, or just not told", () => {
        for (const shortcuts of [false, undefined]) {
            const { unmount } = renderPane({ shortcuts, folders: FOLDERS });
            expect(press("r", CTRL)).toBe(true);
            expect(press("R", CTRL_SHIFT)).toBe(true);
            expect(press("F", CTRL_SHIFT)).toBe(true);
            expect(press("V", CTRL_SHIFT)).toBe(true);
            expect(press("e")).toBe(true);
            expect(openCompose).not.toHaveBeenCalled();
            unmount();
        }
    });

    it("stops taking the keys when the pane goes away", () => {
        const { unmount } = renderPane();
        unmount();
        expect(press("r", CTRL)).toBe(true);
    });

    it("consumes a second Reply while the first is still preparing its window, exactly as the disabled button would", async () => {
        let release!: () => void;
        loadOriginalMessage.mockReturnValue(new Promise((resolve) => (release = () => resolve({ body: "", recipients: [] }))));
        renderPane();

        press("r", CTRL);
        await waitFor(() => expect(openCompose).toHaveBeenCalledTimes(1));
        expect(screen.getByRole("button", { name: "Reply" })).toBeDisabled();
        expect(press("r", CTRL)).toBe(false);
        expect(press("R", CTRL_SHIFT)).toBe(false);
        expect(press("F", CTRL_SHIFT)).toBe(false);
        expect(openCompose).toHaveBeenCalledTimes(1);
        release();
        await waitFor(() => expect(screen.getByRole("button", { name: "Reply" })).not.toBeDisabled());
    });

    it("names its shortcuts on the buttons: a tooltip suffix and aria-keyshortcuts, with the accessible name unchanged", () => {
        renderPane({ folders: FOLDERS });
        const reply = screen.getByRole("button", { name: "Reply" });
        expect(reply).toHaveAttribute("title", "Reply (Ctrl+R)");
        expect(reply).toHaveAttribute("aria-keyshortcuts", "Control+R");
        expect(screen.getByRole("button", { name: "Reply All" })).toHaveAttribute("title", "Reply All (Ctrl+Shift+R)");
        expect(screen.getByRole("button", { name: "Reply All" })).toHaveAttribute("aria-keyshortcuts", "Control+Shift+R");
        expect(screen.getByRole("button", { name: "Forward" })).toHaveAttribute("title", "Forward (Ctrl+Shift+F)");
        expect(screen.getByRole("button", { name: "Archive" })).toHaveAttribute("title", "Archive (E)");
        expect(screen.getByRole("button", { name: "Archive" })).toHaveAttribute("aria-keyshortcuts", "E Backspace");
        expect(screen.getByRole("button", { name: "Move to" })).toHaveAttribute("title", "Move to (Ctrl+Shift+V)");
    });

    it("says nothing about shortcuts on a pane that has none", () => {
        renderPane({ shortcuts: false, folders: FOLDERS });
        for (const name of ["Reply", "Reply All", "Forward", "Archive", "Move to"]) {
            const button = screen.getByRole("button", { name });
            expect(button).toHaveAttribute("title", name);
            expect(button).not.toHaveAttribute("aria-keyshortcuts");
        }
    });

    it("uses Cmd on a Mac", () => {
        platform = vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
        renderPane();
        expect(screen.getByRole("button", { name: "Reply" })).toHaveAttribute("title", "Reply (⌘R)");
        expect(press("r", { metaKey: true })).toBe(false);
        expect(press("r", CTRL)).toBe(true);
    });

    describe("Archive", () => {
        it("archives with E and with Backspace, through the same call the button makes", async () => {
            const archived = messageFixture({ folderUid: "f-archive" });
            const fetchMock = mockFetch(() => jsonResponse(200, archived));
            const onArchived = vi.fn();
            renderPane({ onArchived });

            expect(press("e")).toBe(false);
            await waitFor(() => expect(onArchived).toHaveBeenCalledWith(archived));
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/messages/m1/archive", expect.objectContaining({ method: "POST" }));

            expect(press("Backspace")).toBe(false);
            await waitFor(() => expect(onArchived).toHaveBeenCalledTimes(2));
        });

        it("ignores a second E while the archive is on the wire", async () => {
            let release!: (response: Response) => void;
            const fetchMock = mockFetch(() => new Promise<Response>((resolve) => (release = resolve)));
            renderPane({ onArchived: vi.fn() });

            press("e");
            await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
            expect(press("e")).toBe(false);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            release(jsonResponse(200, messageFixture({ folderUid: "f-archive" })));
            await waitFor(() => expect(screen.getByRole("button", { name: "Archive" })).not.toBeDisabled());
        });

        it("is not offered for a message in Drafts or in Outbox, where the button is not either", () => {
            const { unmount } = renderPane({ draftsFolderUid: "f1" });
            expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
            expect(press("e")).toBe(true);
            unmount();
            renderPane({ isOutbox: true });
            expect(press("e")).toBe(true);
            expect(press("Backspace")).toBe(true);
        });

        it("leaves E and Backspace to a text field", async () => {
            mockFetch(() => jsonResponse(200, messageFixture({ folderUid: "f-archive" })));
            renderPane({ onArchived: vi.fn() });
            const input = document.createElement("input");
            document.body.appendChild(input);
            expect(press("e", {}, input)).toBe(true);
            expect(press("Backspace", {}, input)).toBe(true);
            input.remove();
        });
    });

    describe("Move to", () => {
        it("opens the move prompt with Ctrl+Shift+V", async () => {
            renderPane({ folders: FOLDERS });

            expect(press("V", CTRL_SHIFT)).toBe(false);

            expect(await screen.findByRole("button", { name: /^Receipts/ })).toBeInTheDocument();
        });

        it("is not offered without folders to move to - and never over a text field's paste-as-plain-text", () => {
            const { unmount } = renderPane();
            expect(press("V", CTRL_SHIFT)).toBe(true);
            unmount();
            renderPane({ folders: FOLDERS });
            const textarea = document.createElement("textarea");
            document.body.appendChild(textarea);
            expect(press("V", CTRL_SHIFT, textarea)).toBe(true);
            textarea.remove();
        });
    });
});
