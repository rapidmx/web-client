// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The webmail's app shell (`apps/www/_shell.tsx`) under `@rapidrest/react`'s real client router, in a real DOM with the real React reconciler:
// the shell and its chrome (`AppChrome`) are server-rendered around a page, hydrated with it as one root, and kept mounted - the same DOM
// nodes, with their state, and one mail connection - while the router swaps the pages in and out inside them. The pages are stand-ins (the
// real Mail shell in one); the server is a fake `fetch`. The router's own behaviour is the library's to test; what is tested here is what the
// app relies on: the shell survives, a folder change keeps the page, and what a page load used to do (the title, focus, scroll, the
// announcement, the unread count in the title) still happens after a navigation.
import React, { useEffect, useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterProvider, startRouter, type ClientRoute } from "@rapidrest/react/client";
import { resetPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import WwwShell from "../../../apps/www/_shell.js";
import MailShell, { useMailShell } from "../../../apps/shared/components/mail/layout/MailShell.js";
import { FrameTakeover } from "../../../apps/shared/navigation/frameContext.js";
import { useNavigate } from "../../../apps/shared/navigation/index.js";
import { pageTitle } from "../../../apps/shared/navigation/pageTitle.js";

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
vi.mock("@rapidmx/react-shared/crypto/useIdleKeyTimeout.js", () => ({ useIdleKeyTimeout: vi.fn() }));
vi.mock("../../../apps/shared/search/LocalIndexLifecycle.js", () => ({ default: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** A stand-in for the push WebSocket, driven by hand. */
class FakePushSocket {
    static instances: FakePushSocket[] = [];
    readyState = 1;
    onopen: unknown = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: unknown = null;
    onerror: unknown = null;
    constructor(public url: string) {
        FakePushSocket.instances.push(this);
    }
    send() {
        // Nothing is ever delivered.
    }
    close() {
        // Nothing to close.
    }
    receive(frame: unknown) {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
}

const mailbox = {
    uid: "mb-a",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "a@example.com",
    aliasAddresses: [],
    displayName: "Mailbox A",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};
const folder = (uid: string, type: string, name: string, unreadCount = 0) => ({
    uid,
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb-a",
    name,
    type,
    unreadCount,
    totalCount: 10,
});
const newMail = (uid: string) => ({
    uid,
    version: 0,
    folderUid: "f-inbox",
    mailboxUid: "mb-a",
    subject: "Contract signed",
    from: { address: "dana@client.example", displayName: "Dana Whitfield", type: "to" },
    receivedDate: new Date().toISOString(),
    bodyPreview: "Great news: the contract is signed.",
    flags: { read: false, flagged: false, answered: false, forwarded: false },
});

// --- The pages ------------------------------------------------------------------------------------------------------------------------

/** What happened to the pages, across renders. */
const log = { mounts: {} as Record<string, number>, unmounts: {} as Record<string, number> };
function countMounts(name: string) {
    useEffect(() => {
        log.mounts[name] = (log.mounts[name] ?? 0) + 1;
        return () => {
            log.unmounts[name] = (log.unmounts[name] ?? 0) + 1;
        };
    }, []);
}

function Probe() {
    const { live, mailboxes, mailboxUid, folderUid } = useMailShell();
    const [clicks, setClicks] = useState(0);
    return (
        <>
            <output data-testid="probe">{`tick:${live.tick} mailboxes:${mailboxes.length} ${mailboxUid}|${folderUid}`}</output>
            <button onClick={() => setClicks((n) => n + 1)}>clicks {clicks}</button>
        </>
    );
}

/** Mail: the real Mail shell (its folder links and mail connection) with a page of its own state in it. */
function MailPage(props: any) {
    countMounts("mail");
    return (
        <MailShell {...props}>
            <Probe />
        </MailShell>
    );
}

let go: (href: string) => void;
function CalendarPage() {
    countMounts("calendar");
    go = useNavigate();
    return <p>the calendar page</p>;
}

function ContactsPage() {
    countMounts("contacts");
    return (
        <FrameTakeover>
            <p>the key setup screen</p>
        </FrameTakeover>
    );
}

function SettingsPage() {
    countMounts("settings");
    return <a href="/calendar">from settings</a>;
}

interface PageDef {
    route: string;
    Component: React.ComponentType<any>;
    label: string;
}
const PAGES: Record<string, PageDef> = {
    "/": { route: "/", Component: MailPage, label: "Mail" },
    "/calendar": { route: "/calendar", Component: CalendarPage, label: "Calendar" },
    "/contacts": { route: "/contacts", Component: ContactsPage, label: "Contacts" },
    "/settings/labels": { route: "/settings/labels", Component: SettingsPage, label: "Settings" },
};
const routes: ClientRoute[] = Object.values(PAGES).map((page) => ({ template: page.route, load: async () => ({ default: page.Component }) }));

const branding = { companyName: "Acme", title: "Acme Mail" };
/** What `WwwRoute.fetchProps()` gives every page. */
let serverProps: Record<string, unknown>;

// --- The browser and the server ---------------------------------------------------------------------------------------------------------

const listeners: Array<{ target: any; type: string; handler: any }> = [];

/** `window`, as the router sees it: the real one, but for what the test needs to watch (and listeners it can take back). */
function makeWin() {
    const on = (target: any) => (type: string, handler: any) => {
        listeners.push({ target, type, handler });
        target.addEventListener(type, handler);
    };
    return {
        location: { get href() { return window.location.href; }, assign: vi.fn(), reload: vi.fn() },
        history: window.history,
        scrollX: 0,
        scrollY: 0,
        scrollTo: vi.fn(),
        fetch: vi.fn(),
        confirm: vi.fn(() => true),
        setTimeout: (handler: () => void, ms: number) => window.setTimeout(handler, ms),
        clearTimeout: (handle: any) => window.clearTimeout(handle),
        addEventListener: on(window),
        removeEventListener: (type: string, handler: any) => window.removeEventListener(type, handler),
        sessionStorage: window.sessionStorage,
    };
}

/** `document`, as the router sees it. */
function makeDoc() {
    return {
        get head() { return document.head; },
        get body() { return document.body; },
        get readyState() { return document.readyState; },
        get title() { return document.title; },
        set title(value: string) { document.title = value; },
        createElement: (tag: string) => document.createElement(tag),
        getElementById: (id: string) => document.getElementById(id),
        querySelector: (selector: string) => document.querySelector(selector),
        querySelectorAll: (selector: string) => document.querySelectorAll(selector),
        addEventListener: (type: string, handler: any) => {
            listeners.push({ target: document, type, handler });
            document.addEventListener(type, handler);
        },
    };
}

const respond = (payload: unknown) => ({ ok: true, redirected: false, headers: { get: () => "application/json" }, json: async () => payload });

/** The server, for the router's fetch: the props and the title of the page at each URL. Held while `hold` has a promise. */
const hold: { promise: Promise<void> | null } = { promise: null };
async function serve(href: string) {
    const url = new URL(href);
    const page = PAGES[url.pathname];
    await hold.promise;
    return respond({ route: page.route, props: { ...serverProps, params: {} }, css: [], title: pageTitle(page.label)({ branding }) });
}

let router: Awaited<ReturnType<typeof startRouter>>;
let win: ReturnType<typeof makeWin>;

/** Server-renders the shell around the page at `path` into the document exactly as `ReactRoute` does, then starts the router on it, as the entry does. */
async function mount(path = "/") {
    window.history.pushState(null, "", path);
    const url = new URL(path, "http://localhost");
    const page = PAGES[url.pathname];
    const props = { ...serverProps, params: {} };
    const html = renderToString(
        <div id="react-root">
            <RouterProvider location={{ pathname: url.pathname, search: url.search, params: {}, route: page.route }}>
                <WwwShell {...props}>
                    <page.Component {...props} />
                </WwwShell>
            </RouterProvider>
        </div>,
    );
    const config = { prefix: "", route: page.route, rootId: "react-root", propsId: "react-props", css: [], shell: true };
    document.body.innerHTML =
        html +
        `<script type="application/json" id="rapidrest-router">${JSON.stringify(config)}</script>` +
        `<script type="application/json" id="react-props">${JSON.stringify(props)}</script>`;
    document.title = pageTitle(page.label)({ branding });

    win = makeWin();
    win.fetch.mockImplementation(async (href: string) => serve(href));
    await act(async () => {
        router = await startRouter(routes, { shell: WwwShell }, win, makeDoc());
    });
}

const railLink = (name: string) => within(screen.getByRole("navigation", { name: "Apps" })).getByRole("link", { name });
const rail = () => screen.getByRole("navigation", { name: "Apps" });
const content = () => document.getElementById("app-content")!;
/** The router's live region: the one polite status the router adds to the document (outside React's tree). */
const announcement = () => document.body.querySelector(":scope > [role='status'][aria-live='polite']")!;
/** Follows a link of the page or the rail the way a user does, and waits for the router to be done with it. */
async function click(element: HTMLElement) {
    await act(async () => {
        fireEvent.click(element);
    });
}
async function goTo(href: string) {
    await act(async () => {
        await router!.navigate(href);
    });
}

let fetchMock: ReturnType<typeof mockFetch>;
const requests = (prefix: string) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(prefix));

function mockApi(unread = 3) {
    fetchMock = mockFetch((url) => {
        if (url.startsWith("/api/system/branding")) return jsonResponse(200, branding);
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder("f-inbox", "inbox", "Inbox", unread), folder("f-sent", "sent_items", "Sent Items")]);
        return jsonResponse(200, []);
    });
}

async function greet(): Promise<FakePushSocket> {
    await waitFor(() => expect(FakePushSocket.instances).toHaveLength(1));
    const socket = FakePushSocket.instances[0];
    act(() => socket.receive({ id: 0, type: "SUBSCRIBED", data: ["u1"] }));
    return socket;
}

const originalTitle = document.title;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    log.mounts = {};
    log.unmounts = {};
    FakePushSocket.instances = [];
    hold.promise = null;
    vi.stubGlobal("WebSocket", FakePushSocket);
    serverProps = { userUid: "u1", authServerUrl: "https://auth.example.com", impersonating: false, trusted: false, trustedRoles: ["admin"], branding };
    consoleError = vi.spyOn(console, "error");
    mockApi();
});

