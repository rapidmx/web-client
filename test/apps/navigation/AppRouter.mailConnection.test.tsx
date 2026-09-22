// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The mail connection - the mailbox list, the folder tree and counters, the one push socket, the new-mail pop-ups and the tab title's unread count -
// lives in the persistent app frame (`AppChrome`, kept mounted by `AppRouter`), so it works in every app and moving between apps neither
// opens a second socket (the server allows ten per user) nor forgets anything. Real router, real chrome, real Mail shell; the other app is a
// stand-in page.
import React, { ComponentType } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import AppRouter from "../../../apps/shared/navigation/AppRouter.js";
import MailShell, { useMailShell } from "../../../apps/shared/components/mail/layout/MailShell.js";
import type { RouteDefinition } from "../../../apps/shared/navigation/routes.js";

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
const inbox = {
    uid: "f-inbox",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb-a",
    name: "Inbox",
    type: "inbox" as const,
    unreadCount: 3,
    totalCount: 10,
};

const newMail = (uid: string, overrides: Record<string, unknown> = {}) => ({
    uid,
    version: 0,
    folderUid: "f-inbox",
    mailboxUid: "mb-a",
    subject: "Contract signed",
    from: { address: "dana@client.example", displayName: "Dana Whitfield", type: "to" },
    receivedDate: new Date().toISOString(),
    bodyPreview: "Great news: the contract is signed.",
    flags: { read: false, flagged: false, answered: false, forwarded: false },
    ...overrides,
});

function Probe() {
    const { live, mailboxes } = useMailShell();
    return <output data-testid="probe">{`tick:${live.tick} mailboxes:${mailboxes.length}`}</output>;
}

/** What `routedPage()` returns: the module's default export, carrying the plain page as `.page`. */
function routed(Page: ComponentType<any>): { default: ComponentType<any> } {
    return { default: Object.assign(() => null, { page: Page }) };
}

function MailPage(props: any) {
    return (
        <MailShell {...props}>
            <Probe />
        </MailShell>
    );
}

function CalendarPage() {
    return <p>the calendar page</p>;
}

const routes: RouteDefinition[] = [
    { path: "/", active: "mail", load: () => Promise.resolve(routed(MailPage)) },
    { path: "/calendar", active: "calendar", load: () => Promise.resolve(routed(CalendarPage)) },
];
const PROPS = { userUid: "u1", authServerUrl: "https://auth.example.com", impersonating: false, trusted: false, trustedRoles: ["admin"], pluginNav: undefined, params: {} };

let fetchMock: ReturnType<typeof mockFetch>;
const requests = (prefix: string) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(prefix));

function mockServer(unread = 3) {
    fetchMock = mockFetch((url) => {
        if (url.startsWith("/api/system/branding")) return jsonResponse(200, { companyName: "Acme", title: "Acme Mail" });
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [{ ...inbox, unreadCount: unread }]);
        return jsonResponse(404, {});
    });
}

function renderRouter(props: Record<string, unknown> = PROPS) {
    return render(<AppRouter routes={routes} initialPath="/" initialPage={MailPage} pageProps={props} />);
}

const railLink = (name: string) => within(screen.getByRole("navigation", { name: "Apps" })).getByRole("link", { name });

async function greet(): Promise<FakePushSocket> {
    await waitFor(() => expect(FakePushSocket.instances).toHaveLength(1));
    const socket = FakePushSocket.instances[0];
    socket.receive({ id: 0, type: "SUBSCRIBED", data: ["u1"] });
    return socket;
}

const originalTitle = document.title;

beforeEach(() => {
    FakePushSocket.instances = [];
    vi.stubGlobal("WebSocket", FakePushSocket);
    window.scrollTo = vi.fn();
    window.history.pushState(null, "", "/");
});

afterEach(() => {
    vi.unstubAllGlobals();
    resetPushClient();
    document.title = originalTitle;
    window.history.pushState(null, "", "/");
});

