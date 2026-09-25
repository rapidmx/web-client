// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { jsonResponse, mockFetch } from "../testUtils.js";
import EventModal from "../../../apps/shared/components/calendar/EventModal.js";
import { Attendee } from "@rapidmx/react-shared/calendar/calendarApi.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import { getNotificationsSnapshot, resetNotifications } from "../../../apps/shared/notifications/store.js";
import { addGuest, clickModify, openMoreOptions } from "./eventModalHelpers.js";

// The event dialog's description, visibility, guest permissions, Find a time tab and the guest's request to change - as the dialog draws and saves them.

beforeAll(() => {
    const noRects = { length: 0, item: () => null, [Symbol.iterator]: () => [][Symbol.iterator]() };
    Range.prototype.getClientRects = () => noRects;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

beforeEach(() => {
    resetNotifications();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

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

const guest = (address: string, overrides: Partial<Attendee> = {}): Attendee => ({ address, role: "required", responseStatus: "needsAction", isOrganizer: false, ...overrides });

function renderModal(occ: CalendarOccurrence | null, props: Partial<React.ComponentProps<typeof EventModal>> = {}) {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onDeleted: vi.fn() };
    render(
        <EventModal
            open
            mailboxUid="mb1"
            folderUid="f1"
            calendars={[{ uid: "f1", name: "Work" }]}
            folderColors={{ f1: "rgb(10, 20, 30)" }}
            organizerAddress="jane@example.com"
            occurrence={occ}
            initialStart={new Date("2026-06-10T09:00:00.000Z")}
            initialEnd={new Date("2026-06-10T10:00:00.000Z")}
            {...handlers}
            {...props}
        />,
    );
    return handlers;
}

/** A calendar that answers a create with `created`, an update with `updated`, and a free/busy look-up with nobody busy. */
function mockCalendar(created: CalendarOccurrence = occurrence({ uid: "e2" }), updated: CalendarOccurrence = occurrence()) {
    return mockFetch((url, init) => {
        if (url === "/api/mail/calendar-events" && init?.method === "POST") return jsonResponse(200, created);
        if (url.startsWith("/api/mail/calendar-events/e") && init?.method === "PUT") return jsonResponse(200, updated);
        if (url === "/api/mail/calendar-events/free-busy") {
            const body = JSON.parse(init.body as string);
            return jsonResponse(200, { start: body.start, end: body.end, results: body.addresses.map((address: string) => ({ address, status: "available", busy: [] })) });
        }
        return undefined;
    });
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, method: string) {
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method);
    return JSON.parse((call![1] as RequestInit).body as string);
}

/** The description editor's TipTap instance (it is fetched when first drawn). */
async function descriptionEditor(): Promise<Editor> {
    return await waitFor(() => {
        const found: { editor?: Editor } | null = document.querySelector(".ProseMirror");
        expect(found?.editor).toBeDefined();
        return found!.editor!;
    });
}

describe("a new event's description", () => {
    it("is an Add description row in the quick popover that opens the rich-text box in place, with the text focused", async () => {
        const user = userEvent.setup();
        renderModal(null);

        expect(screen.queryByRole("toolbar", { name: "Description formatting" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Add description" }));

        expect(await screen.findByRole("toolbar", { name: "Description formatting" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add description" })).not.toBeInTheDocument();
        const editor = await descriptionEditor();
        await waitFor(() => expect(editor.isFocused).toBe(true));
    });

    it("is saved as sanitized HTML and the plain text derived from it, and grows with the popover into the card", async () => {
        const fetchMock = mockCalendar();
        const user = userEvent.setup();
        const { onSaved } = renderModal(null);
        await user.type(screen.getByLabelText("Title"), "Planning");
        await user.click(screen.getByRole("button", { name: "Add description" }));
        const editor = await descriptionEditor();
        act(() => {
            editor.commands.setContent('<p>Bring <strong>slides</strong></p><ul><li><p>demo</p></li></ul><p><a href="https://example.com/x">notes</a></p>');
        });

        await openMoreOptions(user);
        // The card starts from what was typed, in its own box (which is always there).
        const card = await screen.findByRole("textbox", { name: "Description" });
        expect(card).toHaveTextContent("Bring slidesdemonotes");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(bodyOf(fetchMock, "POST")).toEqual(
            expect.objectContaining({
                title: "Planning",
                descriptionHtml: '<p>Bring <strong>slides</strong></p><ul><li>demo</li></ul><p><a href="https://example.com/x" rel="noopener noreferrer">notes</a></p>',
                description: "Bring slides\n- demo\nnotes (https://example.com/x)",
            }),
        );
    });

    it("says nothing about the description, visibility or guest permissions when they were not touched", async () => {
        const fetchMock = mockCalendar();
        const user = userEvent.setup();
        const { onSaved } = renderModal(null);
        await user.type(screen.getByLabelText("Title"), "Planning{Enter}");
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const body = bodyOf(fetchMock, "POST");
        for (const key of ["description", "descriptionHtml", "visibility", "guestsCanModify", "guestsCanInviteOthers", "guestsCanSeeGuestList"]) {
            expect(body).not.toHaveProperty(key);
        }
    });

    it("is not sent, and is not a reason to keep the popover open, when the editor was opened and left empty", async () => {
        const fetchMock = mockCalendar();
        const user = userEvent.setup();
        const { onSaved } = renderModal(null);
        await user.type(screen.getByLabelText("Title"), "Planning");
        await user.click(screen.getByRole("button", { name: "Add description" }));
        await screen.findByRole("toolbar", { name: "Description formatting" });
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(bodyOf(fetchMock, "POST")).not.toHaveProperty("descriptionHtml");
    });

    it("counts as something typed: a press on the backdrop does not throw it away", async () => {
        const user = userEvent.setup();
        const { onClose } = renderModal(null);
        await user.click(screen.getByRole("button", { name: "Add description" }));
        const editor = await descriptionEditor();
        act(() => {
            editor.commands.setContent("<p>Notes</p>");
        });

        fireEvent.mouseDown(document.querySelector("[data-event-shell]")!);
        expect(onClose).not.toHaveBeenCalled();
        // The row stays open once there is text in it.
        expect(screen.getByRole("toolbar", { name: "Description formatting" })).toBeInTheDocument();
    });

    it("refuses a description too long for the server, and says so", async () => {
        const fetchMock = mockCalendar();
        const user = userEvent.setup();
        renderModal(null);
        await user.type(screen.getByLabelText("Title"), "Planning");
        await openMoreOptions(user);
        const editor = await descriptionEditor();
        act(() => {
            editor.commands.setContent(`<p>${"a".repeat(33_000)}</p>`);
        });
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("The description is too long.")).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("visibility and guest permissions", () => {
    it("are chosen in the card with Google's defaults and what each choice means", async () => {
        const user = userEvent.setup();
        renderModal(null);
        await openMoreOptions(user);

        const visibility = screen.getByLabelText("Visibility");
        expect(visibility).toHaveValue("default");
        expect(within(visibility).getAllByRole("option").map((o) => o.textContent)).toEqual(["Default visibility", "Public", "Private", "Confidential"]);
        expect(screen.getByText(/as the calendar's sharing allows/)).toBeInTheDocument();
        await user.selectOptions(visibility, "private");
        expect(screen.getByText(/Everyone else who can see the calendar sees a busy block/)).toBeInTheDocument();
        await user.selectOptions(visibility, "confidential");
        expect(screen.getByText(/marks the event confidential/)).toBeInTheDocument();
        await user.selectOptions(visibility, "public");
        expect(screen.getByText("Everyone who can see this calendar sees the event's details.")).toBeInTheDocument();

        const permissions = screen.getByRole("group", { name: "Guest permissions" });
        expect(within(permissions).getByRole("checkbox", { name: "Modify event" })).not.toBeChecked();
        expect(within(permissions).getByRole("checkbox", { name: "Invite others" })).toBeChecked();
        expect(within(permissions).getByRole("checkbox", { name: "See guest list" })).toBeChecked();
        expect(within(permissions).getByText(/applied automatically when this is on/)).toBeInTheDocument();
        expect(within(permissions).getByText("When this is off, each guest is sent an invitation that names only themselves and you.")).toBeInTheDocument();
    });

    it("are sent when they differ from the defaults", async () => {
        const fetchMock = mockCalendar();
        const user = userEvent.setup();
        const { onSaved } = renderModal(null);
        await user.type(screen.getByLabelText("Title"), "Offsite");
        await openMoreOptions(user);
        await user.selectOptions(screen.getByLabelText("Visibility"), "private");
        await user.click(screen.getByRole("checkbox", { name: "Modify event" }));
        await user.click(screen.getByRole("checkbox", { name: "Invite others" }));
        await user.click(screen.getByRole("checkbox", { name: "See guest list" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(bodyOf(fetchMock, "POST")).toEqual(
            expect.objectContaining({ visibility: "private", guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeGuestList: false }),
        );
    });

    it("show in the quick popover's line under the calendar, with the real values", async () => {
        const user = userEvent.setup();
        renderModal(null);
        expect(screen.getByText(/Busy\s+•\s+Default visibility\s+•\s+No notification/)).toBeInTheDocument();

        await openMoreOptions(user);
        await user.selectOptions(screen.getByLabelText("Visibility"), "private");
        await user.selectOptions(screen.getByLabelText("Busy status"), "free");
        expect(screen.getByLabelText("Visibility")).toHaveValue("private");
    });
});

describe("modifying an existing event", () => {
    it("starts from its description, visibility and guest permissions, and sends none of them when they are left alone", async () => {
        const stored = occurrence({
            descriptionHtml: "<p>Agenda</p>",
            description: "Agenda",
            visibility: "public",
            guestsCanModify: true,
            guestsCanInviteOthers: false,
            guestsCanSeeGuestList: false,
        });
        const fetchMock = mockCalendar(undefined, stored);
        const user = userEvent.setup();
        const { onSaved } = renderModal(stored);
        clickModify();

        expect(await screen.findByRole("textbox", { name: "Description" })).toHaveTextContent("Agenda");
        expect(screen.getByLabelText("Visibility")).toHaveValue("public");
        expect(screen.getByRole("checkbox", { name: "Modify event" })).toBeChecked();
        expect(screen.getByRole("checkbox", { name: "Invite others" })).not.toBeChecked();
        expect(screen.getByRole("checkbox", { name: "See guest list" })).not.toBeChecked();
        await descriptionEditor();

        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const body = bodyOf(fetchMock, "PUT");
        for (const key of ["description", "descriptionHtml", "visibility", "guestsCanModify", "guestsCanInviteOthers", "guestsCanSeeGuestList"]) {
            expect(body).not.toHaveProperty(key);
        }
    });

    it("starts from the plain text of an event that has no HTML", async () => {
        mockCalendar();
        renderModal(occurrence({ description: "Line one\nLine two" }));
        clickModify();
        const editor = await descriptionEditor();
        expect(editor.getHTML()).toBe("<p>Line one</p><p>Line two</p>");
    });

    it("sends what was changed, and null twice for a description that was emptied", async () => {
        const stored = occurrence({ descriptionHtml: "<p>Agenda</p>", description: "Agenda" });
        const fetchMock = mockCalendar(undefined, stored);
        const user = userEvent.setup();
        const { onSaved } = renderModal(stored);
        clickModify();
        const editor = await descriptionEditor();
        act(() => {
            editor.commands.setContent("<p>Agenda, revised</p>");
        });
        await user.selectOptions(screen.getByLabelText("Visibility"), "confidential");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
        expect(bodyOf(fetchMock, "PUT")).toEqual(
            expect.objectContaining({ uid: "e1", version: 2, description: "Agenda, revised", descriptionHtml: "<p>Agenda, revised</p>", visibility: "confidential" }),
        );

        fetchMock.mockClear();
        act(() => {
            editor.commands.setContent("<p></p>");
        });
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
        expect(bodyOf(fetchMock, "PUT")).toEqual(expect.objectContaining({ description: null, descriptionHtml: null }));
    });

    it("gives the one occurrence that is detached the description it was edited to, and the series its own", async () => {
        const stored = occurrence({
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["WE"], exceptions: [] },
            recurrenceId: "2026-06-10T09:00:00.000Z",
            isRecurringOccurrence: true,
            descriptionHtml: "<p>Agenda</p>",
            description: "Agenda",
        });
        const fetchMock = mockCalendar(occurrence({ uid: "e2" }), stored);
        const user = userEvent.setup();
        const { onSaved } = renderModal(stored);
        clickModify();
        const editor = await descriptionEditor();
        act(() => {
            editor.commands.setContent("");
        });
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        // "This event only" is the default: a new event, and a create omits nothing it says - it says the description is none.
        expect(bodyOf(fetchMock, "POST")).toEqual(expect.objectContaining({ description: null, descriptionHtml: null }));
    });
});

describe("the Find a time tab", () => {
    it("has an Event details tab and a Find a time tab that switch with a click and the arrow keys, keeping what was typed", async () => {
        const user = userEvent.setup();
        renderModal(null);
        await openMoreOptions(user);
        await user.type(screen.getByLabelText("Location"), "Room 4");

        const details = screen.getByRole("tab", { name: "Event details" });
        const find = screen.getByRole("tab", { name: "Find a time" });
        expect(details).toHaveAttribute("tabindex", "0");
        expect(find).toHaveAttribute("tabindex", "-1");
        expect(screen.getByRole("tabpanel", { name: "Event details" })).toBeVisible();

        await user.click(find);
        expect(find).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("tabpanel", { name: "Find a time" })).toBeVisible();
        // Hidden, not removed: what was typed in it is still there.
        expect(document.getElementById("event-panel-details")).not.toBeVisible();
        expect(document.getElementById("event-panel-details")).toContainElement(screen.getByLabelText("Location", { selector: "input" }));
        expect(screen.getByText("Add guests to see when they are free.")).toBeInTheDocument();
        // The guests stay beside it.
        expect(screen.getByRole("heading", { name: "Guests" })).toBeInTheDocument();

        find.focus();
        await user.keyboard("{ArrowLeft}");
        expect(details).toHaveAttribute("aria-selected", "true");
        expect(details).toHaveFocus();
        await user.keyboard("{ArrowRight}");
        expect(find).toHaveAttribute("aria-selected", "true");
        await user.keyboard("{Home}");
        expect(details).toHaveAttribute("aria-selected", "true");
        await user.keyboard("{End}");
        expect(find).toHaveAttribute("aria-selected", "true");
        await user.keyboard("{Tab}");
        await user.keyboard("{Home}");
        expect(screen.getByLabelText("Location")).toHaveValue("Room 4");
    });

    it("looks up the guests added to the event, and a suggested time sets the event's start (keeping its length)", async () => {
        const fetchMock = mockCalendar();
        const user = userEvent.setup();
        renderModal(null);
        await addGuest(user, "bob@example.com");
        await openMoreOptions(user);
        await user.click(screen.getByRole("tab", { name: "Find a time" }));

        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Everyone is free|conflict/));
        const lookUp = fetchMock.mock.calls.find(([url]) => url === "/api/mail/calendar-events/free-busy")!;
        expect(JSON.parse((lookUp[1] as RequestInit).body as string).addresses).toEqual(["jane@example.com", "bob@example.com"]);
        expect(screen.getByRole("img", { name: /^You:/ })).toBeInTheDocument();

        // Suggestions are for times not yet past; the event's own day may be, so pick from the hour buttons too.
        await user.click(screen.getByRole("button", { name: "Start at 2pm" }));
        expect(screen.getByLabelText("Event start time")).toHaveValue("14:00");
        expect(screen.getByLabelText("Event end time")).toHaveValue("15:00");
    });

    it("follows the date chosen in the form", async () => {
        mockCalendar();
        const user = userEvent.setup();
        renderModal(null);
        await addGuest(user, "bob@example.com");
        await openMoreOptions(user);
        await user.click(screen.getByRole("tab", { name: "Find a time" }));
        expect(screen.getByText("Wednesday, June 10")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Event start date"), { target: { value: "2026-06-12" } });
        expect(screen.getByText("Friday, June 12")).toBeInTheDocument();
    });
});

describe("the details of an event", () => {
    it("draw the description as rich text, with its links, and never its scripts", () => {
        renderModal(
            occurrence({
                descriptionHtml: '<p>See <a href="https://example.com/x">the <b>doc</b></a></p><script>window.hacked = true</script><img src="https://tracker.example/x.png"><p onclick="window.hacked = true">x</p>',
                description: "See the doc",
            }),
        );
        const dialog = screen.getByRole("dialog", { name: "Event details" });
        expect(within(dialog).getByRole("link", { name: "the doc" })).toHaveAttribute("href", "https://example.com/x");
        expect(within(dialog).getByRole("link", { name: "the doc" })).toHaveAttribute("rel", "noopener noreferrer");
        expect(dialog.querySelector("script, img")).toBeNull();
        expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
    });

    it("show a description that has only plain text, and none when there is none", () => {
        renderModal(occurrence({ description: "Just words" }));
        expect(screen.getByText("Just words")).toBeInTheDocument();
    });

    it("say the visibility under the busy status, and what guests can do to the organizer", () => {
        renderModal(occurrence({ visibility: "private", attendees: [guest("bob@example.com")], guestsCanModify: true }));
        expect(screen.getByText("Private")).toBeInTheDocument();
        expect(screen.getByText("Guests can modify the event, invite others and see the guest list.")).toBeInTheDocument();
    });

    it("say Default visibility for an event that has none, and leave the guest permissions of an invitation to its organizer", () => {
        renderModal(occurrence({ organizer: { address: "boss@example.com", type: "to" }, attendees: [guest("jane@example.com"), guest("bob@example.com")] }));
        expect(screen.getByText("Default visibility")).toBeInTheDocument();
        expect(screen.queryByText(/^Guests can/)).not.toBeInTheDocument();
    });

    it("show an invited reader only themselves, and say the organizer hid the guest list", () => {
        renderModal(
            occurrence({
                organizer: { address: "boss@example.com", type: "to" },
                attendees: [guest("jane@example.com", { displayName: "Jane" }), guest("secret@example.com", { displayName: "Secret Guest" })],
                guestsCanSeeGuestList: false,
            }),
        );
        expect(screen.getByText("The organizer has hidden the guest list")).toBeInTheDocument();
        expect(screen.getByText("Jane")).toBeInTheDocument();
        expect(screen.queryByText("Secret Guest")).not.toBeInTheDocument();
        expect(screen.queryByText("2 guests")).not.toBeInTheDocument();
    });

    it("say the organizer hid the guest list even when nobody else than the organizer is left to show", () => {
        renderModal(occurrence({ organizer: { address: "boss@example.com", type: "to" }, attendees: [guest("jane@example.com")], guestsCanSeeGuestList: false }), {
            organizerAddress: "jane@example.com",
        });
        expect(screen.getByText("The organizer has hidden the guest list")).toBeInTheDocument();
    });

    it("show the organizer the whole list, whatever the flag says", () => {
        renderModal(occurrence({ attendees: [guest("bob@example.com", { displayName: "Bob" }), guest("cy@example.com", { displayName: "Cy" })], guestsCanSeeGuestList: false }));
        expect(screen.getByText("2 guests")).toBeInTheDocument();
        expect(screen.getByText("Bob")).toBeInTheDocument();
        expect(screen.getByText("Guests can invite others.")).toBeInTheDocument();
    });
});

describe("a busy block", () => {
    const redacted = () =>
        occurrence({
            title: "Busy",
            redacted: true,
            organizer: { address: "", type: "to" },
            attendees: [],
            visibility: "private",
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["WE"], exceptions: [] },
            isRecurringOccurrence: true,
        });

    it("is drawn as just that: the time, that it is busy, and nothing to change, delete or answer", () => {
        const { onClose } = renderModal(redacted());

        const dialog = screen.getByRole("dialog", { name: "Event details" });
        expect(within(dialog).getByRole("heading", { name: "Busy" })).toBeInTheDocument();
        expect(dialog).toHaveTextContent(/Wednesday, June 10(, 2026)?\s+9:00am – 10:00am/);
        expect(dialog).toHaveTextContent(/Repeats every week on Wednesday/);
        expect(dialog).toHaveTextContent("This time is busy. The event’s details are private, so only its time is shown.");
        for (const name of ["Modify", "Delete", "Accept", "Request a change", "Add guests"]) {
            expect(within(dialog).queryByRole("button", { name })).not.toBeInTheDocument();
        }
        expect(dialog).not.toHaveTextContent("Organizer");

        fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
        fireEvent.click(within(dialog).getByRole("button", { name: "Close details" }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("has no repeat line for a single event", () => {
        renderModal({ ...redacted(), recurrenceRule: undefined, isRecurringOccurrence: false });
        expect(screen.getByRole("dialog")).not.toHaveTextContent("Repeats");
    });
});

describe("a guest's request to change an event", () => {
    const invited = (overrides: Partial<CalendarOccurrence> = {}) =>
        occurrence({
            organizer: { address: "boss@example.com", displayName: "Boss", type: "to" },
            attendees: [guest("jane@example.com"), guest("bob@example.com")],
            location: "Room A",
            ...overrides,
        });

    function mockRequest(status = 200, body: unknown = { requested: true, changes: ["title"], addAttendees: [] }) {
        return mockFetch((url, init) => (url === "/api/mail/calendar-events/e1/request-change" && init?.method === "POST" ? jsonResponse(status, body) : undefined));
    }

    it("is offered as Request a change when the organizer lets guests modify, and Add guests when they may only invite", async () => {
        renderModal(invited({ guestsCanModify: true }));
        expect(screen.getByRole("button", { name: "Request a change" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add guests" })).not.toBeInTheDocument();
        expect(screen.getByText("You were invited to this event. Only the organizer can change its details, but you can ask them to.")).toBeInTheDocument();
    });

    it("is Add guests for a guest who may only invite, and not offered at all when the organizer allows neither", () => {
        renderModal(invited());
        expect(screen.getByRole("button", { name: "Add guests" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Request a change" })).not.toBeInTheDocument();
    });

    it("is not offered when the organizer allows neither, nor to the organizer, nor to a reader who is not a guest", () => {
        renderModal(invited({ guestsCanInviteOthers: false }));
        expect(screen.queryByRole("button", { name: "Request a change" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add guests" })).not.toBeInTheDocument();
        expect(screen.getByText("You were invited to this event. Only the organizer can change its details.")).toBeInTheDocument();
    });

    it("is not offered to the organizer, who modifies the event itself", () => {
        renderModal(occurrence({ attendees: [guest("bob@example.com")], guestsCanModify: true }));
        expect(screen.queryByRole("button", { name: "Request a change" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Modify" })).toBeInTheDocument();
    });

    it("opens a form in place of the button, sends the change, and says it was sent to the organizer", async () => {
        const fetchMock = mockRequest();
        const user = userEvent.setup();
        const { onClose, onSaved } = renderModal(invited({ guestsCanModify: true }));

        await user.click(screen.getByRole("button", { name: "Request a change" }));
        expect(screen.queryByRole("button", { name: "Request a change" })).not.toBeInTheDocument();
        const form = screen.getByRole("form", { name: "Request a change" });
        await user.clear(within(form).getByLabelText("Title"));
        await user.type(within(form).getByLabelText("Title"), "Standup, moved");
        await user.click(within(form).getByRole("button", { name: "Send request" }));

        await waitFor(() => expect(screen.queryByRole("form", { name: "Request a change" })).not.toBeInTheDocument());
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ title: "Standup, moved" });
        expect(getNotificationsSnapshot().visible).toEqual([expect.objectContaining({ kind: "success", title: "Your change was sent to the organizer" })]);
        // Nothing changed here: the details are still the event as it was, and the dialog is still open.
        expect(screen.getByRole("heading", { name: "Standup" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Request a change" })).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        expect(onSaved).not.toHaveBeenCalled();
    });

    it("leaves the details when the form is cancelled, and asks for guests to be added for a series", async () => {
        const fetchMock = mockRequest();
        const user = userEvent.setup();
        renderModal(
            invited({
                guestsCanModify: true,
                recurrenceRule: { freq: "weekly", interval: 1, byDay: ["WE"], exceptions: [] },
                recurrenceId: "2026-06-10T09:00:00.000Z",
                isRecurringOccurrence: true,
            }),
        );
        await user.click(screen.getByRole("button", { name: "Request a change" }));
        expect(screen.queryByLabelText("Starts")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("form", { name: "Request a change" })).not.toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Request a change" }));
        await user.type(screen.getByLabelText("Guests to add"), "new@example.com{Enter}");
        await user.click(screen.getByRole("button", { name: "Send request" }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ addAttendees: [{ address: "new@example.com" }] });
    });
});
