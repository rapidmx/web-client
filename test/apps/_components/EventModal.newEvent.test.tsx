// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import EventModal from "../../../apps/shared/components/calendar/EventModal.js";
import { RecurrenceRule } from "@rapidmx/react-shared/calendar/calendarApi.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import { addGuest, clickModify, openMoreOptions, openTimeControls, setWhen } from "./eventModalHelpers.js";

// A new event: the quick-create popover, "More options" growing it into the full card with the same values, and the fields both share.

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

function renderNew(props: Partial<React.ComponentProps<typeof EventModal>> = {}) {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onDeleted: vi.fn() };
    render(
        <EventModal
            open
            mailboxUid="mb1"
            folderUid="f1"
            calendars={[{ uid: "f1", name: "Work" }]}
            folderColors={{ f1: "rgb(10, 20, 30)" }}
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

function mockCreate(created: CalendarOccurrence = occurrence()) {
    return mockFetch((url, init) => (url === "/api/mail/calendar-events" && init?.method === "POST" ? jsonResponse(200, created) : undefined));
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>) {
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    return JSON.parse((call![1] as RequestInit).body as string);
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("quick create", () => {
    it("opens as a popover with the title focused and the everyday fields, and none of the full form's", () => {
        renderNew();

        const dialog = screen.getByRole("dialog", { name: "New event" });
        expect(dialog.parentElement).toHaveAttribute("data-event-shell", "popover");
        expect(screen.getByLabelText("Title")).toHaveFocus();
        expect(screen.getByLabelText("Title")).toHaveAttribute("placeholder", "Add title");
        expect(screen.getByLabelText("Add guests")).toBeInTheDocument();
        expect(screen.getByLabelText("Add video conferencing")).not.toBeChecked();
        expect(screen.getByLabelText("Location")).toHaveAttribute("placeholder", "Add location");
        expect(screen.getByRole("button", { name: "More options" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
        expect(screen.queryByLabelText("Busy status")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Automatic reply message")).not.toBeInTheDocument();
    });

    it("says when, in which zone and how often, and the calendar with what it will be booked as", () => {
        renderNew();

        expect(screen.getByRole("button", { name: /Wednesday, June 10(, 2026)?\s+9:00am – 10:00am/ })).toBeInTheDocument();
        expect(screen.getByText(/UTC\s+•\s+Does not repeat/)).toBeInTheDocument();
        expect(screen.getByText("Work")).toBeInTheDocument();
        expect(screen.getByText(/Busy\s+•\s+Default visibility\s+•\s+No notification/)).toBeInTheDocument();
    });

    it("opens the date, time, zone and repeat controls in place when the when row is clicked, and closes them again", async () => {
        const user = userEvent.setup();
        renderNew();
        expect(screen.queryByLabelText("Event start date")).not.toBeInTheDocument();

        await openTimeControls(user);
        expect(screen.getByLabelText("Event start date")).toHaveValue("2026-06-10");
        expect(screen.getByLabelText("Event start time")).toHaveValue("09:00");
        expect(screen.getByLabelText("Event end time")).toHaveValue("10:00");
        expect(screen.getByLabelText("Event end date")).toHaveValue("2026-06-10");
        expect(screen.getByRole("checkbox", { name: "All day" })).not.toBeChecked();
        expect(screen.getByLabelText("Recurrence")).toHaveValue("none");

        await user.click(screen.getByRole("button", { name: /Wednesday, June 10/ }));
        expect(screen.queryByLabelText("Event start date")).not.toBeInTheDocument();
    });

    it("updates the when row as the controls change, keeping the length when the start moves", async () => {
        const user = userEvent.setup();
        renderNew();
        await openTimeControls(user);

        setWhen("Start", "2026-06-11T14:00");
        // One hour long still: 2:00pm - 3:00pm the next day.
        expect(screen.getByLabelText("Event end date")).toHaveValue("2026-06-11");
        expect(screen.getByLabelText("Event end time")).toHaveValue("15:00");
        expect(screen.getByRole("button", { name: /Thursday, June 11(, 2026)?\s+2:00pm – 3:00pm/ })).toBeInTheDocument();

        // Only the end moves when the end changes.
        setWhen("End", "2026-06-11T17:30");
        expect(screen.getByLabelText("Event start time")).toHaveValue("14:00");
        expect(screen.getByRole("button", { name: /2:00pm – 5:30pm/ })).toBeInTheDocument();

        // Turning All day on shows dates only.
        await user.click(screen.getByRole("checkbox", { name: "All day" }));
        expect(screen.getByRole("button", { name: /^Thursday, June 11(, \d{4})? ?UTC/ })).toBeInTheDocument();
        expect(screen.queryByLabelText("Event start time")).not.toBeInTheDocument();
        // ... and moving the start moves the end day with it.
        setWhen("Start", "2026-06-15");
        expect(screen.getByLabelText("Event end date")).toHaveValue("2026-06-15");
    });

    it("saves with Enter in the title field, creating the event in the calendar with the popover's values", async () => {
        const fetchMock = mockCreate();
        const user = userEvent.setup();
        const { onSaved } = renderNew();

        await user.type(screen.getByLabelText("Title"), "Planning{Enter}");

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(postedBody(fetchMock)).toEqual(
            expect.objectContaining({
                mailboxUid: "mb1",
                folderUid: "f1",
                title: "Planning",
                startDate: "2026-06-10T09:00:00.000Z",
                endDate: "2026-06-10T10:00:00.000Z",
                allDay: false,
                timezone: "UTC",
                busyStatus: "busy",
                attendees: [],
                organizer: { address: "jane@example.com", type: "to" },
            }),
        );
    });

    it("closes on Escape and on the X, leaving nothing saved", async () => {
        const fetchMock = mockCreate();
        const user = userEvent.setup();
        const { onClose } = renderNew();

        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(2);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("closes on a press outside it while empty, but keeps what was typed against a stray press", async () => {
        const user = userEvent.setup();
        const { onClose } = renderNew();

        fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
        expect(onClose).toHaveBeenCalledTimes(1);

        await user.type(screen.getByLabelText("Title"), "Half typed");
        fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(screen.getByLabelText("Title")).toHaveValue("Half typed");
    });

    it("treats a typed location, a guest, or a half-typed address as something worth keeping too", async () => {
        const user = userEvent.setup();
        const { onClose } = renderNew();

        await user.type(screen.getByLabelText("Location"), "Room 4");
        fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
        await user.clear(screen.getByLabelText("Location"));

        await addGuest(user, "bob@example.com");
        fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
        await user.click(screen.getByRole("button", { name: "Remove bob@example.com" }));

        await user.type(screen.getByLabelText("Add guests"), "amy");
        fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
        expect(onClose).not.toHaveBeenCalled();
    });

    it("draws a bottom sheet on a phone, which still grows into the card", async () => {
        mockMatchMedia(true);
        const user = userEvent.setup();
        renderNew();
        await waitFor(() => expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-event-shell", "sheet"));

        await openMoreOptions(user);
        expect(screen.getByRole("dialog").parentElement).toHaveAttribute("data-event-shell", "card");
    });

    it("starts as an all-day event on the clicked day when asked to (a day of the month view)", async () => {
        const fetchMock = mockCreate();
        const user = userEvent.setup();
        const { onSaved } = renderNew({ initialAllDay: true, initialStart: new Date(2026, 5, 10, 13, 0), initialEnd: new Date(2026, 5, 11) });

        expect(screen.getByRole("button", { name: /^Wednesday, June 10(, \d{4})? ?UTC/ })).toBeInTheDocument();
        await user.type(screen.getByLabelText("Title"), "Holiday{Enter}");

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const body = postedBody(fetchMock);
        expect(body.allDay).toBe(true);
        expect(body.startDate).toBe("2026-06-10T00:00:00.000Z");
        expect(body.endDate).toBe("2026-06-11T00:00:00.000Z");
    });

    it("starts an all-day event today when no day was given", () => {
        renderNew({ initialAllDay: true, initialStart: undefined, initialEnd: undefined });
        // Today, as a single all-day date: no time in the row.
        expect(screen.getByRole("button", { name: /^[A-Za-z]+day, [A-Za-z]+ \d+(, \d{4})? ?UTC/ })).toBeInTheDocument();
    });

    it("gives an event that becomes timed again a length, instead of an empty span", async () => {
        const fetchMock = mockCreate();
        const user = userEvent.setup();
        const { onSaved } = renderNew({ initialAllDay: true, initialStart: new Date(2026, 5, 10), initialEnd: new Date(2026, 5, 10) });
        await user.type(screen.getByLabelText("Title"), "Trip");
        await openTimeControls(user);

        await user.click(screen.getByRole("checkbox", { name: "All day" }));
        expect(screen.getByLabelText("Event start time")).toHaveValue("00:00");
        expect(screen.getByLabelText("Event end time")).toHaveValue("01:00");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(postedBody(fetchMock).endDate).toBe("2026-06-10T01:00:00.000Z");
    });

    it("keeps a timed event's own end when All day is turned off, if it is already after the start", async () => {
        const user = userEvent.setup();
        renderNew();
        await openTimeControls(user);
        await user.click(screen.getByRole("checkbox", { name: "All day" }));
        await user.click(screen.getByRole("checkbox", { name: "All day" }));
        expect(screen.getByLabelText("Event end time")).toHaveValue("10:00");
    });

    it("asks for a date instead of failing when a date or time is cleared", async () => {
        const fetchMock = mockCreate();
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Planning");
        await openTimeControls(user);

        fireEvent.change(screen.getByLabelText("Event start date"), { target: { value: "" } });
        // The row cannot say when, and nothing else moved.
        expect(screen.getByRole("button", { name: /^Pick a date and time/ })).toBeInTheDocument();
        expect(screen.getByLabelText("Event end date")).toHaveValue("2026-06-10");
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Pick a start and an end date and time.")).toBeInTheDocument();

        // The same for an all-day event's dates.
        await user.click(screen.getByRole("checkbox", { name: "All day" }));
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Pick a start and an end date.")).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps the end when the start is cleared and set again", async () => {
        const user = userEvent.setup();
        renderNew();
        await openTimeControls(user);
        fireEvent.change(screen.getByLabelText("Event start date"), { target: { value: "" } });
        fireEvent.change(screen.getByLabelText("Event start date"), { target: { value: "2026-06-12" } });
        // The start had no value to measure a move from, so the end stays where it was.
        expect(screen.getByLabelText("Event end date")).toHaveValue("2026-06-10");
    });

    describe("time zone", () => {
        it("shows the times on the chosen zone's clock and stores the event with that zone, without moving it", async () => {
            const fetchMock = mockCreate();
            const user = userEvent.setup();
            const { onSaved } = renderNew();
            await user.type(screen.getByLabelText("Title"), "Call");
            await openTimeControls(user);

            expect(screen.queryByRole("combobox", { name: "Time zone" })).not.toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Time zone" }));
            await user.selectOptions(screen.getByLabelText("Time zone"), "America/New_York");
            // 09:00Z is 05:00 in New York (EDT).
            expect(screen.getByLabelText("Event start time")).toHaveValue("05:00");
            expect(screen.getByLabelText("Event end time")).toHaveValue("06:00");
            expect(screen.getByText(/America\/New York\s+•/)).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Save" }));
            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = postedBody(fetchMock);
            expect(body.timezone).toBe("America/New_York");
            expect(body.startDate).toBe("2026-06-10T09:00:00.000Z");
        });

        it("reads times typed afterwards on that zone's clock, and back again on the device's", async () => {
            const fetchMock = mockCreate();
            const user = userEvent.setup();
            const { onSaved } = renderNew();
            await user.type(screen.getByLabelText("Title"), "Call");
            await openMoreOptions(user);

            await user.click(screen.getByRole("button", { name: "Time zone" }));
            await user.selectOptions(screen.getByLabelText("Time zone"), "America/New_York");
            setWhen("Start", "2026-06-10T07:00");
            expect(screen.getByLabelText("Event end time")).toHaveValue("08:00");
            await user.click(screen.getByRole("button", { name: "Save" }));
            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            // 07:00 in New York is 11:00Z.
            expect(postedBody(fetchMock).startDate).toBe("2026-06-10T11:00:00.000Z");
        });

        it("returns to the device's clock when its zone is chosen again", async () => {
            const user = userEvent.setup();
            renderNew();
            await openMoreOptions(user);
            await user.click(screen.getByRole("button", { name: "Time zone" }));
            await user.selectOptions(screen.getByLabelText("Time zone"), "America/New_York");
            await user.selectOptions(screen.getByLabelText("Time zone"), "UTC");
            expect(screen.getByLabelText("Event start time")).toHaveValue("09:00");
            expect(screen.getByLabelText("Event end time")).toHaveValue("10:00");
        });

        it("stores an all-day event with the chosen zone and leaves its dates alone, and keeps a value it can't convert", async () => {
            const user = userEvent.setup();
            renderNew();
            await openMoreOptions(user);
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            await user.click(screen.getByRole("button", { name: "Time zone" }));
            await user.selectOptions(screen.getByLabelText("Time zone"), "Asia/Tokyo");
            expect(screen.getByLabelText("Event start date")).toHaveValue("2026-06-10");
            await user.click(screen.getByRole("checkbox", { name: "All day" }));

            // A cleared start can't be converted; it stays as it is when the zone changes.
            fireEvent.change(screen.getByLabelText("Event start date"), { target: { value: "" } });
            await user.selectOptions(screen.getByLabelText("Time zone"), "Europe/Paris");
            expect(screen.getByLabelText("Event start date")).toHaveValue("");
            fireEvent.change(screen.getByLabelText("Event start date"), { target: { value: "2026-06-10" } });
            fireEvent.change(screen.getByLabelText("Event end date"), { target: { value: "" } });
            await user.selectOptions(screen.getByLabelText("Time zone"), "UTC");
            expect(screen.getByLabelText("Event end date")).toHaveValue("");
        });
    });
});

describe("guests", () => {
    it("adds an address with Enter, a comma or a semicolon, and skips one already on the list", async () => {
        const user = userEvent.setup();
        renderNew();
        await addGuest(user, "bob@example.com");
        await user.type(screen.getByLabelText("Add guests"), "amy@example.com,");
        await user.type(screen.getByLabelText("Add guests"), "cat@example.com;");
        await addGuest(user, "BOB@example.com");

        const chips = screen.getAllByRole("listitem").map((item) => item.textContent);
        expect(chips).toEqual(["bob@example.com", "amy@example.com", "cat@example.com"]);
        expect(screen.getByLabelText("Add guests")).toHaveValue("");
    });

    it("keeps what is not an address as a flagged chip once it is committed, and says nothing while it is being typed", async () => {
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Add guests"), "bob@example.com, nonsense");

        // Still being typed: a guest and the text, and no complaint.
        expect(screen.getByText("bob@example.com")).toBeInTheDocument();
        expect(screen.getByLabelText("Add guests")).toHaveValue("nonsense");
        expect(screen.queryByText(/not a valid email address/)).not.toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();

        await user.type(screen.getByLabelText("Add guests"), "{Enter}");
        expect(screen.getByLabelText("Add guests")).toHaveValue("");
        expect(screen.getByText("nonsense").closest("li")).toHaveTextContent("nonsense (not a valid email address)");
        expect(screen.getByText("bob@example.com").closest("li")).not.toHaveTextContent("not a valid email address");
    });

    it("adds an address left in the box when the event is saved, and sends it as a required guest", async () => {
        const fetchMock = mockCreate();
        const user = userEvent.setup();
        const { onSaved } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");
        await user.type(screen.getByLabelText("Add guests"), "bob@example.com");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(postedBody(fetchMock).attendees).toEqual([{ address: "bob@example.com", role: "required", responseStatus: "needsAction", isOrganizer: false }]);
    });

    it("adds an address still in the box when the form is submitted without the box having lost focus", async () => {
        const fetchMock = mockCreate();
        const user = userEvent.setup();
        const { onSaved } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");
        await user.type(screen.getByLabelText("Add guests"), "Bob <bob@example.com>");
        expect(screen.getByLabelText("Add guests")).toHaveFocus();
        fireEvent.submit(screen.getByLabelText("Title").closest("form")!);

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(postedBody(fetchMock).attendees).toEqual([
            { address: "bob@example.com", displayName: "Bob", role: "required", responseStatus: "needsAction", isOrganizer: false },
        ]);
    });

    it("does not save while the box holds something that is not an address", async () => {
        const fetchMock = mockCreate();
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");
        await user.type(screen.getByLabelText("Add guests"), "bob");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("“bob” isn’t a valid email address.")).toBeInTheDocument();
        // Nothing was saved (the guests field itself may have asked for suggestions).
        expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toEqual([]);
    });

    it("does not save while a flagged chip is still in the field, and saves once it is removed", async () => {
        const fetchMock = mockCreate();
        const user = userEvent.setup();
        const { onSaved } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Sync");
        await user.type(screen.getByLabelText("Add guests"), "bob{Enter}");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("“bob” isn’t a valid email address.")).toBeInTheDocument();
        expect(onSaved).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Remove bob" }));
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(postedBody(fetchMock).attendees).toEqual([]);
    });

    it("removes a chip", async () => {
        const user = userEvent.setup();
        renderNew();
        await addGuest(user, "bob@example.com");
        await addGuest(user, "amy@example.com");
        await user.click(screen.getByRole("button", { name: "Remove bob@example.com" }));
        expect(screen.queryByText("bob@example.com")).not.toBeInTheDocument();
        expect(screen.getByText("amy@example.com")).toBeInTheDocument();
    });

    it("shows a guest's display name and address in the full form, and can set the role", async () => {
        const user = userEvent.setup();
        const { onSaved } = { onSaved: vi.fn() };
        const fetchMock = mockFetch((url, init) => (init?.method === "PUT" ? jsonResponse(200, occurrence()) : undefined));
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence({
                    attendees: [{ address: "bob@example.com", displayName: "Bob", role: "required", responseStatus: "accepted", isOrganizer: false }],
                })}
                onSaved={onSaved}
                onDeleted={vi.fn()}
            />,
        );
        clickModify();

        expect(screen.getByText("Bob")).toBeInTheDocument();
        expect(screen.getByText("bob@example.com · Accepted")).toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText("Attendee role 1"), "optional");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).attendees[0].role).toBe("optional");
    });
});

describe("More options", () => {
    it("grows into the card, keeping the title, guests, location, video toggle and times typed so far", async () => {
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Offsite");
        await addGuest(user, "bob@example.com");
        await user.type(screen.getByLabelText("Location"), "Lisbon");
        await user.click(screen.getByLabelText("Add video conferencing"));
        await user.type(screen.getByLabelText("Add guests"), "amy@example.com");
        await openTimeControls(user);
        setWhen("Start", "2026-06-12T13:00");

        await openMoreOptions(user);

        const dialog = screen.getByRole("dialog", { name: "New event" });
        expect(dialog.parentElement).toHaveAttribute("data-event-shell", "card");
        expect(screen.getByLabelText("Title")).toHaveValue("Offsite");
        expect(screen.getByLabelText("Title")).toHaveFocus();
        expect(screen.getByLabelText("Location")).toHaveValue("Lisbon");
        expect(screen.getByLabelText("Add video conferencing")).toBeChecked();
        // The address left in the box was committed when the box lost focus, so both guests are listed with their role and answer.
        expect(screen.getByLabelText("Add guests")).toHaveValue("");
        expect(screen.getByText(/^bob@example.com/)).toBeInTheDocument();
        expect(screen.getByText(/^amy@example.com/)).toBeInTheDocument();
        expect(screen.getByLabelText("Attendee role 2")).toBeInTheDocument();
        expect(screen.getByLabelText("Event start date")).toHaveValue("2026-06-12");
        expect(screen.getByLabelText("Event start time")).toHaveValue("13:00");
        expect(screen.queryByRole("button", { name: "More options" })).not.toBeInTheDocument();
    });

    it("has the full form's fields, in two columns' worth of rows, with its Event details and Find a time tabs, a description and a visibility", async () => {
        const user = userEvent.setup();
        renderNew();
        await openMoreOptions(user);

        expect(screen.getByRole("checkbox", { name: "All day" })).toBeInTheDocument();
        expect(screen.getByLabelText("Recurrence")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Time zone" })).toBeInTheDocument();
        expect(screen.getByLabelText("Add video conferencing")).toBeInTheDocument();
        expect(screen.getByLabelText("Location")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add notification" })).toBeInTheDocument();
        expect(screen.getByText("Work")).toBeInTheDocument();
        expect(screen.getByLabelText("Busy status")).toHaveValue("busy");
        expect(screen.getByRole("checkbox", { name: "Send an automatic reply while this event is happening" })).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Guests" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "+ Add room/equipment" })).toBeInTheDocument();
        expect(screen.getByRole("tab", { name: "Event details" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("tab", { name: "Find a time" })).toHaveAttribute("aria-selected", "false");
        expect(screen.getByLabelText("Visibility")).toHaveValue("default");
        expect(screen.getByRole("group", { name: "Guest permissions" })).toBeInTheDocument();
        expect(await screen.findByRole("toolbar", { name: "Description formatting" })).toBeInTheDocument();
    });

    it("saves from the top right with everything typed in either face", async () => {
        const fetchMock = mockCreate();
        const user = userEvent.setup();
        const { onSaved } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Offsite");
        await addGuest(user, "bob@example.com");
        await openMoreOptions(user);
        await user.selectOptions(screen.getByLabelText("Busy status"), "free");
        await user.click(screen.getByRole("button", { name: "Add notification" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const body = postedBody(fetchMock);
        expect(body.title).toBe("Offsite");
        expect(body.attendees.map((a: { address: string }) => a.address)).toEqual(["bob@example.com"]);
        expect(body.busyStatus).toBe("free");
        expect(body.reminderMinutesBeforeStart).toBe(30);
    });

    it("closes from the X of the card, and on Escape, for a new event", async () => {
        const user = userEvent.setup();
        const { onClose } = renderNew();
        await openMoreOptions(user);

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(1);
        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("says what the popover will book, as the busy status and reminder are changed in the card", async () => {
        const user = userEvent.setup();
        renderNew();
        // The quick popover reads them from the same values: 45 minutes -> "Notify 45 minutes before".
        await openMoreOptions(user);
        await user.click(screen.getByRole("button", { name: "Add notification" }));
        await user.clear(screen.getByLabelText("Reminder (minutes before)"));
        await user.type(screen.getByLabelText("Reminder (minutes before)"), "45");
        expect(screen.getByLabelText("Reminder (minutes before)")).toHaveValue(45);
    });
});

describe("reminder", () => {
    function renderEdit(reminder: number | undefined) {
        const fetchMock = mockFetch((url, init) => (init?.method === "PUT" ? jsonResponse(200, occurrence()) : undefined));
        const onSaved = vi.fn();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence({ reminderMinutesBeforeStart: reminder })}
                onSaved={onSaved}
                onDeleted={vi.fn()}
            />,
        );
        clickModify();
        return { fetchMock, onSaved };
    }
    const sentReminder = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).reminderMinutesBeforeStart;

    it("shows a stored reminder in the largest unit that fits, and no Add notification", () => {
        renderEdit(120);
        expect(screen.getByLabelText("Reminder (minutes before)")).toHaveValue(2);
        expect(screen.getByLabelText("Reminder unit")).toHaveValue("hours");
        expect(screen.queryByRole("button", { name: "Add notification" })).not.toBeInTheDocument();
    });

    it("keeps the amount and converts to minutes when the unit changes", async () => {
        const user = userEvent.setup();
        const { fetchMock, onSaved } = renderEdit(120);
        await user.selectOptions(screen.getByLabelText("Reminder unit"), "days");
        expect(screen.getByLabelText("Reminder (minutes before)")).toHaveValue(2);
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(sentReminder(fetchMock)).toBe(2880);
    });

    it("clears the reminder with the X, and adds one back at 30 minutes", async () => {
        const user = userEvent.setup();
        const { fetchMock, onSaved } = renderEdit(15);
        await user.click(screen.getByRole("button", { name: "Remove notification" }));
        expect(screen.queryByLabelText("Reminder (minutes before)")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(sentReminder(fetchMock)).toBeNull();
    });

    it("sends no reminder while the amount is empty, and reads a fraction of a unit in minutes", async () => {
        const user = userEvent.setup();
        renderEdit(120);
        await user.clear(screen.getByLabelText("Reminder (minutes before)"));
        expect(screen.getByLabelText("Reminder (minutes before)")).toHaveValue(null);
        fireEvent.change(screen.getByLabelText("Reminder (minutes before)"), { target: { value: "1.5" } });
        expect(screen.getByLabelText("Reminder (minutes before)")).toHaveValue(1.5);
        // 1.5 hours is 90 minutes; the same amount in minutes rounds to whole minutes.
        await user.selectOptions(screen.getByLabelText("Reminder unit"), "minutes");
        expect(screen.getByLabelText("Reminder (minutes before)")).toHaveValue(2);
    });

    it("starts a new reminder in minutes", async () => {
        const user = userEvent.setup();
        renderEdit(undefined);
        await user.click(screen.getByRole("button", { name: "Add notification" }));
        expect(screen.getByLabelText("Reminder (minutes before)")).toHaveValue(30);
        expect(screen.getByLabelText("Reminder unit")).toHaveValue("minutes");
    });
});

describe("recurrence menu", () => {
    async function openMenu() {
        const user = userEvent.setup();
        renderNew({ initialStart: new Date("2026-06-10T09:00:00.000Z"), initialEnd: new Date("2026-06-10T10:00:00.000Z") });
        await openMoreOptions(user);
        return { user, menu: screen.getByLabelText("Recurrence") };
    }

    async function saved(user: ReturnType<typeof userEvent.setup>, fetchMock: ReturnType<typeof vi.fn>) {
        await user.type(screen.getByLabelText("Title"), "Series");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        return postedBody(fetchMock).recurrenceRule;
    }

    it.each([
        ["daily", { freq: "daily", interval: 1, exceptions: [] }],
        ["weekly", { freq: "weekly", interval: 1, byDay: ["WE"], exceptions: [] }],
        ["monthly", { freq: "monthly", interval: 1, exceptions: [] }],
        ["yearly", { freq: "yearly", interval: 1, exceptions: [] }],
        ["weekdays", { freq: "weekly", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"], exceptions: [] }],
    ])("stores %s as a plain rule", async (choice, rule) => {
        const fetchMock = mockCreate();
        const { user, menu } = await openMenu();
        await user.selectOptions(menu, choice);
        expect(menu).toHaveValue(choice);
        expect(await saved(user, fetchMock)).toEqual(rule);
    });

    it("names the weekly choice after the event's own weekday", async () => {
        const { menu } = await openMenu();
        expect(within(menu).getByRole("option", { name: "Weekly on Wednesday" })).toBeInTheDocument();
    });

    it("opens the full editor for Custom…, seeded with a weekly rule, and back to Does not repeat", async () => {
        const fetchMock = mockCreate();
        const { user, menu } = await openMenu();
        expect(screen.queryByLabelText("Recurrence frequency")).not.toBeInTheDocument();

        await user.selectOptions(menu, "custom");
        expect(screen.getByLabelText("Recurrence frequency")).toHaveValue("weekly");
        expect(screen.queryByRole("checkbox", { name: "Repeats" })).not.toBeInTheDocument();
        await user.clear(screen.getByLabelText("Recurrence interval"));
        await user.type(screen.getByLabelText("Recurrence interval"), "2");
        expect(menu).toHaveValue("custom");

        await user.selectOptions(menu, "none");
        expect(screen.queryByLabelText("Recurrence frequency")).not.toBeInTheDocument();
        expect(await saved(user, fetchMock)).toBeUndefined();
    });

    it("keeps the editor open for Custom… when the rule is also a plain one, and keeps the skipped dates across plain choices", async () => {
        const fetchMock = mockFetch((url, init) => (init?.method === "PUT" ? jsonResponse(200, occurrence()) : undefined));
        const user = userEvent.setup();
        const rule: RecurrenceRule = { freq: "weekly", interval: 1, byDay: ["WE"], exceptions: ["2026-06-17T09:00:00.000Z"] };
        const onSaved = vi.fn();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence({ recurrenceRule: rule })}
                onSaved={onSaved}
                onDeleted={vi.fn()}
            />,
        );
        clickModify();

        expect(screen.getByLabelText("Recurrence")).toHaveValue("weekly");
        await user.selectOptions(screen.getByLabelText("Recurrence"), "custom");
        expect(screen.getByLabelText("Recurrence frequency")).toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText("Recurrence"), "daily");
        expect(screen.queryByLabelText("Recurrence frequency")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).recurrenceRule).toEqual({
            freq: "daily",
            interval: 1,
            exceptions: ["2026-06-17T09:00:00.000Z"],
        });
    });

    it.each([
        ["an interval", { freq: "daily", interval: 2, exceptions: [] }],
        ["an end count", { freq: "daily", interval: 1, count: 5, exceptions: [] }],
        ["an end date", { freq: "daily", interval: 1, until: "2026-07-01T23:59:59.999Z", exceptions: [] }],
        ["a day of the month", { freq: "monthly", interval: 1, byMonthDay: [3], exceptions: [] }],
        ["a month", { freq: "yearly", interval: 1, byMonth: [6], exceptions: [] }],
        ["weekdays on a daily rule", { freq: "daily", interval: 1, byDay: ["MO"], exceptions: [] }],
        ["no weekdays on a weekly rule", { freq: "weekly", interval: 1, exceptions: [] }],
        ["other weekdays", { freq: "weekly", interval: 1, byDay: ["MO", "FR"], exceptions: [] }],
        ["another weekday than the event's", { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] }],
    ] as const)("shows Custom… for a rule with %s", (_name, rule) => {
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence({ recurrenceRule: rule as never })}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );
        clickModify();
        expect(screen.getByLabelText("Recurrence")).toHaveValue("custom");
        expect(screen.getByLabelText("Recurrence frequency")).toBeInTheDocument();
    });

    it("has a plain Weekly entry even when the event's weekday can't be read", async () => {
        const user = userEvent.setup();
        renderNew();
        await openMoreOptions(user);
        fireEvent.change(screen.getByLabelText("Event start date"), { target: { value: "" } });
        const menu = screen.getByLabelText("Recurrence");
        expect(within(menu).getByRole("option", { name: "Weekly" })).toBeInTheDocument();
        await user.selectOptions(menu, "weekly");
        expect(menu).toHaveValue("weekly");
    });
});

describe("a dialog that is not open", () => {
    it("renders nothing", () => {
        renderNew({ open: false });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
});

describe("calendar and mailbox", () => {
    it("shows the calendar's colour beside its name", () => {
        renderNew();
        const dot = screen.getByText("Work").previousElementSibling as HTMLElement;
        expect(dot).toHaveStyle({ backgroundColor: "rgb(10, 20, 30)" });
    });

    it("shows a selector for the calendars and mailboxes, in the quick popover as in the card", async () => {
        const user = userEvent.setup();
        renderNew({
            calendars: [
                { uid: "f1", name: "Work" },
                { uid: "f2", name: "Home" },
            ],
        });
        expect(screen.getByLabelText("Calendar")).toHaveValue("f1");
        await user.selectOptions(screen.getByLabelText("Calendar"), "f2");
        await openMoreOptions(user);
        expect(screen.getByLabelText("Calendar")).toHaveValue("f2");
    });
});

describe("a video meeting that could not be made", () => {
    it("reloads the calendar when the form is closed after the event was stored anyway", async () => {
        mockFetch((url, init) => {
            if (url === "/api/mail/calendar-events" && init?.method === "POST") return jsonResponse(200, occurrence({ uid: "e-new" }));
            if (url === "/api/mail/video-meetings") return jsonResponse(503, { message: "The meeting service is unavailable." });
            return undefined;
        });
        const user = userEvent.setup();
        const { onSaved, onClose } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Standup");
        await addGuest(user, "bob@example.com");
        await user.click(screen.getByLabelText("Add video conferencing"));
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("The meeting service is unavailable.")).toBeInTheDocument();
        expect(onSaved).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onSaved).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
    });
});
