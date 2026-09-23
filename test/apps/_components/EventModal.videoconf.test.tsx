// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import EventModal from "../../../apps/shared/components/calendar/EventModal.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";

// The "Add video conferencing" toggle, the meeting it mints/cancels through
// `@rapidmx/meet-plugin`'s `/mail/video-meetings` routes, and the organizer's own join affordance.

const PLACEHOLDER = "Video call — link in this invitation";
const HELPER_TEXT = /Changing attendees after enabling video conferencing/;

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
        timezone: "UTC",
        organizer: { address: "jane@example.com", displayName: "Jane", type: "to" },
        attendees: [
            { address: "jane@example.com", displayName: "Jane", role: "required", responseStatus: "accepted", isOrganizer: true },
            { address: "bob@example.com", displayName: "Bob", role: "required", responseStatus: "needsAction", isOrganizer: false },
        ],
        status: "confirmed",
        busyStatus: "busy",
        icalUid: "abc",
        sequence: 0,
        occurrenceKey: "e1",
        isRecurringOccurrence: false,
        ...overrides,
    };
}

function renderModal(occ: CalendarOccurrence | null, props: Partial<React.ComponentProps<typeof EventModal>> = {}) {
    const onSaved = vi.fn();
    const rendered = render(
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
    return { onSaved, ...rendered };
}

/** Every request this flow makes, answered by URL/method, with sensible defaults per step. */
function mockVideoFetch(
    handlers: {
        createEvent?: () => Response;
        updateEvent?: () => Response;
        createMeeting?: () => Response;
        updateMeeting?: () => Response;
        getMeeting?: () => Response | Promise<Response>;
    } = {},
) {
    return mockFetch((url, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.startsWith("/api/mail/video-meetings")) {
            if (method === "POST") {
                return (handlers.createMeeting ?? (() => jsonResponse(200, { meeting: meetingFixture, organizerJoinUrl: JOIN_URL })))();
            }
            if (method === "PUT") {
                return (handlers.updateMeeting ?? (() => jsonResponse(200, { ...meetingFixture, status: "cancelled" })))();
            }
            return (handlers.getMeeting ?? (() => jsonResponse(200, { ...meetingFixture, organizerJoinUrl: JOIN_URL })))();
        }
        if (method === "POST") {
            return (handlers.createEvent ?? (() => jsonResponse(200, { ...occurrence(), uid: "e-new", version: 0 })))();
        }
        return (handlers.updateEvent ?? (() => jsonResponse(200, { ...occurrence(), version: 3 })))();
    });
}

const JOIN_URL = "https://meet.example.com/join/tok-organizer";
const meetingFixture = {
    uid: "vm1",
    mailboxUid: "mb1",
    title: "Standup",
    visibility: "private" as const,
    status: "scheduled" as const,
    calendarEventUid: "e1",
};

