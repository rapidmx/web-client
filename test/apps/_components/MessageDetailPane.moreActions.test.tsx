// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import MessageDetailPane from "../../../apps/shared/components/mail/MessageDetailPane.js";
import { clearBodyContentCache } from "../../../apps/shared/components/mail/reading/bodyContent.js";
import { clearResolvedFolders } from "../../../apps/shared/mail/folderOfType.js";
import { clearMailboxUpdateAccessCache } from "../../../apps/shared/mail/useMailboxUpdateAccess.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { createFakeRouter, TestRouter } from "../routerTestUtils.js";

// The message card's Report junk button and "More actions" menu, over the real pane: which requests each row makes (to the message's own mailbox),
// what the caller is told, and what the reader is told. The body's frame, the compose window and the crypto are stand-ins - the pane's own
// tests cover what they do; the print frame is too, since a test can't print.
const { openCompose, loadOriginalMessage, printDocument, evaluateMessageSecurity, getUnlockedKeys, moveLocalEntity, removeLocalEntity, mailShellOverride } = vi.hoisted(() => ({
    openCompose: vi.fn(),
    loadOriginalMessage: vi.fn(),
    printDocument: vi.fn(),
    evaluateMessageSecurity: vi.fn(),
    getUnlockedKeys: vi.fn(),
    moveLocalEntity: vi.fn(),
    removeLocalEntity: vi.fn(),
    mailShellOverride: { current: undefined as Record<string, unknown> | undefined },
}));
vi.mock("../../../apps/shared/components/mail/reading/MessageBody.js", () => ({
    default: (props: Record<string, any>) => <div data-testid="body">body of {props.messageUid}</div>,
    BodySkeleton: () => <div data-testid="body-skeleton" />,
}));
vi.mock("../../../apps/shared/components/mail/reading/printMessage.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../apps/shared/components/mail/reading/printMessage.js")>()),
    printDocument,
}));
vi.mock("../../../apps/shared/components/mail/compose/ComposeContext.js", () => ({ useCompose: () => ({ openCompose }), prefetchComposeWindow: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/compose/quotedBody.js", () => ({ loadOriginalMessage, prefetchOriginalMessage: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock: vi.fn() }) }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ moveLocalEntity, removeLocalEntity }));
vi.mock("../../../apps/shared/components/mail/layout/MailShell.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../apps/shared/components/mail/layout/MailShell.js")>();
    return { ...actual, useMailShell: () => mailShellOverride.current ?? actual.useMailShell() };
});

const settle = vi.fn();
const trackMessageChange = vi.fn(() => ({ settle, revert: vi.fn() }));

const RAW = "From: Header Sender <header@lists.example.com>\r\nSubject: Hello there\r\n\r\nBody\r\n";

function folder(uid: string, type: string, mailboxUid = "mb1") {
    return { uid, version: 0, dateCreated: "", dateModified: "", mailboxUid, name: type, type, unreadCount: 0, totalCount: 0 };
}

const FOLDERS = [folder("f1", "inbox"), folder("f-junk", "junk"), folder("f-trash", "deleted_items"), folder("f-sent", "sent_items"), folder("f-drafts", "drafts"), folder("f-outbox", "outbox")];

function message(overrides: Record<string, unknown> = {}) {
    return {
        uid: "m1",
        version: 3,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: "abc@example.com",
        subject: "Re: Hello there",
        from: { address: "Sender@Example.com", displayName: "Sender One", type: "to" as const },
        recipients: [
            { address: "u1@example.com", displayName: "Me", type: "to" as const },
            { address: "cc@example.com", type: "cc" as const },
        ],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T12:30:00.000Z",
        bodyPreview: "Hi",
        flags: { read: false, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        ...overrides,
    } as never;
}

/** What the server answered with for a message after `changes`: the next version. */
function next(original: Record<string, any>, changes: Record<string, unknown>) {
    return { ...original, version: original.version + 1, ...changes };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;

/** A server made of `handlers`, asked in order; anything none of them answers is an error the test can see in `calls`. */
function serve(...handlers: Handler[]) {
    return mockFetch((url, init) => {
        for (const handler of handlers) {
            const response = handler(url, init);
            if (response) {
                return response;
            }
        }
        return jsonResponse(500, { message: `unexpected ${init?.method ?? "GET"} ${url}` });
    });
}

const method = (init: RequestInit | undefined) => init?.method ?? "GET";
const putTo = (uid: string, answer: (body: Record<string, any>) => unknown): Handler => (url, init) =>
    url === `/api/mail/messages/${uid}` && method(init) === "PUT" ? jsonResponse(200, answer(JSON.parse(init.body as string))) : undefined;
/** The bulk update the read state goes through (`PUT /mail/messages`, a list of updates): answers each with the next version of the message. */
const bulkPut = (original: Record<string, any>): Handler => (url, init) =>
    url === "/api/mail/messages" && method(init) === "PUT"
        ? jsonResponse(200, (JSON.parse(init.body as string) as Record<string, any>[]).map((update) => next(original, { version: update.version + 1, flags: update.flags })))
        : undefined;
const raw: Handler = (url) => (url === "/api/mail/messages/m1/raw" ? new Response(RAW) : undefined);

/** The bodies of the requests made to `url` with `verb`. */
function bodiesOf(fetchMock: ReturnType<typeof mockFetch>, verb: string, url: string): Record<string, any>[] {
    return fetchMock.mock.calls.filter(([u, init]) => u === url && method(init) === verb).map(([, init]) => JSON.parse(init.body as string));
}

/** The pop-ups on screen. */
function popups() {
    return getNotificationsSnapshot().visible;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, ...path: string[]) {
    await user.click(screen.getByRole("button", { name: "More actions" }));
    for (const name of path) {
        await user.click(screen.getByRole("menuitem", { name }));
    }
}

async function choose(user: ReturnType<typeof userEvent.setup>, path: string[], item: RegExp | string) {
    await openMenu(user, ...path);
    await user.click(screen.getByRole("menuitem", { name: item }));
}

let hrefs: string[];

beforeEach(() => {
    loadOriginalMessage.mockResolvedValue({ body: "<p>quoted</p>", recipients: [] });
    getUnlockedKeys.mockReturnValue(undefined);
    mailShellOverride.current = { mailboxes: [], trackMessageChange, mailboxFolders: [], onFolderCreated: vi.fn(), live: { count: 0, folderUids: null } };
    hrefs = [];
    Object.defineProperty(window, "location", {
        configurable: true,
        value: {
            ...window.location,
            get href() {
                return "http://localhost/";
            },
            set href(value: string) {
                hrefs.push(value);
            },
        },
    });
});

afterEach(() => {
    mailShellOverride.current = undefined;
    clearBodyContentCache();
    clearResolvedFolders();
    clearMailboxUpdateAccessCache();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const REPORT_URL = "/api/mail/messages/m1/report";
/** The server's answer to a report: by default the message moved to Junk Email and the spam filter learned it. */
const reportRoute = (answer: Record<string, unknown> = {}): Handler => (url, init) =>
    url === REPORT_URL && method(init) === "POST" ? jsonResponse(200, { uid: "m1", kind: "junk", moved: true, folderUid: "f-junk", learned: true, ...answer }) : undefined;
/** A server that predates the report route. */
const noReportRoute: Handler = (url, init) => (url === REPORT_URL && method(init) === "POST" ? jsonResponse(404, { message: "Not found" }) : undefined);
/** A server that predates the sender lists. */
const noListRoutes: Handler = (url, init) => (/\/api\/mail\/mailboxes\/mb1\/(blocked|safe)-senders/.test(url) ? jsonResponse(404, { message: "Not found" }) : undefined);
const listChange = (entry: string, changed = true) => ({ entry, changed, blockedSenders: [], safeSenders: [] });
const listRoute = (list: "blocked" | "safe", answer: (entry: string) => unknown): Handler => (url, init) =>
    url === `/api/mail/mailboxes/mb1/${list}-senders` && method(init) === "POST" ? jsonResponse(200, answer(JSON.parse(init.body as string).entry)) : undefined;
const unlistRoute = (list: "blocked" | "safe", status = 200): Handler => (url, init) =>
    url.startsWith(`/api/mail/mailboxes/mb1/${list}-senders/`) && method(init) === "DELETE" ? jsonResponse(status, status === 200 ? listChange("x") : { message: "boom" }) : undefined;
const readOnlyMailbox = () => {
    mailShellOverride.current = { ...mailShellOverride.current, mailboxes: [{ uid: "mb1", accessRole: "delegate", primarySmtpAddress: "shared@example.com", aliasAddresses: [] }] };
};
const access = (canUpdate: boolean): Handler => (url) =>
    url === "/api/mail/mailboxes/mb1/access/me" ? jsonResponse(200, { canRead: true, canCreate: false, canUpdate, canDelete: false, canManage: false }) : undefined;

describe("Report junk on the card", () => {
    it("is a button after Move to and before the Labels and More actions buttons", () => {
        serve();
        const labels = [{ uid: "l1", name: "Work" }] as never;
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} labels={labels} />);
        const names = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
        const junk = names.indexOf("Report junk");
        expect(junk).toBeGreaterThan(names.indexOf("Move to"));
        expect(names.indexOf("Labels")).toBeGreaterThan(junk);
        expect(names.indexOf("More actions")).toBeGreaterThan(names.indexOf("Labels"));
        expect(names.indexOf("More actions")).toBe(names.lastIndexOf("More actions"));
    });

    it("asks the server to report it, which moves it and teaches the spam filter, then tells the caller, the badges, the search index and the reader", async () => {
        const original = message() as Record<string, any>;
        const fetchMock = serve(reportRoute());
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await user.click(screen.getByRole("button", { name: "Report junk" }));

        await waitFor(() => expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ uid: "m1", folderUid: "f-junk" })));
        expect(bodiesOf(fetchMock, "POST", REPORT_URL)).toEqual([{ kind: "junk" }]);
        expect(moveLocalEntity).toHaveBeenCalledWith("mb1", "m1", "f-junk");
        expect(trackMessageChange).toHaveBeenCalledWith(original, expect.objectContaining({ folderUid: "f-junk" }));
        expect(settle).toHaveBeenCalled();
        expect(popups()).toEqual([
            expect.objectContaining({
                kind: "success",
                title: "Reported as junk",
                message: "“Re: Hello there” was moved to Junk Email and used to train the spam filter.",
            }),
        ]);
        expect(popups()[0].hint).toBeUndefined();
        // Nothing but the report: the server does the move, so the client makes no move of its own.
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([REPORT_URL]);
    });

    it.each([
        ["failed", "The spam filter could not be trained from this report."],
        ["encrypted", "Not used to train the spam filter: the message is encrypted."],
        ["disabled", undefined],
        ["unsupported", undefined],
        ["too_large", undefined],
    ])("says of a filter that learned nothing (%s) only what is worth knowing", async (learnSkipped, hint) => {
        serve(reportRoute({ learned: false, learnSkipped }));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await user.click(screen.getByRole("button", { name: "Report junk" }));
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(popups()[0]).toMatchObject({ kind: "success", title: "Reported as junk", message: "“Re: Hello there” was moved to Junk Email." });
        expect(popups()[0].hint).toBe(hint);
    });

    it("says it was already in Junk Email when the server did not have to move it, and still takes it out of the list", async () => {
        serve(reportRoute({ moved: false }));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
        await user.click(screen.getByRole("button", { name: "Report junk" }));
        await waitFor(() => expect(onMoved).toHaveBeenCalled());
        expect(popups()[0].message).toBe("“Re: Hello there” is already in Junk Email and used to train the spam filter.");
    });

    it("leaves the list alone when the server files it in the folder the card already had it in", async () => {
        serve(reportRoute({ moved: false, folderUid: "f1" }));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
        await user.click(screen.getByRole("button", { name: "Report junk" }));
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(onMoved).not.toHaveBeenCalled();
        expect(moveLocalEntity).not.toHaveBeenCalled();
        expect(trackMessageChange).not.toHaveBeenCalled();
    });

    it("says what could not be done, and moves nothing, when the server refuses", async () => {
        serve((url, init) => (url === REPORT_URL && method(init) === "POST" ? jsonResponse(500, { message: "boom" }) : undefined));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await user.click(screen.getByRole("button", { name: "Report junk" }));

        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't report this message as junk" })]));
        expect(onMoved).not.toHaveBeenCalled();
        expect(trackMessageChange).not.toHaveBeenCalled();
        // The button is usable again.
        await waitFor(() => expect(screen.getByRole("button", { name: "Report junk" })).toBeEnabled());
    });

    it("waits while it is working, so a second click cannot report it twice", async () => {
        let answer: (response: Response) => void = () => undefined;
        const fetchMock = serve((url, init) => (url === REPORT_URL && method(init) === "POST" ? new Promise<Response>((resolve) => (answer = resolve)) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);

        await user.click(screen.getByRole("button", { name: "Report junk" }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Report junk" })).toBeDisabled());
        expect(screen.getByRole("button", { name: "Report junk" })).toHaveAttribute("aria-busy", "true");
        await user.click(screen.getByRole("button", { name: "Report junk" }));
        expect(bodiesOf(fetchMock, "POST", REPORT_URL)).toHaveLength(1);
        answer(jsonResponse(200, { uid: "m1", kind: "junk", moved: true, folderUid: "f-junk", learned: true }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Report junk" })).toBeEnabled());
    });

    it("is disabled in a mailbox shared with the reader view-only, and usable until the server has said so", async () => {
        readOnlyMailbox();
        serve(access(false));
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        // Usable until the server has said otherwise.
        expect(screen.getByRole("button", { name: "Report junk" })).toBeEnabled();
        await waitFor(() => expect(screen.getByRole("button", { name: "Report junk" })).toBeDisabled());
        expect(screen.getByRole("button", { name: "Report junk" })).toHaveAttribute("title", "View-only mailbox");
    });

    it.each([
        ["Drafts", "f-drafts"],
        ["Outbox", "f-outbox"],
    ])("is not on the card of a message in %s, nor is the More actions menu", (_name, folderUid) => {
        serve();
        render(<MessageDetailPane message={message({ folderUid })} attachments={[]} folders={FOLDERS as never} draftsFolderUid="f-drafts" isOutbox={folderUid === "f-outbox"} />);
        expect(screen.queryByRole("button", { name: "Report junk" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    });

    it("is not on the card of mail the reader sent, which has the menu with Report and Block held", async () => {
        serve();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message({ folderUid: "f-sent" })} attachments={[]} folders={FOLDERS as never} isSentItems />);
        expect(screen.queryByRole("button", { name: "Report junk" })).not.toBeInTheDocument();
        await openMenu(user, "Report");
        expect(screen.getByRole("menuitem", { name: /^Report junk/ })).toBeDisabled();
    });
});

describe("Report junk on a server without the report route", () => {
    it("falls back to moving the message to its mailbox's Junk Email folder itself, and says only that", async () => {
        const original = message() as Record<string, any>;
        const moved = next(original, { folderUid: "f-junk" });
        const fetchMock = serve(noReportRoute, putTo("m1", () => moved));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await user.click(screen.getByRole("button", { name: "Report junk" }));

        await waitFor(() => expect(onMoved).toHaveBeenCalledWith(moved));
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")).toEqual([{ uid: "m1", version: 3, folderUid: "f-junk" }]);
        expect(moveLocalEntity).toHaveBeenCalledWith("mb1", "m1", "f-junk");
        expect(trackMessageChange).toHaveBeenCalledWith(original, moved);
        expect(popups()).toEqual([
            expect.objectContaining({ kind: "success", title: "Reported as junk", message: "“Re: Hello there” was moved to Junk Email." }),
        ]);
    });

    it("moves a message opened from another mailbox into THAT mailbox's Junk, found on the server when the tree it was given is another mailbox's", async () => {
        const other = message({ mailboxUid: "mb2", folderUid: "g1" }) as Record<string, any>;
        const moved = next(other, { folderUid: "g-junk" });
        const fetchMock = serve(
            noReportRoute,
            (url) => (url === "/api/mail/folders?limit=200&page=0&mailboxUid=mb2" ? jsonResponse(200, [folder("g1", "inbox", "mb2"), folder("g-junk", "junk", "mb2")]) : undefined),
            putTo("m1", () => moved),
        );
        const onMoved = vi.fn();
        const onFolderCreated = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={other as never} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} onFolderCreated={onFolderCreated} />);

        await user.click(screen.getByRole("button", { name: "Report junk" }));

        await waitFor(() => expect(onMoved).toHaveBeenCalledWith(moved));
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")[0].folderUid).toBe("g-junk");
        expect(onFolderCreated).toHaveBeenCalledWith(expect.objectContaining({ uid: "g-junk" }));
    });

    it("makes the Junk Email folder when the mailbox has none", async () => {
        const original = message() as Record<string, any>;
        const fetchMock = serve(
            noReportRoute,
            (url, init) => (url === "/api/mail/folders" && method(init) === "POST" ? jsonResponse(200, folder("f-new", "junk")) : undefined),
            (url) => (url.startsWith("/api/mail/folders?") ? jsonResponse(200, [folder("f1", "inbox")]) : undefined),
            putTo("m1", () => next(original, { folderUid: "f-new" })),
        );
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={[folder("f1", "inbox")] as never} onMoved={onMoved} />);

        await user.click(screen.getByRole("button", { name: "Report junk" }));

        await waitFor(() => expect(onMoved).toHaveBeenCalled());
        expect(bodiesOf(fetchMock, "POST", "/api/mail/folders")).toEqual([expect.objectContaining({ mailboxUid: "mb1", name: "Junk Email", type: "junk" })]);
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")[0].folderUid).toBe("f-new");
    });

    it("says what could not be done when the move fails too", async () => {
        serve(noReportRoute, (url, init) => (url === "/api/mail/messages/m1" && method(init) === "PUT" ? jsonResponse(500, { message: "boom" }) : undefined));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
        await user.click(screen.getByRole("button", { name: "Report junk" }));
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't report this message as junk" })]));
        expect(onMoved).not.toHaveBeenCalled();
    });

    it("moves a reported phishing message the same way, without the words about the filter or the audit log", async () => {
        const original = message() as Record<string, any>;
        serve(noReportRoute, putTo("m1", () => next(original, { folderUid: "f-junk" })));
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Report"], /^Report phishing/);
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(popups()[0]).toMatchObject({ title: "Reported as phishing", message: "“Re: Hello there” was moved to Junk Email." });
    });

    it("moves a message in Junk Email to the Inbox for Not junk, and says a safe sender cannot be kept on this server", async () => {
        const original = message({ folderUid: "f-junk" }) as Record<string, any>;
        const fetchMock = serve(noReportRoute, putTo("m1", () => next(original, { folderUid: "f1" })));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
        await choose(user, ["Report"], /^Not junk, and always trust/);
        await waitFor(() => expect(onMoved).toHaveBeenCalled());
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")).toEqual([{ uid: "m1", version: 3, folderUid: "f1" }]);
        expect(popups()[0]).toMatchObject({
            title: "Marked as not junk",
            message: "“Re: Hello there” was moved to the Inbox. This server cannot keep a list of safe senders, so its sender was not added to one.",
        });
    });

    it("moves a message in Junk Email to the Inbox for Not junk", async () => {
        const original = message({ folderUid: "f-junk" }) as Record<string, any>;
        serve(noReportRoute, putTo("m1", () => next(original, { folderUid: "f1" })));
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} />);
        await user.click(screen.getByRole("button", { name: "Not junk" }));
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(popups()[0].message).toBe("“Re: Hello there” was moved to the Inbox.");
    });

    it("moves a message in Junk Email to the Inbox for the Report menu's plain Not junk too", async () => {
        const original = message({ folderUid: "f-junk" }) as Record<string, any>;
        serve(noReportRoute, putTo("m1", () => next(original, { folderUid: "f1" })));
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Report"], /^Not junk$/);
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(popups()[0].message).toBe("“Re: Hello there” was moved to the Inbox.");
    });
});

describe("Report > Report phishing", () => {
    it("asks the server to report it as phishing, and says the report was recorded", async () => {
        const fetchMock = serve(reportRoute({ kind: "phishing" }));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await choose(user, ["Report"], /^Report phishing/);

        await waitFor(() => expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ folderUid: "f-junk" })));
        expect(bodiesOf(fetchMock, "POST", REPORT_URL)).toEqual([{ kind: "phishing" }]);
        expect(popups()).toEqual([
            expect.objectContaining({
                kind: "success",
                title: "Reported as phishing",
                message: "“Re: Hello there” was moved to Junk Email and used to train the spam filter. The report was recorded in the audit log.",
            }),
        ]);
        expect(popups()[0].message).not.toContain("not sent to anyone");
    });

    it("has Report junk in the same submenu, doing what the card's button does, and names a message with no subject", async () => {
        const fetchMock = serve(reportRoute());
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message({ subject: "" })} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await choose(user, ["Report"], /^Report junk/);

        await waitFor(() => expect(onMoved).toHaveBeenCalled());
        expect(bodiesOf(fetchMock, "POST", REPORT_URL)).toEqual([{ kind: "junk" }]);
        expect(popups()).toEqual([expect.objectContaining({ title: "Reported as junk", message: expect.stringContaining("“(no subject)” was moved to Junk Email") })]);
    });

    it("reports a refusal as such", async () => {
        serve((url, init) => (url === REPORT_URL && method(init) === "POST" ? jsonResponse(403, { message: "no" }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Report"], /^Report phishing/);
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't report this message as phishing" })]));
    });

    it("is a 400 the server's own words when the message is in Drafts or Outbox", async () => {
        serve((url, init) => (url === REPORT_URL && method(init) === "POST" ? jsonResponse(400, { message: "A message in Drafts or Outbox cannot be reported." }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Report"], /^Report phishing/);
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(popups()[0].message).toContain("cannot be reported");
    });
});

describe("Not junk, in Junk Email", () => {
    const inJunk = () => message({ folderUid: "f-junk" });
    const toInbox = (answer: Record<string, unknown> = {}) => reportRoute({ kind: "not_junk", folderUid: "f1", ...answer });

    it("turns the card's Report junk button into Not junk, which reports it as not junk: to the Inbox, and the spam filter told", async () => {
        const fetchMock = serve(toInbox());
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={inJunk()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
        expect(screen.queryByRole("button", { name: "Report junk" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Not junk" }));

        await waitFor(() => expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ folderUid: "f1" })));
        expect(bodiesOf(fetchMock, "POST", REPORT_URL)).toEqual([{ kind: "not_junk" }]);
        expect(moveLocalEntity).toHaveBeenCalledWith("mb1", "m1", "f1");
        expect(popups()).toEqual([
            expect.objectContaining({ kind: "success", title: "Marked as not junk", message: "“Re: Hello there” was moved to the Inbox and used to train the spam filter." }),
        ]);
        expect(popups()[0].actions).toEqual([]);
    });

    it("has Not junk under Report too, with Report junk and Report phishing held because it is in Junk Email already", async () => {
        serve(toInbox());
        const user = userEvent.setup();
        render(<MessageDetailPane message={inJunk()} attachments={[]} folders={FOLDERS as never} />);
        await openMenu(user, "Report");
        expect(screen.getByRole("menuitem", { name: /^Report junk/ })).toHaveTextContent("Already in Junk Email");
        expect(screen.getByRole("menuitem", { name: /^Report junk/ })).toBeDisabled();
        expect(screen.getByRole("menuitem", { name: /^Report phishing/ })).toBeDisabled();
        expect(screen.getByRole("menuitem", { name: "Not junk" })).toBeEnabled();
        expect(screen.getByRole("menuitem", { name: "Not junk, and always trust Sender@Example.com" })).toBeEnabled();
    });

    it("has no Not junk rows for a message that is not in Junk Email", async () => {
        serve();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await openMenu(user, "Report");
        expect(screen.queryByRole("menuitem", { name: /^Not junk/ })).not.toBeInTheDocument();
    });

    it("reports it as not junk with alwaysTrustSender from the second row, and says the sender is trusted, with Undo and a link to the lists", async () => {
        const fetchMock = serve(toInbox({ safeSender: "sender@example.com" }), unlistRoute("safe"));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={inJunk()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await choose(user, ["Report"], "Not junk, and always trust Sender@Example.com");

        await waitFor(() => expect(onMoved).toHaveBeenCalled());
        expect(bodiesOf(fetchMock, "POST", REPORT_URL)).toEqual([{ kind: "not_junk", alwaysTrustSender: true }]);
        const [popup] = popups();
        expect(popup).toMatchObject({
            kind: "success",
            title: "Marked as not junk",
            message: "“Re: Hello there” was moved to the Inbox and used to train the spam filter. Mail from sender@example.com that passes authentication is no longer sent to Junk Email.",
        });
        expect(popup.actions.map((action) => action.label)).toEqual(["Undo", "Manage safe senders"]);
        expect(popup.actions[1].href).toBe("/settings/blocked-senders?mailboxUid=mb1");

        act(() => popup.actions[0].onClick!());
        await waitFor(() => expect(popups().map((p) => p.title)).toContain("sender@example.com is no longer a safe sender"));
        expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/mail/mailboxes/mb1/safe-senders/sender%40example.com" && method(init) === "DELETE")).toBe(true);
    });

    it("says when Undo could not take the sender off the safe list", async () => {
        serve(toInbox({ safeSender: "sender@example.com" }), unlistRoute("safe", 500));
        const user = userEvent.setup();
        render(<MessageDetailPane message={inJunk()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Report"], /^Not junk, and always trust/);
        await waitFor(() => expect(popups()).toHaveLength(1));
        act(() => popups()[0].actions[0].onClick!());
        await waitFor(() => expect(popups().map((p) => p.title)).toContain("Couldn't undo trusting this sender"));
    });

    it("says the message names no address to trust when the server added none", async () => {
        serve(toInbox());
        const user = userEvent.setup();
        render(<MessageDetailPane message={inJunk()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Report"], /^Not junk, and always trust/);
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(popups()[0].message).toContain("The message names no address that could be trusted.");
        expect(popups()[0].actions).toEqual([]);
    });

    it("surfaces the server's refusal, and moves nothing, when the reader lacks full access to the mailbox", async () => {
        serve((url, init) =>
            url === REPORT_URL && method(init) === "POST" ? jsonResponse(403, { message: "Only the mailbox's owner can add a sender to its safe senders." }) : undefined,
        );
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={inJunk()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
        await choose(user, ["Report"], /^Not junk, and always trust/);
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(popups()[0]).toMatchObject({ kind: "error", title: "Couldn't report this message as not junk" });
        expect(popups()[0].message).toContain("Only the mailbox's owner");
        expect(onMoved).not.toHaveBeenCalled();
    });

    it("offers the always-trust row to a delegate who may update the mailbox (the server refuses one who may not have full access), not to one who may not", async () => {
        readOnlyMailbox();
        serve(access(true));
        const user = userEvent.setup();
        const { unmount } = render(<MessageDetailPane message={inJunk()} attachments={[]} folders={FOLDERS as never} />);
        await openMenu(user, "Report");
        expect(screen.getByRole("menuitem", { name: /^Not junk, and always trust/ })).toBeEnabled();
        unmount();

        clearMailboxUpdateAccessCache();
        serve(access(false));
        render(<MessageDetailPane message={inJunk()} attachments={[]} folders={FOLDERS as never} />);
        await waitFor(() => expect(screen.getByRole("button", { name: "Not junk" })).toBeDisabled());
        expect(screen.getByRole("button", { name: "Not junk" })).toHaveAttribute("title", "View-only mailbox");
        await openMenu(user, "Report");
        expect(screen.getByRole("menuitem", { name: /^Not junk/ })).toBeDisabled();
        expect(screen.queryByRole("menuitem", { name: /^Not junk, and always trust/ })).not.toBeInTheDocument();
    });

    it("does not offer to trust the reader's own address", async () => {
        mailShellOverride.current = { ...mailShellOverride.current, mailboxes: [{ uid: "mb1", accessRole: "owner", primarySmtpAddress: "sender@example.com", aliasAddresses: [] }] };
        serve();
        const user = userEvent.setup();
        render(<MessageDetailPane message={inJunk()} attachments={[]} folders={FOLDERS as never} />);
        await openMenu(user, "Report");
        expect(screen.getByRole("menuitem", { name: "Not junk" })).toBeEnabled();
        expect(screen.queryByRole("menuitem", { name: /^Not junk, and always trust/ })).not.toBeInTheDocument();
    });
});

describe("Delete, Mark as read, Flag", () => {
    it("moves the message to Deleted Items with Delete, and tells the caller", async () => {
        const original = message() as Record<string, any>;
        const moved = next(original, { folderUid: "f-trash" });
        const fetchMock = serve(putTo("m1", () => moved));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await choose(user, [], /^Delete/);

        await waitFor(() => expect(onMoved).toHaveBeenCalledWith(moved));
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")).toEqual([{ uid: "m1", version: 3, folderUid: "f-trash" }]);
        expect(trackMessageChange).toHaveBeenCalledWith(original, moved);
        // No pop-up: a deleted message is gone from where the reader looks.
        expect(popups()).toEqual([]);
    });

    describe("in Deleted Items", () => {
        const dialog = () => screen.findByRole("dialog", { name: "Delete permanently" });
        const purge: Handler = (url, init) => (url === "/api/mail/messages/m1?purge=true" && method(init) === "DELETE" ? emptyResponse(204) : undefined);
        const inTrash = () => message({ folderUid: "f-trash" });

        it("reads Delete permanently, asks first, and does nothing when the reader cancels", async () => {
            const fetchMock = serve(purge);
            const onMoved = vi.fn();
            const user = userEvent.setup();
            render(<MessageDetailPane message={inTrash()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

            await choose(user, [], "Delete permanently");
            const asking = await dialog();
            expect(asking).toHaveTextContent("Permanently delete 1 message");
            expect(fetchMock).not.toHaveBeenCalled();
            await user.click(within(asking).getByRole("button", { name: "Cancel" }));

            await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete permanently" })).not.toBeInTheDocument());
            expect(fetchMock).not.toHaveBeenCalled();
            expect(onMoved).not.toHaveBeenCalled();
            await waitFor(() => expect(screen.getByRole("button", { name: "Report junk" })).toBeEnabled());
        });

        it("deletes it for good once confirmed, tells the caller, the badges, the search index and the reader", async () => {
            const original = inTrash() as Record<string, any>;
            const fetchMock = serve(purge);
            const onMoved = vi.fn();
            const user = userEvent.setup();
            render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

            await choose(user, [], "Delete permanently");
            await user.click(within(await dialog()).getByRole("button", { name: "Delete permanently" }));

            await waitFor(() => expect(onMoved).toHaveBeenCalledWith(original));
            expect(fetchMock.mock.calls.map(([url, init]) => [url, method(init)])).toEqual([["/api/mail/messages/m1?purge=true", "DELETE"]]);
            expect(trackMessageChange).toHaveBeenCalledWith(original, null);
            expect(removeLocalEntity).toHaveBeenCalledWith("mb1", "m1");
            expect(popups()).toEqual([expect.objectContaining({ kind: "success", title: "1 message permanently deleted" })]);
        });

        it("holds the card's other actions while the question is open", async () => {
            serve(purge);
            const user = userEvent.setup();
            render(<MessageDetailPane message={inTrash()} attachments={[]} folders={FOLDERS as never} />);
            await choose(user, [], "Delete permanently");
            await dialog();
            expect(screen.getByRole("button", { name: "Report junk" })).toBeDisabled();
        });

        it("keeps the card and says why when the server refuses (a legal hold)", async () => {
            serve((url, init) => (url === "/api/mail/messages/m1?purge=true" && method(init) === "DELETE" ? jsonResponse(409, { message: "Under legal hold" }) : undefined));
            const onMoved = vi.fn();
            const user = userEvent.setup();
            render(<MessageDetailPane message={inTrash()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
            await choose(user, [], "Delete permanently");
            await user.click(within(await dialog()).getByRole("button", { name: "Delete permanently" }));
            await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't permanently delete that message" })]));
            expect(onMoved).not.toHaveBeenCalled();
        });

        it("works with no caller listening", async () => {
            const fetchMock = serve(purge);
            const user = userEvent.setup();
            render(<MessageDetailPane message={inTrash()} attachments={[]} folders={FOLDERS as never} />);
            await choose(user, [], "Delete permanently");
            await user.click(within(await dialog()).getByRole("button", { name: "Delete permanently" }));
            await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
            await waitFor(() => expect(popups()).toHaveLength(1));
        });

        it("can still be reported as junk, which files it in Junk Email as anywhere else", async () => {
            const original = inTrash() as Record<string, any>;
            const fetchMock = serve(reportRoute());
            const onMoved = vi.fn();
            const user = userEvent.setup();
            render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
            await user.click(screen.getByRole("button", { name: "Report junk" }));
            await waitFor(() => expect(onMoved).toHaveBeenCalledWith(expect.objectContaining({ folderUid: "f-junk" })));
            expect(bodiesOf(fetchMock, "POST", REPORT_URL)).toEqual([{ kind: "junk" }]);
        });
    });

    it("says what could not be deleted", async () => {
        serve((url, init) => (url === "/api/mail/messages/m1" && method(init) === "PUT" ? jsonResponse(500, { message: "boom" }) : undefined));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
        await choose(user, [], /^Delete/);
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't delete this message" })]));
        expect(onMoved).not.toHaveBeenCalled();
    });

    it("marks an unread message read, at once for the caller and then as the server has it, and offers Mark as unread after", async () => {
        const original = message() as Record<string, any>;
        const fetchMock = serve(bulkPut(original));
        const onChanged = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onChanged={onChanged} />);

        await choose(user, [], "Mark as read");

        await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
        expect(onChanged.mock.calls[0][0].flags.read).toBe(true);
        expect(onChanged.mock.calls[0][1]).toBe(original);
        expect(onChanged.mock.calls[1][0]).toMatchObject({ version: 4, flags: { read: true } });
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages")[0]).toEqual([expect.objectContaining({ uid: "m1", version: 3, flags: expect.objectContaining({ read: true }) })]);
        await openMenu(user);
        expect(screen.getByRole("menuitem", { name: "Mark as unread" })).toBeInTheDocument();
    });

    it("marks a read message unread, building on the version the last change left", async () => {
        const original = message({ flags: { read: true, flagged: false, answered: false, forwarded: false } }) as Record<string, any>;
        const fetchMock = serve(bulkPut(original));
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} />);

        await choose(user, [], "Mark as unread");
        await waitFor(() => expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages")).toHaveLength(1));
        await openMenu(user);
        // The server's copy (version 4) is what the card knows now, and it says unread.
        await waitFor(() => expect(screen.getByRole("menuitem", { name: "Mark as read" })).toBeInTheDocument());
        await user.click(screen.getByRole("menuitem", { name: "Mark as read" }));
        await waitFor(() => expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages")).toHaveLength(2));
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages")[1]).toEqual([expect.objectContaining({ version: 4, flags: expect.objectContaining({ read: true }) })]);
    });

    it("puts the message back as it was and says so when the server refuses to mark it", async () => {
        const original = message() as Record<string, any>;
        serve((url, init) => (url === "/api/mail/messages/m1" && method(init) === "PUT" ? jsonResponse(500, { message: "boom" }) : undefined));
        const onChanged = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onChanged={onChanged} />);

        await choose(user, [], "Mark as read");

        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't update the message" })]));
        expect(onChanged).toHaveBeenLastCalledWith(original, expect.objectContaining({ flags: expect.objectContaining({ read: true }) }));
        await openMenu(user);
        expect(screen.getByRole("menuitem", { name: "Mark as read" })).toBeInTheDocument();
    });

    it("flags a message and then unflags it", async () => {
        const original = message() as Record<string, any>;
        const fetchMock = serve(putTo("m1", (body) => next(original, { version: body.version + 1, flags: body.flags })));
        const onChanged = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onChanged={onChanged} />);

        await choose(user, [], "Flag");
        await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
        expect(onChanged.mock.calls[0][0].flags.flagged).toBe(true);
        expect(onChanged.mock.calls[0][1]).toBe(original);
        await openMenu(user);
        await waitFor(() => expect(screen.getByRole("menuitem", { name: "Unflag" })).toBeInTheDocument());
        await user.click(screen.getByRole("menuitem", { name: "Unflag" }));
        await waitFor(() => expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")).toHaveLength(2));
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")[1]).toMatchObject({ version: 4, flags: { flagged: false } });
    });

    it("says so when the message could not be flagged, and works without a caller listening", async () => {
        serve((url, init) => (url === "/api/mail/messages/m1" && method(init) === "PUT" ? jsonResponse(500, { message: "boom" }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, [], "Flag");
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't update the message" })]));
    });

    it("works with no caller listening for what it changes or moves", async () => {
        const original = message() as Record<string, any>;
        serve(
            putTo("m1", (body) => next(original, { version: body.version + 1, flags: body.flags ?? original.flags, folderUid: body.folderUid ?? original.folderUid })),
            bulkPut(original),
            reportRoute(),
        );
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, [], "Flag");
        await openMenu(user);
        await waitFor(() => expect(screen.getByRole("menuitem", { name: "Unflag" })).toBeInTheDocument());
        await user.click(screen.getByRole("menuitem", { name: "Mark as read" }));
        await openMenu(user);
        await waitFor(() => expect(screen.getByRole("menuitem", { name: "Mark as unread" })).toBeInTheDocument());
        // The rows wait while the last change is on the wire.
        await waitFor(() => expect(screen.getByRole("menuitem", { name: /^Delete/ })).toBeEnabled());
        await user.click(screen.getByRole("menuitem", { name: /^Delete/ }));
        await waitFor(() => expect(moveLocalEntity).toHaveBeenCalledWith("mb1", "m1", "f-trash"));
        await waitFor(() => expect(screen.getByRole("button", { name: "Report junk" })).toBeEnabled());
        await user.click(screen.getByRole("button", { name: "Report junk" }));
        await waitFor(() => expect(moveLocalEntity).toHaveBeenCalledWith("mb1", "m1", "f-junk"));
    });
});

describe("Block > Block <sender>", () => {
    const SENDER = "Sender@Example.com";
    // What the From header of `RAW` says, which is what is blocked: it is what the reader sees and what the mail server matches a list against.
    const HEADER = "header@lists.example.com";
    const blockRoute = listRoute("blocked", (entry) => listChange(entry));
    const moveToJunk = (original: Record<string, any>) => putTo("m1", () => next(original, { folderUid: "f-junk" }));
    const LISTS_HREF = "/settings/blocked-senders?mailboxUid=mb1";

    it("adds the address in the From header to the mailbox's blocked senders, moves this message to Junk, and offers Undo and a link to the list", async () => {
        const original = message() as Record<string, any>;
        const moved = next(original, { folderUid: "f-junk" });
        const fetchMock = serve(raw, blockRoute, putTo("m1", () => moved));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await choose(user, ["Block"], `Block ${SENDER}`);

        await waitFor(() => expect(onMoved).toHaveBeenCalledWith(moved));
        // One entry, the header's address: the list is matched against the header and the envelope sender both. No filter rule is made.
        expect(bodiesOf(fetchMock, "POST", "/api/mail/mailboxes/mb1/blocked-senders")).toEqual([{ entry: HEADER }]);
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("mail-filter-rules"))).toBe(false);
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")[0].folderUid).toBe("f-junk");
        // The move is a plain move, not a report: blocking a sender does not teach the spam filter.
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/report"))).toBe(false);
        const [popup] = popups();
        expect(popup).toMatchObject({
            kind: "success",
            title: `Blocked ${HEADER}`,
            message: "New mail from this address goes to Junk Email. This message was moved there.",
        });
        expect(popup.actions.map((action) => action.label)).toEqual(["Undo", "Manage blocked senders"]);
        expect(popup.actions[1].href).toBe(LISTS_HREF);
    });

    it("takes the block back with Undo (a DELETE of the URL-encoded entry), and says this message stays where it is", async () => {
        const original = message() as Record<string, any>;
        const fetchMock = serve(raw, blockRoute, moveToJunk(original), unlistRoute("blocked"));
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(popups()).toHaveLength(1));

        act(() => popups()[0].actions[0].onClick!());

        await waitFor(() => expect(popups().map((popup) => popup.title)).toContain(`Unblocked ${HEADER}`));
        expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/mail/mailboxes/mb1/blocked-senders/header%40lists.example.com" && method(init) === "DELETE")).toBe(true);
        expect(popups().find((popup) => popup.title === `Unblocked ${HEADER}`)!.message).toContain("This message stays where it is.");
    });

    it("says when Undo could not take the block back", async () => {
        const original = message() as Record<string, any>;
        serve(raw, blockRoute, moveToJunk(original), unlistRoute("blocked", 500));
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(popups()).toHaveLength(1));
        act(() => popups()[0].actions[0].onClick!());
        await waitFor(() => expect(popups().map((popup) => popup.title)).toContain("Couldn't undo the block"));
    });

    it("says the sender is already blocked, offers no Undo, and still moves this message", async () => {
        const original = message() as Record<string, any>;
        serve(raw, listRoute("blocked", (entry) => listChange(entry, false)), moveToJunk(original));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await choose(user, ["Block"], `Block ${SENDER}`);

        await waitFor(() => expect(onMoved).toHaveBeenCalled());
        expect(popups()).toEqual([expect.objectContaining({ kind: "info", title: `${HEADER} is already blocked` })]);
        expect(popups()[0].actions.map((action) => action.label)).toEqual(["Manage blocked senders"]);
    });

    it("leaves a message that is already in Junk where it is, and says so", async () => {
        const fetchMock = serve(raw, blockRoute);
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message({ folderUid: "f-junk" })} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await choose(user, ["Block"], `Block ${SENDER}`);

        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(popups()[0].message).toContain("This message is already in Junk Email.");
        expect(onMoved).not.toHaveBeenCalled();
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")).toEqual([]);
    });

    it("blocks the address the message is filed under when its source cannot be read", async () => {
        const original = message() as Record<string, any>;
        const fetchMock = serve((url) => (url === "/api/mail/messages/m1/raw" ? new Response("nope", { status: 500 }) : undefined), blockRoute, moveToJunk(original));
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(bodiesOf(fetchMock, "POST", "/api/mail/mailboxes/mb1/blocked-senders")).toHaveLength(1));
        expect(bodiesOf(fetchMock, "POST", "/api/mail/mailboxes/mb1/blocked-senders")).toEqual([{ entry: "sender@example.com" }]);
    });

    it("blocks the address the message is filed under when the From header has none", async () => {
        const original = message() as Record<string, any>;
        const fetchMock = serve((url) => (url === "/api/mail/messages/m1/raw" ? new Response("Subject: x\r\n\r\nx") : undefined), blockRoute, moveToJunk(original));
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(bodiesOf(fetchMock, "POST", "/api/mail/mailboxes/mb1/blocked-senders")).toHaveLength(1));
        expect(bodiesOf(fetchMock, "POST", "/api/mail/mailboxes/mb1/blocked-senders")).toEqual([{ entry: "sender@example.com" }]);
    });

    it("moves nothing and says why when the server refuses, as it does a reader without full access to the mailbox", async () => {
        serve(raw, (url, init) =>
            url === "/api/mail/mailboxes/mb1/blocked-senders" && method(init) === "POST"
                ? jsonResponse(403, { message: "Only the mailbox's owner can change its blocked and safe senders." })
                : undefined,
        );
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't block this sender" })]));
        expect(popups()[0].message).toContain("Only the mailbox's owner");
        expect(onMoved).not.toHaveBeenCalled();
    });

    it("says the sender is blocked but the message could not be moved, when the move fails", async () => {
        serve(raw, blockRoute, (url, init) => (url === "/api/mail/messages/m1" && method(init) === "PUT" ? jsonResponse(500, { message: "boom" }) : undefined));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(popups().map((popup) => popup.title)).toEqual(expect.arrayContaining(["Couldn't move this message to Junk Email", `Blocked ${HEADER}`])));
        expect(popups().find((popup) => popup.title === `Blocked ${HEADER}`)!.message).toContain("This message is still where it was.");
        expect(onMoved).not.toHaveBeenCalled();
    });

    it("does not block a From header that is one of the reader's own addresses, even when the message is filed under another", async () => {
        mailShellOverride.current = { ...mailShellOverride.current, mailboxes: [{ uid: "mb1", accessRole: "owner", primarySmtpAddress: "me@example.com", aliasAddresses: ["Header@Lists.example.com"] }] };
        const fetchMock = serve(raw, blockRoute);
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(popups()[0]).toMatchObject({ kind: "info", title: "That is your own address" });
        expect(bodiesOf(fetchMock, "POST", "/api/mail/mailboxes/mb1/blocked-senders")).toEqual([]);
    });

    it.each(["nodomain", "bad@@example.com"])("says a sender address that cannot go on a list (%s) cannot, and asks the server nothing", async (address) => {
        const fetchMock = serve((url) => (url === "/api/mail/messages/m1/raw" ? new Response("nope", { status: 500 }) : undefined), blockRoute);
        const user = userEvent.setup();
        render(<MessageDetailPane message={message({ from: { address, type: "to" } })} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Block ${address}`);
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't block this sender" })]));
        expect(popups()[0].message).toBe("This message has no sender address that can be put on a list.");
        expect(bodiesOf(fetchMock, "POST", "/api/mail/mailboxes/mb1/blocked-senders")).toEqual([]);
    });

    it("is not offered for the reader's own address", async () => {
        mailShellOverride.current = { ...mailShellOverride.current, mailboxes: [{ uid: "mb1", accessRole: "owner", primarySmtpAddress: "sender@example.com", aliasAddresses: [] }] };
        serve();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await openMenu(user, "Block");
        expect(screen.getByRole("menuitem", { name: /^Block Sender/ })).toBeDisabled();
    });

    it("is not offered for an address of another of the reader's own mailboxes either", async () => {
        mailShellOverride.current = {
            ...mailShellOverride.current,
            mailboxes: [
                { uid: "mb1", accessRole: "owner", primarySmtpAddress: "u1@example.com", aliasAddresses: [] },
                { uid: "mb2", accessRole: "owner", primarySmtpAddress: "other@example.com", aliasAddresses: ["sender@example.com"] },
            ],
        };
        serve();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await openMenu(user, "Block");
        expect(screen.getByRole("menuitem", { name: /^Block Sender/ })).toBeDisabled();
    });
});

describe("Block > Never block <sender>", () => {
    const SENDER = "Sender@Example.com";
    const HEADER = "header@lists.example.com";
    const safeRoute = listRoute("safe", (entry) => listChange(entry));

    it("adds the sender to the mailbox's safe senders, moves nothing, and says an authenticated sender is delivered to the Inbox instead of Junk", async () => {
        const fetchMock = serve(raw, safeRoute);
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);

        await choose(user, ["Block"], `Never block ${SENDER}`);

        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(bodiesOf(fetchMock, "POST", "/api/mail/mailboxes/mb1/safe-senders")).toEqual([{ entry: HEADER }]);
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("mail-filter-rules"))).toBe(false);
        expect(popups()[0]).toMatchObject({ kind: "success", title: `Never blocking ${HEADER}` });
        expect(popups()[0].message).toContain("Any block on this address is removed.");
        expect(popups()[0].message).toContain("Mail from it that passes authentication is delivered to your Inbox instead of Junk Email");
        expect(popups()[0].actions.map((action) => action.label)).toEqual(["Undo", "Manage safe senders"]);
        expect(popups()[0].actions[1].href).toBe("/settings/blocked-senders?mailboxUid=mb1");
        // Nothing was moved: this is about mail to come.
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")).toEqual([]);
    });

    it("takes the sender off the safe list with Undo", async () => {
        const fetchMock = serve(raw, safeRoute, unlistRoute("safe"));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Never block ${SENDER}`);
        await waitFor(() => expect(popups()).toHaveLength(1));
        act(() => popups()[0].actions[0].onClick!());
        await waitFor(() => expect(popups().map((popup) => popup.title)).toContain(`${HEADER} is no longer a safe sender`));
        expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/mail/mailboxes/mb1/safe-senders/header%40lists.example.com" && method(init) === "DELETE")).toBe(true);
    });

    it("says when Undo could not do it", async () => {
        serve(raw, safeRoute, unlistRoute("safe", 500));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Never block ${SENDER}`);
        await waitFor(() => expect(popups()).toHaveLength(1));
        act(() => popups()[0].actions[0].onClick!());
        await waitFor(() => expect(popups().map((popup) => popup.title)).toContain("Couldn't undo the change"));
    });

    it("says the sender is already a safe sender, with no Undo", async () => {
        serve(raw, listRoute("safe", (entry) => listChange(entry, false)));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Never block ${SENDER}`);
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(popups()[0]).toMatchObject({ kind: "info", title: `${HEADER} is already a safe sender` });
        expect(popups()[0].actions.map((action) => action.label)).toEqual(["Manage safe senders"]);
    });

    it("says what could not be done", async () => {
        serve(raw, (url, init) => (url === "/api/mail/mailboxes/mb1/safe-senders" && method(init) === "POST" ? jsonResponse(500, { message: "boom" }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Never block ${SENDER}`);
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't stop blocking this sender" })]));
    });

    it("says a sender address that cannot go on a list cannot", async () => {
        serve((url) => (url === "/api/mail/messages/m1/raw" ? new Response("nope", { status: 500 }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message({ from: { address: "nodomain", type: "to" } })} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], "Never block nodomain");
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't stop blocking this sender" })]));
    });
});

describe("Block and Never block on a server without sender lists", () => {
    const SENDER = "Sender@Example.com";
    const junkRule = (overrides: Record<string, unknown> = {}) => ({
        uid: "r1",
        version: 1,
        mailboxUid: "mb1",
        name: "Block sender@example.com",
        enabled: true,
        sequence: -1,
        stopProcessingRules: true,
        conditions: { fromContains: ["sender@example.com", "header@lists.example.com"] },
        actions: [{ type: "move_to_folder", folderUid: "f-junk" }],
        ...overrides,
    });
    const rules = (list: unknown[]): Handler => (url, init) => (url.startsWith("/api/mail/mail-filter-rules?") && method(init) === "GET" ? jsonResponse(200, list) : undefined);
    const createRule: Handler = (url, init) =>
        url === "/api/mail/mail-filter-rules" && method(init) === "POST" ? jsonResponse(200, { ...junkRule({ uid: "new", version: 0 }), ...JSON.parse(init.body as string) }) : undefined;

    it("blocks with a filter rule for the sender's addresses (the one it is filed under and the From header's), moves this message to Junk, and offers Undo and View rules", async () => {
        const original = message() as Record<string, any>;
        const moved = next(original, { folderUid: "f-junk" });
        const fetchMock = serve(noListRoutes, raw, rules([]), createRule, putTo("m1", () => moved));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await choose(user, ["Block"], `Block ${SENDER}`);

        await waitFor(() => expect(onMoved).toHaveBeenCalledWith(moved));
        expect(bodiesOf(fetchMock, "POST", "/api/mail/mail-filter-rules")).toEqual([
            expect.objectContaining({
                mailboxUid: "mb1",
                name: "Block sender@example.com",
                sequence: -1,
                stopProcessingRules: true,
                enabled: true,
                conditions: { fromContains: ["sender@example.com", "header@lists.example.com"] },
                actions: [{ type: "move_to_folder", folderUid: "f-junk" }],
            }),
        ]);
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")[0].folderUid).toBe("f-junk");
        const [popup] = popups();
        expect(popup).toMatchObject({
            kind: "success",
            title: `Blocked ${SENDER}`,
            message: "New mail from this address goes to Junk Email. This message was moved there.",
            hint: "This server has no list of blocked senders, so the block is a filter rule that matches any sender address containing this one.",
        });
        expect(popup.actions.map((action) => action.label)).toEqual(["Undo", "View rules"]);
        expect(popup.actions[1].href).toBe("/settings/filters?mailboxUid=mb1");
    });

    it("takes the block back with Undo, and says this message stays where it is", async () => {
        const fetchMock = serve(
            noListRoutes,
            raw,
            rules([]),
            createRule,
            putTo("m1", () => next(message() as Record<string, any>, { folderUid: "f-junk" })),
            (url, init) => (url === "/api/mail/mail-filter-rules/new?version=0" && method(init) === "DELETE" ? emptyResponse(204) : undefined),
        );
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(popups()).toHaveLength(1));

        act(() => popups()[0].actions[0].onClick!());

        await waitFor(() => expect(popups().map((popup) => popup.title)).toContain(`Unblocked ${SENDER}`));
        expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/mail/mail-filter-rules/new?version=0" && method(init) === "DELETE")).toBe(true);
    });

    it("says when Undo could not take the block back", async () => {
        serve(
            noListRoutes,
            raw,
            rules([]),
            createRule,
            putTo("m1", () => next(message() as Record<string, any>, { folderUid: "f-junk" })),
            (url, init) => (method(init) === "DELETE" ? jsonResponse(500, { message: "boom" }) : undefined),
        );
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(popups()).toHaveLength(1));
        act(() => popups()[0].actions[0].onClick!());
        await waitFor(() => expect(popups().map((popup) => popup.title)).toContain("Couldn't undo the block"));
    });

    it("makes no second rule when the sender is already blocked, says so, and still moves this message", async () => {
        const original = message() as Record<string, any>;
        const fetchMock = serve(noListRoutes, raw, rules([junkRule()]), putTo("m1", () => next(original, { folderUid: "f-junk" })));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={original as never} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);

        await choose(user, ["Block"], `Block ${SENDER}`);

        await waitFor(() => expect(onMoved).toHaveBeenCalled());
        expect(bodiesOf(fetchMock, "POST", "/api/mail/mail-filter-rules")).toEqual([]);
        expect(popups()).toEqual([expect.objectContaining({ kind: "info", title: `${SENDER} is already blocked` })]);
        // Nothing to Undo: no rule was made.
        expect(popups()[0].actions.map((action) => action.label)).toEqual(["View rules"]);
    });

    it("blocks the address it is filed under alone when the message's source cannot be read", async () => {
        const fetchMock = serve(
            noListRoutes,
            (url) => (url === "/api/mail/messages/m1/raw" ? new Response("nope", { status: 500 }) : undefined),
            rules([]),
            createRule,
            putTo("m1", () => next(message() as Record<string, any>, { folderUid: "f-junk" })),
        );
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(bodiesOf(fetchMock, "POST", "/api/mail/mail-filter-rules")).toHaveLength(1));
        expect(bodiesOf(fetchMock, "POST", "/api/mail/mail-filter-rules")[0].conditions).toEqual({ fromContains: ["sender@example.com"] });
    });

    it("moves nothing and says so when the rule could not be made", async () => {
        serve(noListRoutes, raw, rules([]), (url, init) => (url === "/api/mail/mail-filter-rules" && method(init) === "POST" ? jsonResponse(400, { message: "bad rule" }) : undefined));
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't block this sender" })]));
        expect(onMoved).not.toHaveBeenCalled();
    });

    it("turns a block that was switched off back on", async () => {
        const fetchMock = serve(
            noListRoutes,
            raw,
            rules([junkRule({ enabled: false })]),
            (url, init) => (url === "/api/mail/mail-filter-rules/r1" && method(init) === "PUT" ? jsonResponse(200, junkRule({ version: 2 })) : undefined),
            putTo("m1", () => next(message() as Record<string, any>, { folderUid: "f-junk" })),
        );
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(bodiesOf(fetchMock, "PUT", "/api/mail/mail-filter-rules/r1")).toEqual([expect.objectContaining({ enabled: true, version: 1 })]);
        expect(popups()[0]).toMatchObject({ kind: "success", title: `Blocked ${SENDER}` });
        expect(popups()[0].actions.map((action) => action.label)).toEqual(["View rules"]);
    });

    it("leaves a message that is already in Junk where it is when it falls back to a rule", async () => {
        serve(noListRoutes, raw, rules([]), createRule);
        const onMoved = vi.fn();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message({ folderUid: "f-junk" })} attachments={[]} folders={FOLDERS as never} onMoved={onMoved} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(popups()).toHaveLength(1));
        expect(popups()[0].message).toContain("This message is already in Junk Email.");
        expect(onMoved).not.toHaveBeenCalled();
    });

    it("says the sender is blocked but the message could not be moved, when the move fails", async () => {
        serve(noListRoutes, raw, rules([]), createRule, (url, init) => (url === "/api/mail/messages/m1" && method(init) === "PUT" ? jsonResponse(500, { message: "boom" }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Block"], `Block ${SENDER}`);
        await waitFor(() => expect(popups().map((popup) => popup.title)).toEqual(expect.arrayContaining(["Couldn't move this message to Junk Email", `Blocked ${SENDER}`])));
        expect(popups().find((popup) => popup.title === `Blocked ${SENDER}`)!.message).toContain("This message is still where it was.");
    });

    describe("Never block", () => {
        const rule = (uid: string, folderUid: string, name: string) => ({
            uid,
            version: 2,
            mailboxUid: "mb1",
            name,
            enabled: true,
            sequence: -1,
            stopProcessingRules: true,
            conditions: { fromContains: ["sender@example.com", "header@lists.example.com"] },
            actions: [{ type: "move_to_folder", folderUid }],
        });
        const keepRule: Handler = (url, init) =>
            url === "/api/mail/mail-filter-rules" && method(init) === "POST" ? jsonResponse(200, { ...rule("keep", "f1", "x"), ...JSON.parse(init.body as string) }) : undefined;

        it("makes the rule that keeps the sender in the Inbox, and says what it can and cannot do", async () => {
            const fetchMock = serve(noListRoutes, raw, rules([]), keepRule);
            const user = userEvent.setup();
            render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);

            await choose(user, ["Block"], `Never block ${SENDER}`);

            await waitFor(() => expect(popups()).toHaveLength(1));
            expect(bodiesOf(fetchMock, "POST", "/api/mail/mail-filter-rules")).toEqual([
                expect.objectContaining({
                    name: "Never block sender@example.com",
                    stopProcessingRules: true,
                    conditions: { fromContains: ["sender@example.com", "header@lists.example.com"] },
                    actions: [{ type: "move_to_folder", folderUid: "f1" }],
                }),
            ]);
            expect(popups()[0]).toMatchObject({
                kind: "success",
                title: `Never blocking ${SENDER}`,
                message: "New mail from this address stays in your Inbox, ahead of your other filters. Mail the spam filter judges to be junk still goes to Junk Email.",
            });
            expect(popups()[0].actions).toEqual([{ label: "View rules", href: "/settings/filters?mailboxUid=mb1" }]);
            // Nothing was moved: this is about mail to come.
            expect(bodiesOf(fetchMock, "PUT", "/api/mail/messages/m1")).toEqual([]);
        });

        it("takes away the block on the sender, and says so", async () => {
            const fetchMock = serve(noListRoutes, raw, rules([rule("block", "f-junk", "Block sender@example.com")]), keepRule, (url, init) =>
                url === "/api/mail/mail-filter-rules/block?version=2" && method(init) === "DELETE" ? emptyResponse(204) : undefined,
            );
            const user = userEvent.setup();
            render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
            await choose(user, ["Block"], `Never block ${SENDER}`);
            await waitFor(() => expect(popups()).toHaveLength(1));
            expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/mail/mail-filter-rules/block?version=2" && method(init) === "DELETE")).toBe(true);
            expect(popups()[0].message).toMatch(/^The block on this sender was removed\. New mail/);
            expect(popups()[0].kind).toBe("success");
        });

        it("makes nothing when the sender is already never blocked", async () => {
            const fetchMock = serve(noListRoutes, raw, rules([rule("keep", "f1", "Never block sender@example.com")]));
            const user = userEvent.setup();
            render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
            await choose(user, ["Block"], `Never block ${SENDER}`);
            await waitFor(() => expect(popups()).toHaveLength(1));
            expect(bodiesOf(fetchMock, "POST", "/api/mail/mail-filter-rules")).toEqual([]);
            expect(popups()[0]).toMatchObject({ kind: "info", title: `${SENDER} is already never blocked` });
        });

        it("says what could not be done", async () => {
            serve(noListRoutes, raw, (url) => (url.startsWith("/api/mail/mail-filter-rules?") ? jsonResponse(500, { message: "boom" }) : undefined));
            const user = userEvent.setup();
            render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
            await choose(user, ["Block"], `Never block ${SENDER}`);
            await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't stop blocking this sender" })]));
        });
    });
});

describe("Other reply actions", () => {
    it("opens the compose window for Reply all and Forward, as the buttons do", async () => {
        serve();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Other reply actions"], /^Reply all/);
        await waitFor(() => expect(openCompose).toHaveBeenCalledTimes(1));
        expect(openCompose.mock.calls[0][0]).toMatchObject({ subject: "Re: Hello there", mailboxUid: "mb1" });
        await waitFor(() => expect(screen.getByRole("button", { name: "Reply" })).toBeEnabled());
        await choose(user, ["Other reply actions"], /^Forward/);
        await waitFor(() => expect(openCompose).toHaveBeenCalledTimes(2));
        expect(openCompose.mock.calls[1][0]).toMatchObject({ subject: "Fwd: Re: Hello there" });
    });
});

describe("Print", () => {
    it("prints the message: its header lines and the body the server sanitized, in the print frame", async () => {
        serve((url, init) => (url === "/api/mail/messages/m1/content" ? new Response("<p>Server <b>body</b></p>", { headers: { "content-type": "text/html" } }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);

        await choose(user, [], "Print");

        await waitFor(() => expect(printDocument).toHaveBeenCalledTimes(1));
        const html = printDocument.mock.calls[0][0] as string;
        expect(html).toContain("<h1>Re: Hello there</h1>");
        expect(html).toContain("<dt>From</dt><dd>Sender One &lt;Sender@Example.com&gt;</dd>");
        expect(html).toContain("<dt>To</dt><dd>Me &lt;u1@example.com&gt;</dd>");
        expect(html).toContain("<dt>Cc</dt><dd>cc@example.com</dd>");
        expect(html).toContain(`<dd>${new Date("2026-01-01T12:30:00.000Z").toLocaleString()}</dd>`);
        expect(html).toContain("<b>body</b>");
    });

    it("prints Save as PDF the same way, through the print dialog", async () => {
        serve((url) => (url === "/api/mail/messages/m1/content" ? new Response("plain words", { headers: { "content-type": "text/plain" } }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Save as"], /^Save as PDF/);
        await waitFor(() => expect(printDocument).toHaveBeenCalledTimes(1));
        expect(printDocument.mock.calls[0][0]).toContain('<pre class="rr-text">plain words</pre>');
    });

    it("says a message too large to prepare cannot be printed here", async () => {
        serve((url) => (url === "/api/mail/messages/m1/content" ? new Response("x".repeat(1_600_000), { headers: { "content-type": "text/html" } }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, [], "Print");
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "warning", title: "This message is too large to print here" })]));
        expect(printDocument).not.toHaveBeenCalled();
    });

    it("says what went wrong when the body could not be fetched", async () => {
        serve((url) => (url === "/api/mail/messages/m1/content" ? jsonResponse(500, { message: "boom" }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, [], "Print");
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't print this message" })]));
    });

    describe("an encrypted message", () => {
        const encrypted = () => message({ encrypted: true, subject: "Encrypted message" });

        it("cannot be printed while it is still being opened", async () => {
            serve((url) => (url === "/api/mail/messages/m1/raw" ? new Promise<Response>(() => undefined) : undefined));
            const user = userEvent.setup();
            render(<MessageDetailPane message={encrypted()} attachments={[]} folders={FOLDERS as never} />);
            await openMenu(user);
            expect(screen.getByRole("menuitem", { name: /^Print/ })).toBeDisabled();
            expect(screen.getByRole("menuitem", { name: /^Print/ })).toHaveTextContent("Still opening this message");
        });

        it("cannot be printed while the keys are locked", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "locked" });
            serve(raw);
            const user = userEvent.setup();
            render(<MessageDetailPane message={encrypted()} attachments={[]} folders={FOLDERS as never} />);
            await screen.findByRole("button", { name: "Unlock to view this message" });
            await openMenu(user);
            expect(screen.getByRole("menuitem", { name: /^Print/ })).toHaveTextContent("Unlock this message to print it");
        });

        it("cannot be printed when it cannot be read even with the keys open", async () => {
            getUnlockedKeys.mockReturnValue([{}]);
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "Wrong key" });
            serve(raw);
            const user = userEvent.setup();
            render(<MessageDetailPane message={encrypted()} attachments={[]} folders={FOLDERS as never} />);
            await screen.findByText(/Wrong key/);
            await openMenu(user);
            expect(screen.getByRole("menuitem", { name: /^Print/ })).toHaveTextContent("This message can't be read, so it can't be printed");
        });

        it("prints the text it was opened to, never the server's ciphertext", async () => {
            evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", text: "the secret words" });
            const fetchMock = serve(raw);
            const user = userEvent.setup();
            render(<MessageDetailPane message={encrypted()} attachments={[]} folders={FOLDERS as never} />);
            await waitFor(() => expect(evaluateMessageSecurity).toHaveBeenCalled());
            await choose(user, [], "Print");
            await waitFor(() => expect(printDocument).toHaveBeenCalledTimes(1));
            expect(printDocument.mock.calls[0][0]).toContain('<pre class="rr-text">the secret words</pre>');
            expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/content"))).toBe(false);
        });
    });
});

describe("View > source and details", () => {
    it("shows the message source in a dialog, and closes it with the focus back on the menu button", async () => {
        serve(raw);
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);

        await choose(user, ["View"], /^View message source/);

        const dialog = await screen.findByRole("dialog", { name: "Message source" });
        expect(await within(dialog).findByLabelText("Message source", { selector: "pre" })).toHaveTextContent("From: Header Sender <header@lists.example.com>");
        expect(within(dialog).getByLabelText("Message source", { selector: "pre" })).toHaveTextContent("Body");
        expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog", { name: "Message source" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "More actions" })).toHaveFocus();
    });

    it("shows only the headers as the message's details", async () => {
        serve(raw);
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["View"], /^Message details/);
        const block = await screen.findByLabelText("Message details", { selector: "pre" });
        await waitFor(() => expect(block).toHaveTextContent("Subject: Hello there"));
        expect(block.textContent).not.toContain("Body");
    });

    it("labels the source of an encrypted message as the ciphertext the server has", async () => {
        evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "locked" });
        serve(raw);
        const user = userEvent.setup();
        render(<MessageDetailPane message={message({ encrypted: true })} attachments={[]} folders={FOLDERS as never} />);
        await waitFor(() => expect(evaluateMessageSecurity).toHaveBeenCalled());
        await choose(user, ["View"], /^View message source/);
        expect(await screen.findByRole("note")).toHaveTextContent("it is not decrypted here");
    });

    it("says why the source could not be loaded, and a non-API failure generically", async () => {
        serve((url) => (url === "/api/mail/messages/m1/raw" ? jsonResponse(404, { message: "It is gone" }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["View"], /^View message source/);
        expect(await screen.findByRole("alert")).toHaveTextContent("It is gone");
        await user.click(screen.getByRole("button", { name: "Close" }));
        vi.stubGlobal("fetch", () => Promise.reject(new TypeError("network down")));
        await choose(user, ["View"], /^View message source/);
        expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this message's source.");
    });

    it("shows nothing of a source that arrives after the dialog was closed", async () => {
        let answer: (response: Response) => void = () => undefined;
        serve((url) => (url === "/api/mail/messages/m1/raw" ? new Promise<Response>((resolve) => (answer = resolve)) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["View"], /^View message source/);
        expect(await screen.findByRole("status")).toHaveTextContent("Loading the message");
        await user.click(screen.getByRole("button", { name: "Close" }));
        answer(new Response(RAW));
        // Give the answer time to arrive: it must change nothing.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
        });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows nothing of a failure that arrives after the dialog was closed", async () => {
        let fail: (response: Response) => void = () => undefined;
        serve((url) => (url === "/api/mail/messages/m1/raw" ? new Promise<Response>((resolve) => (fail = resolve)) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["View"], /^View message source/);
        await user.click(await screen.findByRole("button", { name: "Close" }));
        fail(jsonResponse(500, { message: "late" }));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
        });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});

describe("Save as > Save as .eml", () => {
    function stubDownload() {
        const saved: { name: string; blob: Blob }[] = [];
        let last: Blob | undefined;
        Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: (blob: Blob) => ((last = blob), "blob:eml") });
        Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            saved.push({ name: this.download, blob: last! });
        });
        return saved;
    }

    afterEach(() => {
        delete (URL as unknown as Record<string, unknown>).createObjectURL;
        delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    });

    it("downloads the raw message, named after its subject", async () => {
        const saved = stubDownload();
        serve(raw);
        const user = userEvent.setup();
        render(<MessageDetailPane message={message({ subject: "Plan: Q3/Q4?" })} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Save as"], /^Save as \.eml/);
        await waitFor(() => expect(saved).toHaveLength(1));
        expect(saved[0].name).toBe("Plan Q3 Q4.eml");
        expect(saved[0].blob.type).toBe("message/rfc822");
        expect(saved[0].blob.size).toBe(RAW.length);
    });

    it("is named for what an encrypted message says, not its placeholder subject", async () => {
        const saved = stubDownload();
        serve(raw);
        const user = userEvent.setup();
        render(<MessageDetailPane message={message({ encrypted: true, subject: "Encrypted message" })} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Save as"], /^Save as \.eml/);
        await waitFor(() => expect(saved).toHaveLength(1));
        expect(saved[0].name).toBe("Encrypted message.eml");
    });

    it("says what could not be saved", async () => {
        stubDownload();
        serve((url) => (url === "/api/mail/messages/m1/raw" ? jsonResponse(500, { message: "boom" }) : undefined));
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />);
        await choose(user, ["Save as"], /^Save as \.eml/);
        await waitFor(() => expect(popups()).toEqual([expect.objectContaining({ kind: "error", title: "Couldn't save this message" })]));
    });
});

describe("Advanced actions > Create rule", () => {
    it("opens the new filter page for the message's mailbox with its sender and its subject, without Re:", async () => {
        serve();
        const user = userEvent.setup();
        const router = createFakeRouter({ url: "/" });
        render(
            <TestRouter router={router}>
                <MessageDetailPane message={message()} attachments={[]} folders={FOLDERS as never} />
            </TestRouter>,
        );
        await choose(user, ["Advanced actions"], /^Create rule/);
        expect(router.navigate).toHaveBeenCalledTimes(1);
        expect(router.navigate).toHaveBeenCalledWith("/settings/filters/new?mailboxUid=mb1&from=Sender%40Example.com&subject=Hello+there", expect.anything());
    });

    it("leaves the subject out for an encrypted message, and for one that has none", async () => {
        serve();
        const user = userEvent.setup();
        const router = createFakeRouter({ url: "/" });
        const { unmount } = render(
            <TestRouter router={router}>
                <MessageDetailPane message={message({ encrypted: true, subject: "Encrypted message" })} attachments={[]} folders={FOLDERS as never} />
            </TestRouter>,
        );
        await choose(user, ["Advanced actions"], /^Create rule/);
        expect(router.navigate.mock.calls[0][0]).toBe("/settings/filters/new?mailboxUid=mb1&from=Sender%40Example.com");
        unmount();
        render(
            <TestRouter router={router}>
                <MessageDetailPane message={message({ subject: "Fwd:" })} attachments={[]} folders={FOLDERS as never} />
            </TestRouter>,
        );
        await choose(user, ["Advanced actions"], /^Create rule/);
        expect(router.navigate.mock.calls[1][0]).toBe("/settings/filters/new?mailboxUid=mb1&from=Sender%40Example.com");
    });
});

describe("the menu in the message's own place", () => {
    it("does not act on a message that is still loading its mailbox: the menu works with the shell knowing no mailboxes", async () => {
        serve();
        const user = userEvent.setup();
        render(<MessageDetailPane message={message()} attachments={[]} />);
        await openMenu(user);
        expect(screen.getByRole("menuitem", { name: /^Delete/ })).toBeEnabled();
    });
});
