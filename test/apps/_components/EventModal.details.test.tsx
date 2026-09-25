// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import EventModal from "../../../apps/shared/components/calendar/EventModal.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import { Attendee } from "@rapidmx/react-shared/calendar/calendarApi.js";

// What an existing event shows first: read-only details, with Modify (organizer only) and Delete, and the invited reader's answer.

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

const guest = (address: string, overrides: Partial<Attendee> = {}): Attendee => ({
    address,
    role: "required",
    responseStatus: "needsAction",
    isOrganizer: false,
    ...overrides,
});

function renderDetails(occ: CalendarOccurrence, props: Partial<React.ComponentProps<typeof EventModal>> = {}) {
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
            {...handlers}
            {...props}
        />,
    );
    return handlers;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EventModal details", () => {
    it("shows the title, when, location, organizer, calendar, busy status and reminder", () => {
        renderDetails(occurrence({ reminderMinutesBeforeStart: 15, organizer: { address: "jane@example.com", displayName: "Jane Doe", type: "to" } }));

        const dialog = screen.getByRole("dialog", { name: "Event details" });
        expect(within(dialog).getByRole("heading", { name: "Standup" })).toBeInTheDocument();
        expect(dialog).toHaveTextContent(/Wednesday, June 3(, 2026)?\s+3:00pm – 3:30pm/);
        expect(within(dialog).getByText("Room A")).toBeInTheDocument();
        expect(within(dialog).getByText("Jane Doe")).toBeInTheDocument();
        expect(within(dialog).getByText(/jane@example.com · Organizer/)).toBeInTheDocument();
        expect(within(dialog).getByText("Work")).toBeInTheDocument();
        expect(within(dialog).getByText("Busy")).toBeInTheDocument();
        expect(within(dialog).getByText("Notify 15 minutes before")).toBeInTheDocument();
        // No reader-zone note when the event is in the reader's own zone; no repeat line for a single event.
        expect(dialog).not.toHaveTextContent("Event time zone");
        expect(dialog).not.toHaveTextContent("Repeats");
    });

    it("names an untitled event, an organizer with no display name and an event with no location or calendar name", () => {
        renderDetails(occurrence({ title: "", location: undefined }), { calendars: undefined });
        expect(screen.getByRole("heading", { name: "(no title)" })).toBeInTheDocument();
        expect(screen.getByText("jane@example.com")).toBeInTheDocument();
        expect(screen.queryByText("Room A")).not.toBeInTheDocument();
        expect(screen.getByText("No notification")).toBeInTheDocument();
    });

    it("says when a recurring event repeats, and where the event's own time zone differs from the reader's", () => {
        renderDetails(
            occurrence({
                timezone: "America/New_York",
                recurrenceRule: { freq: "weekly", interval: 1, byDay: ["WE"], exceptions: [] },
                isRecurringOccurrence: true,
            }),
        );
        expect(screen.getByText(/^Repeats every week on Wednesday/)).toBeInTheDocument();
        expect(screen.getByText("Event time zone: America/New York")).toBeInTheDocument();
    });

    it("shows an all-day event's days without a time, and no time zone note", () => {
        renderDetails(occurrence({ allDay: true, timezone: "America/New_York", startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-12T00:00:00.000Z" }));
        const dialog = screen.getByRole("dialog");
        expect(dialog).toHaveTextContent(/Wednesday, June 10(, 2026)? – Thursday, June 11(, 2026)?/);
        expect(dialog).not.toHaveTextContent(/\d(am|pm)/);
        expect(dialog).not.toHaveTextContent("Event time zone");
    });

    it("lists the guests with each one's answer, and their role when it isn't the usual one", () => {
        renderDetails(
            occurrence({
                attendees: [
                    guest("jane@example.com", { isOrganizer: true, responseStatus: "accepted" }),
                    guest("bob@example.com", { displayName: "Bob", responseStatus: "accepted" }),
                    guest("amy@example.com", { responseStatus: "declined", role: "optional" }),
                    guest("cat@example.com", { responseStatus: "tentative" }),
                    guest("room-a@example.com", { displayName: "Room A", role: "resource" }),
                ],
            }),
        );

        // The organizer is listed once, as the organizer; the four guests below.
        expect(screen.getByText("4 guests")).toBeInTheDocument();
        const list = within(screen.getByText("4 guests").parentElement!).getByRole("list");
        const rows = within(list).getAllByRole("listitem");
        expect(rows.map((row) => row.textContent)).toEqual([
            "BobAccepted",
            "amy@example.com (Optional)Declined",
            "cat@example.comTentative",
            "Room A (Room/equipment)Awaiting response",
        ]);
    });

    it("says '1 guest' for a single guest", () => {
        renderDetails(occurrence({ attendees: [guest("bob@example.com")] }));
        expect(screen.getByText("1 guest")).toBeInTheDocument();
    });

    it("mentions an event's automatic reply", () => {
        renderDetails(occurrence({ autoReplyEnabled: true, autoReplyMessage: "Away" }));
        expect(screen.getByText("Sends an automatic reply while this event is happening")).toBeInTheDocument();
    });

    it("offers Modify and Delete (and Close) to the organizer, and no Your response block", () => {
        const { onClose } = renderDetails(occurrence());
        expect(screen.getByRole("button", { name: "Modify" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
        expect(screen.queryByText("Your response")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole("button", { name: "Close details" }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("offers a personal event with no other organizer's attendee entry the same Modify", () => {
        renderDetails(occurrence({ attendees: [guest("jane@example.com", { isOrganizer: true, responseStatus: "accepted" })] }));
        expect(screen.getByRole("button", { name: "Modify" })).toBeInTheDocument();
    });

    describe("an invitation", () => {
        const invited = (response: Attendee["responseStatus"] = "needsAction") =>
            occurrence({ organizer: { address: "boss@example.com", type: "to" }, attendees: [guest("bob@example.com", { responseStatus: response })] });

        it("has Accept, Tentative and Decline, marks the one already given, and has no Modify", () => {
            renderDetails(invited("tentative"), { organizerAddress: "bob@example.com" });

            // Guests may invite others unless the organizer turned that off, so the reader is told they can ask.
            expect(screen.getByText("You were invited to this event. Only the organizer can change its details, but you can ask them to.")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Modify" })).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Tentative" })).toHaveAttribute("aria-pressed", "true");
            expect(screen.getByRole("button", { name: "Accept" })).toHaveAttribute("aria-pressed", "false");
            expect(screen.getByRole("button", { name: "Decline" })).toHaveAttribute("aria-pressed", "false");
        });

        it("marks nothing while the invitation is unanswered, and disables the answers while one is being sent", async () => {
            let finish: (res: Response) => void = () => undefined;
            mockFetch(() => new Promise<Response>((resolve) => (finish = resolve)));
            const user = userEvent.setup();
            const { onSaved } = renderDetails(invited(), { organizerAddress: "bob@example.com" });
            expect(screen.getByRole("button", { name: "Accept" })).toHaveAttribute("aria-pressed", "false");

            await user.click(screen.getByRole("button", { name: "Accept" }));
            expect(screen.getByRole("button", { name: "Decline" })).toBeDisabled();
            expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
            finish(jsonResponse(200, invited("accepted")));
            await waitFor(() => expect(onSaved).toHaveBeenCalled());
        });

        it("removes the event from the reader's calendar with Delete, as before", async () => {
            const fetchMock = mockFetch(() => new Response(null, { status: 200 }));
            const user = userEvent.setup();
            const { onDeleted } = renderDetails(invited(), { organizerAddress: "bob@example.com" });

            await user.click(screen.getByRole("button", { name: "Delete" }));
            await waitFor(() => expect(onDeleted).toHaveBeenCalled());
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e1?version=2", expect.objectContaining({ method: "DELETE" }));
        });
    });

    describe("Modify", () => {
        it("switches to the form, and closing the form returns to the details with the edits discarded", async () => {
            const user = userEvent.setup();
            const { onClose } = renderDetails(occurrence());

            await user.click(screen.getByRole("button", { name: "Modify" }));
            expect(screen.getByRole("dialog", { name: "Edit event" })).toBeInTheDocument();
            expect(screen.getByLabelText("Title")).toHaveFocus();
            await user.type(screen.getByLabelText("Title"), " (edited)");

            await user.click(screen.getByRole("button", { name: "Close" }));
            expect(screen.getByRole("dialog", { name: "Event details" })).toBeInTheDocument();
            expect(screen.getByRole("heading", { name: "Standup" })).toBeInTheDocument();
            expect(onClose).not.toHaveBeenCalled();

            // Modify again: the form starts over from the event.
            await user.click(screen.getByRole("button", { name: "Modify" }));
            expect(screen.getByLabelText("Title")).toHaveValue("Standup");
        });

        it("goes back to the details on Escape, and closes on a second Escape", async () => {
            const user = userEvent.setup();
            const { onClose } = renderDetails(occurrence());
            await user.click(screen.getByRole("button", { name: "Modify" }));

            await user.keyboard("{Escape}");
            expect(screen.getByRole("dialog", { name: "Event details" })).toBeInTheDocument();
            expect(onClose).not.toHaveBeenCalled();
            await user.keyboard("{Escape}");
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it("does not throw the form's edits away on a press on the backdrop, but a press on the details' backdrop closes", async () => {
            const user = userEvent.setup();
            const { onClose } = renderDetails(occurrence());
            await user.click(screen.getByRole("button", { name: "Modify" }));

            fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
            expect(screen.getByRole("dialog", { name: "Edit event" })).toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Close" }));
            fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it("still closes on a press on the backdrop of a form with nothing in it (a blank title, location and guests)", async () => {
            const user = userEvent.setup();
            renderDetails(occurrence({ title: "", location: undefined }));
            await user.click(screen.getByRole("button", { name: "Modify" }));

            fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
            // Back to the details, as Close would.
            expect(screen.getByRole("dialog", { name: "Event details" })).toBeInTheDocument();
        });
    });
});
