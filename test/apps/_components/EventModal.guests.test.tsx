// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecipientSuggestion } from "@rapidmx/react-shared/mail/directoryApi.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import EventModal from "../../../apps/shared/components/calendar/EventModal.js";
import { openMoreOptions } from "./eventModalHelpers.js";

// The guests field of the event dialog is compose's recipient field: typing a name looks it up among the contacts and the server's mailboxes and
// lists, and what is picked, typed or pasted becomes a chip (the quick popover) or a row (the full form) - each a guest with an address and a name.

const support: RecipientSuggestion = { displayName: "Support Desk", address: "support@example.com", kind: "shared" };
const sara: RecipientSuggestion = { displayName: "Sara Suarez", address: "sara@example.com", kind: "contact" };
const team: RecipientSuggestion = { displayName: "Sales Team", address: "sales-team@example.com", kind: "list" };
const DIRECTORY = [support, sara, team];

function occurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
    return {
        uid: "e1",
        version: 2,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: "Standup",
        startDate: "2026-06-10T09:00:00.000Z",
        endDate: "2026-06-10T10:00:00.000Z",
        allDay: false,
        timezone: "UTC",
        organizer: { address: "jane@example.com", type: "to" },
        attendees: [],
        status: "confirmed",
        busyStatus: "busy",
        icalUid: "abc",
        sequence: 0,
        occurrenceKey: "e1",
        isRecurringOccurrence: false,
        ...overrides,
    };
}

/** Answers the two suggestion lookups from `entries` (every word of the query must start a word of the name or the address) and saves. */
function mockServer(entries: RecipientSuggestion[] = DIRECTORY, lookup: (url: string) => Response | undefined = () => undefined) {
    return mockFetch((url, init) => {
        const failed = lookup(url);
        if (failed) {
            return failed;
        }
        if (url.startsWith("/api/mail/directory")) {
            const q = new URL(url, "http://localhost").searchParams.get("q")!.toLowerCase();
            const contacts = url.startsWith("/api/mail/directory/contacts");
            return jsonResponse(
                200,
                entries.filter((entry) => (entry.kind === "contact") === contacts && `${entry.displayName} ${entry.address}`.toLowerCase().split(/\W+/).some((word) => word.startsWith(q))),
            );
        }
        if (init?.method === "POST" || init?.method === "PUT") {
            return jsonResponse(200, occurrence());
        }
        return undefined;
    });
}

function renderNew(props: Partial<React.ComponentProps<typeof EventModal>> = {}) {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onDeleted: vi.fn() };
    render(
        <EventModal
            open
            mailboxUid="mb1"
            folderUid="f1"
            calendars={[{ uid: "f1", name: "Work" }]}
            organizerAddress="jane@example.com"
            occurrence={null}
            initialStart={new Date("2026-06-10T09:00:00.000Z")}
            initialEnd={new Date("2026-06-10T10:00:00.000Z")}
            {...handlers}
            {...props}
        />,
    );
    return handlers;
}

const box = () => screen.getByLabelText("Add guests");
const chips = () => (screen.queryByRole("list", { name: "Guests" }) ? within(screen.getByRole("list", { name: "Guests" })).getAllByRole("listitem").map((item) => item.getAttribute("title")) : []);

/** Types into the guests field and waits for the suggestions it asks the server for. */
async function typeAndWait(user: ReturnType<typeof userEvent.setup>, text: string) {
    await user.type(box(), text);
    return await screen.findByRole("listbox", { name: "Add guests suggestions" }, { timeout: 5000 });
}

function savedBody(fetchMock: ReturnType<typeof vi.fn>, method = "POST") {
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method);
    return JSON.parse((call![1] as RequestInit).body as string);
}