/** The parsed body of the nth request matching `url`/`method`. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, urlPrefix: string, method: string, index = 0) {
    const calls = fetchMock.mock.calls.filter(
        ([url, init]) => String(url).startsWith(urlPrefix) && ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() === method,
    );
    return JSON.parse((calls[index][1] as RequestInit).body as string);
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, urlPrefix: string, method?: string) {
    return fetchMock.mock.calls.filter(
        ([url, init]) =>
            String(url).startsWith(urlPrefix) && (!method || ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() === method),
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EventModal video conferencing toggle", () => {
    it("offers the toggle under Location, unchecked and without the helper text, for a new event", () => {
        renderModal(null);
        const toggle = screen.getByLabelText("Add video conferencing");
        expect(toggle).not.toBeChecked();
        expect(screen.queryByText(HELPER_TEXT)).not.toBeInTheDocument();
    });

    it("shows the invitee-list limitation as soon as the toggle is checked", async () => {
        const user = userEvent.setup();
        renderModal(null);
        await user.click(screen.getByLabelText("Add video conferencing"));
        expect(screen.getByText(HELPER_TEXT)).toBeInTheDocument();
    });

    it("mints a meeting for the attendees (minus the organizer) and links it to the just-created event", async () => {
        const fetchMock = mockVideoFetch();
        const user = userEvent.setup();
        const { onSaved } = renderModal(null);
        await user.type(screen.getByLabelText("Title"), "Standup");
        await user.click(screen.getByRole("button", { name: "+ Add attendee" }));
        await user.type(screen.getByLabelText("Attendee email 1"), "bob@example.com");
        await user.click(screen.getByRole("button", { name: "+ Add attendee" }));
        await user.type(screen.getByLabelText("Attendee email 2"), "jane@example.com");
        // A third, still-blank row: never sent as an invitee.
        await user.click(screen.getByRole("button", { name: "+ Add attendee" }));
        await user.click(screen.getByLabelText("Add video conferencing"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const meetingBody = bodyOf(fetchMock, "/api/mail/video-meetings", "POST");
        expect(meetingBody).toEqual({
            mailboxUid: "mb1",
            title: "Standup",
            visibility: "private",
            calendarEventUid: "e-new",
            startTime: "2026-06-03T15:00:00.000Z",
            endTime: "2026-06-03T15:30:00.000Z",
            invitees: [{ email: "bob@example.com" }],
        });
        // The event is saved first, then patched with the placeholder location and the meeting's uid.
        const eventCalls = callsTo(fetchMock, "/api/mail/calendar-events");
        expect((eventCalls[0][1] as RequestInit).method).toBe("POST");
        expect(String(eventCalls[1][0])).toBe("/api/mail/calendar-events/e-new");
        expect(bodyOf(fetchMock, "/api/mail/calendar-events/e-new", "PUT")).toEqual({
            uid: "e-new",
            version: 0,
            location: PLACEHOLDER,
            videoMeetingUid: "vm1",
        });
    });

    it("uses the create call's own organizerJoinUrl for the join button, with no extra fetch", async () => {
        const fetchMock = mockVideoFetch();
        const user = userEvent.setup();
        const openSpy = vi.fn();
        vi.stubGlobal("open", openSpy);
        renderModal(occurrence({ attendees: [{ address: "bob@example.com", role: "required", responseStatus: "needsAction", isOrganizer: false }] }));
        await user.click(screen.getByLabelText("Add video conferencing"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        const join = await screen.findByRole("button", { name: "Join video call" });
        await waitFor(() => expect(join).toBeEnabled());
        expect(callsTo(fetchMock, "/api/mail/video-meetings", "GET")).toHaveLength(0);
        await user.click(join);
        expect(openSpy).toHaveBeenCalledWith(JOIN_URL, "_blank", "noopener,noreferrer");
    });

    it("offers no link to open when the new meeting came back without an organizer link", async () => {
        const fetchMock = mockVideoFetch({ createMeeting: () => jsonResponse(200, { meeting: meetingFixture }) });
        const user = userEvent.setup();
        const { onSaved } = renderModal(occurrence());
        await user.click(screen.getByLabelText("Add video conferencing"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(await screen.findByText("This meeting’s join link isn’t available.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Join video call" })).toBeDisabled();
        // The deployment simply has no public URL for the plugin - nothing was re-fetched to find that out.
        expect(callsTo(fetchMock, "/api/mail/video-meetings", "GET")).toHaveLength(0);
    });

    it("refuses to mint a meeting with no attendee other than the organizer, without blocking the save", async () => {
        const fetchMock = mockVideoFetch();
        const user = userEvent.setup();
        const { onSaved } = renderModal(
            occurrence({ attendees: [{ address: "jane@example.com", role: "required", responseStatus: "accepted", isOrganizer: true }] }),
        );
        await user.click(screen.getByLabelText("Add video conferencing"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Add at least one attendee other than yourself to add video conferencing.")).toBeInTheDocument();
        expect(callsTo(fetchMock, "/api/mail/video-meetings")).toHaveLength(0);
        expect(callsTo(fetchMock, "/api/mail/calendar-events", "PUT")).toHaveLength(1);
        expect(onSaved).not.toHaveBeenCalled();
    });

    it("leaves an already-linked meeting completely alone when attendees changed", async () => {
        const fetchMock = mockVideoFetch();
        const user = userEvent.setup();
        const { onSaved } = renderModal(occurrence({ videoMeetingUid: "vm1" }));
        expect(screen.getByLabelText("Add video conferencing")).toBeChecked();
        expect(screen.getByText(HELPER_TEXT)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "+ Add attendee" }));
        await user.type(screen.getByLabelText("Attendee email 3"), "carol@example.com");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(callsTo(fetchMock, "/api/mail/video-meetings", "POST")).toHaveLength(0);
        expect(callsTo(fetchMock, "/api/mail/video-meetings", "PUT")).toHaveLength(0);
    });

    it("cancels the meeting and clears the auto-generated location when the toggle is turned off", async () => {
        const fetchMock = mockVideoFetch();
        const user = userEvent.setup();
        const { onSaved } = renderModal(occurrence({ videoMeetingUid: "vm1", location: PLACEHOLDER }));
        await user.click(screen.getByLabelText("Add video conferencing"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(String(callsTo(fetchMock, "/api/mail/video-meetings", "PUT")[0][0])).toBe("/api/mail/video-meetings/vm1");
        expect(bodyOf(fetchMock, "/api/mail/video-meetings", "PUT")).toEqual({ status: "cancelled" });
        expect(bodyOf(fetchMock, "/api/mail/calendar-events", "PUT", 1)).toEqual({
            uid: "e1",
            version: 3,
            location: null,
            videoMeetingUid: null,
        });
        expect(screen.getByLabelText("Location")).toHaveValue("");
    });

    it("keeps a location the user typed themselves when the toggle is turned off", async () => {
        const fetchMock = mockVideoFetch();
        const user = userEvent.setup();
        const { onSaved } = renderModal(occurrence({ videoMeetingUid: "vm1", location: PLACEHOLDER }));
        await user.clear(screen.getByLabelText("Location"));
        await user.type(screen.getByLabelText("Location"), "Room 12");
        await user.click(screen.getByLabelText("Add video conferencing"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(bodyOf(fetchMock, "/api/mail/calendar-events", "PUT", 1)).toEqual({
            uid: "e1",
            version: 3,
            location: "Room 12",
            videoMeetingUid: null,
        });
        expect(screen.getByLabelText("Location")).toHaveValue("Room 12");
    });

    it("saves the event anyway when minting the meeting fails, and retries against the saved event", async () => {
        let meetingAttempts = 0;
        const fetchMock = mockVideoFetch({
            createMeeting: () => {
                meetingAttempts += 1;
                return meetingAttempts === 1
                    ? jsonResponse(503, { message: "The meeting service is unavailable." })
                    : jsonResponse(200, { meeting: meetingFixture, organizerJoinUrl: JOIN_URL });
            },
        });
        const user = userEvent.setup();
        const { onSaved } = renderModal(occurrence());
        await user.click(screen.getByLabelText("Add video conferencing"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("The meeting service is unavailable.")).toBeInTheDocument();
        expect(onSaved).not.toHaveBeenCalled();
        // The event itself was saved, and the toggle stays on so the meeting can be retried.
        expect(callsTo(fetchMock, "/api/mail/calendar-events", "PUT")).toHaveLength(1);
        expect(screen.getByLabelText("Add video conferencing")).toBeChecked();
        expect(screen.queryByRole("button", { name: "Join video call" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        // The retry updates the record the first save left behind, at the version it came back with.
        expect(bodyOf(fetchMock, "/api/mail/calendar-events", "PUT", 1).version).toBe(3);
        expect(bodyOf(fetchMock, "/api/mail/calendar-events", "PUT", 2)).toEqual({
            uid: "e1",
            version: 3,
            location: PLACEHOLDER,
            videoMeetingUid: "vm1",
        });
    });

    it("reports a non-API failure of the cancel call generically, leaving the link in place", async () => {
        const fetchMock = mockVideoFetch({
            updateMeeting: () => {
                throw new TypeError("Failed to fetch");
            },
        });
        const user = userEvent.setup();
        const { onSaved } = renderModal(occurrence({ videoMeetingUid: "vm1", location: PLACEHOLDER }));
        await user.click(screen.getByLabelText("Add video conferencing"));
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Could not update this event's video conferencing.")).toBeInTheDocument();
        expect(onSaved).not.toHaveBeenCalled();
        expect(callsTo(fetchMock, "/api/mail/calendar-events", "PUT")).toHaveLength(1);
        expect(screen.getByRole("button", { name: "Join video call" })).toBeInTheDocument();
    });
});

describe("EventModal join video call affordance", () => {
    it("fetches the organizer's own join link for an event that already had a meeting, and opens it", async () => {
        const fetchMock = mockVideoFetch();
        const openSpy = vi.fn();
        vi.stubGlobal("open", openSpy);
        const user = userEvent.setup();
        renderModal(occurrence({ videoMeetingUid: "vm1" }));

        const join = screen.getByRole("button", { name: "Join video call" });
        expect(join).toBeDisabled();
        expect(screen.getByText("Loading the join link…")).toBeInTheDocument();
        await waitFor(() => expect(join).toBeEnabled());
        expect(String(callsTo(fetchMock, "/api/mail/video-meetings", "GET")[0][0])).toBe("/api/mail/video-meetings/vm1");

        await user.click(join);
        expect(openSpy).toHaveBeenCalledWith(JOIN_URL, "_blank", "noopener,noreferrer");
    });

    it("says so when the meeting carries no organizer link", async () => {
        mockVideoFetch({ getMeeting: () => jsonResponse(200, meetingFixture) });
        renderModal(occurrence({ videoMeetingUid: "vm1" }));
        expect(await screen.findByText("This meeting’s join link isn’t available.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Join video call" })).toBeDisabled();
    });

    it("says so when the meeting can't be fetched at all", async () => {
        mockVideoFetch({ getMeeting: () => jsonResponse(404, { message: "Not found." }) });
        renderModal(occurrence({ videoMeetingUid: "vm1" }));
        expect(await screen.findByText("This meeting’s join link isn’t available.")).toBeInTheDocument();
    });

    it("refuses a non-http(s) organizerJoinUrl - keeps the join button disabled rather than opening it", async () => {
        // The same scheme allow-list calendarReminders.ts#joinMeetingUrl() applies to a reminder's own
        // location field, reused here so a malformed or hostile join link (a javascript:/file: URL) can
        // never reach window.open().
        const openSpy = vi.fn();
        vi.stubGlobal("open", openSpy);
        mockVideoFetch({ getMeeting: () => jsonResponse(200, { ...meetingFixture, organizerJoinUrl: "javascript:alert(1)" }) });
        renderModal(occurrence({ videoMeetingUid: "vm1" }));

        expect(await screen.findByText("This meeting’s join link isn’t available.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Join video call" })).toBeDisabled();
        expect(openSpy).not.toHaveBeenCalled();
    });

    it("is not offered at all for an event with no meeting, and fetches nothing", () => {
        const fetchMock = mockVideoFetch();
        renderModal(occurrence());
        expect(screen.queryByRole("button", { name: "Join video call" })).not.toBeInTheDocument();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("drops a join link that arrives after the modal is gone", async () => {
        let resolveMeeting: (res: Response) => void = () => undefined;
        mockVideoFetch({ getMeeting: () => new Promise<Response>((resolve) => (resolveMeeting = resolve)) });
        const { unmount } = renderModal(occurrence({ videoMeetingUid: "vm1" }));
        unmount();
        resolveMeeting(jsonResponse(200, { ...meetingFixture, organizerJoinUrl: JOIN_URL }));
        // Nothing to assert on screen - the point is that settling after the unmount changes no state (a
        // React warning here would fail the run).
        await waitFor(() => expect(screen.queryByRole("button", { name: "Join video call" })).not.toBeInTheDocument());
    });
});
