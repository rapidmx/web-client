// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// MailShell's sidebar sections ("All Mailboxes" and one per mailbox) as collapsible disclosures: what is open by default, what a toggle
// remembers (per user), that the section of the open folder is never hidden, the unread badge a collapsed section shows, the same list
// in the phone's folders drawer, and the single-mailbox sidebar, which has nothing to collapse.
import React, { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MailShell, { useMailShell } from "../../../apps/shared/components/mail/layout/MailShell.js";
import AppRouter, { useNavigate } from "../../../apps/shared/navigation/AppRouter.js";
import { collapsedSectionsKey } from "../../../apps/shared/mail/useCollapsedSections.js";

vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", () => ({
    getKeyVault: vi.fn().mockResolvedValue({ wrappedKeys: [{ fingerprint: "already-enrolled" }], masterKeyWraps: [] }),
    enrollKey: vi.fn(),
    getEncryptionPolicy: vi.fn().mockResolvedValue({ encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" }),
    lookupKeys: vi.fn().mockResolvedValue({ keys: [] }),
    findActivePublicKey: vi.fn().mockReturnValue(undefined),
}));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({
    MASTER_KEY_AAD_PURPOSE: "master-key",
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE: "encrypt-private-key",
    getUnlockedKeys: vi.fn().mockReturnValue({ masterKey: new Uint8Array(32) }),
    unlockWithPassword: vi.fn(),
    destroyUnlockedKeys: vi.fn(),
    subscribeKeySession: vi.fn(() => () => undefined),
}));
vi.mock("../../../apps/shared/search/LocalIndexLifecycle.js", () => ({ default: () => null }));

// The chrome is the stand-in the router's own tests use: here only the shell inside it matters.
vi.mock("../../../apps/shared/components/layout/AppShell.js", async () => {
    const react = await import("react");
    return {
        AppChrome: (props: any) => react.createElement("div", { "data-testid": "chrome" }, props.children),
        default: (props: any) => react.createElement(react.Fragment, null, props.children),
    };
});

const base = {
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    aliasAddresses: [],
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};
/** The caller's own (primary) mailbox: created first, so it stays the primary one. */
const own = { ...base, uid: "mb-jp", displayName: "Jean-Philippe", primarySmtpAddress: "jp@example.com", ownerUserUid: "u1", accessRole: "owner", dateCreated: "2025-01-01T00:00:00.000Z" };
/** A shared mailbox the server lists ahead of the caller's own. */
const hello = { ...base, uid: "mb-hello", displayName: "Hello", primarySmtpAddress: "hello@example.com", ownerUserUid: undefined, accessRole: "delegate" };
/** A second mailbox of the caller's own: not the primary one, so collapsed by default. */
const alpha = { ...base, uid: "mb-alpha", displayName: "Alpha", primarySmtpAddress: "alpha@example.com", ownerUserUid: "u1", accessRole: "owner" };

const INBOX_UNREAD: Record<string, number> = { "mb-jp": 0, "mb-hello": 0, "mb-alpha": 0 };
/** Folders a test adds to a mailbox besides its Inbox and Drafts: an Archive, a user's own folder, Junk Email or Deleted Items, with their unread counts. */
const EXTRA_FOLDERS: Record<string, { type: string; name: string; unread: number }[]> = {};
/** What the server says of a mailbox's folders: an Inbox with the unread count set in `INBOX_UNREAD`, and Drafts holding two messages. */
function foldersOf(mailboxUid: string) {
    const folder = (type: string, name: string, unreadCount: number, totalCount: number) => ({
        ...base,
        uid: `f-${type}-${mailboxUid}`,
        mailboxUid,
        name,
        type,
        unreadCount,
        totalCount,
    });
    return [
        folder("inbox", "Inbox", INBOX_UNREAD[mailboxUid] ?? 0, 10),
        folder("drafts", "Drafts", 0, 2),
        ...(EXTRA_FOLDERS[mailboxUid] ?? []).map((extra) => folder(extra.type, extra.name, extra.unread, 6)),
    ];
}

function mockServer(mailboxes: unknown[]) {
    mockFetch((url) => {
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, mailboxes);
        if (url.startsWith("/api/mail/folders")) {
            const mailbox = (mailboxes as { uid: string }[]).find((mb) => url.includes(`mailboxUid=${mb.uid}`));
            return jsonResponse(200, mailbox ? foldersOf(mailbox.uid) : []);
        }
        return jsonResponse(200, []);
    });
}

