// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ConversationThreadPane from "../../../apps/shared/components/mail/ConversationThreadPane.js";
import MailAddress from "../../../apps/shared/components/mail/MailAddress.js";

// `MessageDetailPane`'s own rendering is exhaustively tested in its own file - mocked here so this file
// only exercises the thread pane's own concerns: loading the thread, which messages are expanded, where it
// scrolls, per-message actions and keeping the caller's list in step. The mock draws what the thread hands an expanded card: the sender
// button that collapses it (`threadHeader`), and the body it controls.
// A stand-in pane can leave out the sender button (the pane draws it and registers its ref); the thread must cope.
const paneOptions = vi.hoisted(() => ({ omitHeaderButton: false }));

vi.mock("../../../apps/shared/components/mail/MessageDetailPane.js", () => ({
    default: ({
        message,
        attachments,
        isSentItems,
        isOutbox,
        draftsFolderUid,
        inThread,
        threadSubject,
        threadHeader,
        footer,
        shortcuts,
        onArchived,
        onLabelsChanged,
        labels,
    }: {
        message: { uid: string; labelUids?: string[]; from: { address: string; displayName?: string } } | null;
        attachments: { filename: string }[];
        isSentItems?: boolean;
        isOutbox?: boolean;
        draftsFolderUid?: string;
        inThread?: boolean;
        threadSubject?: string;
        threadHeader?: { bodyId: string; unread: boolean; onToggle: () => void; buttonRef: (node: HTMLButtonElement | null) => void };
        footer?: boolean;
        shortcuts?: boolean;
        onArchived?: (updated: Record<string, unknown>) => void;
        onLabelsChanged?: (updated: Record<string, unknown>) => void;
        labels?: { uid: string }[];
    }) => (
        <div data-testid={`detail-${message!.uid}`}>
            {threadHeader && !paneOptions.omitHeaderButton && (
                <h2>
                    <button
                        type="button"
                        ref={threadHeader.buttonRef}
                        aria-expanded="true"
                        aria-controls={threadHeader.bodyId}
                        onClick={threadHeader.onToggle}
                        data-unread-header={String(threadHeader.unread)}
                    >
                        {threadHeader.unread && <span className="sr-only">Unread. </span>}
                        <MailAddress recipient={message!.from} />
                    </button>
                </h2>
            )}
            <span id={threadHeader?.bodyId}>
            thread-subject:{threadSubject} footer:{String(!!footer)} body:{message!.uid} attachments:{attachments.map((a) => a.filename).join(",")} sentItems:
            {String(!!isSentItems)} outbox:{String(!!isOutbox)} drafts:
            {draftsFolderUid ?? "unset"} inThread:{String(!!inThread)} shortcuts:{String(!!shortcuts)} labels:{(labels ?? []).length}
            </span>
            <button type="button" onClick={() => onArchived!({ ...message, folderUid: "f-archive" })}>
                archive-{message!.uid}
            </button>
            <button type="button" onClick={() => onLabelsChanged!({ ...message, version: 9, labelUids: ["l1"] })}>
                label-{message!.uid}
            </button>
            <button type="button" onClick={() => onLabelsChanged!({ ...message, version: 10, flags: { ...(message as any).flags, read: false } })}>
                unread-{message!.uid}
            </button>
        </div>
    ),
}));

function folderFixture(uid: string, name: string, type: string) {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        name,
        type,
    };
}

const FOLDERS = [folderFixture("f1", "Inbox", "inbox"), folderFixture("f2", "Sent Items", "sent_items"), folderFixture("f3", "Drafts", "drafts")];