afterEach(async () => {
    // Nothing of a test's router is left listening for the next test's.
    for (const { target, type, handler } of listeners.splice(0)) {
        target.removeEventListener(type, handler);
    }
    await act(async () => {
        document.body.innerHTML = "";
    });
    vi.unstubAllGlobals();
    resetPushClient();
    document.title = originalTitle;
    window.history.replaceState(null, "", "/");
});

describe("the webmail's app shell under the client router", () => {
    it("hydrates the server's markup as one root - the shell around the page - without a warning, and puts the page in the content region", async () => {
        await mount("/");
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });

        expect(consoleError).not.toHaveBeenCalled();
        expect(content()).toContainElement(screen.getByTestId("probe"));
        expect(railLink("Mail")).toHaveAttribute("aria-current", "page");
        expect(railLink("Calendar")).not.toHaveAttribute("aria-current");
        expect(log.mounts.mail).toBe(1);
    });

    it("keeps the shell's DOM and its state while the pages are swapped: the rail, the open dialog, the one mail connection", async () => {
        await mount("/");
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });
        await greet();
        const railBefore = rail();
        const contentBefore = content();
        // State that lives in the chrome, not in a page: the keyboard help dialog.
        act(() => {
            fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
        });
        const dialog = await screen.findByRole("dialog");

        await click(railLink("Calendar"));
        expect(await screen.findByText("the calendar page")).toBeInTheDocument();
        await goTo("/settings/labels");
        await screen.findByText("from settings");
        await click(screen.getByText("from settings"));
        await screen.findByText("the calendar page");
        await goTo("/");
        await screen.findByTestId("probe");

        // The very same elements, not equal ones.
        expect(rail()).toBe(railBefore);
        expect(content()).toBe(contentBefore);
        expect(screen.getByRole("dialog")).toBe(dialog);
        // Only the pages were new instances - Mail twice, since it was left and came back.
        expect(log.mounts).toEqual({ mail: 2, calendar: 2, settings: 1 });
        // One socket, and the mailboxes and folders listed once, however the user moved between the apps.
        expect(FakePushSocket.instances).toHaveLength(1);
        expect(requests("/api/mail/mailboxes?")).toHaveLength(1);
        expect(requests("/api/mail/folders")).toHaveLength(1);
        expect(screen.getAllByText("Inbox").length).toBeGreaterThan(0);
    });

    it("highlights the rail entry of the route: an app by its page, Settings none", async () => {
        await mount("/");
        await click(railLink("Calendar"));
        await screen.findByText("the calendar page");
        expect(railLink("Calendar")).toHaveAttribute("aria-current", "page");
        expect(railLink("Mail")).not.toHaveAttribute("aria-current");
        expect(within(screen.getByRole("banner")).getByText("Calendar")).toBeInTheDocument();

        await goTo("/settings/labels");
        await screen.findByText("from settings");
        expect(within(screen.getByRole("navigation", { name: "Apps" })).queryByRole("link", { current: "page" })).toBeNull();
        expect(within(screen.getByRole("banner")).getByText("Settings")).toBeInTheDocument();
    });

    it("keeps the page - its state, and its instance - when a folder is chosen, and follows the folder in the URL", async () => {
        await mount("/?mailboxUid=mb-a&folderUid=f-inbox");
        await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-a|f-inbox"));
        fireEvent.click(screen.getByRole("button", { name: "clicks 0" }));
        expect(screen.getByRole("button", { name: "clicks 1" })).toBeInTheDocument();

        await click((await screen.findAllByRole("link", { name: /Sent Items/ }))[0]);

        await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-a|f-sent"));
        expect(window.location.search).toBe("?mailboxUid=mb-a&folderUid=f-sent");
        expect(screen.getByRole("button", { name: "clicks 1" })).toBeInTheDocument();
        expect(log.mounts.mail).toBe(1);
        expect(log.unmounts.mail).toBeUndefined();
        // Nothing was asked of the server for it: a shallow navigation neither fetches the props nor loads a page.
        expect(win.fetch).not.toHaveBeenCalled();

        // Going back over it is shallow as well.
        await act(async () => {
            window.history.back();
            await new Promise((resolve) => window.setTimeout(resolve, 80));
        });
        await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("mb-a|f-inbox"));
        expect(log.mounts.mail).toBe(1);
        expect(screen.getByRole("button", { name: "clicks 1" })).toBeInTheDocument();
    });

    it("keeps the same for the calendar's own navigate(): a query change on the page is shallow, another page is not", async () => {
        await mount("/calendar");
        await screen.findByText("the calendar page");

        act(() => go("/calendar?mailboxUid=mb-a"));
        await waitFor(() => expect(window.location.search).toBe("?mailboxUid=mb-a"));
        expect(log.mounts.calendar).toBe(1);
        expect(win.fetch).not.toHaveBeenCalled();

        act(() => go("/contacts"));
        await screen.findByText("the key setup screen");
        expect(log.unmounts.calendar).toBe(1);
        expect(win.fetch).toHaveBeenCalledTimes(1);
    });

    it("goes back and forward between pages without unmounting the shell", async () => {
        await mount("/");
        await screen.findByTestId("probe");
        const railBefore = rail();
        await click(railLink("Calendar"));
        await screen.findByText("the calendar page");

        await act(async () => {
            window.history.back();
            await new Promise((resolve) => window.setTimeout(resolve, 80));
        });
        await screen.findByTestId("probe");
        expect(window.location.pathname).toBe("/");
        expect(rail()).toBe(railBefore);
        await act(async () => {
            window.history.forward();
            await new Promise((resolve) => window.setTimeout(resolve, 80));
        });
        await screen.findByText("the calendar page");
        expect(rail()).toBe(railBefore);
    });

    it("sets the tab's title to the page's own on every navigation, keeps the unread count in front of it, and takes it off the announcement", async () => {
        await mount("/");
        await waitFor(() => expect(document.title).toBe("(3) Acme Mail: Mail"));

        await click(railLink("Calendar"));
        await screen.findByText("the calendar page");
        await waitFor(() => expect(document.title).toBe("(3) Acme Mail: Calendar"));

        // Mail arriving while the calendar is showing moves the count.
        const socket = await greet();
        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));
        await waitFor(() => expect(document.title).toBe("(4) Acme Mail: Calendar"));

        await click(railLink("Mail"));
        await waitFor(() => expect(document.title).toBe("(4) Acme Mail: Mail"));
        expect(document.title).not.toMatch(/^\(\d+\) \(\d+\)/);
        // The screen reader is told the page, not the count in front of it.
        await waitFor(() => expect(announcement()).toHaveTextContent(/^Acme Mail: Mail$/));
    });

    it("leaves the title alone with nothing unread", async () => {
        mockApi(0);
        await mount("/");
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });
        expect(document.title).toBe("Acme Mail: Mail");
        await click(railLink("Calendar"));
        await screen.findByText("the calendar page");
        expect(document.title).toBe("Acme Mail: Calendar");
    });

    it("moves focus to the content region, scrolls to the top and announces the page's title after a navigation - and not for the first page", async () => {
        await mount("/");
        await screen.findByTestId("probe");
        expect(document.activeElement).toBe(document.body);
        expect(win.scrollTo).not.toHaveBeenCalled();

        await click(railLink("Calendar"));
        await screen.findByText("the calendar page");

        expect(document.activeElement).toBe(content());
        expect(content()).toHaveAttribute("tabindex", "-1");
        expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
        await waitFor(() => expect(announcement()).toHaveTextContent("Acme Mail: Calendar"));
    });

    it("marks the content busy while the next page loads, with the old page still on screen", async () => {
        await mount("/");
        await screen.findByTestId("probe");
        let release!: () => void;
        hold.promise = new Promise((resolve) => (release = resolve));

        await click(railLink("Calendar"));
        await waitFor(() => expect(content()).toHaveAttribute("aria-busy", "true"));
        expect(screen.getByTestId("probe")).toBeInTheDocument();

        await act(async () => {
            release();
            await hold.promise;
        });
        await screen.findByText("the calendar page");
        expect(content()).not.toHaveAttribute("aria-busy");
    });

    it("gives the shell the next page's props on every navigation: the impersonation banner follows the server's answer", async () => {
        await mount("/");
        await screen.findByTestId("probe");
        expect(screen.queryByText(/You are viewing as/)).not.toBeInTheDocument();

        serverProps = { ...serverProps, impersonating: true };
        await click(railLink("Calendar"));
        await screen.findByText("the calendar page");

        expect(screen.getByText(/You are viewing as/)).toBeInTheDocument();
    });

    it("hides the chrome for a screen that takes over the window, and brings it back when the user leaves it", async () => {
        await mount("/");
        await screen.findByTestId("probe");
        const contentBefore = content();
        await goTo("/contacts");
        await screen.findByText("the key setup screen");
        expect(screen.queryByRole("navigation", { name: "Apps" })).not.toBeInTheDocument();
        expect(content()).toBe(contentBefore);

        await goTo("/calendar");
        await screen.findByText("the calendar page");
        expect(rail()).toBeInTheDocument();
        expect(content()).toBe(contentBefore);
    });

    it("leaves what is not one of the webmail's pages to the browser: another app, a modified click, a new tab, a download, data-router-ignore", async () => {
        await mount("/settings/labels");
        const page = content();
        const links = document.createElement("div");
        links.innerHTML = [
            '<a id="admin" href="/admin">admin</a>',
            '<a id="blank" href="/calendar" target="_blank">blank</a>',
            '<a id="download" href="/calendar" download>download</a>',
            '<a id="ignored" href="/calendar" data-router-ignore>ignored</a>',
            '<a id="plain" href="/calendar">plain</a>',
        ].join("");
        page.appendChild(links);
        const prevented = (id: string, init: MouseEventInit = {}) => {
            const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
            document.getElementById(id)!.dispatchEvent(event);
            return event.defaultPrevented;
        };

        expect(prevented("admin")).toBe(false);
        expect(prevented("blank")).toBe(false);
        expect(prevented("download")).toBe(false);
        expect(prevented("ignored")).toBe(false);
        expect(prevented("plain", { ctrlKey: true })).toBe(false);
        expect(prevented("plain", { metaKey: true })).toBe(false);
        // ...and a plain click on one of the app's pages is the router's.
        await act(async () => {
            expect(prevented("plain")).toBe(true);
        });
        await screen.findByText("the calendar page");
    });

    it("does nothing for a page with no signed-in user: no request, no socket", async () => {
        serverProps = { ...serverProps, userUid: undefined };
        await mount("/");
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(requests("/api/mail/mailboxes")).toHaveLength(0);
        expect(FakePushSocket.instances).toHaveLength(0);
    });
});

