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
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";

// Round-3 review fixes: occurrence vs. series saves, organizer preservation, invited (read-only) events,
// explicit nulls for cleared fields, and date-only all-day events.

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
        organizer: { address: "jane@example.com", displayName: "Jane", type: "to" },
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

function recurring(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
    return occurrence({
        recurrenceRule: { freq: "weekly", interval: 1, byDay: ["WE"], exceptions: [] },
        recurrenceId: "2026-06-03T15:00:00.000Z",
        isRecurringOccurrence: true,
        ...overrides,
    });
}

function renderModal(occ: CalendarOccurrence | null, props: Partial<React.ComponentProps<typeof EventModal>> = {}) {
    const onSaved = vi.fn();
    render(
        <EventModal
            open
            onClose={vi.fn()}
            mailboxUid="mb1"
            folderUid="f1"
            organizerAddress="jane@example.com"
            occurrence={occ}
            onSaved={onSaved}
            onDeleted={vi.fn()}
            {...props}
        />,
    );
    return { onSaved };
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, method: string) {
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method);
    return JSON.parse((call![1] as RequestInit).body as string);
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EventModal (round-3 fixes)", () => {
    describe("this event only", () => {
        it("hides the Repeats editor and detaches without the series rule, keeping the event's organizer", async () => {
            const fetchMock = mockFetch((url, init) => {
                if (url === "/api/mail/calendar-events" && init?.method === "POST") return jsonResponse(200, occurrence({ uid: "e2" }));
                return jsonResponse(200, recurring());
            });
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring());

            expect(screen.queryByRole("checkbox", { name: "Repeats" })).not.toBeInTheDocument();
            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            expect(screen.getByRole("checkbox", { name: "Repeats" })).toBeChecked();
            await user.click(screen.getByRole("radio", { name: "This event only" }));

            await user.clear(screen.getByLabelText("Location"));
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "POST");
            expect(body.recurrenceRule).toBeUndefined();
            expect(body.organizer).toEqual({ address: "jane@example.com", displayName: "Jane", type: "to" });
            // A create omits a cleared field rather than sending null.
            expect("location" in body).toBe(false);
        });
    });

    describe("the entire series", () => {
        it("doesn't send start/end (or fetch the master) when the times weren't changed", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, recurring()));
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring());

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const body = bodyOf(fetchMock, "PUT");
            expect(body.startDate).toBeUndefined();
            expect(body.endDate).toBeUndefined();
            expect(body.organizer).toBeUndefined();
            expect(body.recurrenceRule).toEqual({ freq: "weekly", interval: 1, byDay: ["WE"], exceptions: [] });
        });

        it("applies only the time-of-day change and new duration to the master's own start", async () => {
            const master = recurring({ startDate: "2026-05-06T15:00:00.000Z", endDate: "2026-05-06T15:30:00.000Z", isRecurringOccurrence: false });
            const fetchMock = mockFetch((url, init) => (init?.method === "PUT" ? jsonResponse(200, master) : jsonResponse(200, master)));
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring());

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-06-03T16:00" } });
            fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-06-03T17:00" } });
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e1", expect.not.objectContaining({ method: expect.anything() }));
            const body = bodyOf(fetchMock, "PUT");
            expect(body.startDate).toBe("2026-05-06T16:00:00.000Z");
            expect(body.endDate).toBe("2026-05-06T17:00:00.000Z");
        });

        it("turning a timed series all-day keeps the master's first date", async () => {
            const master = recurring({ startDate: "2026-05-06T15:00:00.000Z", endDate: "2026-05-06T15:30:00.000Z" });
            const fetchMock = mockFetch(() => jsonResponse(200, master));
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring());

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "PUT");
            expect(body.allDay).toBe(true);
            expect(body.startDate).toBe("2026-05-06T00:00:00.000Z");
            expect(body.endDate).toBe("2026-05-07T00:00:00.000Z");
        });

        it("keeps an all-day master's date when a series stays all-day but gets longer", async () => {
            const allDayOcc = recurring({ allDay: true, startDate: "2026-06-03T00:00:00.000Z", endDate: "2026-06-04T00:00:00.000Z" });
            const master = recurring({ allDay: true, startDate: "2026-05-06T00:00:00.000Z", endDate: "2026-05-07T00:00:00.000Z" });
            const fetchMock = mockFetch(() => jsonResponse(200, master));
            const user = userEvent.setup();
            const { onSaved } = renderModal(allDayOcc);

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-06-04" } });
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "PUT");
            expect(body.startDate).toBe("2026-05-06T00:00:00.000Z");
            expect(body.endDate).toBe("2026-05-08T00:00:00.000Z");
        });

        it("turning an all-day series timed uses the master's date at the new time", async () => {
            const allDayOcc = recurring({ allDay: true, startDate: "2026-06-03T00:00:00.000Z", endDate: "2026-06-04T00:00:00.000Z" });
            const master = recurring({ allDay: true, startDate: "2026-05-06T00:00:00.000Z", endDate: "2026-05-07T00:00:00.000Z" });
            const fetchMock = mockFetch(() => jsonResponse(200, master));
            const user = userEvent.setup();
            const { onSaved } = renderModal(allDayOcc);

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-06-03T09:00" } });
            fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-06-03T10:00" } });
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "PUT");
            expect(body.startDate).toBe("2026-05-06T09:00:00.000Z");
            expect(body.endDate).toBe("2026-05-06T10:00:00.000Z");
        });
    });

    it("sends null for cleared location/reminder/recurrence/auto-reply message when updating in place", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, occurrence()));
        const user = userEvent.setup();
        const { onSaved } = renderModal(
            occurrence({
                reminderMinutesBeforeStart: 10,
                recurrenceRule: { freq: "daily", interval: 1, exceptions: [] },
                autoReplyEnabled: true,
                autoReplyMessage: "Away",
            }),
        );

        await user.clear(screen.getByLabelText("Location"));
        await user.clear(screen.getByLabelText("Reminder (minutes before)"));
        await user.click(screen.getByRole("checkbox", { name: "Repeats" }));
        await user.click(screen.getByRole("checkbox", { name: "Send an automatic reply while this event is happening" }));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const body = bodyOf(fetchMock, "PUT");
        expect(body.location).toBeNull();
        expect(body.reminderMinutesBeforeStart).toBeNull();
        expect(body.recurrenceRule).toBeNull();
        expect(body.autoReplyEnabled).toBe(false);
        expect(body.autoReplyMessage).toBeNull();
        expect(body.organizer).toBeUndefined();
    });

    describe("invited events", () => {
        const invited = () =>
            occurrence({ attendees: [{ address: "bob@example.com", role: "required", responseStatus: "needsAction", isOrganizer: false }] });

        it("is read-only apart from the RSVP controls", () => {
            renderModal(invited(), { organizerAddress: "bob@example.com" });

            expect(screen.getByText(/Only the organizer can change its details/)).toBeInTheDocument();
            expect(screen.getByLabelText("Title")).toBeDisabled();
            expect(screen.getByRole("button", { name: "+ Add attendee" })).toBeDisabled();
            expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Accept" })).not.toBeDisabled();
        });

        it("hides the edit-scope choice for an invited recurring occurrence", () => {
            renderModal(recurring({ organizer: { address: "jane@example.com", type: "to" } }), { organizerAddress: "BOB@example.com" });
            expect(screen.queryByText("Apply changes to")).not.toBeInTheDocument();
        });

        it("isn't read-only when the viewing mailbox is flagged as an organizer attendee", () => {
            renderModal(
                occurrence({ attendees: [{ address: "bob@example.com", role: "required", responseStatus: "accepted", isOrganizer: true }] }),
                { organizerAddress: "bob@example.com" },
            );
            expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
            expect(screen.getByLabelText("Title")).not.toBeDisabled();
        });
    });

    describe("all-day events", () => {
        it("shows a stored all-day event's inclusive last day", () => {
            renderModal(occurrence({ allDay: true, startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-12T00:00:00.000Z" }));
            expect(screen.getByLabelText("Start")).toHaveValue("2026-06-10");
            expect(screen.getByLabelText("End")).toHaveValue("2026-06-11");
        });

        it("never shows an end date before the start for a zero-length all-day event", () => {
            renderModal(occurrence({ allDay: true, startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-10T00:00:00.000Z" }));
            expect(screen.getByLabelText("End")).toHaveValue("2026-06-10");
        });

        it("saves a one-day all-day event as UTC midnight with an exclusive end", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, occurrence()));
            const user = userEvent.setup();
            const { onSaved } = renderModal(null);

            await user.type(screen.getByLabelText("Title"), "Holiday");
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-06-10" } });
            fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-06-10" } });
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "POST");
            expect(body.startDate).toBe("2026-06-10T00:00:00.000Z");
            expect(body.endDate).toBe("2026-06-11T00:00:00.000Z");
            expect(body.organizer).toEqual({ address: "jane@example.com", type: "to" });
        });

        it("rejects an all-day end date before its start date", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, occurrence()));
            const user = userEvent.setup();
            renderModal(null);

            await user.type(screen.getByLabelText("Title"), "Holiday");
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-06-10" } });
            fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-06-09" } });
            await user.click(screen.getByRole("button", { name: "Save" }));

            expect(await screen.findByText("The end date can't be before the start date.")).toBeInTheDocument();
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });
});