let go: (href: string) => void;
let track: (previous: any, next: any) => unknown;

function Probe() {
    const { mailboxUid, folderUid, aggregateFolderType, trackMessageChange } = useMailShell();
    const navigate = useNavigate();
    useEffect(() => {
        go = navigate;
        track = trackMessageChange;
    });
    return <output data-testid="probe">{`${mailboxUid}|${folderUid}|${aggregateFolderType}`}</output>;
}

function Page(props: any) {
    return (
        <MailShell {...props}>
            <Probe />
        </MailShell>
    );
}

function renderShell(userUid = "u1") {
    return render(
        <AppRouter
            routes={[{ path: "/", active: "mail", load: () => Promise.resolve({ default: () => null }) }]}
            initialPath="/"
            initialPage={Page}
            pageProps={{ userUid }}
        />,
    );
}

/** A section's heading button, in the whole page or (`within`) one of its two copies of the sidebar. */
const heading = (name: RegExp, scope: { getByRole: typeof screen.getByRole } = screen) => scope.getByRole("button", { name });
/** A collapsed heading's accessible name: its text, then the unread count for a screen reader (the two are separate flex items, so a browser puts a space between them). */
const unreadName = (label: string, unread: number) => new RegExp(`^${label.replace(/[()]/g, (c) => `\\${c}`)}\\s*${unread} unread$`);
const stored = (userUid = "u1") => JSON.parse(localStorage.getItem(collapsedSectionsKey(userUid)) ?? "null");
/** The hrefs of the folder rows on show (not inside a collapsed section). */
const visibleFolderHrefs = (scope: { getAllByRole: typeof screen.getAllByRole } = screen) =>
    scope.getAllByRole("link").map((el) => el.getAttribute("href")!).filter((href) => href.includes("folderUid="));
const inboxHref = (uid: string) => `/?mailboxUid=${uid}&folderUid=f-inbox-${uid}`;

