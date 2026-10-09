// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushEvent } from "../../../lib/mail/pushClient.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import ContactsPageBase from "../../../apps/www/contacts/index.js";
import { withTestRouter } from "../routerTestUtils.js";

// The contacts page and what the push connection tells it about a contact created, changed or deleted elsewhere.

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const ContactsPage = withTestRouter(ContactsPageBase);

// The shared push connection: the page adds a listener, and the tests are the server.
const listeners = new Set<(event: PushEvent) => void>();
// The channels each group asked for, as `PushClient.setChannels()` keeps them.
const channelGroups = new Map<string, readonly string[]>();
vi.mock("../../../lib/mail/pushClient.js", () => ({
    getPushClient: () => ({
        onEvent: (listener: (event: PushEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setChannels: (channels: readonly string[], group: string) => {
            if (channels.length > 0) {
                channelGroups.set(group, channels);
            } else {
                channelGroups.delete(group);
            }
        },
        start: () => undefined,
    }),
}));
function push(event: PushEvent) {
    act(() => {
        for (const listener of [...listeners]) {
            listener(event);
        }
    });
}

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};
const contactsFolder = {
    uid: "f-contacts",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Contacts",
    type: "contacts" as const,
    unreadCount: 0,
    totalCount: 0,
};

function contact(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        uid: "c1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        folderUid: "f-contacts",
        displayName: "Jane Doe",
        emails: [],
        phones: [],
        addresses: [],
        ...overrides,
    };
}

let contacts: unknown[];
let suggested: unknown[];
let single: (uid: string) => Response;

function mockContacts() {
    return mockFetch((url, init) => {
        const method = init?.method ?? "GET";
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [contactsFolder]);
        if (url.startsWith("/api/mail/contact-lists")) return jsonResponse(200, []);
        if (url.startsWith("/api/mail/directory/suggested-contacts") && method === "POST") {
            return jsonResponse(200, { folderUid: "f-suggested", created: 0, remaining: 0 });
        }
        const one = /^\/api\/mail\/contacts\/([^/?]+)$/.exec(url);
        if (one && method === "GET") return single(one[1]);
        if (url.startsWith("/api/mail/contacts?") && method === "GET") {
            return jsonResponse(200, url.includes("folderUid=f-suggested") ? suggested : contacts);
        }
        throw new Error(`unexpected ${method} ${url}`);
    });
}

/** Renders the page and waits for both lists - the mailbox's contacts and its suggested contacts - to be loaded and subscribed to. */
async function renderPage(firstName: string) {
    const fetchMock = mockContacts();
    const view = render(<ContactsPage userUid="u1" />);
    await screen.findByText(firstName);
    await waitFor(() => expect(channelGroups.get("contacts")).toEqual(["f-contacts", "f-suggested"]));
    return { fetchMock, ...view };
}

/** The number of suggested contacts the sidebar shows. */
async function suggestedCount(): Promise<string | null> {
    return (await screen.findByRole("button", { name: /Suggested contacts/ })).textContent;
}

/** Lets a fetch that the test has seen made settle. */
async function settle() {
    await act(async () => {
        await Promise.resolve();
    });
}