function messageFixture(uid: string, sender: string, overrides: Record<string, unknown> = {}) {
    return {
        uid,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: `${uid}@example.com`,
        subject: "Project Zeus",
        from: { address: `${sender.toLowerCase()}@example.com`, displayName: sender, type: "to" as const },
        recipients: [],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: `Preview of ${uid}`,
        flags: { read: true, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    };
}

const THREAD = [messageFixture("m1", "Alice"), messageFixture("m2", "Bob"), messageFixture("m3", "Carol")];

function conversationFixture(overrides: Record<string, unknown> = {}) {
    return {
        conversationId: "c1",
        subject: "Project Zeus",
        messageUids: ["m1", "m2", "m3"],
        folderUids: ["f1"],
        messageCount: 3,
        unreadCount: 0,
        latestDate: "2026-01-01T00:00:00.000Z",
        participants: [{ address: "alice@example.com", displayName: "Alice", type: "to" as const }],
        hasAttachments: false,
        flagged: false,
        latestMessageUid: "m3",
        latestFrom: { address: "carol@example.com", displayName: "Carol", type: "to" as const },
        latestPreview: "Preview of m3",
        latestFolderUid: "f1",
        ...overrides,
    };
}

/** Renders the pane over a thread the server answers with, plus whatever else a test's `extra` handles. */
function renderThread(
    props: Partial<React.ComponentProps<typeof ConversationThreadPane>> = {},
    thread: unknown[] = THREAD,
    extra?: (url: string, init?: RequestInit) => Response | undefined,
) {
    const fetchMock = mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/messages/conversations/")) {
            const page = Number(new URLSearchParams(url.split("?")[1]).get("page") ?? 0);
            return jsonResponse(200, thread.slice(page * 100, page * 100 + 100));
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
    const onMessagePatched = vi.fn();
    const onMessageRemoved = vi.fn();
    const result = render(
        <ConversationThreadPane
            conversation={conversationFixture()}
            mailboxUid="mb1"
            selectedUid="m3"
            folders={FOLDERS}
            onMessagePatched={onMessagePatched}
            onMessageRemoved={onMessageRemoved}
            {...props}
        />,
    );
    return { fetchMock, onMessagePatched, onMessageRemoved, ...result };
}

/** The header button of the message `sender` sent - an unread one starts with a visually hidden "Unread.". */
function header(sender: string) {
    return screen.getByRole("button", { name: new RegExp(`^(Unread[.])?${sender}`) });
}

/** The uids of the thread's entries, in the order the pane actually renders them. */
function renderedOrder(): string[] {
    return screen
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-controls"))
        .filter((controls): controls is string => !!controls?.startsWith("thread-message-"))
        .map((controls) => controls.replace("thread-message-", ""));
}

/** Each entry's uid paired with whether it is expanded, in rendered order. */
function renderedPattern(): [string, string | null][] {
    return screen
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-controls")?.startsWith("thread-message-"))
        .map((button) => [
            button.getAttribute("aria-controls")!.replace("thread-message-", ""),
            button.getAttribute("aria-expanded"),
        ]);
}

afterEach(() => {
    paneOptions.omitHeaderButton = false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("ConversationThreadPane", () => {
    it("shows each message's sender with their address in the entry's header", async () => {
        renderThread();
        await screen.findAllByRole("heading", { level: 2 });
        expect(screen.getByText("Alice <alice@example.com>", { selector: ".sr-only" })).toBeInTheDocument();
        expect(screen.getByText("Carol <carol@example.com>", { selector: ".sr-only" })).toBeInTheDocument();
    });

    describe("keyboard shortcuts", () => {
        /** Which expanded messages were told to register the reading pane's shortcuts. */
        const registering = () =>
            THREAD.map((message) => message.uid).filter((uid) => screen.queryByTestId(`detail-${uid}`)?.textContent?.includes("shortcuts:true"));

        it("hands them to the opened message only - never to every expanded one, which would fight over Ctrl+R", async () => {
            renderThread({ shortcuts: true, selectedUid: "m1" });
            await screen.findByTestId("detail-m1");
            // Opening m1 expands it and everything above it.
            expect(screen.getByTestId("detail-m2")).toBeInTheDocument();
            expect(screen.getByTestId("detail-m3")).toBeInTheDocument();
            expect(registering()).toEqual(["m1"]);
        });

        it("does not read a message straight back after the reader marks it unread while it is open (Ctrl+U on a message that was already read)", async () => {
            const user = userEvent.setup();
            const { fetchMock } = renderThread({ shortcuts: true });
            await screen.findByTestId("detail-m3");
            const writes = () => fetchMock.mock.calls.filter(([, init]: any) => init?.method === "PUT");
            expect(writes()).toHaveLength(0);

            await user.click(screen.getByRole("button", { name: "unread-m3" }));

            // Nothing is sent: it was asked about once, when it was opened, and it was already read then.
            await new Promise((resolve) => setTimeout(resolve, 30));
            expect(writes()).toHaveLength(0);
        });

        it("falls back to the newest message when the opened one is not in the thread", async () => {
            renderThread({ shortcuts: true, selectedUid: "not-in-this-thread" });
            await screen.findByTestId("detail-m3");
            expect(registering()).toEqual(["m3"]);
        });

        it("hands them to nobody unless the caller asks (select mode has the keyboard for itself)", async () => {
            renderThread({ selectedUid: "m1" });
            await screen.findByTestId("detail-m1");
            expect(registering()).toEqual([]);
        });
    });

    it("says what to do with no conversation open", () => {
        render(
            <ConversationThreadPane
                conversation={null}
                mailboxUid="mb1"
                selectedUid={null}
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />,
        );
        expect(screen.getByText("Select a conversation to read it.")).toBeInTheDocument();
    });

    it("opens the whole thread at its newest message, with the older ones collapsed", async () => {
        renderThread();

        expect(await screen.findByTestId("detail-m3")).toBeInTheDocument();
        expect(screen.queryByTestId("detail-m1")).not.toBeInTheDocument();
        expect(screen.queryByTestId("detail-m2")).not.toBeInTheDocument();
        expect(header("Carol")).toHaveAttribute("aria-expanded", "true");
        expect(header("Alice")).toHaveAttribute("aria-expanded", "false");
        // A collapsed message is a one-line summary: sender, date and preview.
        expect(header("Alice")).toHaveTextContent("Preview of m1");
        expect(header("Carol")).not.toHaveTextContent("Preview of m3");
        expect(screen.getByRole("heading", { level: 1, name: "Project Zeus" })).toBeInTheDocument();
        expect(screen.getByText("3 messages")).toBeInTheDocument();
    });

    it("lists the thread newest first, whatever the list it was opened from is sorted by", async () => {
        // The pane's order is the pane's own - the reading order for mail - not the arrangement the message
        // list happens to be in, so the message a conversation row stands for is always the top entry.
        renderThread();
        await screen.findByTestId("detail-m3");

        expect(renderedOrder()).toEqual(["m3", "m2", "m1"]);
        // The newest is the one expanded, and it is the entry at the top.
        expect(renderedPattern()).toEqual([
            ["m3", "true"],
            ["m2", "false"],
            ["m1", "false"],
        ]);
    });

    it("expands the opened message and everything above it, collapsing what is below", async () => {
        renderThread({ selectedUid: "m2" });
        await screen.findByTestId("detail-m2");

        expect(renderedPattern()).toEqual([
            ["m3", "true"],
            ["m2", "true"],
            ["m1", "false"],
        ]);
    });

    it("expands every entry when the oldest - the bottom one - was opened", async () => {
        renderThread({ selectedUid: "m1" });
        await screen.findByTestId("detail-m1");

        expect(renderedPattern()).toEqual([
            ["m3", "true"],
            ["m2", "true"],
            ["m1", "true"],
        ]);
    });

    it("reverses a paged thread once, so page order never reaches the reader", async () => {
        // The pages arrive oldest first (and the 500-message cap has to apply in that order - it is the
        // oldest that are dropped), so the reversal happens after the last page, not per page.
        const many = Array.from({ length: 120 }, (_, i) => messageFixture(`x${i}`, `Sender${i}`));
        renderThread({ selectedUid: "x119" }, many);
        await screen.findByTestId("detail-x119");

        const order = renderedOrder();
        expect(order[0]).toBe("x119");
        expect(order[1]).toBe("x118");
        expect(order[order.length - 1]).toBe("x0");
    });

    it("scrolls the messages as a whole, each card exactly as tall as its message, with a gap between the cards", async () => {
        renderThread();
        await screen.findByTestId("detail-m3");

        // The scrolling list is the pane's one growing child, under the subject card that stays put...
        const list = screen.getByTestId("detail-m3").closest("ul")!;
        expect(list.className).toContain("flex-1");
        expect(list.className).toContain("min-h-0");
        expect(list.className).toContain("overflow-y-auto");
        // ...its cards separated by a gap rather than a rule...
        expect(list.className).toContain("gap-3");
        // ...and no card has a height of its own: a message is as tall as what it holds, expanded or not.
        for (const row of [screen.getByTestId("detail-m3").closest("li")!, header("Alice").closest("li")!]) {
            expect(row.className).not.toMatch(/min-h-full|h-full|h-\[\d/);
        }
        const subjectCard = screen.getByRole("heading", { level: 1 }).closest("header")!;
        expect(list.parentElement!.firstElementChild).toBe(subjectCard);
        expect(subjectCard.className).toContain("shrink-0");
    });

    it("expands the run from the message that was opened through to the newest", async () => {
        renderThread({ selectedUid: "m2" });

        expect(await screen.findByTestId("detail-m2")).toBeInTheDocument();
        expect(screen.getByTestId("detail-m3")).toBeInTheDocument();
        expect(screen.queryByTestId("detail-m1")).not.toBeInTheDocument();
    });

    it("expands every message when the oldest one was opened", async () => {
        renderThread({ selectedUid: "m1" });

        expect(await screen.findByTestId("detail-m1")).toBeInTheDocument();
        expect(screen.getByTestId("detail-m2")).toBeInTheDocument();
        expect(screen.getByTestId("detail-m3")).toBeInTheDocument();
    });

    it("falls back to the newest message when the selected one isn't in this thread", async () => {
        renderThread({ selectedUid: "gone" });

        expect(await screen.findByTestId("detail-m3")).toBeInTheDocument();
        expect(screen.queryByTestId("detail-m2")).not.toBeInTheDocument();
    });

    it("gives the message it opened at focus, leaving the page alone when nothing inside the pane scrolls", async () => {
        const intoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
        renderThread({ selectedUid: "m2" });

        await screen.findByTestId("detail-m2");

        expect(document.activeElement).toBe(header("Bob"));
        // Never `scrollIntoView()`, which scrolls every scrollable ancestor - the window included.
        expect(intoView).not.toHaveBeenCalled();
        expect(document.documentElement.scrollTop).toBe(0);
    });

    it("leaves the focus on a list row that a key press moved it to, so Enter still opens the message page, but takes it after a click", async () => {
        vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
        const row = document.createElement("div");
        row.setAttribute("data-message-uid", "row");
        const rowButton = document.createElement("button");
        rowButton.setAttribute("data-row-open", "true");
        row.appendChild(rowButton);
        document.body.appendChild(row);
        const matches = Element.prototype.matches;
        let ring: boolean | "throws" = true;
        vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
            if (selector === ":focus-visible") {
                if (ring === "throws") throw new SyntaxError("':focus-visible' is not a valid selector");
                return ring;
            }
            return matches.call(this, selector);
        });
        rowButton.focus();
        const first = renderThread({ selectedUid: "m2" });
        await screen.findByTestId("detail-m2");
        expect(document.activeElement).toBe(rowButton);
        first.unmount();

        // No focus ring: a click. The thread takes the focus, as it always has.
        ring = false;
        rowButton.focus();
        const second = renderThread({ selectedUid: "m2" });
        await screen.findByTestId("detail-m2");
        expect(document.activeElement).toBe(header("Bob"));
        second.unmount();

        // A browser that can't answer `:focus-visible` counts as no ring: the thread takes the focus.
        ring = "throws";
        rowButton.focus();
        renderThread({ selectedUid: "m2" });
        await screen.findByTestId("detail-m2");
        expect(document.activeElement).toBe(header("Bob"));
        row.remove();
    });

    /** Makes `node` the element `scrollingAncestor()` resolves to: jsdom has neither styles nor layout. */
    function makeScroller(node: HTMLElement, top: number, clientHeight: number) {
        node.style.overflowY = "auto";
        Object.defineProperty(node, "scrollHeight", { value: 4000, configurable: true });
        Object.defineProperty(node, "clientHeight", { value: clientHeight, configurable: true });
        node.getBoundingClientRect = () => ({ top }) as DOMRect;
    }

    it("scrolls the thread's own list to a message opened below the fold, and nothing else", async () => {
        const { rerender, container } = renderThread({ selectedUid: "m3" });
        await screen.findByTestId("detail-m3");
        const list = container.querySelector("ul") as HTMLElement;
        makeScroller(list, 100, 500);
        list.scrollTop = 0;
        // The oldest message sits 800px below the list's own top - well past its 500px of view.
        header("Alice").closest("li")!.getBoundingClientRect = () => ({ top: 900, height: 400 }) as DOMRect;

        rerender(
            <ConversationThreadPane
                conversation={conversationFixture()}
                mailboxUid="mb1"
                selectedUid="m1"
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />,
        );
        await screen.findByTestId("detail-m1");

        expect(list.scrollTop).toBe(800);
        expect(document.documentElement.scrollTop).toBe(0);
    });

    it("leaves the thread's list where it is when the opened message is already in view", async () => {
        const { rerender, container } = renderThread({ selectedUid: "m3" });
        await screen.findByTestId("detail-m3");
        const list = container.querySelector("ul") as HTMLElement;
        makeScroller(list, 0, 500);
        list.scrollTop = 30;
        header("Alice").closest("li")!.getBoundingClientRect = () => ({ top: 10, height: 100 }) as DOMRect;

        rerender(
            <ConversationThreadPane
                conversation={conversationFixture()}
                mailboxUid="mb1"
                selectedUid="m1"
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />,
        );
        await screen.findByTestId("detail-m1");

        expect(list.scrollTop).toBe(30);
    });

    it("re-opens at another message of the same thread without reloading it", async () => {
        const { fetchMock, rerender } = renderThread({ selectedUid: "m3" });
        await screen.findByTestId("detail-m3");
        const threadRequests = () =>
            fetchMock.mock.calls.filter(([url]: [string]) => String(url).includes("/conversations/c1")).length;
        const before = threadRequests();

        rerender(
            <ConversationThreadPane
                conversation={conversationFixture()}
                mailboxUid="mb1"
                selectedUid="m1"
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />,
        );

        expect(await screen.findByTestId("detail-m1")).toBeInTheDocument();
        expect(threadRequests()).toBe(before);
    });

    it("expands a collapsed message on click and keeps it where it was on screen", async () => {
        const user = userEvent.setup();
        const { container } = renderThread();
        await screen.findByTestId("detail-m3");

        const row = header("Alice").closest("li")!;
        // The thread isn't itself the scroll container - the mail shell's own `<main>` is - so the
        // adjustment has to land on whichever ancestor actually scrolls.
        const scroller = container.firstElementChild as HTMLElement;
        scroller.style.overflowY = "auto";
        Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
        Object.defineProperty(scroller, "clientHeight", { value: 500, configurable: true });
        // jsdom has no layout: stand in for the row sitting 60px lower once it has a body, by answering
        // the click with where it was and the layout pass that follows with where it ended up.
        let reads = 0;
        row.getBoundingClientRect = () => ({ top: reads++ === 0 ? 100 : 160 }) as DOMRect;
        scroller.scrollTop = 40;

        await user.click(header("Alice"));

        expect(screen.getByTestId("detail-m1")).toBeInTheDocument();
        expect(header("Alice")).toHaveAttribute("aria-expanded", "true");
        // Expanding a message above the one being read moved it down 60px, so the scroller followed it.
        expect(scroller.scrollTop).toBe(100);
    });

    it("leaves the page alone when nothing around the thread scrolls", async () => {
        const user = userEvent.setup();
        renderThread();
        await screen.findByTestId("detail-m3");
        const row = header("Alice").closest("li")!;
        let reads = 0;
        row.getBoundingClientRect = () => ({ top: reads++ === 0 ? 100 : 160 }) as DOMRect;
        document.documentElement.scrollTop = 0;

        await user.click(header("Alice"));

        // Nothing here overflows, so the fallback is the page itself.
        expect(document.documentElement.scrollTop).toBe(60);
    });

    it("collapses an expanded message again, from the keyboard", async () => {
        const user = userEvent.setup();
        renderThread();
        await screen.findByTestId("detail-m3");

        header("Carol").focus();
        await user.keyboard("{Enter}");

        expect(screen.queryByTestId("detail-m3")).not.toBeInTheDocument();
        expect(header("Carol")).toHaveAttribute("aria-expanded", "false");
    });

    it("copes with a message pane that draws no sender button: nothing to focus, and expanding still works", async () => {
        paneOptions.omitHeaderButton = true;
        const user = userEvent.setup();
        renderThread({ selectedUid: "m3" });
        await screen.findByTestId("detail-m3");

        await user.click(header("Alice"));

        expect(screen.getByTestId("detail-m1")).toBeInTheDocument();
    });

    it("keeps the focus on a message's header button as it collapses and expands, though each state draws its own button", async () => {
        const user = userEvent.setup();
        renderThread();
        await screen.findByTestId("detail-m3");

        header("Carol").focus();
        await user.keyboard("{Enter}");
        expect(header("Carol")).toHaveAttribute("aria-expanded", "false");
        expect(document.activeElement).toBe(header("Carol"));

        await user.keyboard("{Enter}");
        expect(header("Carol")).toHaveAttribute("aria-expanded", "true");
        expect(document.activeElement).toBe(header("Carol"));

        // A click focuses the button it lands on, as a browser does, and that stays true after the swap.
        await user.click(header("Alice"));
        expect(screen.getByTestId("detail-m1")).toBeInTheDocument();
        expect(document.activeElement).toBe(header("Alice"));

        // Toggled with the focus elsewhere - as when another control expanded it - the focus is left alone.
        (document.activeElement as HTMLElement).blur();
        fireEvent.click(header("Bob"));
        expect(header("Bob")).toHaveAttribute("aria-expanded", "true");
        expect(document.activeElement).toBe(document.body);
    });

    it("marks only the expanded messages as read, and hands the newer copies to the list", async () => {
        const unread = { read: false, flagged: false, answered: false, forwarded: false };
        const thread = [
            messageFixture("m1", "Alice", { flags: unread }),
            messageFixture("m2", "Bob", { flags: unread }),
            messageFixture("m3", "Carol", { flags: unread }),
        ];
        const { fetchMock, onMessagePatched } = renderThread({ selectedUid: "m2" }, thread, (url, init) => {
            if (url.startsWith("/api/mail/messages/") && init?.method === "PUT") {
                const uid = url.split("/").pop()!;
                return jsonResponse(200, messageFixture(uid, "Bob", { version: 1 }));
            }
            return undefined;
        });

        await screen.findByTestId("detail-m2");
        // Each of the two: the optimistic copy at once, then the server's.
        await waitFor(() => expect(onMessagePatched).toHaveBeenCalledTimes(4));
        expect(onMessagePatched).toHaveBeenCalledWith(
            expect.objectContaining({ uid: "m2", flags: expect.objectContaining({ read: true }), version: 0 }),
            expect.objectContaining({ uid: "m2", flags: unread }),
        );
        expect(onMessagePatched).toHaveBeenCalledWith(expect.objectContaining({ uid: "m2", version: 1 }), undefined);
        const marked = fetchMock.mock.calls
            .filter(([, init]: [string, RequestInit]) => init?.method === "PUT")
            .map(([url]: [string]) => String(url).split("/").pop());
        expect(marked.sort()).toEqual(["m2", "m3"]);
    });

    it("loads an expanded message's attachments and passes them to its own pane", async () => {
        const thread = [messageFixture("m1", "Alice"), messageFixture("m2", "Bob", { hasAttachments: true })];
        renderThread({ selectedUid: "m2" }, thread, (url) => {
            if (url.startsWith("/api/mail/attachments")) return jsonResponse(200, [{ uid: "a1", filename: "notes.txt" }]);
            return undefined;
        });

        // `findByTestId` resolves the moment the row mounts, which is before its attachments request has
        // landed - the assertion has to be the thing that retries, or this races under full-suite load.
        await waitFor(() => expect(screen.getByTestId("detail-m2")).toHaveTextContent("attachments:notes.txt"));
    });

    it("tells each message's own pane which folder that message is in", async () => {
        const thread = [messageFixture("m1", "Alice", { folderUid: "f2" }), messageFixture("m2", "Bob")];
        renderThread({ selectedUid: "m1" }, thread);

        expect(await screen.findByTestId("detail-m1")).toHaveTextContent("sentItems:true");
        expect(screen.getByTestId("detail-m1")).toHaveTextContent("drafts:f3");
        expect(screen.getByTestId("detail-m2")).toHaveTextContent("sentItems:false");
        expect(screen.getByTestId("detail-m2")).toHaveTextContent("inThread:true");
    });

    it("takes a message out of the thread, and tells the list, when it is archived", async () => {
        const user = userEvent.setup();
        const { onMessageRemoved } = renderThread({ selectedUid: "m2" });
        await screen.findByTestId("detail-m2");

        await user.click(within(screen.getByTestId("detail-m2")).getByRole("button", { name: "archive-m2" }));

        expect(screen.queryByTestId("detail-m2")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Bob/ })).not.toBeInTheDocument();
        expect(onMessageRemoved).toHaveBeenCalledWith(expect.objectContaining({ uid: "m2", folderUid: "f-archive" }));
        expect(screen.getByText("2 messages")).toBeInTheDocument();
    });

    it("keeps a newer copy of a message an action produced, and tells the list", async () => {
        const user = userEvent.setup();
        const { onMessagePatched } = renderThread({ selectedUid: "m3", labels: [{ uid: "l1" } as never] });
        await screen.findByTestId("detail-m3");

        await user.click(screen.getByRole("button", { name: "label-m3" }));

        expect(onMessagePatched).toHaveBeenCalledWith(expect.objectContaining({ uid: "m3", labelUids: ["l1"] }), undefined);
        // The pane keeps it too, so the next action carries the version the last one came back with.
        expect(screen.getByTestId("detail-m3")).toHaveTextContent("labels:1");
    });

    it("pages a long thread, and says so once it stops", { timeout: 30_000 }, async () => {
        const many = Array.from({ length: 500 }, (_, i) => messageFixture(`x${i}`, `Sender${i}`));
        const { fetchMock } = renderThread({ selectedUid: `x499` }, many);

        // 500 cards (an avatar, an address and a preview each) take a while to lay out, longer under coverage.
        expect(await screen.findByTestId("detail-x499", undefined, { timeout: 15_000 })).toBeInTheDocument();
        const pages = fetchMock.mock.calls
            .filter(([url]: [string]) => String(url).includes("/conversations/c1"))
            .map(([url]: [string]) => new URLSearchParams(String(url).split("?")[1]).get("page"));
        expect(pages).toEqual(["0", "1", "2", "3", "4"]);
        expect(
            screen.getByText(/Only the oldest 500 messages of this conversation are shown here/),
        ).toBeInTheDocument();
    });

    it("asks for a second page only while the one before it was full", async () => {
        const thread = Array.from({ length: 120 }, (_, i) => messageFixture(`x${i}`, `Sender${i}`));
        const { fetchMock } = renderThread({ selectedUid: "x119" }, thread);

        expect(await screen.findByTestId("detail-x119")).toBeInTheDocument();
        const pages = fetchMock.mock.calls
            .filter(([url]: [string]) => String(url).includes("/conversations/c1"))
            .map(([url]: [string]) => new URLSearchParams(String(url).split("?")[1]).get("page"));
        expect(pages).toEqual(["0", "1"]);
        expect(screen.queryByText(/Only the oldest/)).not.toBeInTheDocument();
        expect(screen.getByText("120 messages")).toBeInTheDocument();
    });

    it("draws the subject card and a skeleton card per message at once while the thread is being fetched, then fills them in", async () => {
        let resolveThread: ((value: Response) => void) | undefined;
        mockFetch(() => new Promise<Response>((resolve) => (resolveThread = resolve)));
        render(
            <ConversationThreadPane
                conversation={conversationFixture()}
                mailboxUid="mb1"
                selectedUid="m3"
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />,
        );

        // The list row already knows the subject and the count, so the pane's frame is there before any message is.
        expect(screen.getByRole("status")).toHaveTextContent("Loading the message");
        expect(screen.getByRole("heading", { level: 1, name: "Project Zeus" })).toBeInTheDocument();
        expect(screen.getByText("3 messages")).toBeInTheDocument();
        expect(document.querySelectorAll("[aria-hidden='true'].rounded-lg")).toHaveLength(3);
        resolveThread!(jsonResponse(200, THREAD));
        expect(await screen.findByTestId("detail-m3")).toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        // The same header card stays: it was not swapped for another.
        expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    });

    it("says why a thread couldn't be loaded", async () => {
        mockFetch(() => jsonResponse(500, { message: "thread boom" }));
        render(
            <ConversationThreadPane
                conversation={conversationFixture()}
                mailboxUid="mb1"
                selectedUid="m3"
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />,
        );

        expect(await screen.findByText("thread boom")).toBeInTheDocument();
    });

    it("says something generic when the load fails with no API message", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(
            <ConversationThreadPane
                conversation={conversationFixture()}
                mailboxUid="mb1"
                selectedUid="m3"
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />,
        );

        expect(await screen.findByText("Could not load this conversation.")).toBeInTheDocument();
    });

    it("names a conversation with no subject, and counts a single message in the singular", async () => {
        renderThread({ conversation: conversationFixture({ subject: "", messageCount: 1 }) }, [messageFixture("m1", "Alice")]);

        await screen.findByTestId("detail-m1");
        expect(screen.getByRole("heading", { level: 1, name: "(no subject)" })).toBeInTheDocument();
        expect(screen.getByText("1 message")).toBeInTheDocument();
    });

    it("calls an encrypted thread 'Encrypted message' rather than by the placeholder subject, and a collapsed encrypted message says so with a lock", async () => {
        renderThread(
            { conversation: conversationFixture({ subject: "[...]", messageCount: 2 }), selectedUid: "m2" },
            [
                messageFixture("m1", "Alice", { subject: "[...]", bodyPreview: "", encrypted: true }),
                messageFixture("m2", "Bob", { subject: "[...]", bodyPreview: "", encrypted: true }),
            ],
        );

        await screen.findByTestId("detail-m2");
        expect(screen.getByRole("heading", { level: 1, name: "Encrypted message" })).toBeInTheDocument();
        const collapsed = header("Alice");
        expect(collapsed).toHaveTextContent("Encrypted message");
        expect(collapsed.querySelector("svg[aria-hidden=true]")).not.toBeNull();
    });

    it("leaves a collapsed message with no preview and no encryption blank", async () => {
        renderThread({ selectedUid: "m2", conversation: conversationFixture({ messageCount: 2 }) }, [
            messageFixture("m1", "Alice", { bodyPreview: "" }),
            messageFixture("m2", "Bob"),
        ]);

        await screen.findByTestId("detail-m2");
        expect(header("Alice")).not.toHaveTextContent("Encrypted message");
    });

    it("falls back to a sender's address when it has no display name", async () => {
        renderThread({ selectedUid: "m1" }, [
            messageFixture("m1", "Alice", { from: { address: "nameless@example.com", type: "to" } }),
        ]);

        await screen.findByTestId("detail-m1");
        expect(screen.getByRole("button", { name: /^nameless@example\.com/ })).toBeInTheDocument();
    });

    it("drops attachments that land after the reader has moved to another conversation", async () => {
        let resolveAttachments: ((value: Response) => void) | undefined;
        mockFetch((url) => {
            if (url.startsWith("/api/mail/attachments")) {
                // Only the first conversation's request is left hanging; the second answers at once.
                return url.includes("m1")
                    ? new Promise<Response>((resolve) => (resolveAttachments = resolve))
                    : jsonResponse(200, []);
            }
            if (url.includes("/conversations/c1")) return jsonResponse(200, [messageFixture("m1", "Alice", { hasAttachments: true })]);
            return jsonResponse(200, [messageFixture("z1", "Zoe", { hasAttachments: true })]);
        });
        const props = {
            mailboxUid: "mb1",
            folders: FOLDERS,
            onMessagePatched: vi.fn(),
            onMessageRemoved: vi.fn(),
        };
        const { rerender } = render(<ConversationThreadPane conversation={conversationFixture()} selectedUid="m1" {...props} />);
        await screen.findByTestId("detail-m1");

        rerender(
            <ConversationThreadPane
                conversation={conversationFixture({ conversationId: "c2", latestMessageUid: "z1" })}
                selectedUid="z1"
                {...props}
            />,
        );
        await screen.findByTestId("detail-z1");

        resolveAttachments!(jsonResponse(200, [{ uid: "a1", filename: "stale.txt" }]));
        await waitFor(() => expect(screen.getByTestId("detail-z1")).toBeInTheDocument());
        expect(screen.getByTestId("detail-z1")).not.toHaveTextContent("stale.txt");
    });

    it("forgets a failed attachments request, so re-expanding the message tries again", async () => {
        const user = userEvent.setup();
        const thread = [messageFixture("m1", "Alice", { hasAttachments: true }), messageFixture("m2", "Bob")];
        let attempts = 0;
        renderThread({ selectedUid: "m1" }, thread, (url) => {
            if (url.startsWith("/api/mail/attachments")) {
                attempts += 1;
                return attempts === 1 ? jsonResponse(500, { message: "no attachments for you" }) : jsonResponse(200, [{ uid: "a1", filename: "notes.txt" }]);
            }
            return undefined;
        });

        expect(await screen.findByTestId("detail-m1")).toHaveTextContent("attachments:");
        await waitFor(() => expect(attempts).toBe(1));

        await user.click(header("Alice"));
        await user.click(header("Alice"));

        await waitFor(() => expect(screen.getByTestId("detail-m1")).toHaveTextContent("attachments:notes.txt"));
    });

    it("puts a failed mark-as-read back, does not retry it by itself, and tries again when the message is opened again", async () => {
        const user = userEvent.setup();
        const unread = { read: false, flagged: false, answered: false, forwarded: false };
        const thread = [messageFixture("m1", "Alice", { flags: unread }), messageFixture("m2", "Bob")];
        let attempts = 0;
        const { onMessagePatched } = renderThread({ selectedUid: "m1" }, thread, (url, init) => {
            if (url === "/api/mail/messages/m1" && init?.method === "PUT") {
                attempts += 1;
                return attempts === 1 ? jsonResponse(409, { message: "changed since read" }) : jsonResponse(200, messageFixture("m1", "Alice", { version: 1 }));
            }
            return undefined;
        });

        await screen.findByTestId("detail-m1");
        await waitFor(() => expect(attempts).toBe(1));
        // The optimistic copy, then the unread one put back - and no request in a loop meanwhile.
        await waitFor(() => expect(onMessagePatched).toHaveBeenCalledTimes(2));
        expect(onMessagePatched).toHaveBeenLastCalledWith(
            expect.objectContaining({ uid: "m1", flags: unread }),
            expect.objectContaining({ uid: "m1", flags: expect.objectContaining({ read: true }) }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(attempts).toBe(1);

        await user.click(header("Alice"));
        await user.click(header("Alice"));

        await waitFor(() =>
            // The server's own copy, once it has accepted the change.
            expect(onMessagePatched).toHaveBeenCalledWith(expect.objectContaining({ uid: "m1", version: 1 }), undefined),
        );
        // And the change itself was handed over with the unread copy it replaced - what a conversation row's own
        // unread count moves by (see `onMessagePatched`'s own doc comment).
        expect(onMessagePatched).toHaveBeenCalledWith(
            expect.objectContaining({ uid: "m1", flags: expect.objectContaining({ read: true }) }),
            expect.objectContaining({ uid: "m1", flags: unread }),
        );
    });

    it("drops a mark-as-read that lands after the reader has moved to another conversation", async () => {
        const unread = { read: false, flagged: false, answered: false, forwarded: false };
        let resolveMarkRead: ((value: Response) => void) | undefined;
        const onMessagePatched = vi.fn();
        mockFetch((url, init) => {
            if (url === "/api/mail/messages/m1" && init?.method === "PUT") {
                return new Promise<Response>((resolve) => (resolveMarkRead = resolve));
            }
            if (url.includes("/conversations/c1")) return jsonResponse(200, [messageFixture("m1", "Alice", { flags: unread })]);
            return jsonResponse(200, [messageFixture("z1", "Zoe")]);
        });
        const { rerender } = render(
            <ConversationThreadPane
                conversation={conversationFixture()}
                mailboxUid="mb1"
                selectedUid="m1"
                folders={FOLDERS}
                onMessagePatched={onMessagePatched}
                onMessageRemoved={vi.fn()}
            />,
        );
        await screen.findByTestId("detail-m1");

        rerender(
            <ConversationThreadPane
                conversation={conversationFixture({ conversationId: "c2", latestMessageUid: "z1" })}
                mailboxUid="mb1"
                selectedUid="z1"
                folders={FOLDERS}
                onMessagePatched={onMessagePatched}
                onMessageRemoved={vi.fn()}
            />,
        );
        await screen.findByTestId("detail-z1");
        // Only the optimistic copy, made while that conversation was open.
        expect(onMessagePatched).toHaveBeenCalledTimes(1);

        resolveMarkRead!(jsonResponse(200, messageFixture("m1", "Alice", { version: 1 })));
        await waitFor(() => expect(screen.getByTestId("detail-z1")).toBeInTheDocument());
        expect(onMessagePatched).toHaveBeenCalledTimes(1);
    });

    it("drops a load failure that lands after the reader has moved to another conversation", async () => {
        let rejectFirst: ((value: Response) => void) | undefined;
        mockFetch((url) => {
            if (url.includes("/conversations/c1")) {
                return new Promise<Response>((resolve) => (rejectFirst = resolve));
            }
            return jsonResponse(200, [messageFixture("z1", "Zoe")]);
        });
        const { rerender } = render(
            <ConversationThreadPane
                conversation={conversationFixture()}
                mailboxUid="mb1"
                selectedUid="m3"
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />,
        );

        rerender(
            <ConversationThreadPane
                conversation={conversationFixture({ conversationId: "c2", latestMessageUid: "z1" })}
                mailboxUid="mb1"
                selectedUid="z1"
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />,
        );
        expect(await screen.findByTestId("detail-z1")).toBeInTheDocument();

        rejectFirst!(jsonResponse(500, { message: "too late" }));
        await waitFor(() => expect(screen.getByTestId("detail-z1")).toBeInTheDocument());
        expect(screen.queryByText("too late")).not.toBeInTheDocument();
    });

    it("drops a thread that arrives after the reader has moved to another conversation", async () => {
        let resolveFirst: ((value: Response) => void) | undefined;
        mockFetch((url) => {
            if (url.includes("/conversations/c1")) {
                return new Promise<Response>((resolve) => (resolveFirst = resolve));
            }
            return jsonResponse(200, [messageFixture("z1", "Zoe")]);
        });
        const { rerender } = render(
            <ConversationThreadPane
                conversation={conversationFixture()}
                mailboxUid="mb1"
                selectedUid="m3"
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />,
        );

        rerender(
            <ConversationThreadPane
                conversation={conversationFixture({ conversationId: "c2", subject: "Atlas", latestMessageUid: "z1" })}
                mailboxUid="mb1"
                selectedUid="z1"
                folders={FOLDERS}
                onMessagePatched={vi.fn()}
                onMessageRemoved={vi.fn()}
            />,
        );
        expect(await screen.findByTestId("detail-z1")).toBeInTheDocument();

        resolveFirst!(jsonResponse(200, THREAD));
        await waitFor(() => expect(screen.getByTestId("detail-z1")).toBeInTheDocument());
        expect(screen.queryByTestId("detail-m3")).not.toBeInTheDocument();
    });
});