beforeEach(() => {
    Object.assign(INBOX_UNREAD, { "mb-jp": 0, "mb-hello": 0, "mb-alpha": 0 });
    for (const uid of Object.keys(EXTRA_FOLDERS)) delete EXTRA_FOLDERS[uid];
    window.history.replaceState(null, "", "/");
    mockServer([hello, own, alpha]);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("MailShell's collapsible sidebar sections", () => {
    it("opens All Mailboxes and the primary mailbox and collapses every other mailbox by default", async () => {
        renderShell();
        await screen.findByRole("button", { name: /All Mailboxes/ });

        expect(heading(/All Mailboxes/)).toHaveAttribute("aria-expanded", "true");
        expect(heading(/^Jean-Philippe/)).toHaveAttribute("aria-expanded", "true");
        expect(heading(/^Alpha/)).toHaveAttribute("aria-expanded", "false");
        expect(heading(/^Hello/)).toHaveAttribute("aria-expanded", "false");
        // The order is the primary mailbox first, the caller's others, then the shared ones.
        expect(screen.getAllByRole("button", { name: /^(Jean-Philippe|Alpha|Hello)/ }).map((el) => el.textContent)).toEqual([
            "Jean-Philippe",
            "Alpha",
            "Hello (shared)",
        ]);
        // Only the open sections' folders are on show; the rest are still in the document, hidden.
        expect(visibleFolderHrefs()).toEqual([inboxHref("mb-jp"), `/?mailboxUid=mb-jp&folderUid=f-drafts-mb-jp`]);
        expect(screen.getAllByRole("link", { hidden: true }).some((el) => el.getAttribute("href") === inboxHref("mb-hello"))).toBe(true);
        expect(screen.getAllByRole("link").filter((el) => el.getAttribute("href")?.startsWith("/?aggregate="))).toHaveLength(5);
        // Nothing has been chosen, so nothing is stored.
        expect(localStorage.getItem(collapsedSectionsKey("u1"))).toBeNull();
    });

    it("makes each heading a disclosure button that controls its own folder list, with a chevron that turns", async () => {
        renderShell();
        const hello = await screen.findByRole("button", { name: /^Hello/ });
        const primary = heading(/^Jean-Philippe/);

        const controlled = document.getElementById(hello.getAttribute("aria-controls")!)!;
        expect(controlled).toBeInTheDocument();
        expect(controlled).toHaveAttribute("hidden");
        expect(within(controlled).getByRole("link", { hidden: true, name: /Inbox/ })).toHaveAttribute("href", inboxHref("mb-hello"));
        const primaryList = document.getElementById(primary.getAttribute("aria-controls")!)!;
        expect(primaryList).not.toHaveAttribute("hidden");
        expect(within(primaryList).getAllByRole("link")).toHaveLength(2);

        // A heading is a real heading, holding the button.
        expect(hello.closest("h2")).not.toBeNull();
        expect(hello).toHaveAttribute("type", "button");
        expect(hello.querySelector("svg")).toHaveClass("-rotate-90");
        expect(primary.querySelector("svg")).not.toHaveClass("-rotate-90");
        expect(hello.className).toContain("focus-visible:outline-primary");

        fireEvent.click(hello);
        expect(hello).toHaveAttribute("aria-expanded", "true");
        expect(controlled).not.toHaveAttribute("hidden");
        expect(hello.querySelector("svg")).not.toHaveClass("-rotate-90");
    });

    it("toggles with the mouse, remembers the choice for this user, and keeps it across a remount", async () => {
        const user = userEvent.setup();
        const first = renderShell();
        await user.click(await screen.findByRole("button", { name: /^Hello/ }));
        // The primary mailbox holds the selected folder, and collapses like any other section.
        await user.click(heading(/^Jean-Philippe/));

        expect(heading(/^Hello/)).toHaveAttribute("aria-expanded", "true");
        expect(heading(/^Jean-Philippe/)).toHaveAttribute("aria-expanded", "false");
        expect(visibleFolderHrefs()).toEqual([inboxHref("mb-hello"), "/?mailboxUid=mb-hello&folderUid=f-drafts-mb-hello"]);
        expect(stored()).toEqual({ "mb-hello": false, "mb-jp": true });
        first.unmount();

        renderShell();
        await screen.findByRole("button", { name: /^Hello/ });
        expect(heading(/^Hello/)).toHaveAttribute("aria-expanded", "true");
        expect(heading(/^Jean-Philippe/)).toHaveAttribute("aria-expanded", "false");
        expect(heading(/All Mailboxes/)).toHaveAttribute("aria-expanded", "true");
        expect(heading(/^Alpha/)).toHaveAttribute("aria-expanded", "false");
    });

    it("toggles from the keyboard with Enter and with Space", async () => {
        const user = userEvent.setup();
        renderShell();
        const alphaHeading = await screen.findByRole("button", { name: /^Alpha/ });

        alphaHeading.focus();
        expect(alphaHeading).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(alphaHeading).toHaveAttribute("aria-expanded", "true");
        await user.keyboard(" ");
        expect(alphaHeading).toHaveAttribute("aria-expanded", "false");
        await user.keyboard("[Space]");
        expect(alphaHeading).toHaveAttribute("aria-expanded", "true");
        expect(stored()).toEqual({ "mb-alpha": false });
    });

    it("can collapse All Mailboxes, which stays collapsed after a reload", async () => {
        const user = userEvent.setup();
        const first = renderShell();
        await user.click(await screen.findByRole("button", { name: /All Mailboxes/ }));
        expect(screen.queryAllByRole("link").filter((el) => el.getAttribute("href")?.startsWith("/?aggregate="))).toHaveLength(0);
        expect(stored()).toEqual({ all: true });
        first.unmount();

        renderShell();
        expect(await screen.findByRole("button", { name: /All Mailboxes/ })).toHaveAttribute("aria-expanded", "false");
    });

    it("does not change the selection or the address when a section is collapsed or opened", async () => {
        const user = userEvent.setup();
        window.history.replaceState(null, "", "/?mailboxUid=mb-jp&folderUid=f-drafts-mb-jp");
        renderShell();
        await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-jp|f-drafts-mb-jp|undefined"));

        await user.click(await screen.findByRole("button", { name: /^Hello/ }));
        await user.click(heading(/All Mailboxes/));
        await user.click(heading(/All Mailboxes/));
        await user.click(heading(/^Hello/));

        expect(screen.getByTestId("probe")).toHaveTextContent("mb-jp|f-drafts-mb-jp|undefined");
        expect(window.location.search).toBe("?mailboxUid=mb-jp&folderUid=f-drafts-mb-jp");
        expect(visibleFolderHrefs()).toContain("/?mailboxUid=mb-jp&folderUid=f-drafts-mb-jp");
    });

    it("keeps one user's choices apart from another's", async () => {
        const user = userEvent.setup();
        const first = renderShell("u1");
        await user.click(await screen.findByRole("button", { name: /^Hello/ }));
        expect(stored("u1")).toEqual({ "mb-hello": false });
        first.unmount();

        // The same browser, another account: nothing of the first one's carries over, and their own choice lands under their own key.
        mockServer([own, hello]);
        renderShell("u2");
        const second = await screen.findByRole("button", { name: /^Hello/ });
        expect(second).toHaveAttribute("aria-expanded", "false");
        await user.click(second);
        expect(stored("u2")).toEqual({ "mb-hello": false });
        expect(stored("u1")).toEqual({ "mb-hello": false });
        await user.click(second);
        expect(stored("u2")).toEqual({ "mb-hello": true });
        expect(stored("u1")).toEqual({ "mb-hello": false });
    });

    describe("storage that is corrupt or blocked", () => {
        it("falls back to the defaults for corrupt JSON, and a toggle replaces it", async () => {
            const user = userEvent.setup();
            localStorage.setItem(collapsedSectionsKey("u1"), "{not json");
            renderShell();
            const hello = await screen.findByRole("button", { name: /^Hello/ });
            expect(hello).toHaveAttribute("aria-expanded", "false");
            expect(heading(/^Jean-Philippe/)).toHaveAttribute("aria-expanded", "true");

            await user.click(hello);
            expect(hello).toHaveAttribute("aria-expanded", "true");
            expect(stored()).toEqual({ "mb-hello": false });
        });

        it("ignores stored values that are not choices, section by section", async () => {
            localStorage.setItem(collapsedSectionsKey("u1"), JSON.stringify({ "mb-hello": false, "mb-alpha": "open", "mb-jp": [true] }));
            renderShell();
            await screen.findByRole("button", { name: /^Hello/ });
            expect(heading(/^Hello/)).toHaveAttribute("aria-expanded", "true");
            expect(heading(/^Alpha/)).toHaveAttribute("aria-expanded", "false");
            expect(heading(/^Jean-Philippe/)).toHaveAttribute("aria-expanded", "true");
        });

        it("still opens and closes sections when localStorage throws, just without remembering them", async () => {
            const user = userEvent.setup();
            const getItem = Storage.prototype.getItem;
            const setItem = Storage.prototype.setItem;
            vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
                if (key.startsWith("rapidmx:mail-sidebar-collapsed:")) throw new Error("blocked");
                return getItem.call(this, key);
            });
            vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
                if (key.startsWith("rapidmx:mail-sidebar-collapsed:")) throw new Error("blocked");
                return setItem.call(this, key, value);
            });
            renderShell();
            const hello = await screen.findByRole("button", { name: /^Hello/ });
            expect(hello).toHaveAttribute("aria-expanded", "false");
            expect(heading(/^Jean-Philippe/)).toHaveAttribute("aria-expanded", "true");

            await user.click(hello);
            expect(hello).toHaveAttribute("aria-expanded", "true");
            await user.click(hello);
            expect(hello).toHaveAttribute("aria-expanded", "false");
        });
    });

    describe("the section of the open folder", () => {
        it("opens on All Mailboxes > Inbox, and that section can be collapsed with its Inbox still the selected view", async () => {
            const user = userEvent.setup();
            const first = renderShell();
            await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("undefined|undefined|inbox"));
            const all = await screen.findByRole("button", { name: /All Mailboxes/ });
            expect(all).toHaveAttribute("aria-expanded", "true");
            // The primary mailbox is open only by default, not because the open view is in it.
            expect(heading(/^Jean-Philippe/)).toHaveAttribute("aria-expanded", "true");
            expect(heading(/^Jean-Philippe/)).not.toHaveAttribute("aria-disabled");

            await user.click(all);
            expect(all).toHaveAttribute("aria-expanded", "false");
            expect(screen.getByTestId("probe")).toHaveTextContent("undefined|undefined|inbox");
            expect(stored()).toEqual({ all: true });
            first.unmount();

            renderShell();
            await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("undefined|undefined|inbox"));
            expect(await screen.findByRole("button", { name: /All Mailboxes/ })).toHaveAttribute("aria-expanded", "false");
        });

        it("can be collapsed, the primary mailbox's included, without changing the selection - and stays collapsed after a reload", async () => {
            const user = userEvent.setup();
            window.history.replaceState(null, "", "/?mailboxUid=mb-jp");
            const first = renderShell();
            await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-jp|f-inbox-mb-jp|undefined"));
            const primary = await screen.findByRole("button", { name: /^Jean-Philippe/ });
            expect(primary).toHaveAttribute("aria-expanded", "true");
            expect(primary).not.toHaveAttribute("aria-disabled");
            expect(primary).not.toHaveAttribute("title");

            await user.click(primary);
            expect(primary).toHaveAttribute("aria-expanded", "false");
            expect(visibleFolderHrefs()).toEqual([]);
            expect(screen.getByTestId("probe")).toHaveTextContent("mb-jp|f-inbox-mb-jp|undefined");
            expect(stored()).toEqual({ "mb-jp": true });
            first.unmount();

            // The Inbox is still the selected folder after a reload, and its section is still collapsed.
            renderShell();
            await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-jp|f-inbox-mb-jp|undefined"));
            expect(await screen.findByRole("button", { name: /^Jean-Philippe/ })).toHaveAttribute("aria-expanded", "false");
            expect(visibleFolderHrefs()).toEqual([]);
            const hiddenInbox = screen.getAllByRole("link", { hidden: true }).find((el) => el.getAttribute("href") === inboxHref("mb-jp"))!;
            expect(hiddenInbox.className).toContain("bg-primary/10");
        });

        it("stays collapsed when the page loads on a folder in it, whether by choice or by default", async () => {
            localStorage.setItem(collapsedSectionsKey("u1"), JSON.stringify({ "mb-alpha": true }));
            window.history.replaceState(null, "", "/?mailboxUid=mb-alpha");
            const first = renderShell();
            await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-alpha|f-inbox-mb-alpha|undefined"));
            expect(await screen.findByRole("button", { name: /^Alpha/ })).toHaveAttribute("aria-expanded", "false");
            first.unmount();

            window.history.replaceState(null, "", "/?mailboxUid=mb-hello&folderUid=f-drafts-mb-hello");
            renderShell();
            await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-hello|f-drafts-mb-hello|undefined"));
            expect(await screen.findByRole("button", { name: /^Hello/ })).toHaveAttribute("aria-expanded", "false");
            expect(localStorage.getItem(collapsedSectionsKey("u1"))).toBe(JSON.stringify({ "mb-alpha": true }));
        });

        it("opens a collapsed section when the open folder moves into it, without making that a choice, and closes it again when it moves on", async () => {
            renderShell();
            const hello = await screen.findByRole("button", { name: /^Hello/ });
            await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("undefined|undefined|inbox"));
            expect(hello).toHaveAttribute("aria-expanded", "false");

            act(() => go("/?mailboxUid=mb-hello"));
            await waitFor(() => expect(hello).toHaveAttribute("aria-expanded", "true"));
            const inbox = screen.getAllByRole("link").find((el) => el.getAttribute("href") === inboxHref("mb-hello"))!;
            expect(inbox.className).toContain("bg-primary/10");
            expect(heading(/^Jean-Philippe/)).toHaveAttribute("aria-expanded", "true");
            expect(localStorage.getItem(collapsedSectionsKey("u1"))).toBeNull();

            // A folder chosen in the sidebar itself, back in the primary mailbox.
            fireEvent.click(screen.getAllByRole("link").find((el) => el.getAttribute("href") === inboxHref("mb-jp"))!);
            await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-jp|f-inbox-mb-jp|undefined"));
            await waitFor(() => expect(hello).toHaveAttribute("aria-expanded", "false"));
            expect(localStorage.getItem(collapsedSectionsKey("u1"))).toBeNull();
        });

        it("opens the section over a stored choice to collapse it, and All Mailboxes when an all-mailboxes view is opened", async () => {
            localStorage.setItem(collapsedSectionsKey("u1"), JSON.stringify({ all: true, "mb-hello": true }));
            renderShell();
            const all = await screen.findByRole("button", { name: /All Mailboxes/ });
            const hello = heading(/^Hello/);
            // The page opens on All Mailboxes > Inbox, and its section stays collapsed as chosen: a load is not a navigation.
            expect(all).toHaveAttribute("aria-expanded", "false");
            await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("undefined|undefined|inbox"));

            act(() => go("/?mailboxUid=mb-jp"));
            await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-jp|f-inbox-mb-jp|undefined"));
            expect(all).toHaveAttribute("aria-expanded", "false");

            act(() => go("/?aggregate=inbox"));
            await waitFor(() => expect(all).toHaveAttribute("aria-expanded", "true"));
            const aggregateInbox = screen.getAllByRole("link").find((el) => el.getAttribute("href") === "/?aggregate=inbox")!;
            expect(aggregateInbox.className).toContain("bg-primary/10");

            act(() => go("/?mailboxUid=mb-hello"));
            await waitFor(() => expect(hello).toHaveAttribute("aria-expanded", "true"));
            await waitFor(() => expect(all).toHaveAttribute("aria-expanded", "false"));
            expect(stored()).toEqual({ all: true, "mb-hello": true });
        });

        it("makes the reader's own choice, the opposite of what shows, when the section it opened is toggled", async () => {
            const user = userEvent.setup();
            renderShell();
            const hello = await screen.findByRole("button", { name: /^Hello/ });
            await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("undefined|undefined|inbox"));
            act(() => go("/?mailboxUid=mb-hello"));
            await waitFor(() => expect(hello).toHaveAttribute("aria-expanded", "true"));

            await user.click(hello);
            expect(hello).toHaveAttribute("aria-expanded", "false");
            expect(stored()).toEqual({ "mb-hello": true });
            // The selection did not move, and the folder is simply hidden by the reader's choice.
            expect(screen.getByTestId("probe")).toHaveTextContent("mb-hello|f-inbox-mb-hello|undefined");

            await user.click(hello);
            expect(hello).toHaveAttribute("aria-expanded", "true");
            expect(stored()).toEqual({ "mb-hello": false });
        });
    });

    describe("the unread badge on a collapsed heading", () => {
        it("sums the unread mail in the folders of a collapsed mailbox that carry an unread count, and goes away when it is opened", async () => {
            const user = userEvent.setup();
            INBOX_UNREAD["mb-hello"] = 5;
            EXTRA_FOLDERS["mb-hello"] = [
                { type: "archive", name: "Archive", unread: 2 },
                { type: "user", name: "Projects", unread: 1 },
            ];
            renderShell();
            const hello = await screen.findByRole("button", { name: /^Hello/ });

            // Drafts' two messages are a total, not unread mail, so they are not part of it.
            expect(hello).toHaveAccessibleName(unreadName("Hello (shared)", 8));
            expect(within(hello).getByText("8")).toBeInTheDocument();
            expect(heading(/^Alpha/)).toHaveAccessibleName("Alpha");

            await user.click(hello);
            expect(hello).toHaveAccessibleName("Hello (shared)");
            // The rows inside still carry their own.
            const list = document.getElementById(hello.getAttribute("aria-controls")!)!;
            expect(within(list).getByRole("link", { name: /^Inbox\s*5 unread/ })).toBeInTheDocument();
            expect(within(list).getByRole("link", { name: /^Archive\s*2 unread/ })).toBeInTheDocument();

            await user.click(hello);
            expect(hello).toHaveAccessibleName(unreadName("Hello (shared)", 8));
        });

        it("shows the chip for unread mail in Archive alone, or in a user's own folder alone", async () => {
            EXTRA_FOLDERS["mb-hello"] = [{ type: "archive", name: "Archive", unread: 3 }];
            EXTRA_FOLDERS["mb-alpha"] = [{ type: "user", name: "Projects", unread: 4 }];
            renderShell();
            expect(await screen.findByRole("button", { name: /^Hello/ })).toHaveAccessibleName(unreadName("Hello (shared)", 3));
            expect(heading(/^Alpha/)).toHaveAccessibleName(unreadName("Alpha", 4));
        });

        it("shows no chip for unread mail in Junk Email, Deleted Items or Sent Items alone, or when there is none", async () => {
            EXTRA_FOLDERS["mb-hello"] = [
                { type: "junk", name: "Junk Email", unread: 7 },
                { type: "deleted_items", name: "Deleted Items", unread: 3 },
                { type: "sent_items", name: "Sent Items", unread: 2 },
            ];
            renderShell();
            const hello = await screen.findByRole("button", { name: /^Hello/ });
            expect(hello).toHaveAccessibleName("Hello (shared)");
            expect(heading(/^Alpha/)).toHaveAccessibleName("Alpha");
            expect(within(hello).queryByText(/\d/)).not.toBeInTheDocument();
        });

        it("shows no chip on an open section, however much is unread in it", async () => {
            INBOX_UNREAD["mb-jp"] = 4;
            renderShell();
            const primary = await screen.findByRole("button", { name: /^Jean-Philippe/ });
            expect(primary).toHaveAccessibleName("Jean-Philippe");
            expect(within(primary).queryByText("4")).not.toBeInTheDocument();
        });

        it("sums the same folders of every mailbox on All Mailboxes while it is collapsed, and shows none while it is open", async () => {
            const user = userEvent.setup();
            INBOX_UNREAD["mb-jp"] = 2;
            INBOX_UNREAD["mb-hello"] = 5;
            INBOX_UNREAD["mb-alpha"] = 1;
            EXTRA_FOLDERS["mb-hello"] = [{ type: "archive", name: "Archive", unread: 2 }];
            EXTRA_FOLDERS["mb-alpha"] = [{ type: "junk", name: "Junk Email", unread: 9 }];
            renderShell();
            const all = await screen.findByRole("button", { name: /All Mailboxes/ });
            expect(all).toHaveAccessibleName("All Mailboxes");

            await user.click(all);
            expect(all).toHaveAccessibleName(unreadName("All Mailboxes", 10));
        });

        it("follows the counts as they change, so new mail in a hidden mailbox is noticed", async () => {
            INBOX_UNREAD["mb-hello"] = 1;
            EXTRA_FOLDERS["mb-hello"] = [{ type: "archive", name: "Archive", unread: 0 }];
            renderShell();
            const hello = await screen.findByRole("button", { name: /^Hello/ });
            expect(hello).toHaveAccessibleName(unreadName("Hello (shared)", 1));

            // A new unread message arrives in the hidden mailbox's Inbox (what the push connection's handler does), and is read again.
            const arrived = { uid: "m1", folderUid: "f-inbox-mb-hello", mailboxUid: "mb-hello", flags: {} } as any;
            act(() => {
                track(null, arrived);
            });
            await waitFor(() => expect(hello).toHaveAccessibleName(unreadName("Hello (shared)", 2)));
            act(() => {
                track(arrived, { ...arrived, flags: { read: true } });
            });
            await waitFor(() => expect(hello).toHaveAccessibleName(unreadName("Hello (shared)", 1)));

            // ... and one that a rule filed into the Archive counts too.
            const filed = { uid: "m2", folderUid: "f-archive-mb-hello", mailboxUid: "mb-hello", flags: {} } as any;
            act(() => {
                track(null, filed);
            });
            await waitFor(() => expect(hello).toHaveAccessibleName(unreadName("Hello (shared)", 2)));
            act(() => {
                track(filed, { ...filed, flags: { read: true } });
            });
            await waitFor(() => expect(hello).toHaveAccessibleName(unreadName("Hello (shared)", 1)));
        });
    });

    describe("in the phone's folders drawer", () => {
        it("shows the same sections in the same state, with ids of their own", async () => {
            const user = userEvent.setup();
            INBOX_UNREAD["mb-hello"] = 2;
            renderShell();
            await screen.findByRole("button", { name: /^Hello/ });
            await user.click(screen.getByRole("button", { name: "Open folders" }));
            const drawer = screen.getByRole("dialog", { name: "Folders" });

            expect(heading(/All Mailboxes/, within(drawer))).toHaveAttribute("aria-expanded", "true");
            expect(heading(/^Jean-Philippe/, within(drawer))).toHaveAttribute("aria-expanded", "true");
            const hello = heading(/^Hello/, within(drawer));
            expect(hello).toHaveAttribute("aria-expanded", "false");
            expect(hello).toHaveAccessibleName(unreadName("Hello (shared)", 2));
            expect(visibleFolderHrefs(within(drawer))).toEqual([inboxHref("mb-jp"), "/?mailboxUid=mb-jp&folderUid=f-drafts-mb-jp"]);

            // The desktop list and the drawer's are both in the document: each heading controls the list beside it.
            const ids = [...document.querySelectorAll("[aria-controls]")].map((el) => el.getAttribute("aria-controls")!);
            expect(ids).toHaveLength(8);
            expect(new Set(ids).size).toBe(8);
            for (const id of ids) {
                expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
            }
            expect(drawer.contains(document.getElementById(hello.getAttribute("aria-controls")!))).toBe(true);
        });

        it("toggles there, remembers it, keeps the drawer open, and the desktop list follows", async () => {
            const user = userEvent.setup();
            renderShell();
            await screen.findByRole("button", { name: /^Hello/ });
            await user.click(screen.getByRole("button", { name: "Open folders" }));
            const drawer = screen.getByRole("dialog", { name: "Folders" });

            const hello = heading(/^Hello/, within(drawer));
            await user.click(hello);
            expect(hello).toHaveAttribute("aria-expanded", "true");
            expect(within(drawer).getAllByRole("link").some((el) => el.getAttribute("href") === inboxHref("mb-hello"))).toBe(true);
            expect(screen.getByRole("dialog", { name: "Folders" })).toBeInTheDocument();
            expect(stored()).toEqual({ "mb-hello": false });
            // Same state for the copy in the sidebar beside the list.
            const others = screen.getAllByRole("button", { name: /^Hello/, hidden: true }).filter((el) => el !== hello);
            expect(others).toHaveLength(1);
            expect(others[0]).toHaveAttribute("aria-expanded", "true");

            // Keyboard works there too.
            hello.focus();
            await user.keyboard("{Enter}");
            expect(hello).toHaveAttribute("aria-expanded", "false");
            expect(stored()).toEqual({ "mb-hello": true });
        });

        it("still closes the drawer when a folder is chosen from an open section", async () => {
            const user = userEvent.setup();
            renderShell();
            await screen.findByRole("button", { name: /^Hello/ });
            await user.click(screen.getByRole("button", { name: "Open folders" }));
            const drawer = screen.getByRole("dialog", { name: "Folders" });

            fireEvent.click(within(drawer).getAllByRole("link").find((el) => el.getAttribute("href") === "/?mailboxUid=mb-jp&folderUid=f-drafts-mb-jp")!);
            await waitFor(() => expect(screen.queryByRole("dialog", { name: "Folders" })).not.toBeInTheDocument());
            expect(screen.getByTestId("probe")).toHaveTextContent("mb-jp|f-drafts-mb-jp|undefined");
        });
    });

    describe("with a single mailbox", () => {
        beforeEach(() => {
            mockServer([own]);
        });

        it("has no All Mailboxes section and no toggle: the mailbox's heading is plain text over its folders", async () => {
            renderShell();
            await screen.findByText("Jean-Philippe");

            expect(screen.queryByText("All Mailboxes")).not.toBeInTheDocument();
            expect(screen.queryAllByRole("button", { expanded: true })).toHaveLength(0);
            expect(screen.queryAllByRole("button", { expanded: false })).toHaveLength(0);
            expect(document.querySelector("[aria-controls]")).toBeNull();
            expect(screen.getByText("Jean-Philippe").closest("button")).toBeNull();
            expect(visibleFolderHrefs()).toEqual([inboxHref("mb-jp"), "/?mailboxUid=mb-jp&folderUid=f-drafts-mb-jp"]);
        });

        it("never hides the folders, even for a stored choice to collapse them, and shows no badge", async () => {
            localStorage.setItem(collapsedSectionsKey("u1"), JSON.stringify({ "mb-jp": true }));
            INBOX_UNREAD["mb-jp"] = 3;
            renderShell();
            await screen.findByText("Jean-Philippe");

            expect(visibleFolderHrefs()).toEqual([inboxHref("mb-jp"), "/?mailboxUid=mb-jp&folderUid=f-drafts-mb-jp"]);
            expect(screen.getByRole("link", { name: /^Inbox\s*3 unread/ })).toBeInTheDocument();
            expect(screen.getAllByText("3", { exact: true })).toHaveLength(1);
        });

        it("has the same plain sidebar in the phone's drawer", async () => {
            const user = userEvent.setup();
            renderShell();
            await screen.findByText("Jean-Philippe");
            await user.click(screen.getByRole("button", { name: "Open folders" }));
            const drawer = screen.getByRole("dialog", { name: "Folders" });

            expect(within(drawer).queryAllByRole("button", { expanded: false })).toHaveLength(0);
            expect(visibleFolderHrefs(within(drawer))).toEqual([inboxHref("mb-jp"), "/?mailboxUid=mb-jp&folderUid=f-drafts-mb-jp"]);
        });
    });

    it("keeps a mailbox's folder-load failure visible while its section is collapsed", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [own, hello]);
            if (url.startsWith("/api/mail/folders") && url.includes("mb-hello")) return jsonResponse(500, { message: "hello boom" });
            return jsonResponse(200, foldersOf("mb-jp"));
        });
        renderShell();

        expect(await screen.findByText("hello boom")).toBeVisible();
        expect(heading(/^Hello/)).toHaveAttribute("aria-expanded", "false");
    });
});