describe("new mail, whichever app is showing", () => {
    it("announces it with a pop-up while another app is showing - the same pop-up, in one live region", async () => {
        await mount("/");
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });
        const socket = await greet();
        await click(railLink("Calendar"));
        await screen.findByText("the calendar page");

        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));

        const region = screen.getByTestId("notification-others");
        expect(screen.getAllByTestId("notification-others")).toHaveLength(1);
        const toast = within(region).getByRole("link");
        expect(toast).toHaveAttribute("href", "/messages/m9");
        expect(toast).toHaveTextContent("Dana Whitfield");
        expect(toast).toHaveTextContent("Contract signed");
    });

    it("shows a pop-up once while Mail is showing too - the Mail shell draws none of its own inside the frame", async () => {
        await mount("/");
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });
        const socket = await greet();

        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));

        expect(screen.getAllByTestId("notification-others")).toHaveLength(1);
        expect(within(screen.getByTestId("notification-others")).getAllByRole("link")).toHaveLength(1);
    });

    it("does not announce a message twice when the user goes to another app and back", async () => {
        await mount("/");
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });
        const socket = await greet();
        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));
        await click(railLink("Calendar"));
        await screen.findByText("the calendar page");
        await click(railLink("Mail"));
        await screen.findByTestId("probe");

        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));

        expect(within(screen.getByTestId("notification-others")).getAllByRole("link")).toHaveLength(1);
    });

    it("offers desktop notifications in the first pop-up while another app is showing, asking the browser only from the click", async () => {
        const requestPermission = vi.fn().mockResolvedValue("granted");
        vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission }));
        await mount("/");
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });
        const socket = await greet();
        await click(railLink("Calendar"));
        await screen.findByText("the calendar page");
        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));
        expect(requestPermission).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Turn on desktop notifications" }));

        await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByRole("button", { name: "Turn on desktop notifications" })).not.toBeInTheDocument());
    });
});
