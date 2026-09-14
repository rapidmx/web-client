// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import EventModal from "../../../apps/shared/components/calendar/EventModal.js";
import { CalendarOccurrence, expandOccurrences } from "@rapidmx/react-shared/calendar/recurrence.js";
import { CalendarEvent } from "@rapidmx/react-shared/calendar/calendarApi.js";

// Round-4 review fixes: all-day series west of UTC, series time changes on the event's own wall clock,
// unchanged-time detection, organizer aliases, and the detached-occurrence sync warning.

function occurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
    return {
        uid: "e1",
        version: 2,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: "Standup",
        startDate: "2026-06-03T15:00:00.000Z",
        endDate: "2026-06-03T15:30:00.000Z",
        allDay: false,
        timezone: "America/New_York",
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

/** The master on GET, an empty folder listing (no detached occurrences), and the PUT echoed back. */
function mockSeries(master: CalendarOccurrence) {
    return mockFetch((url) => (url.startsWith("/api/mail/calendar-events?") ? jsonResponse(200, []) : jsonResponse(200, master)));
}

const originalTz = process.env.TZ;

afterEach(() => {
    process.env.TZ = originalTz;
    vi.unstubAllGlobals();
});

describe("EventModal (round-4 fixes)", () => {
    describe("all-day series west of UTC", () => {
        beforeEach(() => {
            process.env.TZ = "America/New_York";
        });

        it("stores a weekly all-day series' end date as the end of that UTC day, and every occurrence lands on its own date", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, occurrence()));
            const user = userEvent.setup();
            const { onSaved } = renderModal(null);

            await user.type(screen.getByLabelText("Title"), "Gym");
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-09-14" } });
            fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-09-14" } });
            await user.click(screen.getByRole("checkbox", { name: "Repeats" }));
            await user.click(screen.getByRole("button", { name: "Tue" }));
            await user.click(screen.getByRole("radio", { name: "On" }));
            fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-09-28" } });
            expect(screen.getByLabelText("End date")).toHaveValue("2026-09-28");
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "POST");
            expect(body.startDate).toBe("2026-09-14T00:00:00.000Z");
            expect(body.recurrenceRule.until).toBe("2026-09-28T23:59:59.999Z");

            const expanded = expandOccurrences(
                { ...occurrence(), ...body, uid: "e9" } as CalendarEvent,
                new Date("2026-09-01T00:00:00.000Z"),
                new Date("2026-10-31T00:00:00.000Z"),
            );
            // Mondays and Tuesdays - never the day before (a local-midnight read of a UTC date), and no Tuesday
            // Sep 29 after the chosen end date (the local end of Sep 28 is already Sep 29 in UTC).
            expect(expanded.map((o) => o.startDate.slice(0, 10))).toEqual(["2026-09-14", "2026-09-15", "2026-09-21", "2026-09-22", "2026-09-28"]);
        });

        it("keeps the chosen end date when All day is turned off again, re-storing it as the end of the local day", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, occurrence()));
            const user = userEvent.setup();
            const { onSaved } = renderModal(null);

            await user.type(screen.getByLabelText("Title"), "Gym");
            await user.click(screen.getByRole("checkbox", { name: "Repeats" }));
            await user.click(screen.getByRole("radio", { name: "On" }));
            fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-09-28" } });
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            expect(screen.getByLabelText("End date")).toHaveValue("2026-09-28");
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            expect(screen.getByLabelText("End date")).toHaveValue("2026-09-28");
            // Toggling without a recurrence end date leaves the rule alone.
            await user.click(screen.getByRole("radio", { name: "Never" }));
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            await user.click(screen.getByRole("radio", { name: "On" }));
            fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-09-28" } });
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(bodyOf(fetchMock, "POST").recurrenceRule.until).toBe(new Date(2026, 8, 28, 23, 59, 59, 999).toISOString());
        });

        it("turning a timed series all-day keeps the master's date on the event's own wall clock", async () => {
            process.env.TZ = "UTC";
            // 22:00 on May 5 in New York is already May 6 in UTC.
            const master = recurring({ startDate: "2026-05-06T02:00:00.000Z", endDate: "2026-05-06T02:30:00.000Z" });
            const fetchMock = mockSeries(master);
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring({ startDate: "2026-06-03T02:00:00.000Z", endDate: "2026-06-03T02:30:00.000Z" }));

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(bodyOf(fetchMock, "PUT").startDate).toBe("2026-05-05T00:00:00.000Z");
        });

        it("turning an all-day series timed puts the master's date at the chosen New York time", async () => {
            const allDayOcc = recurring({ allDay: true, startDate: "2026-06-03T00:00:00.000Z", endDate: "2026-06-04T00:00:00.000Z" });
            const master = recurring({ allDay: true, startDate: "2026-05-06T00:00:00.000Z", endDate: "2026-05-07T00:00:00.000Z" });
            const fetchMock = mockSeries(master);
            const user = userEvent.setup();
            const { onSaved } = renderModal(allDayOcc);

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-06-03T09:00" } });
            fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-06-03T10:00" } });
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "PUT");
            expect(body.startDate).toBe("2026-05-06T13:00:00.000Z");
            expect(body.endDate).toBe("2026-05-06T14:00:00.000Z");
        });
    });

    describe("series time changes", () => {
        it("moves the series by the smallest change on the event's wall clock - 19:00 to 21:00 New York is two hours later, even where that crosses UTC midnight", async () => {
            process.env.TZ = "UTC";
            // 19:00 EDT = 23:00Z; 21:00 EDT = 01:00Z the next day.
            const master = recurring({ startDate: "2026-05-06T23:00:00.000Z", endDate: "2026-05-06T23:30:00.000Z" });
            const fetchMock = mockSeries(master);
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring({ startDate: "2026-06-03T23:00:00.000Z", endDate: "2026-06-03T23:30:00.000Z" }));

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-06-04T01:00" } });
            fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-06-04T01:30" } });
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "PUT");
            expect(body.startDate).toBe("2026-05-07T01:00:00.000Z");
            expect(body.endDate).toBe("2026-05-07T01:30:00.000Z");
        });

        it("moving 01:00 back to 23:00 is two hours earlier, into the previous day", async () => {
            process.env.TZ = "America/New_York";
            const master = recurring({ startDate: "2026-05-06T05:00:00.000Z", endDate: "2026-05-06T05:30:00.000Z" });
            const fetchMock = mockSeries(master);
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring({ startDate: "2026-06-03T05:00:00.000Z", endDate: "2026-06-03T05:30:00.000Z" }));

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-06-02T23:00" } });
            fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-06-02T23:30" } });
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(bodyOf(fetchMock, "PUT").startDate).toBe("2026-05-06T03:00:00.000Z");
        });

        it("keeps the chosen local time for a master on the other side of a DST change", async () => {
            process.env.TZ = "America/New_York";
            // Master in January (EST, UTC-5) at 09:00; the edited occurrence in June (EDT, UTC-4) at 09:00.
            const master = recurring({ startDate: "2026-01-07T14:00:00.000Z", endDate: "2026-01-07T14:30:00.000Z" });
            const fetchMock = mockSeries(master);
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring({ startDate: "2026-06-03T13:00:00.000Z", endDate: "2026-06-03T13:30:00.000Z" }));

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-06-03T10:00" } });
            fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-06-03T11:00" } });
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "PUT");
            expect(body.startDate).toBe("2026-01-07T15:00:00.000Z");
            expect(body.endDate).toBe("2026-01-07T16:00:00.000Z");
        });

        it("treats stored dates without milliseconds as unchanged, sending no dates and never fetching the master", async () => {
            process.env.TZ = "UTC";
            const fetchMock = mockFetch(() => jsonResponse(200, recurring()));
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring({ startDate: "2026-06-03T15:00:00Z", endDate: "2026-06-03T15:30:00Z" }));

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const body = bodyOf(fetchMock, "PUT");
            expect(body.startDate).toBeUndefined();
            expect(body.endDate).toBeUndefined();
        });

        it("warns (and leaves closing to the user) when a detached occurrence couldn't be moved with the series", async () => {
            process.env.TZ = "UTC";
            const master = recurring({ startDate: "2026-05-06T15:00:00.000Z", endDate: "2026-05-06T15:30:00.000Z" });
            const detached = occurrence({ uid: "e2", icalUid: "abc", recurrenceId: "2026-05-13T15:00:00.000Z" });
            mockFetch((url, init) => {
                if (url.startsWith("/api/mail/calendar-events?")) return jsonResponse(200, [detached]);
                if (url === "/api/mail/calendar-events/e2" && init?.method === "PUT") return jsonResponse(409, { message: "conflict" });
                return jsonResponse(200, master);
            });
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring());

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-06-03T16:00" } });
            fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-06-03T16:30" } });
            await user.click(screen.getByRole("button", { name: "Save" }));

            expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t be moved with it/);
            expect(onSaved).not.toHaveBeenCalled();
            await user.click(screen.getByRole("button", { name: "OK" }));
            expect(onSaved).toHaveBeenCalledTimes(1);
        });
    });

    describe("organizer aliases", () => {
        it("isn't read-only when the organizer is one of the mailbox's aliases (from mailboxOptions), in any case", () => {
            renderModal(occurrence({ organizer: { address: "J.Doe@Example.com", type: "to" } }), {
                mailboxOptions: [
                    { mailbox: { uid: "mb-other", primarySmtpAddress: "x@example.com", aliasAddresses: ["j.doe@example.com"] } as never, calendars: [] },
                    { mailbox: { uid: "mb1", primarySmtpAddress: "jane@example.com", aliasAddresses: ["j.doe@example.com"] } as never, calendars: [] },
                ],
            });
            expect(screen.queryByText(/Only the organizer can change its details/)).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
        });

        it("offers the RSVP controls when the invitation names an alias passed as organizerAliases", () => {
            renderModal(
                occurrence({
                    organizer: { address: "boss@example.com", type: "to" },
                    attendees: [{ address: "JANE.ALIAS@example.com", role: "required", responseStatus: "needsAction", isOrganizer: false }],
                }),
                { organizerAliases: ["jane.alias@example.com"] },
            );
            expect(screen.getByText(/Only the organizer can change its details/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
        });

        it("still treats an unrelated organizer as an invitation when the mailbox isn't among mailboxOptions", () => {
            renderModal(occurrence({ organizer: { address: "boss@example.com", type: "to" } }), {
                mailboxOptions: [{ mailbox: { uid: "mb-other", primarySmtpAddress: "x@example.com" } as never, calendars: [] }],
            });
            expect(screen.getByText(/Only the organizer can change its details/)).toBeInTheDocument();
        });
    });
});