describe("the mail connection in the persistent frame", () => {
    it("opens one push socket and lists the mailboxes once, however the user moves between the apps", async () => {
        mockServer();
        renderRouter();
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });
        expect(screen.getByTestId("probe")).toHaveTextContent("mailboxes:1");
        await greet();

        fireEvent.click(railLink("Calendar"));
        expect(await screen.findByText("the calendar page")).toBeInTheDocument();
        fireEvent.click(railLink("Mail"));
        await screen.findByTestId("probe");
        // The tree is there in the very render that shows the page - nothing to load and nothing to wait for.
        expect(screen.getAllByText("Inbox").length).toBeGreaterThan(0);
        expect(screen.getByTestId("probe")).toHaveTextContent("mailboxes:1");

        expect(FakePushSocket.instances).toHaveLength(1);
        expect(requests("/api/mail/mailboxes?")).toHaveLength(1);
        expect(requests("/api/mail/folders")).toHaveLength(1);
    });

    it("announces new mail with a pop-up while another app is showing - the same pop-up, in one live region", async () => {
        mockServer();
        renderRouter();
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });
        const socket = await greet();
        fireEvent.click(railLink("Calendar"));
        await screen.findByText("the calendar page");

        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));

        const region = screen.getByTestId("notification-others");
        expect(screen.getAllByTestId("notification-others")).toHaveLength(1);
        const toast = within(region).getByRole("link");
        expect(toast).toHaveAttribute("href", "/messages/m9");
        expect(toast).toHaveTextContent("Dana Whitfield");
        expect(toast).toHaveTextContent("Contract signed");
        expect(toast).toHaveTextContent("Great news: the contract is signed.");
    });

    it("shows a pop-up once while Mail is showing too - the Mail shell draws none of its own inside the frame", async () => {
        mockServer();
        renderRouter();
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });
        const socket = await greet();

        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));

        expect(screen.getAllByTestId("notification-others")).toHaveLength(1);
        expect(within(screen.getByTestId("notification-others")).getAllByRole("link")).toHaveLength(1);
    });

    it("does not announce a message twice when the user goes to another app and back", async () => {
        mockServer();
        renderRouter();
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });
        const socket = await greet();
        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));
        fireEvent.click(railLink("Calendar"));
        await screen.findByText("the calendar page");
        fireEvent.click(railLink("Mail"));
        await screen.findByTestId("probe");

        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));

        expect(within(screen.getByTestId("notification-others")).getAllByRole("link")).toHaveLength(1);
    });

    it("offers desktop notifications in the first pop-up while another app is showing, asking the browser only from the click", async () => {
        const requestPermission = vi.fn().mockResolvedValue("granted");
        vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission }));
        mockServer();
        renderRouter();
        await screen.findAllByText("Inbox", {}, { timeout: 5000 });
        const socket = await greet();
        fireEvent.click(railLink("Calendar"));
        await screen.findByText("the calendar page");
        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));
        expect(requestPermission).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Turn on desktop notifications" }));

        await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.queryByRole("button", { name: "Turn on desktop notifications" })).not.toBeInTheDocument());
        // "Not now" is the other answer, and dismisses the pop-up's offer as well.
    });

    it("keeps the unread count in the tab title on every page, taking it off the page's own title again", async () => {
        mockServer(3);
        renderRouter();
        await waitFor(() => expect(document.title).toBe("(3) Acme Mail: Mail"));

        fireEvent.click(railLink("Calendar"));
        await screen.findByText("the calendar page");
        await waitFor(() => expect(document.title).toBe("(3) Acme Mail: Calendar"));

        // Mail arriving while the calendar is showing moves the count.
        const socket = await greet();
        act(() => socket.receive({ type: "MessageMongo", action: "create", data: newMail("m9") }));
        await waitFor(() => expect(document.title).toBe("(4) Acme Mail: Calendar"));

        fireEvent.click(railLink("Mail"));
        await waitFor(() => expect(document.title).toBe("(4) Acme Mail: Mail"));
        expect(document.title).not.toMatch(/^\(\d+\) \(\d+\)/);
    });

    it("leaves the title alone with nothing unread", async () => {
        mockServer(0);
        renderRouter();
        await waitFor(() => expect(document.title).toBe("Acme Mail: Mail"));
    });

    it("does nothing for a page with no signed-in user: no request, no socket", async () => {
        mockServer();
        renderRouter({ ...PROPS, userUid: undefined });
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(requests("/api/mail/mailboxes")).toHaveLength(0);
        expect(FakePushSocket.instances).toHaveLength(0);
    });
});