beforeEach(() => {
    listeners.clear();
    channelGroups.clear();
    contacts = [contact()];
    suggested = [];
    single = () => jsonResponse(404, { message: "not found" });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ContactsPage live updates", () => {
    it("subscribes to its contacts folder and its Suggested Contacts folder while it is open, under its own channel group, and lets them go when the page goes", async () => {
        const { unmount } = await renderPage("Jane Doe");
        expect(listeners.size).toBeGreaterThanOrEqual(1);

        unmount();
        expect(channelGroups.has("contacts")).toBe(false);
        expect(listeners.size).toBe(0);
    });

    it("shows a contact another device created", async () => {
        const { fetchMock } = await renderPage("Jane Doe");

        single = (uid) => jsonResponse(200, contact({ uid, displayName: "Bob Smith" }));
        push({ type: "ContactMongo", action: "create", data: { uid: "c2" } });

        expect(await screen.findByText("Bob Smith")).toBeInTheDocument();
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/contacts/c2")).toBe(true);
    });

    it("replaces a contact another device changed, and leaves the others as they are", async () => {
        contacts = [contact(), contact({ uid: "c2", displayName: "Old Name" })];
        await renderPage("Old Name");

        single = (uid) => jsonResponse(200, contact({ uid, displayName: "New Name" }));
        push({ type: "ContactSQL", action: "update", data: { uid: "c2" } });

        expect(await screen.findByText("New Name")).toBeInTheDocument();
        expect(screen.queryByText("Old Name")).not.toBeInTheDocument();
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });

    it("drops a deleted contact without fetching it", async () => {
        contacts = [contact(), contact({ uid: "c2", displayName: "Doomed" })];
        const { fetchMock } = await renderPage("Doomed");

        push({ type: "ContactMongo", action: "delete", data: { uid: "c2" } });

        await waitFor(() => expect(screen.queryByText("Doomed")).not.toBeInTheDocument());
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/contacts/c2")).toBe(false);
    });

    it("drops a suggested contact that was deleted", async () => {
        suggested = [contact({ uid: "s1", folderUid: "f-suggested", displayName: "Sam Suggested" })];
        await renderPage("Jane Doe");
        await waitFor(async () => expect(await suggestedCount()).toContain("1"));

        push({ type: "ContactSQL", action: "delete", data: { uid: "s1" } });

        await waitFor(async () => expect(await suggestedCount()).toContain("0"));
    });

    it("drops a contact the server says is deleted, or that is now in a folder the page does not show", async () => {
        contacts = [contact(), contact({ uid: "c2", displayName: "Soft Deleted" }), contact({ uid: "c3", displayName: "Moved Away" })];
        await renderPage("Moved Away");

        single = (uid) => jsonResponse(200, contact({ uid, displayName: "Soft Deleted", deleted: true }));
        push({ type: "ContactMongo", action: "update", data: { uid: "c2" } });
        await waitFor(() => expect(screen.queryByText("Soft Deleted")).not.toBeInTheDocument());

        single = (uid) => jsonResponse(200, contact({ uid, displayName: "Moved Away", folderUid: "f-other" }));
        push({ type: "ContactMongo", action: "update", data: { uid: "c3" } });
        await waitFor(() => expect(screen.queryByText("Moved Away")).not.toBeInTheDocument());
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });

    it("moves a contact between the mailbox's contacts and its suggested contacts as its folder changes", async () => {
        contacts = [contact(), contact({ uid: "c2", displayName: "Wanderer" })];
        await renderPage("Wanderer");
        await waitFor(async () => expect(await suggestedCount()).toContain("0"));

        // Into the suggested folder: out of the main list, into the suggested one.
        single = (uid) => jsonResponse(200, contact({ uid, displayName: "Wanderer", folderUid: "f-suggested" }));
        push({ type: "ContactMongo", action: "update", data: { uid: "c2" } });
        await waitFor(() => expect(screen.queryByText("Wanderer")).not.toBeInTheDocument());
        await waitFor(async () => expect(await suggestedCount()).toContain("1"));

        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /Suggested contacts/ }));
        expect(await screen.findByText("Wanderer")).toBeInTheDocument();
        expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();

        // And back again: out of the suggested list.
        single = (uid) => jsonResponse(200, contact({ uid, displayName: "Wanderer", folderUid: "f-contacts" }));
        push({ type: "ContactMongo", action: "update", data: { uid: "c2" } });
        await waitFor(() => expect(screen.queryByText("Wanderer")).not.toBeInTheDocument());
        expect(await suggestedCount()).toContain("0");

        await user.click(screen.getByRole("button", { name: /Your contacts/ }));
        expect(await screen.findByText("Wanderer")).toBeInTheDocument();
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });

    it("drops a contact that is gone, and leaves the list alone when the fetch fails for any other reason", async () => {
        contacts = [contact(), contact({ uid: "c2", displayName: "Doomed" })];
        const { fetchMock } = await renderPage("Doomed");

        single = () => jsonResponse(500, { message: "boom" });
        push({ type: "ContactMongo", action: "update", data: { uid: "c2" } });
        await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/mail/contacts/c2")).toBe(true));
        await settle();
        expect(screen.getByText("Doomed")).toBeInTheDocument();

        single = () => jsonResponse(404, { message: "gone" });
        push({ type: "ContactMongo", action: "update", data: { uid: "c2" } });
        await waitFor(() => expect(screen.queryByText("Doomed")).not.toBeInTheDocument());
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });

    it("does nothing for a push that is not about a contact", async () => {
        const { fetchMock } = await renderPage("Jane Doe");
        single = (uid) => jsonResponse(200, contact({ uid, displayName: "Should Not Appear" }));
        const fetched = () => fetchMock.mock.calls.filter(([url]) => /^\/api\/mail\/contacts\/[^/?]+$/.test(url)).length;

        push({ type: "ContactListMongo", action: "update", data: { uid: "c1" } });
        push({ type: "MessageMongo", action: "create", data: { uid: "c9" } });
        push({ type: "ContactMongo", action: "reminder", data: { uid: "c9" } });
        push({ type: "ContactMongo", action: "update", data: { uid: 5 } });
        await settle();

        expect(fetched()).toBe(0);
        expect(screen.queryByText("Should Not Appear")).not.toBeInTheDocument();
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });
});
