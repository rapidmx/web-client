// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageInvite } from "@rapidmx/react-shared/calendar/inviteApi.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import InviteCard, { formatInviteWhen, isCalendarAttachment } from "../../../apps/shared/components/mail/InviteCard.js";
import { clearInviteCache } from "../../../apps/shared/components/mail/invite/inviteStore.js";
import { conflictSummary } from "../../../apps/shared/components/mail/invite/inviteFormat.js";
import { dismissAll, getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";

// The suite runs in UTC (vitest.config.ts), so the reader's own zone is UTC below.

/** A request nobody has answered yet: what the server sends for a meeting invitation addressed to the reader. */
function inviteFixture(overrides: Partial<MessageInvite> = {}): MessageInvite {
    return {
        method: "REQUEST",
        uid: "ical-1",
        sequence: 0,
        summary: "Quarterly planning",
        location: "Room 4",
        startDate: "2026-06-16T14:00:00.000Z",
        endDate: "2026-06-16T15:30:00.000Z",
        allDay: false,
        timezone: "America/New_York",
        organizer: { address: "boss@example.com", displayName: "The Boss" },
        attendees: [
            { address: "me@example.com", displayName: "Me", responseStatus: "needs-action" },
            { address: "amy@example.com", responseStatus: "accepted" },
        ],
        recurring: false,
        isOrganizer: false,
        onCalendar: false,
        outdated: false,
        canRespond: true,
        canAdd: false,
        canRemove: false,
        canPropose: false,
        canAcceptProposal: false,
        conflicts: [],
        schedule: [],
        ...overrides,
    };
}

/** Serves the invite routes for message `m1`: `lookup` answers the GET, `action` the two POSTs. Returns fetch's mock. */
function mockInviteServer(
    lookup: () => Response | Promise<Response>,
    action: (url: string, init: RequestInit) => Response | Promise<Response> = () => jsonResponse(500, { message: "unexpected" }),
) {
    return mockFetch((url, init) => ((init?.method ?? "GET") === "GET" ? lookup() : action(url, init)));
}

/** The "N:NN PM" the locale writes has a narrow no-break space in newer ICU: compare as plain spaces. */
function plain(text: string | null | undefined): string {
    return (text ?? "").replace(/\s+/g, " ");
}

afterEach(() => {
    vi.unstubAllGlobals();
    clearInviteCache();
    dismissAll();
});

/** Renders the card and waits for its region. */
async function renderCard(invite: MessageInvite | null, props: Partial<React.ComponentProps<typeof InviteCard>> = {}) {
    // Several cards are drawn for the one message uid in a test: each starts from a cold cache.
    clearInviteCache();
    const fetchMock = mockInviteServer(() => (invite ? jsonResponse(200, invite) : jsonResponse(404, { message: "none" })));
    const view = render(<InviteCard messageUid="m1" {...props} />);
    if (invite) {
        await screen.findByRole("region");
    }
    return { fetchMock, ...view };
}

describe("isCalendarAttachment", () => {
    it.each([
        [{ filename: "invite.ics", mimeType: "application/octet-stream" }, true],
        [{ filename: "INVITE.ICS", mimeType: "" }, true],
        [{ filename: "invite", mimeType: "text/calendar" }, true],
        [{ filename: "invite", mimeType: "Text/Calendar; method=REQUEST; charset=UTF-8" }, true],
        [{ filename: "invite", mimeType: "application/ics" }, true],
        [{ filename: "notes.txt", mimeType: "text/plain" }, false],
        [{ filename: "ics.zip", mimeType: "application/zip" }, false],
        [{ filename: undefined, mimeType: undefined }, false],
    ] as const)("%j -> %s", (attachment, expected) => {
        expect(isCalendarAttachment(attachment as never)).toBe(expected);
    });
});

describe("formatInviteWhen", () => {
    it("shows one date and a time range for a same-day event, naming the zone once", () => {
        expect(plain(formatInviteWhen(inviteFixture()))).toBe("Tue, Jun 16, 2026, 2:00 PM - 3:30 PM UTC");
    });

    it("shows both ends in full for an event that spans days", () => {
        expect(plain(formatInviteWhen(inviteFixture({ endDate: "2026-06-17T09:00:00.000Z" })))).toBe(
            "Tue, Jun 16, 2026, 2:00 PM - Wed, Jun 17, 2026, 9:00 AM UTC",
        );
    });

    it("shows the start alone when the end is missing, unparseable or not after it", () => {
        for (const endDate of [undefined, "garbage", "2026-06-16T14:00:00.000Z"]) {
            expect(plain(formatInviteWhen(inviteFixture({ endDate })))).toBe("Tue, Jun 16, 2026, 2:00 PM UTC");
        }
    });

    it("is undefined when there is no usable start", () => {
        expect(formatInviteWhen(inviteFixture({ startDate: undefined }))).toBeUndefined();
        expect(formatInviteWhen(inviteFixture({ startDate: "garbage" }))).toBeUndefined();
    });

    it("shows only dates for an all-day event, treating its end as the midnight after its last day", () => {
        const allDay = { allDay: true, timezone: "UTC", startDate: "2026-06-16T00:00:00.000Z" };
        expect(formatInviteWhen(inviteFixture({ ...allDay, endDate: "2026-06-17T00:00:00.000Z" }))).toBe("Tue, Jun 16, 2026");
        expect(formatInviteWhen(inviteFixture({ ...allDay, endDate: "2026-06-19T00:00:00.000Z" }))).toBe("Tue, Jun 16, 2026 - Thu, Jun 18, 2026");
        expect(formatInviteWhen(inviteFixture({ ...allDay, endDate: undefined }))).toBe("Tue, Jun 16, 2026");
    });

    it("draws an all-day date in the organizer's zone, and in UTC when that zone is missing or unknown", () => {
        // Midnight in New York is 04:00 UTC: the same calendar day whatever zone the reader is in.
        const base = { allDay: true, startDate: "2026-06-16T04:00:00.000Z", endDate: "2026-06-17T04:00:00.000Z" };
        expect(formatInviteWhen(inviteFixture({ ...base, timezone: "America/New_York" }))).toBe("Tue, Jun 16, 2026");
        const utcMidnights = { allDay: true, startDate: "2026-06-16T00:00:00.000Z", endDate: "2026-06-17T00:00:00.000Z" };
        expect(formatInviteWhen(inviteFixture({ ...utcMidnights, timezone: undefined }))).toBe("Tue, Jun 16, 2026");
        expect(formatInviteWhen(inviteFixture({ ...utcMidnights, timezone: "Not/AZone" }))).toBe("Tue, Jun 16, 2026");
    });
});

describe("InviteCard", () => {
    it("asks the server once for the message's invitation and draws a labelled region", async () => {
        const { fetchMock } = await renderCard(inviteFixture());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/invite/m1", expect.anything());
        const region = screen.getByRole("region", { name: "Meeting invitation" });
        expect(within(region).getByRole("heading", { level: 2, name: "Meeting invitation" })).toBeInTheDocument();
    });

    it("draws the heading one level lower when told to (inside a thread's card)", async () => {
        await renderCard(inviteFixture(), { headingLevel: 3 });
        expect(screen.getByRole("heading", { level: 3, name: "Meeting invitation" })).toBeInTheDocument();
    });

    it("shows the title, when, where, organizer with address, and attendees by name", async () => {
        await renderCard(inviteFixture());
        const region = screen.getByRole("region");

        expect(within(region).getByText("Quarterly planning")).toBeInTheDocument();
        expect(plain(within(region).getByText("When").nextElementSibling?.textContent)).toBe("Tue, Jun 16, 2026, 2:00 PM - 3:30 PM UTC");
        expect(within(region).getByText("Where").nextElementSibling).toHaveTextContent("Room 4");
        expect(within(region).getByText("Organizer").nextElementSibling).toHaveTextContent("The Boss <boss@example.com>");
        expect(within(region).getByText("Attendees").nextElementSibling).toHaveTextContent("2 attendees: Me, amy@example.com");
    });

    it("falls back to '(no title)' and leaves out the rows it has nothing for", async () => {
        await renderCard(
            inviteFixture({ summary: "  ", location: undefined, startDate: undefined, endDate: undefined, organizer: undefined, attendees: [] }),
        );
        const region = screen.getByRole("region");

        expect(within(region).getByText("(no title)")).toBeInTheDocument();
        for (const label of ["When", "Where", "Organizer", "Attendees"]) {
            expect(within(region).queryByText(label)).not.toBeInTheDocument();
        }
    });

    it("only counts a long attendee list, and says 'attendee' for one", async () => {
        const many = Array.from({ length: 6 }, (_, i) => ({ address: `p${i}@example.com` }));
        const { unmount } = await renderCard(inviteFixture({ attendees: many }));
        expect(screen.getByText("Attendees").nextElementSibling).toHaveTextContent(/^6 attendees$/);
        unmount();

        await renderCard(inviteFixture({ attendees: [{ address: "solo@example.com", displayName: "Solo" }] }));
        expect(screen.getByText("Attendees").nextElementSibling).toHaveTextContent("1 attendee: Solo");
    });

    it("mentions that a recurring meeting repeats", async () => {
        await renderCard(inviteFixture({ recurring: true }));
        expect(screen.getByText("When").nextElementSibling).toHaveTextContent(/\(Repeats\)$/);
    });

    it("shows dates only for an all-day meeting", async () => {
        await renderCard(
            inviteFixture({ allDay: true, timezone: "UTC", startDate: "2026-06-16T00:00:00.000Z", endDate: "2026-06-17T00:00:00.000Z" }),
        );
        expect(screen.getByText("When").nextElementSibling).toHaveTextContent(/^Tue, Jun 16, 2026$/);
    });

    it("shows nothing when the message has no readable invitation (404)", async () => {
        const { fetchMock, container } = await renderCard(null);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(container).toBeEmptyDOMElement();
    });

    it("shows nothing, once and without a pop-up, when the lookup fails", async () => {
        const fetchMock = mockInviteServer(() => jsonResponse(500, { message: "Boom" }));
        const { container, rerender } = render(<InviteCard messageUid="m1" />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(container).toBeEmptyDOMElement();
        expect(getNotificationsSnapshot().visible).toEqual([]);
        // Not retried when something else about the card changes.
        rerender(<InviteCard messageUid="m1" headingLevel={3} />);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("shows nothing when the request never reaches the server", async () => {
        const fetchMock = mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
        const { container } = render(<InviteCard messageUid="m1" />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(container).toBeEmptyDOMElement();
    });

    it("ignores an answer to the lookup that arrives after the card is unmounted", async () => {
        let answer!: (response: Response) => void;
        const fetchMock = mockInviteServer(() => new Promise<Response>((resolve) => (answer = resolve)));
        const { unmount, container } = render(<InviteCard messageUid="m1" />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        unmount();
        answer(jsonResponse(200, inviteFixture()));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(container).toBeEmptyDOMElement();
    });

    it("never shows one message's invitation for another, and ignores the earlier message's late answer", async () => {
        const answers: Record<string, (response: Response) => void> = {};
        const fetchMock = mockFetch(
            (url) => new Promise<Response>((resolve) => (answers[url.split("/").pop()!] = resolve)),
        );
        const { rerender } = render(<InviteCard messageUid="m1" />);
        await waitFor(() => expect(answers.m1).toBeDefined());
        rerender(<InviteCard messageUid="m2" />);
        await waitFor(() => expect(answers.m2).toBeDefined());
        expect(fetchMock).toHaveBeenCalledTimes(2);

        answers.m1(jsonResponse(200, inviteFixture({ summary: "First" })));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.queryByRole("region")).not.toBeInTheDocument();

        answers.m2(jsonResponse(200, inviteFixture({ summary: "Second" })));
        expect(await screen.findByText("Second")).toBeInTheDocument();
        expect(screen.queryByText("First")).not.toBeInTheDocument();

        // Back to the first message: its own answer is not what is shown.
        rerender(<InviteCard messageUid="m1" />);
        expect(screen.queryByText("Second")).not.toBeInTheDocument();
    });

    describe("a request addressed to the reader", () => {
        it("offers Accept, Tentative and Decline, none of them selected, and no status line", async () => {
            await renderCard(inviteFixture());
            const group = screen.getByRole("group", { name: "Respond to this meeting" });

            for (const name of ["Accept", "Tentative", "Decline"]) {
                const button = within(group).getByRole("button", { name });
                expect(button).toBeEnabled();
                expect(button).toHaveAttribute("aria-pressed", "false");
            }
            expect(screen.queryByRole("status")).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: /calendar/i })).not.toBeInTheDocument();
        });

        it.each([
            ["Accept", "accepted", "You accepted this meeting."],
            ["Tentative", "tentative", "You tentatively accepted this meeting."],
            ["Decline", "declined", "You declined this meeting. It is not on your calendar."],
        ] as const)("%s sends the answer, then shows it selected with what it means", async (name, response, status) => {
            const user = userEvent.setup();
            const fetchMock = mockInviteServer(
                () => jsonResponse(200, inviteFixture()),
                () => jsonResponse(200, inviteFixture({ response, onCalendar: response !== "declined", calendarEventUid: "ev1" })),
            );
            render(<InviteCard messageUid="m/1" />);
            await user.click(await screen.findByRole("button", { name }));

            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(status));
            expect(fetchMock).toHaveBeenLastCalledWith(
                "/api/mail/calendar-events/invite/m%2F1/respond",
                expect.objectContaining({ method: "POST", body: JSON.stringify({ responseStatus: response }) }),
            );
            const selected = screen.getByRole("button", { name });
            expect(selected).toBeDisabled();
            expect(selected).toHaveAttribute("aria-pressed", "true");
            // The other two stay available, so the answer can be changed.
            for (const other of ["Accept", "Tentative", "Decline"].filter((n) => n !== name)) {
                expect(screen.getByRole("button", { name: other })).toBeEnabled();
                expect(screen.getByRole("button", { name: other })).toHaveAttribute("aria-pressed", "false");
            }
        });

        it("lets the reader change an answer already given", async () => {
            const user = userEvent.setup();
            const fetchMock = mockInviteServer(
                () => jsonResponse(200, inviteFixture({ response: "accepted", onCalendar: true, calendarEventUid: "ev1" })),
                () => jsonResponse(200, inviteFixture({ response: "declined" })),
            );
            render(<InviteCard messageUid="m1" />);

            expect(await screen.findByRole("status")).toHaveTextContent("You accepted this meeting.");
            expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
            await user.click(screen.getByRole("button", { name: "Decline" }));

            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("You declined this meeting. It is not on your calendar."));
            expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
            expect(screen.getByRole("button", { name: "Decline" })).toBeDisabled();
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it("disables every button and marks the card busy while an answer is on its way", async () => {
            const user = userEvent.setup();
            let finish!: (response: Response) => void;
            mockInviteServer(
                () => jsonResponse(200, inviteFixture()),
                () => new Promise<Response>((resolve) => (finish = resolve)),
            );
            render(<InviteCard messageUid="m1" />);
            await user.click(await screen.findByRole("button", { name: "Tentative" }));

            const group = screen.getByRole("group", { name: "Respond to this meeting" });
            expect(group).toHaveAttribute("aria-busy", "true");
            expect(screen.getByRole("button", { name: "Tentative" })).toHaveAttribute("aria-busy", "true");
            expect(screen.getByRole("button", { name: "Accept" })).not.toHaveAttribute("aria-busy");
            for (const name of ["Accept", "Tentative", "Decline"]) {
                expect(screen.getByRole("button", { name })).toBeDisabled();
            }

            finish(jsonResponse(200, inviteFixture({ response: "tentative" })));
            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("You tentatively accepted this meeting."));
            expect(group).not.toHaveAttribute("aria-busy");
            expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
        });

        it("raises an error pop-up and leaves the card as it was when the answer fails", async () => {
            const user = userEvent.setup();
            mockInviteServer(
                () => jsonResponse(200, inviteFixture()),
                () => jsonResponse(500, { message: "The mail server is down" }),
            );
            render(<InviteCard messageUid="m1" />);
            await user.click(await screen.findByRole("button", { name: "Accept" }));

            await waitFor(() =>
                expect(getNotificationsSnapshot().visible).toMatchObject([
                    { kind: "error", title: "Couldn't accept this meeting", message: expect.stringContaining("The mail server is down") },
                ]),
            );
            expect(screen.queryByRole("status")).not.toBeInTheDocument();
            for (const name of ["Accept", "Tentative", "Decline"]) {
                expect(screen.getByRole("button", { name })).toBeEnabled();
                expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
            }
            expect(screen.getByRole("group", { name: "Respond to this meeting" })).not.toHaveAttribute("aria-busy");
        });

        it.each([
            ["Tentative", "Couldn't respond tentatively to this meeting"],
            ["Decline", "Couldn't decline this meeting"],
        ])("names what %s could not do in its pop-up", async (name, title) => {
            const user = userEvent.setup();
            mockInviteServer(
                () => jsonResponse(200, inviteFixture()),
                () => Promise.reject(new TypeError("Failed to fetch")),
            );
            render(<InviteCard messageUid="m1" />);
            await user.click(await screen.findByRole("button", { name }));
            await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title }]));
        });

        it("has no response buttons for the organizer, who is told so", async () => {
            await renderCard(inviteFixture({ isOrganizer: true, canRespond: true, attendees: [] }));
            expect(screen.queryByRole("button")).not.toBeInTheDocument();
            expect(screen.getByRole("region")).toHaveTextContent("You are the organizer of this meeting.");
        });

        it("has no response buttons when the request is not addressed to the reader", async () => {
            await renderCard(inviteFixture({ canRespond: false }));
            expect(screen.queryByRole("button")).not.toBeInTheDocument();
        });

        it("says a newer version is already on the calendar when the message is outdated", async () => {
            await renderCard(inviteFixture({ outdated: true }));
            expect(screen.getByText("A newer version of this meeting is already on your calendar.")).toBeInTheDocument();
        });

        it("leaves that note out otherwise", async () => {
            await renderCard(inviteFixture());
            expect(screen.queryByText(/newer version/)).not.toBeInTheDocument();
        });
    });

    describe("Open in Calendar", () => {
        it("links to the day view of the day the meeting starts once it is on the calendar", async () => {
            await renderCard(inviteFixture({ response: "accepted", onCalendar: true, calendarEventUid: "ev1" }));
            expect(screen.getByRole("link", { name: "Open in Calendar" })).toHaveAttribute("href", "/calendar?date=2026-06-16&view=day");
        });

        it("uses the organizer's day for an all-day meeting", async () => {
            await renderCard(
                inviteFixture({
                    allDay: true,
                    timezone: "America/New_York",
                    startDate: "2026-06-16T04:00:00.000Z",
                    endDate: "2026-06-17T04:00:00.000Z",
                    onCalendar: true,
                    calendarEventUid: "ev1",
                }),
            );
            expect(screen.getByRole("link", { name: "Open in Calendar" })).toHaveAttribute("href", "/calendar?date=2026-06-16&view=day");
        });

        it("falls back to the calendar itself when the invitation has no usable start", async () => {
            await renderCard(inviteFixture({ startDate: undefined, onCalendar: true, calendarEventUid: "ev1" }));
            expect(screen.getByRole("link", { name: "Open in Calendar" })).toHaveAttribute("href", "/calendar");
        });

        it("is not offered while the meeting is not on the calendar, or without its event", async () => {
            const { unmount } = await renderCard(inviteFixture({ onCalendar: false, calendarEventUid: "ev1" }));
            expect(screen.queryByRole("link")).not.toBeInTheDocument();
            unmount();

            await renderCard(inviteFixture({ onCalendar: true, calendarEventUid: undefined }));
            expect(screen.queryByRole("link")).not.toBeInTheDocument();
        });
    });

    describe("a published event, or a file that names no method", () => {
        const publish = () => inviteFixture({ method: "PUBLISH", canRespond: false, canAdd: true, organizer: undefined, attendees: [] });

        it.each([["PUBLISH"], [""]])("(method %j) offers 'Add to calendar' only, under a neutral heading", async (method) => {
            await renderCard({ ...publish(), method });
            expect(screen.getByRole("region", { name: "Calendar event" })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Add to calendar" })).toBeEnabled();
            expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
        });

        it("adds it by accepting it, then shows where it is", async () => {
            const user = userEvent.setup();
            const fetchMock = mockInviteServer(
                () => jsonResponse(200, publish()),
                () => jsonResponse(200, { ...publish(), canAdd: false, response: "accepted", onCalendar: true, calendarEventUid: "ev1" }),
            );
            render(<InviteCard messageUid="m1" />);
            await user.click(await screen.findByRole("button", { name: "Add to calendar" }));

            await waitFor(() => expect(screen.queryByRole("button", { name: "Add to calendar" })).not.toBeInTheDocument());
            expect(fetchMock).toHaveBeenLastCalledWith(
                "/api/mail/calendar-events/invite/m1/respond",
                expect.objectContaining({ method: "POST", body: JSON.stringify({ responseStatus: "accepted" }) }),
            );
            expect(screen.getByRole("link", { name: "Open in Calendar" })).toBeInTheDocument();
        });

        it("is busy while it is being added, and a failure raises a pop-up and leaves the button", async () => {
            const user = userEvent.setup();
            let fail!: (response: Response) => void;
            mockInviteServer(
                () => jsonResponse(200, publish()),
                () => new Promise<Response>((resolve) => (fail = resolve)),
            );
            render(<InviteCard messageUid="m1" />);
            await user.click(await screen.findByRole("button", { name: "Add to calendar" }));

            expect(screen.getByRole("button", { name: "Add to calendar" })).toBeDisabled();
            expect(screen.getByRole("button", { name: "Add to calendar" })).toHaveAttribute("aria-busy", "true");
            fail(jsonResponse(403, { message: "Not allowed" }));

            await waitFor(() =>
                expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title: "Couldn't add this event to your calendar" }]),
            );
            expect(screen.getByRole("button", { name: "Add to calendar" })).toBeEnabled();
        });
    });

    describe("a cancellation", () => {
        const cancel = (overrides: Partial<MessageInvite> = {}) =>
            inviteFixture({ method: "CANCEL", canRespond: false, canRemove: true, onCalendar: true, calendarEventUid: "ev1", ...overrides });

        it("says the meeting was canceled and offers to remove it from the calendar", async () => {
            await renderCard(cancel());
            expect(screen.getByRole("region", { name: "Meeting canceled" })).toBeInTheDocument();
            expect(screen.getByText("This meeting was canceled.")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Remove from calendar" })).toBeEnabled();
            expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
        });

        it("removes it and then shows a card with nothing left to do", async () => {
            const user = userEvent.setup();
            const fetchMock = mockInviteServer(
                () => jsonResponse(200, cancel()),
                () => jsonResponse(200, cancel({ canRemove: false, onCalendar: false, calendarEventUid: undefined })),
            );
            render(<InviteCard messageUid="m/1" />);
            await user.click(await screen.findByRole("button", { name: "Remove from calendar" }));

            await waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
            expect(fetchMock).toHaveBeenLastCalledWith("/api/mail/calendar-events/invite/m%2F1/remove", expect.objectContaining({ method: "POST" }));
            expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
            expect(screen.getByText("This meeting was canceled.")).toBeInTheDocument();
            expect(screen.queryByRole("link")).not.toBeInTheDocument();
        });

        it("is busy while it is being removed, and a failure raises a pop-up and leaves the button", async () => {
            const user = userEvent.setup();
            let fail!: (response: Response) => void;
            mockInviteServer(
                () => jsonResponse(200, cancel()),
                () => new Promise<Response>((resolve) => (fail = resolve)),
            );
            render(<InviteCard messageUid="m1" />);
            await user.click(await screen.findByRole("button", { name: "Remove from calendar" }));

            expect(screen.getByRole("button", { name: "Remove from calendar" })).toBeDisabled();
            expect(screen.getByRole("button", { name: "Remove from calendar" })).toHaveAttribute("aria-busy", "true");
            fail(jsonResponse(500, { message: "Nope" }));

            await waitFor(() =>
                expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title: "Couldn't remove this meeting from your calendar" }]),
            );
            expect(screen.getByRole("button", { name: "Remove from calendar" })).toBeEnabled();
        });

        it("shows no button for a canceled meeting that is not on the calendar", async () => {
            await renderCard(cancel({ canRemove: false, onCalendar: false, calendarEventUid: undefined }));
            expect(screen.queryByRole("button")).not.toBeInTheDocument();
            expect(screen.getByText("This meeting was canceled.")).toBeInTheDocument();
        });
    });

    describe("a reply to the reader's own invitation", () => {
        const reply = (overrides: Partial<MessageInvite> = {}) =>
            inviteFixture({
                method: "REPLY",
                isOrganizer: true,
                canRespond: false,
                summary: "Video Test",
                reply: { address: "jp@example.com", displayName: "Jean-Philippe Steinmetz", responseStatus: "tentative" },
                attendees: [{ address: "jp@example.com", displayName: "Jean-Philippe Steinmetz", responseStatus: "tentative" }],
                ...overrides,
            });

        it("says who answered and how in one line, with the meeting under it and nothing to do", async () => {
            await renderCard(reply());
            const region = screen.getByRole("region", { name: "Meeting response" });

            expect(within(region).getByText("Jean-Philippe Steinmetz").parentElement).toHaveTextContent("Jean-Philippe Steinmetz tentatively accepted.");
            expect(within(region).getByText("Video Test")).toBeInTheDocument();
            expect(plain(region.textContent)).toContain("Tue, Jun 16, 2026, 2:00 PM - 3:30 PM UTC");
            expect(screen.queryByRole("button")).not.toBeInTheDocument();
            for (const label of ["When", "Organizer", "Attendees"]) {
                expect(within(region).queryByText(label)).not.toBeInTheDocument();
            }
            expect(region).not.toHaveTextContent("You are the organizer");
        });

        it.each([
            ["accepted", "accepted"],
            ["tentative", "tentatively accepted"],
            ["declined", "declined"],
            ["needs-action", "responded"],
        ] as const)("words a %s answer as '%s'", async (responseStatus, verb) => {
            await renderCard(reply({ reply: { address: "bob@example.com", displayName: "Bob", responseStatus } }));
            expect(screen.getByRole("region")).toHaveTextContent(`Bob ${verb}.`);
        });

        it("falls back to the first attendee, to the address without a name, and to 'Someone'", async () => {
            const { unmount } = await renderCard(reply({ reply: undefined }));
            expect(screen.getByRole("region")).toHaveTextContent("Jean-Philippe Steinmetz tentatively accepted.");
            unmount();

            const second = await renderCard(reply({ reply: { address: "bob@example.com" } }));
            expect(screen.getByRole("region")).toHaveTextContent("bob@example.com responded.");
            second.unmount();

            await renderCard(reply({ reply: undefined, attendees: [] }));
            expect(screen.getByRole("region")).toHaveTextContent("Someone responded.");
        });

        it("leaves out the time when the reply names none", async () => {
            await renderCard(reply({ startDate: undefined }));
            expect(screen.getByRole("region")).not.toHaveTextContent("2026");
        });
    });

    describe("an attendee's proposed new time", () => {
        const counter = (overrides: Partial<MessageInvite> = {}) =>
            inviteFixture({
                method: "COUNTER",
                isOrganizer: true,
                canRespond: false,
                canPropose: false,
                canAcceptProposal: true,
                startDate: "2026-06-17T10:00:00.000Z",
                endDate: "2026-06-17T11:00:00.000Z",
                reply: { address: "amy@example.com", displayName: "Amy", responseStatus: "needs-action" },
                ...overrides,
            });

        it("says who proposed which time and offers to accept it", async () => {
            await renderCard(counter());
            const region = screen.getByRole("region", { name: "New time proposed" });

            expect(plain(region.textContent)).toContain("Amy proposed a new time: Wed, Jun 17, 2026, 10:00 AM - 11:00 AM UTC");
            expect(within(region).getByText("Quarterly planning")).toBeInTheDocument();
            expect(within(region).getByRole("button", { name: "Accept proposal" })).toBeEnabled();
            expect(within(region).queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
            expect(within(region).queryByText("When")).not.toBeInTheDocument();
            expect(region).not.toHaveTextContent("You are the organizer");
        });

        it("names the proposer even when the proposal has no time", async () => {
            await renderCard(counter({ startDate: undefined, reply: undefined, attendees: [{ address: "amy@example.com" }] }));
            expect(screen.getByRole("region")).toHaveTextContent("amy@example.com proposed a new time.");
        });

        it("accepts the proposal, busy meanwhile, then says so", async () => {
            const user = userEvent.setup();
            let finish!: (response: Response) => void;
            const fetchMock = mockInviteServer(
                () => jsonResponse(200, counter()),
                () => new Promise<Response>((resolve) => (finish = resolve)),
            );
            render(<InviteCard messageUid="m/1" />);
            await user.click(await screen.findByRole("button", { name: "Accept proposal" }));

            expect(screen.getByRole("button", { name: "Accept proposal" })).toBeDisabled();
            expect(screen.getByRole("button", { name: "Accept proposal" })).toHaveAttribute("aria-busy", "true");
            finish(jsonResponse(200, counter({ response: "accepted", canAcceptProposal: false })));

            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("You accepted the proposed time."));
            expect(screen.queryByRole("button", { name: "Accept proposal" })).not.toBeInTheDocument();
            expect(fetchMock).toHaveBeenLastCalledWith("/api/mail/calendar-events/invite/m%2F1/accept-proposal", expect.objectContaining({ method: "POST" }));
            expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
        });

        it("hides the button once the proposal is accepted even if the server still offers it", async () => {
            await renderCard(counter({ response: "accepted" }));
            expect(screen.queryByRole("button", { name: "Accept proposal" })).not.toBeInTheDocument();
            expect(screen.getByRole("status")).toHaveTextContent("You accepted the proposed time.");
        });

        it("raises a pop-up and leaves the button when accepting fails", async () => {
            const user = userEvent.setup();
            mockInviteServer(
                () => jsonResponse(200, counter()),
                () => jsonResponse(409, { message: "The meeting has changed" }),
            );
            render(<InviteCard messageUid="m1" />);
            await user.click(await screen.findByRole("button", { name: "Accept proposal" }));

            await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title: "Couldn't accept the proposed time" }]));
            expect(screen.getByRole("button", { name: "Accept proposal" })).toBeEnabled();
            expect(screen.queryByRole("status")).not.toBeInTheDocument();
        });
    });

    describe("conflicts", () => {
        const entry = (uid: string, title: string) => ({ uid, title, startDate: "2026-06-16T14:30:00.000Z", endDate: "2026-06-16T15:00:00.000Z", allDay: false, busy: true, tentative: false });

        it("names the events a request conflicts with", async () => {
            await renderCard(inviteFixture({ conflicts: [entry("e1", "Standup"), entry("e2", "")] }));
            expect(screen.getByRole("region")).toHaveTextContent("Conflicts with: Standup, (no title)");
        });

        it("leaves the line out when there are none, or for a cancellation", async () => {
            const { unmount } = await renderCard(inviteFixture());
            expect(screen.getByRole("region")).not.toHaveTextContent("Conflicts");
            unmount();

            await renderCard(inviteFixture({ method: "CANCEL", canRespond: false, conflicts: [entry("e1", "Standup")] }));
            expect(screen.getByRole("region")).not.toHaveTextContent("Conflicts");
        });

        it("counts the rest of a long list", () => {
            expect(conflictSummary([{ title: "A" }, { title: "B" }, { title: "C" }])).toBe("A, B, C");
            expect(conflictSummary([{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }, { title: "E" }])).toBe("A, B, C and 2 more");
        });

        it("copes with an answer that leaves the lists out", async () => {
            const partial: Partial<MessageInvite> = inviteFixture();
            delete partial.conflicts;
            delete partial.schedule;
            delete partial.attendees;
            await renderCard(partial as MessageInvite);
            expect(screen.getByRole("region")).toBeInTheDocument();
        });
    });

    describe("Propose new time", () => {
        const proposable = () => inviteFixture({ canPropose: true });

        it("is offered only when the server says the reader can, and opens a form prefilled with the invitation's own time", async () => {
            const { unmount } = await renderCard(inviteFixture());
            expect(screen.queryByRole("button", { name: "Propose new time" })).not.toBeInTheDocument();
            unmount();

            const user = userEvent.setup();
            await renderCard(proposable());
            await user.click(screen.getByRole("button", { name: "Propose new time" }));

            const form = screen.getByRole("form", { name: "Propose a new time" });
            expect(within(form).getByLabelText("Date")).toHaveValue("2026-06-16");
            expect(within(form).getByLabelText("Start")).toHaveValue("14:00");
            expect(within(form).getByLabelText("End")).toHaveValue("15:30");
            expect(screen.queryByRole("button", { name: "Propose new time" })).not.toBeInTheDocument();
        });

        it("closes without sending on Cancel", async () => {
            const user = userEvent.setup();
            const { fetchMock } = await renderCard(proposable());
            await user.click(screen.getByRole("button", { name: "Propose new time" }));
            await user.click(screen.getByRole("button", { name: "Cancel" }));

            expect(screen.queryByRole("form")).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Propose new time" })).toBeInTheDocument();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("sends the proposed instants and comment, then says it was sent", async () => {
            const user = userEvent.setup();
            const fetchMock = mockInviteServer(
                () => jsonResponse(200, proposable()),
                () => jsonResponse(200, proposable()),
            );
            render(<InviteCard messageUid="m/1" />);
            await user.click(await screen.findByRole("button", { name: "Propose new time" }));
            const form = screen.getByRole("form");
            fireEvent.change(within(form).getByLabelText("Date"), { target: { value: "2026-06-18" } });
            fireEvent.change(within(form).getByLabelText("Start"), { target: { value: "09:00" } });
            fireEvent.change(within(form).getByLabelText("End"), { target: { value: "10:15" } });
            await user.type(within(form).getByLabelText("Comment (optional)"), "  Thursday is better  ");
            await user.click(within(form).getByRole("button", { name: "Send proposal" }));

            await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Your proposed time was sent to the organizer."));
            expect(fetchMock).toHaveBeenLastCalledWith(
                "/api/mail/calendar-events/invite/m%2F1/propose",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ startDate: "2026-06-18T09:00:00.000Z", endDate: "2026-06-18T10:15:00.000Z", comment: "Thursday is better" }),
                }),
            );
            expect(screen.queryByRole("form")).not.toBeInTheDocument();
        });

        it("sends no comment when the field is blank", async () => {
            const user = userEvent.setup();
            const fetchMock = mockInviteServer(
                () => jsonResponse(200, proposable()),
                () => jsonResponse(200, proposable()),
            );
            render(<InviteCard messageUid="m1" />);
            await user.click(await screen.findByRole("button", { name: "Propose new time" }));
            await user.click(screen.getByRole("button", { name: "Send proposal" }));

            await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
            expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ startDate: "2026-06-16T14:00:00.000Z", endDate: "2026-06-16T15:30:00.000Z" });
        });

        it("keeps the form and raises a pop-up when sending fails, busy while it does", async () => {
            const user = userEvent.setup();
            let fail!: (response: Response) => void;
            mockInviteServer(
                () => jsonResponse(200, proposable()),
                () => new Promise<Response>((resolve) => (fail = resolve)),
            );
            render(<InviteCard messageUid="m1" />);
            await user.click(await screen.findByRole("button", { name: "Propose new time" }));
            await user.click(screen.getByRole("button", { name: "Send proposal" }));

            expect(screen.getByRole("button", { name: "Send proposal" })).toBeDisabled();
            expect(screen.getByLabelText("Date")).toBeDisabled();
            fail(jsonResponse(500, { message: "Boom" }));

            await waitFor(() => expect(getNotificationsSnapshot().visible).toMatchObject([{ kind: "error", title: "Couldn't send the proposed time" }]));
            expect(screen.getByRole("form")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Send proposal" })).toBeEnabled();
            expect(screen.queryByRole("status")).not.toBeInTheDocument();
        });
    });

    it("draws a method it does not know as a plain calendar event", async () => {
        await renderCard(inviteFixture({ method: "x-custom", canRespond: false }));
        expect(screen.getByRole("region", { name: "Calendar event" })).toBeInTheDocument();
    });
});
