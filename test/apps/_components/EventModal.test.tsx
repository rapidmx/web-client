// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import EventModal from "../../../apps/shared/components/calendar/EventModal.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/recurrence.js";
import { Mailbox } from "@rapidmx/react-shared/mailApi.js";

// `ResourcePicker`'s own loading/filtering/error rendering is tested in its own file — mocked here so
// this file only exercises how `EventModal` opens it and reacts to a selection.
vi.mock("../../../apps/shared/components/calendar/ResourcePicker.js", () => ({
    default: ({
        onSelect,
        onClose,
        excludeAddresses,
    }: {
        onSelect: (mailbox: Partial<Mailbox>) => void;
        onClose: () => void;
        excludeAddresses: string[];
    }) => (
        <div>
            <button
                type="button"
                onClick={() => onSelect({ uid: "room-a@example.com", primarySmtpAddress: "room-a@example.com", displayName: "Room A" })}
            >
                fake-resource
            </button>
            <span data-testid="exclude-addresses">{excludeAddresses.join(",")}</span>
            <button type="button" onClick={onClose}>
                fake-resource-close
            </button>
        </div>
    ),
}));

function occurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
    return {
        uid: "e1",
        version: 2,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: "Standup",
        location: "Room A",
        startDate: "2026-06-03T15:00:00.000Z",
        endDate: "2026-06-03T15:30:00.000Z",
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

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EventModal", () => {
    it("shows 'New event' with a blank form when occurrence is null", () => {
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={null}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );
        expect(screen.getByText("New event")).toBeInTheDocument();
        expect(screen.getByLabelText("Title")).toHaveValue("");
        expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    });

    it("shows 'Edit event' pre-filled from an existing occurrence", () => {
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence()}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );
        expect(screen.getByText("Edit event")).toBeInTheDocument();
        expect(screen.getByLabelText("Title")).toHaveValue("Standup");
        expect(screen.getByLabelText("Location")).toHaveValue("Room A");
        expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });

    it("shows a validation error and does not submit when the title is blank", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, occurrence()));
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={null}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("A title is required.")).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows a validation error and does not submit when the end time is not after the start time", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, occurrence()));
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence()}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        // Set End to exactly whatever Start currently shows (component pre-fills both from the same
        // occurrence's local-time-converted start/end) — same instant, so "after start" must fail.
        const startValue = screen.getByLabelText("Start").value;
        fireEvent.change(screen.getByLabelText("End"), { target: { value: startValue } });

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("The end time must be after the start time.")).toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("creates a new event with the entered fields", async () => {
        const created = occurrence({ uid: "e-new" });
        const fetchMock = mockFetch((url, init) =>
            url === "/api/mail/calendar-events" && init?.method === "POST" ? jsonResponse(200, created) : undefined,
        );
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={null}
                initialStart={new Date("2026-06-10T09:00:00.000Z")}
                initialEnd={new Date("2026-06-10T10:00:00.000Z")}
                onSaved={onSaved}
                onDeleted={vi.fn()}
            />,
        );

        await user.type(screen.getByLabelText("Title"), "Planning");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events", expect.objectContaining({ method: "POST" })));
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toEqual(
            expect.objectContaining({
                mailboxUid: "mb1",
                folderUid: "f1",
                title: "Planning",
                organizer: { address: "jane@example.com", type: "to" },
                allDay: false,
            }),
        );
        expect(onSaved).toHaveBeenCalled();
    });

    it("shows a generic error message when creating fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={null}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        await user.type(screen.getByLabelText("Title"), "Planning");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Could not save this event.")).toBeInTheDocument();
    });

    it("shows an API error message when creating fails", async () => {
        mockFetch(() => jsonResponse(500, { message: "create failed" }));
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={null}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        await user.type(screen.getByLabelText("Title"), "Planning");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("create failed")).toBeInTheDocument();
    });

    it("updates a non-recurring event via a plain PUT", async () => {
        const fetchMock = mockFetch((url, init) =>
            url === "/api/mail/calendar-events/e1" && init?.method === "PUT" ? jsonResponse(200, occurrence({ title: "Renamed" })) : undefined,
        );
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence()}
                onSaved={onSaved}
                onDeleted={vi.fn()}
            />,
        );

        await user.clear(screen.getByLabelText("Title"));
        await user.type(screen.getByLabelText("Title"), "Renamed");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/calendar-events/e1",
                expect.objectContaining({ method: "PUT" }),
            ),
        );
        expect(onSaved).toHaveBeenCalled();
        expect(screen.queryByText(/Apply changes to/)).not.toBeInTheDocument();
    });

    it("shows the edit-scope choice for a recurring occurrence, defaulting to 'this event only', and detaches it on save", async () => {
        const recurring = occurrence({
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] },
            recurrenceId: "2026-06-03T15:00:00.000Z",
            isRecurringOccurrence: true,
        });
        const fetchMock = mockFetch((url, init) => {
            if (url === "/api/mail/calendar-events/e1" && init?.method === "PUT") return jsonResponse(200, recurring);
            if (url === "/api/mail/calendar-events" && init?.method === "POST") return jsonResponse(200, occurrence({ uid: "e2" }));
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={recurring}
                onSaved={onSaved}
                onDeleted={vi.fn()}
            />,
        );

        expect(screen.getByRole("radio", { name: "This event only" })).toBeChecked();
        await user.click(screen.getByRole("button", { name: "Save" }));

        // detachOccurrence: adds an exception to the master (PUT), then creates a standalone event (POST).
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e1", expect.objectContaining({ method: "PUT" })));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events", expect.objectContaining({ method: "POST" })),
        );
        expect(onSaved).toHaveBeenCalled();
    });

    it("saves the entire series when 'The entire series' is selected", async () => {
        const recurring = occurrence({
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] },
            recurrenceId: "2026-06-03T15:00:00.000Z",
            isRecurringOccurrence: true,
        });
        const fetchMock = mockFetch((url, init) =>
            url === "/api/mail/calendar-events/e1" && init?.method === "PUT" ? jsonResponse(200, recurring) : undefined,
        );
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={recurring}
                onSaved={onSaved}
                onDeleted={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("radio", { name: "The entire series" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e1", expect.objectContaining({ method: "PUT" }));
        expect(onSaved).toHaveBeenCalled();
    });

    it("deletes a non-recurring event immediately (no confirmation sub-step)", async () => {
        const fetchMock = mockFetch(() => new Response(null, { status: 200 }));
        const onDeleted = vi.fn();
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence()}
                onSaved={vi.fn()}
                onDeleted={onDeleted}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e1?version=2", expect.objectContaining({ method: "DELETE" })),
        );
        expect(onDeleted).toHaveBeenCalled();
    });

    it("offers a this-event/series choice when deleting a recurring occurrence", async () => {
        const recurring = occurrence({
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] },
            recurrenceId: "2026-06-03T15:00:00.000Z",
            isRecurringOccurrence: true,
        });
        const fetchMock = mockFetch((url, init) =>
            url === "/api/mail/calendar-events/e1" && init?.method === "PUT" ? jsonResponse(200, recurring) : undefined,
        );
        const onDeleted = vi.fn();
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={recurring}
                onSaved={vi.fn()}
                onDeleted={onDeleted}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(screen.getByRole("button", { name: "Delete this event" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Delete this event" }));

        // deleteEventOccurrence: just an exception added to the master (PUT), no series-wide delete.
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e1", expect.objectContaining({ method: "PUT" })),
        );
        expect(onDeleted).toHaveBeenCalled();
    });

    it("deletes the entire series when 'Delete series' is chosen for a recurring occurrence", async () => {
        const recurring = occurrence({
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] },
            recurrenceId: "2026-06-03T15:00:00.000Z",
            isRecurringOccurrence: true,
        });
        const fetchMock = mockFetch((url, init) =>
            url === "/api/mail/calendar-events/e1?version=2" && init?.method === "DELETE" ? new Response(null, { status: 200 }) : undefined,
        );
        const onDeleted = vi.fn();
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={recurring}
                onSaved={vi.fn()}
                onDeleted={onDeleted}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getByRole("button", { name: "Delete series" }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e1?version=2", expect.objectContaining({ method: "DELETE" })),
        );
        expect(onDeleted).toHaveBeenCalled();
    });

    it("shows an error and stops saving-state when delete fails", async () => {
        mockFetch(() => jsonResponse(500, { message: "delete failed" }));
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence()}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Delete" }));

        expect(await screen.findByText("delete failed")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });

    it("shows a generic error message when delete fails with a non-API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence()}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Delete" }));

        expect(await screen.findByText("Could not delete this event.")).toBeInTheDocument();
    });

    it("switches Start/End to date-only inputs and clears the time-of-day when All day is toggled on", async () => {
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence()}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        expect(screen.getByLabelText("Start")).toHaveAttribute("type", "datetime-local");
        fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-06-04T09:00" } });
        expect(screen.getByLabelText("Start")).toHaveValue("2026-06-04T09:00");

        await user.click(screen.getByRole("checkbox", { name: "All day" }));
        expect(screen.getByLabelText("Start")).toHaveAttribute("type", "date");
        expect(screen.getByLabelText("End")).toHaveAttribute("type", "date");

        fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-06-10" } });
        expect(screen.getByLabelText("Start")).toHaveValue("2026-06-10");
        fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-06-11" } });
        expect(screen.getByLabelText("End")).toHaveValue("2026-06-11");
    });

    it("updates Location and Busy status", async () => {
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={occurrence()}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        await user.clear(screen.getByLabelText("Location"));
        await user.type(screen.getByLabelText("Location"), "Room B");
        expect(screen.getByLabelText("Location")).toHaveValue("Room B");

        await user.selectOptions(screen.getByLabelText("Busy status"), "free");
        expect(screen.getByLabelText("Busy status")).toHaveValue("free");
    });

    it("editing one attendee's role leaves the other attendee untouched", async () => {
        const twoAttendees = occurrence({
            attendees: [
                { address: "bob@example.com", role: "required", responseStatus: "needsAction", isOrganizer: false },
                { address: "amy@example.com", role: "required", responseStatus: "needsAction", isOrganizer: false },
            ],
        });
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={twoAttendees}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        await user.selectOptions(screen.getByLabelText("Attendee role 2"), "optional");

        expect(screen.getByLabelText("Attendee role 1")).toHaveValue("required");
        expect(screen.getByLabelText("Attendee role 2")).toHaveValue("optional");
        expect(screen.getByLabelText("Attendee email 1")).toHaveValue("bob@example.com");
    });

    it("switching the edit scope back to 'This event only' after picking 'The entire series'", async () => {
        const recurring = occurrence({
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] },
            recurrenceId: "2026-06-03T15:00:00.000Z",
            isRecurringOccurrence: true,
        });
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={recurring}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("radio", { name: "The entire series" }));
        await user.click(screen.getByRole("radio", { name: "This event only" }));

        expect(screen.getByRole("radio", { name: "This event only" })).toBeChecked();
    });

    it("adds, edits, and removes an attendee row", async () => {
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={null}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: "+ Add attendee" }));
        const emailInput = screen.getByLabelText("Attendee email 1");
        await user.type(emailInput, "bob@example.com");
        expect(emailInput).toHaveValue("bob@example.com");

        await user.selectOptions(screen.getByLabelText("Attendee role 1"), "optional");
        expect(screen.getByLabelText("Attendee role 1")).toHaveValue("optional");

        await user.click(screen.getByRole("button", { name: "Remove attendee 1" }));
        expect(screen.queryByLabelText("Attendee email 1")).not.toBeInTheDocument();
    });

    it("sends an explicit reminder value, and undefined when left blank", async () => {
        const fetchMock = mockFetch((url, init) =>
            url === "/api/mail/calendar-events" && init?.method === "POST" ? jsonResponse(200, occurrence()) : undefined,
        );
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={null}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        await user.type(screen.getByLabelText("Title"), "Planning");
        await user.type(screen.getByLabelText("Reminder (minutes before)"), "15");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.reminderMinutesBeforeStart).toBe(15);
    });

    it("shows no calendar selector when only one calendar is available (or `calendars` is omitted)", () => {
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                calendars={[{ uid: "f1", name: "Calendar" }]}
                organizerAddress="jane@example.com"
                occurrence={null}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );
        expect(screen.queryByLabelText("Calendar")).not.toBeInTheDocument();
    });

    it("shows no calendar selector when editing an existing occurrence, even with multiple calendars", () => {
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                calendars={[
                    { uid: "f1", name: "Work" },
                    { uid: "f2", name: "Personal" },
                ]}
                organizerAddress="jane@example.com"
                occurrence={occurrence()}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );
        expect(screen.queryByLabelText("Calendar")).not.toBeInTheDocument();
    });

    it("creates a new event in whichever calendar is chosen from the selector, defaulting to `folderUid`", async () => {
        const fetchMock = mockFetch((url, init) =>
            url === "/api/mail/calendar-events" && init?.method === "POST" ? jsonResponse(200, occurrence()) : undefined,
        );
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={vi.fn()}
                mailboxUid="mb1"
                folderUid="f1"
                calendars={[
                    { uid: "f1", name: "Work" },
                    { uid: "f2", name: "Personal" },
                ]}
                organizerAddress="jane@example.com"
                occurrence={null}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        expect(screen.getByLabelText("Calendar")).toHaveValue("f1");
        await user.selectOptions(screen.getByLabelText("Calendar"), "f2");
        await user.type(screen.getByLabelText("Title"), "Planning");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.folderUid).toBe("f2");
    });

    it("calls onClose when Cancel is clicked", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(
            <EventModal
                open
                onClose={onClose}
                mailboxUid="mb1"
                folderUid="f1"
                organizerAddress="jane@example.com"
                occurrence={null}
                onSaved={vi.fn()}
                onDeleted={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onClose).toHaveBeenCalled();
    });

    describe("respond", () => {
        it("shows a responseStatus badge for each attendee, reflecting needsAction/accepted/declined/tentative", () => {
            const withAttendees = occurrence({
                attendees: [
                    { address: "bob@example.com", role: "required", responseStatus: "accepted", isOrganizer: false },
                    { address: "amy@example.com", role: "required", responseStatus: "declined", isOrganizer: false },
                ],
            });
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={withAttendees}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );

            expect(screen.getByText("Accepted")).toBeInTheDocument();
            expect(screen.getByText("Declined")).toBeInTheDocument();
        });

        it("shows no response controls for a new (not-yet-created) event", () => {
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={null}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );
            expect(screen.queryByText("Your response")).not.toBeInTheDocument();
        });

        it("shows no response controls when the viewing mailbox is the organizer", () => {
            // `organizerAddress` ("jane@example.com") isn't listed among `attendees` at all here — the
            // default fixture's `attendees: []` — so there's nothing to respond as.
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={occurrence()}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );
            expect(screen.queryByText("Your response")).not.toBeInTheDocument();
        });

        it("shows no response controls when the viewing mailbox is listed as an attendee but flagged as the organizer", () => {
            const selfAsOrganizer = occurrence({
                attendees: [{ address: "jane@example.com", role: "required", responseStatus: "accepted", isOrganizer: true }],
            });
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={selfAsOrganizer}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );
            expect(screen.queryByText("Your response")).not.toBeInTheDocument();
        });

        function invitedOccurrence(overrides: Partial<CalendarOccurrence> = {}) {
            return occurrence({
                organizer: { address: "jane@example.com", type: "to" },
                attendees: [{ address: "bob@example.com", role: "required", responseStatus: "needsAction", isOrganizer: false }],
                ...overrides,
            });
        }

        it("shows Accept/Tentative/Decline when the viewing mailbox is an invited (non-organizer) attendee", () => {
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="bob@example.com"
                    occurrence={invitedOccurrence()}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );
            expect(screen.getByText("Your response")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Tentative" })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
        });

        it("accepting POSTs responseStatus:accepted and calls onSaved", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, { ...invitedOccurrence() }));
            const onSaved = vi.fn();
            const user = userEvent.setup();
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="bob@example.com"
                    occurrence={invitedOccurrence()}
                    onSaved={onSaved}
                    onDeleted={vi.fn()}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Accept" }));

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    "/api/mail/calendar-events/e1/respond",
                    expect.objectContaining({ method: "POST", body: JSON.stringify({ responseStatus: "accepted" }) }),
                ),
            );
            expect(onSaved).toHaveBeenCalled();
        });

        it("marking tentative POSTs responseStatus:tentative and calls onSaved", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, { ...invitedOccurrence() }));
            const onSaved = vi.fn();
            const user = userEvent.setup();
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="bob@example.com"
                    occurrence={invitedOccurrence()}
                    onSaved={onSaved}
                    onDeleted={vi.fn()}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Tentative" }));

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    "/api/mail/calendar-events/e1/respond",
                    expect.objectContaining({ method: "POST", body: JSON.stringify({ responseStatus: "tentative" }) }),
                ),
            );
            expect(onSaved).toHaveBeenCalled();
        });

        it("declining POSTs responseStatus:declined and calls onDeleted instead of onSaved", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, { uid: "e1" }));
            const onSaved = vi.fn();
            const onDeleted = vi.fn();
            const user = userEvent.setup();
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="bob@example.com"
                    occurrence={invitedOccurrence()}
                    onSaved={onSaved}
                    onDeleted={onDeleted}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Decline" }));

            await waitFor(() =>
                expect(fetchMock).toHaveBeenCalledWith(
                    "/api/mail/calendar-events/e1/respond",
                    expect.objectContaining({ method: "POST", body: JSON.stringify({ responseStatus: "declined" }) }),
                ),
            );
            expect(onDeleted).toHaveBeenCalled();
            expect(onSaved).not.toHaveBeenCalled();
        });

        it("shows an API error message and re-enables the response buttons when responding fails", async () => {
            mockFetch(() => jsonResponse(500, { message: "boom" }));
            const user = userEvent.setup();
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="bob@example.com"
                    occurrence={invitedOccurrence()}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Accept" }));

            expect(await screen.findByText("boom")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Accept" })).not.toBeDisabled();
        });

        it("shows a generic error message when responding fails with a non-API error", async () => {
            mockFetch(() => {
                throw new TypeError("network down");
            });
            const user = userEvent.setup();
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="bob@example.com"
                    occurrence={invitedOccurrence()}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );

            await user.click(screen.getByRole("button", { name: "Decline" }));

            expect(await screen.findByText("Could not send your response.")).toBeInTheDocument();
        });
    });

    describe("automatic reply", () => {
        it("hides the message textarea until the toggle is checked", () => {
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={null}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );
            expect(screen.queryByLabelText("Automatic reply message")).not.toBeInTheDocument();
        });

        it("shows the message textarea once the toggle is checked, and hides it again when unchecked", async () => {
            const user = userEvent.setup();
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={null}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );

            const toggle = screen.getByRole("checkbox", { name: "Send an automatic reply while this event is happening" });
            await user.click(toggle);
            expect(screen.getByLabelText("Automatic reply message")).toBeInTheDocument();

            await user.click(toggle);
            expect(screen.queryByLabelText("Automatic reply message")).not.toBeInTheDocument();
        });

        it("pre-fills the toggle/message from an existing occurrence", () => {
            const withAutoReply = occurrence({ autoReplyEnabled: true, autoReplyMessage: "On vacation" });
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={withAutoReply}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );

            expect(screen.getByRole("checkbox", { name: "Send an automatic reply while this event is happening" })).toBeChecked();
            expect(screen.getByLabelText("Automatic reply message")).toHaveValue("On vacation");
        });

        it("sends autoReplyEnabled/autoReplyMessage when the toggle is on", async () => {
            const fetchMock = mockFetch((url, init) =>
                url === "/api/mail/calendar-events" && init?.method === "POST" ? jsonResponse(200, occurrence()) : undefined,
            );
            const user = userEvent.setup();
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={null}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );

            await user.type(screen.getByLabelText("Title"), "Vacation");
            await user.click(screen.getByRole("checkbox", { name: "Send an automatic reply while this event is happening" }));
            await user.type(screen.getByLabelText("Automatic reply message"), "On vacation");
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(fetchMock).toHaveBeenCalled());
            const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
            expect(body.autoReplyEnabled).toBe(true);
            expect(body.autoReplyMessage).toBe("On vacation");
        });
    });

    describe("resource picker", () => {
        it("is closed until '+ Add room/equipment' is clicked", async () => {
            const user = userEvent.setup();
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={null}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );

            expect(screen.queryByText("fake-resource")).not.toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "+ Add room/equipment" }));
            expect(screen.getByText("fake-resource")).toBeInTheDocument();
        });

        it("closes via the picker's own onClose", async () => {
            const user = userEvent.setup();
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={null}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );

            await user.click(screen.getByRole("button", { name: "+ Add room/equipment" }));
            await user.click(screen.getByText("fake-resource-close"));
            expect(screen.queryByText("fake-resource")).not.toBeInTheDocument();
        });

        it("selecting a resource adds it as a 'resource' attendee and closes the picker", async () => {
            const user = userEvent.setup();
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={null}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );

            await user.click(screen.getByRole("button", { name: "+ Add room/equipment" }));
            await user.click(screen.getByText("fake-resource"));

            expect(screen.queryByText("fake-resource")).not.toBeInTheDocument();
            expect(screen.getByLabelText("Attendee email 1")).toHaveValue("room-a@example.com");
            expect(screen.getByLabelText("Attendee role 1")).toHaveValue("resource");
        });

        it("passes the current attendees' addresses (lowercased) as excludeAddresses", async () => {
            const withAttendee = occurrence({
                attendees: [{ address: "Bob@Example.com", role: "required", responseStatus: "needsAction", isOrganizer: false }],
            });
            const user = userEvent.setup();
            render(
                <EventModal
                    open
                    onClose={vi.fn()}
                    mailboxUid="mb1"
                    folderUid="f1"
                    organizerAddress="jane@example.com"
                    occurrence={withAttendee}
                    onSaved={vi.fn()}
                    onDeleted={vi.fn()}
                />,
            );

            await user.click(screen.getByRole("button", { name: "+ Add room/equipment" }));
            expect(screen.getByTestId("exclude-addresses")).toHaveTextContent("bob@example.com");
        });
    });
});