async function save(user: ReturnType<typeof userEvent.setup>, fetchMock: ReturnType<typeof vi.fn>, method = "POST") {
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === method)).toBe(true));
    return savedBody(fetchMock, method);
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("guest suggestions in the quick popover", () => {
    it("suggests mailboxes, contacts and lists by name, and a picked one becomes a chip that is saved as a guest with its address and name", async () => {
        const fetchMock = mockServer();
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");

        const listbox = await typeAndWait(user, "su");
        expect(box()).toHaveAttribute("role", "combobox");
        const options = within(listbox).getAllByRole("option");
        // Contacts first, then the directory: a name and an address, and what it is.
        expect(options.map((option) => option.textContent)).toEqual(["Sara Suarezsara@example.comContact", "Support Desksupport@example.comShared mailbox"]);
        await user.click(screen.getByRole("option", { name: /Support Desk/ }));

        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(box()).toHaveValue("");
        expect(chips()).toEqual(["Support Desk <support@example.com>"]);
        expect(screen.getByText("Support Desk")).toBeInTheDocument();
        // The dialog is still open: a press on a suggestion is not a press outside it.
        expect(screen.getByRole("dialog", { name: "New event" })).toBeInTheDocument();

        expect((await save(user, fetchMock)).attendees).toEqual([
            { address: "support@example.com", displayName: "Support Desk", role: "required", responseStatus: "needsAction", isOrganizer: false },
        ]);
    });

    it("looks up the contacts of the mailbox the event is on, and lists as one guest with their own address", async () => {
        const fetchMock = mockServer();
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");

        await typeAndWait(user, "sal");
        expect(screen.getByRole("option", { name: /Sales Team/ })).toHaveTextContent("Group");
        expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/mail/directory/contacts?") && String(url).includes("mailboxUid=mb1"))).toBe(true);
        await user.click(screen.getByRole("option", { name: /Sales Team/ }));

        expect((await save(user, fetchMock)).attendees).toEqual([
            { address: "sales-team@example.com", displayName: "Sales Team", role: "required", responseStatus: "needsAction", isOrganizer: false },
        ]);
    });

    it("moves through the suggestions with the arrow keys and picks with Enter or Tab, and Escape closes them without closing the dialog", async () => {
        mockServer();
        const user = userEvent.setup();
        const { onClose } = renderNew();

        await typeAndWait(user, "su");
        expect(box()).toHaveAttribute("aria-expanded", "true");
        await user.keyboard("{ArrowDown}");
        expect(box()).toHaveAttribute("aria-activedescendant", "event-guests-suggestion-1");
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();

        await user.keyboard("{ArrowDown}");
        expect(await screen.findByRole("listbox")).toBeInTheDocument();
        await user.keyboard("{ArrowDown}{Enter}");
        expect(chips()).toHaveLength(1);

        await user.type(box(), "su");
        await screen.findByRole("listbox");
        await user.keyboard("{Tab}");
        expect(chips()).toHaveLength(2);
        expect(box()).toHaveFocus();
    });

    it("draws the suggestions above the dialog, outside its own box so its scrolling does not clip them", async () => {
        mockServer();
        const user = userEvent.setup();
        renderNew();

        const listbox = await typeAndWait(user, "su");
        expect(screen.getByRole("dialog", { name: "New event" })).not.toContainElement(listbox);
        expect(listbox.parentElement).toBe(document.body);
        expect(listbox).toHaveStyle({ position: "fixed", zIndex: "1100" });
    });

    it("keeps a name that matches nothing as text, without an error while it is typed, and flags it once it is committed", async () => {
        const fetchMock = mockServer();
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");

        await user.type(box(), "zebra");
        await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/mail/directory?"))).toBe(true));
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(box()).toHaveValue("zebra");
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.queryByText(/not a valid email address/)).not.toBeInTheDocument();

        await user.keyboard("{Enter}");
        expect(box()).toHaveValue("");
        expect(screen.getByText("zebra").closest("li")).toHaveTextContent("zebra (not a valid email address)");

        // It can't be a guest, so it stops the save until it is removed.
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("“zebra” isn’t a valid email address.");
        expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
        await user.click(screen.getByRole("button", { name: "Remove zebra" }));
        expect((await save(user, fetchMock)).attendees).toEqual([]);
    });

    it("commits what is typed when the field loses focus", async () => {
        mockServer();
        const user = userEvent.setup();
        renderNew();

        await user.type(box(), "amy@example.com");
        await user.click(screen.getByLabelText("Location"));
        expect(chips()).toEqual(["amy@example.com"]);
        expect(box()).toHaveValue("");
    });

    it("adds an address with Enter, a comma or a semicolon, and takes a paste of several addresses and names", async () => {
        const fetchMock = mockServer();
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");

        await user.type(box(), "a@example.com{Enter}b@example.com,c@example.com;");
        await user.click(box());
        await user.paste('Dee Dunn <d@example.com>, "Doe, Ed" <e@example.com>; f@example.com');
        await user.keyboard("{Enter}");

        expect(chips()).toEqual([
            "a@example.com",
            "b@example.com",
            "c@example.com",
            "Dee Dunn <d@example.com>",
            '"Doe, Ed" <e@example.com>',
            "f@example.com",
        ]);
        expect((await save(user, fetchMock)).attendees.map((a: { address: string; displayName?: string }) => [a.address, a.displayName])).toEqual([
            ["a@example.com", undefined],
            ["b@example.com", undefined],
            ["c@example.com", undefined],
            ["d@example.com", "Dee Dunn"],
            ["e@example.com", "Doe, Ed"],
            ["f@example.com", undefined],
        ]);
    });

    it("does not add a guest twice, nor the organizer as a guest, and does not suggest one already added", async () => {
        const fetchMock = mockServer([{ displayName: "Bob Bell", address: "bob@example.com", kind: "user" }, { displayName: "Bobby Bell", address: "bobby@example.com", kind: "user" }]);
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");

        await user.type(box(), "bob@example.com, BOB@example.com, Jane@Example.com, ");
        expect(chips()).toEqual(["bob@example.com"]);
        await user.type(box(), "bo");
        const listbox = await screen.findByRole("listbox");
        expect(within(listbox).getAllByRole("option").map((option) => option.textContent)).toEqual(["Bobby Bellbobby@example.comPerson"]);
        await user.clear(box());

        expect((await save(user, fetchMock)).attendees.map((a: { address: string }) => a.address)).toEqual(["bob@example.com"]);
    });

    it("removes a chip with its button, and the last one with Backspace in the empty box", async () => {
        mockServer();
        const user = userEvent.setup();
        renderNew();

        await user.type(box(), "a@example.com,b@example.com,c@example.com,");
        await user.click(screen.getByRole("button", { name: "Remove b@example.com" }));
        expect(chips()).toEqual(["a@example.com", "c@example.com"]);
        expect(box()).toHaveFocus();
        await user.keyboard("{Backspace}");
        expect(chips()).toEqual(["a@example.com"]);
    });

    it("still accepts plain addresses when the lookup fails, and says nothing about the failure", async () => {
        const fetchMock = mockServer(DIRECTORY, (url) => (url.startsWith("/api/mail/directory") ? jsonResponse(500, { message: "down" }) : undefined));
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");

        await user.type(box(), "bob@exa");
        await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/mail/directory")).length).toBeGreaterThan(0));
        await user.type(box(), "mple.com{Enter}");
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect((await save(user, fetchMock)).attendees.map((a: { address: string }) => a.address)).toEqual(["bob@example.com"]);
    });

    it("works in the bottom sheet a phone gets", async () => {
        mockMatchMedia(true);
        mockServer();
        const user = userEvent.setup();
        renderNew();
        await waitFor(() => expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-event-shell", "sheet"));

        await typeAndWait(user, "sar");
        await user.click(screen.getByRole("option", { name: /Sara Suarez/ }));
        expect(chips()).toEqual(["Sara Suarez <sara@example.com>"]);
    });
});

