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
import { CalendarOccurrence } from "../../../lib/calendar/recurrence.js";
import { clickModify, setWhen } from "./eventModalHelpers.js";

// Round-3 review (W3) fixes in the event dialog.

function occurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
    return {
        uid: "e1",
        version: 2,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: "Standup",
        startDate: "2026-06-02T15:00:00.000Z",
        endDate: "2026-06-02T15:30:00.000Z",
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
        recurrenceRule: { freq: "weekly", interval: 1, byDay: ["TU"], exceptions: [] },
        isRecurringOccurrence: true,
        ...overrides,
    });
}

function renderModal(occ: CalendarOccurrence | null, props: Partial<React.ComponentProps<typeof EventModal>> = {}, view = false) {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    render(
        <EventModal
            open
            onClose={onClose}
            mailboxUid="mb1"
            folderUid="f1"
            organizerAddress="jane@example.com"
            occurrence={occ}
            onSaved={onSaved}
            onDeleted={onDeleted}
            {...props}
        />,
    );
    if (occ && !view) {
        clickModify();
    }
    return { onSaved, onClose, onDeleted };
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, method: string) {
    const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method);
    return JSON.parse((call![1] as RequestInit).body as string);
}

function mockSeries(master: CalendarOccurrence) {
    return mockFetch((url) => (url.startsWith("/api/mail/calendar-events?") ? jsonResponse(200, []) : jsonResponse(200, master)));
}

const originalTz = process.env.TZ;

beforeEach(() => {
    process.env.TZ = "UTC";
});
afterEach(() => {
    process.env.TZ = originalTz;
    vi.unstubAllGlobals();
});