describe("guest suggestions in the full form", () => {
    it("lists a picked guest as a row with their name, address and role, and saves them with both", async () => {
        const fetchMock = mockServer();
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");
        await openMoreOptions(user);

        await typeAndWait(user, "sup");
        await user.click(screen.getByRole("option", { name: /Support Desk/ }));

        // The row is the guest; the field draws no chip beside it.
        expect(screen.getByText("Support Desk")).toBeInTheDocument();
        expect(screen.getByText("support@example.com · Awaiting response")).toBeInTheDocument();
        expect(chips()).toEqual([]);
        expect(box()).toHaveValue("");
        await user.selectOptions(screen.getByLabelText("Attendee role 1"), "optional");

        expect((await save(user, fetchMock)).attendees).toEqual([
            { address: "support@example.com", displayName: "Support Desk", role: "optional", responseStatus: "needsAction", isOrganizer: false },
        ]);
    });

    it("keeps a name that matches nothing as text and flags it when it is committed, drawing only that as a chip", async () => {
        const fetchMock = mockServer();
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");
        await openMoreOptions(user);

        await user.type(box(), "bob@example.com,zebra");
        await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/mail/directory?"))).toBe(true));
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(box()).toHaveValue("zebra");

        await user.keyboard("{Enter}");
        expect(chips()).toEqual(["zebra"]);
        expect(screen.getByRole("list", { name: "Guests" })).toHaveTextContent("zebra (not a valid email address)");
        expect(screen.getByLabelText("Attendee role 1")).toBeInTheDocument();

        // Backspace removes the flagged chip, not the guest listed above it.
        await user.keyboard("{Backspace}");
        expect(chips()).toEqual([]);
        await user.keyboard("{Backspace}");
        expect(screen.getByLabelText("Attendee role 1")).toBeInTheDocument();
    });

    it("commits what is typed when the popover grows into the full form: an address as a guest, a half-typed name as a flagged entry", async () => {
        mockServer();
        const user = userEvent.setup();
        renderNew();

        await user.type(box(), "amy@example.com, bo");
        await openMoreOptions(user);

        // Leaving the field committed both: an address is a guest, a half-typed name is a flagged entry.
        expect(screen.getByText(/^amy@example.com/)).toBeInTheDocument();
        expect(chips()).toEqual(["bo"]);
    });

    it("adds a guest to an existing event without touching the others, and leaves the organizer and roles alone", async () => {
        const fetchMock = mockServer();
        const user = userEvent.setup();
        renderNew({
            occurrence: occurrence({
                attendees: [
                    { address: "jane@example.com", displayName: "Jane", role: "required", responseStatus: "accepted", isOrganizer: true },
                    { address: "bob@example.com", displayName: "Bob", role: "optional", responseStatus: "declined", isOrganizer: false },
                ],
            }),
        });
        fireEvent.click(screen.getByRole("button", { name: "Modify" }));

        await user.type(box(), "sara@example.com, JANE@example.com, ");
        await typeAndWait(user, "su");
        await user.click(screen.getByRole("option", { name: /Support Desk/ }));

        expect((await save(user, fetchMock, "PUT")).attendees).toEqual([
            { address: "jane@example.com", displayName: "Jane", role: "required", responseStatus: "accepted", isOrganizer: true },
            { address: "bob@example.com", displayName: "Bob", role: "optional", responseStatus: "declined", isOrganizer: false },
            { address: "sara@example.com", role: "required", responseStatus: "needsAction", isOrganizer: false },
            { address: "support@example.com", displayName: "Support Desk", role: "required", responseStatus: "needsAction", isOrganizer: false },
        ]);
    });
});