describe("EventModal (round-3 review)", () => {
    describe("W3-01: editing the entire series with a changed date", () => {
        it("moves the series' own start by the days the occurrence moved, and a single-weekday rule follows (W3-05)", async () => {
            const master = recurring({ startDate: "2026-05-05T15:00:00.000Z", endDate: "2026-05-05T15:30:00.000Z" });
            const fetchMock = mockSeries(master);
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring());

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            setWhen("Start", "2026-06-04T15:00");
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "PUT");
            expect(body.startDate).toBe("2026-05-07T15:00:00.000Z");
            expect(body.endDate).toBe("2026-05-07T15:30:00.000Z");
            expect(body.recurrenceRule.byDay).toEqual(["TH"]);
        });

        it("rotates an untouched multi-day weekly rule with the date", async () => {
            const rule = { freq: "weekly" as const, interval: 1, byDay: ["TU" as const, "FR" as const], exceptions: [] };
            const master = recurring({ recurrenceRule: rule, startDate: "2026-05-05T15:00:00.000Z", endDate: "2026-05-05T15:30:00.000Z" });
            const fetchMock = mockSeries(master);
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring({ recurrenceRule: rule }));

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            setWhen("Start", "2026-06-03T15:00");
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "PUT");
            expect(body.startDate).toBe("2026-05-06T15:00:00.000Z");
            expect(body.recurrenceRule.byDay).toEqual(["WE", "SA"]);
        });

        it("moves an all-day series by the days the occurrence moved", async () => {
            const occ = recurring({ allDay: true, startDate: "2026-06-02T00:00:00.000Z", endDate: "2026-06-03T00:00:00.000Z" });
            const master = recurring({ allDay: true, startDate: "2026-05-05T00:00:00.000Z", endDate: "2026-05-06T00:00:00.000Z" });
            const fetchMock = mockSeries(master);
            const user = userEvent.setup();
            const { onSaved } = renderModal(occ);

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            setWhen("Start", "2026-06-04");
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            const body = bodyOf(fetchMock, "PUT");
            expect(body.startDate).toBe("2026-05-07T00:00:00.000Z");
            expect(body.endDate).toBe("2026-05-08T00:00:00.000Z");
        });

        it("turning a timed series all-day on another date moves its own date by the same days", async () => {
            const master = recurring({ startDate: "2026-05-05T15:00:00.000Z", endDate: "2026-05-05T15:30:00.000Z" });
            const fetchMock = mockSeries(master);
            const user = userEvent.setup();
            const { onSaved } = renderModal(recurring());

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            setWhen("Start", "2026-06-04");
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(bodyOf(fetchMock, "PUT").startDate).toBe("2026-05-07T00:00:00.000Z");
        });

        it("turning an all-day series timed on another date moves its own date by the same days", async () => {
            const occ = recurring({ allDay: true, startDate: "2026-06-02T00:00:00.000Z", endDate: "2026-06-03T00:00:00.000Z" });
            const master = recurring({ allDay: true, startDate: "2026-05-05T00:00:00.000Z", endDate: "2026-05-06T00:00:00.000Z" });
            const fetchMock = mockSeries(master);
            const user = userEvent.setup();
            const { onSaved } = renderModal(occ);

            await user.click(screen.getByRole("radio", { name: "The entire series" }));
            await user.click(screen.getByRole("checkbox", { name: "All day" }));
            setWhen("Start", "2026-06-04T09:00");
            setWhen("End", "2026-06-04T10:00");
            await user.click(screen.getByRole("button", { name: "Save" }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(bodyOf(fetchMock, "PUT").startDate).toBe("2026-05-07T09:00:00.000Z");
        });
    });

    describe("W3-06: leaving a form that holds changes", () => {
        it("asks before Escape throws away a new event's text, and keeps it on Keep editing", async () => {
            const user = userEvent.setup();
            const { onClose } = renderModal(null);
            await user.type(screen.getByLabelText("Title"), "Lunch");

            await user.keyboard("{Escape}");
            expect(await screen.findByRole("dialog", { name: "Discard changes?" })).toBeInTheDocument();
            expect(onClose).not.toHaveBeenCalled();

            await user.click(screen.getByRole("button", { name: "Keep editing" }));
            expect(screen.queryByRole("dialog", { name: "Discard changes?" })).not.toBeInTheDocument();
            expect(screen.getByLabelText("Title")).toHaveValue("Lunch");

            // Escape on the question itself is Keep editing.
            await user.keyboard("{Escape}");
            expect(await screen.findByRole("dialog", { name: "Discard changes?" })).toBeInTheDocument();
            await user.keyboard("{Escape}");
            await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard changes?" })).not.toBeInTheDocument());
            expect(onClose).not.toHaveBeenCalled();

            await user.keyboard("{Escape}");
            await user.click(await screen.findByRole("button", { name: "Discard" }));
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it("closes an untouched new event at once", async () => {
            const user = userEvent.setup();
            const { onClose } = renderModal(null);
            await user.keyboard("{Escape}");
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it("asks before Escape drops an existing event's edits, and returns to its details on Discard", async () => {
            const user = userEvent.setup();
            renderModal(occurrence());
            await user.type(screen.getByLabelText("Title"), " (edited)");

            await user.keyboard("{Escape}");
            await user.click(await screen.findByRole("button", { name: "Discard" }));
            expect(screen.getByRole("dialog", { name: "Event details" })).toBeInTheDocument();
        });
    });

    describe("W3-02: answering one occurrence of a series", () => {
        function invitedSeries() {
            return recurring({
                organizer: { address: "bob@example.com", displayName: "Bob", type: "to" },
                attendees: [{ address: "jane@example.com", displayName: "Jane", role: "required", responseStatus: "needsAction", isOrganizer: false }],
            });
        }

        it("says a decline covers the whole series and sends nothing until confirmed", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, invitedSeries()));
            const user = userEvent.setup();
            const { onDeleted } = renderModal(invitedSeries(), {}, true);

            await user.click(screen.getByRole("button", { name: "Decline" }));
            expect(screen.getByRole("alert")).toHaveTextContent(/applies to every event in this series.*removes the series/);
            expect(fetchMock).not.toHaveBeenCalled();

            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(screen.queryByText(/applies to every event/)).not.toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Decline" }));
            await user.click(screen.getByRole("button", { name: "Decline the series" }));
            await waitFor(() => expect(onDeleted).toHaveBeenCalled());
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e1/respond", expect.objectContaining({ method: "POST" }));
        });

        it("asks the same of an accept, without the warning about removal", async () => {
            const fetchMock = mockFetch(() => jsonResponse(200, invitedSeries()));
            const user = userEvent.setup();
            const { onSaved } = renderModal(invitedSeries(), {}, true);

            await user.click(screen.getByRole("button", { name: "Accept" }));
            expect(screen.getByRole("alert")).toHaveTextContent("Your answer applies to every event in this series, not just this one.");
            expect(fetchMock).not.toHaveBeenCalled();
            await user.click(screen.getByRole("button", { name: "Accept the series" }));
            await waitFor(() => expect(onSaved).toHaveBeenCalled());
        });
    });

    describe("W3-11: deleting and view-only calendars", () => {
        it("asks before deleting a single event, and Keep leaves it alone", async () => {
            const fetchMock = mockFetch(() => new Response(null, { status: 200 }));
            const user = userEvent.setup();
            const { onDeleted } = renderModal(occurrence(), {}, true);

            await user.click(screen.getByRole("button", { name: "Delete" }));
            expect(screen.getByText("Delete this event?")).toBeInTheDocument();
            expect(fetchMock).not.toHaveBeenCalled();
            await user.click(screen.getByRole("button", { name: "Keep" }));
            expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
            expect(onDeleted).not.toHaveBeenCalled();
        });

        it("offers no Modify, Delete or answer on a calendar shared view-only", async () => {
            mockFetch((url) =>
                url === "/api/mail/mailboxes/mb1/access/me"
                    ? jsonResponse(200, { canRead: true, canCreate: false, canUpdate: false, canDelete: false, canManage: false })
                    : jsonResponse(200, {}),
            );
            const invitedToo = recurring({
                organizer: { address: "bob@example.com", displayName: "Bob", type: "to" },
                attendees: [{ address: "jane@example.com", displayName: "Jane", role: "required", responseStatus: "needsAction", isOrganizer: false }],
            });
            renderModal(invitedToo, {
                mailboxOptions: [{ mailbox: { uid: "mb1", primarySmtpAddress: "jane@example.com", accessRole: "delegate" } as never, calendars: [] }],
            }, true);

            await waitFor(() => expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument());
            expect(screen.queryByRole("button", { name: "Modify" })).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
        });
    });
});
