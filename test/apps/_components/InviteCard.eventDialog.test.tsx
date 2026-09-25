// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MessageInvite } from "@rapidmx/react-shared/calendar/inviteApi.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import InviteCard from "../../../apps/shared/components/mail/InviteCard.js";
import { clearInviteCache } from "../../../apps/shared/components/mail/invite/inviteStore.js";
import { dismissAll, getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";

// What an invitation in a message says of the event dialog's fields - its description, who may do what, a guest's request to change it, and the
// organizer's card for such a request. The suite runs in UTC (vitest.config.ts).

beforeAll(() => {
    const noRects = { length: 0, item: () => null, [Symbol.iterator]: () => [][Symbol.iterator]() };
    Range.prototype.getClientRects = () => noRects;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
});

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
        timezone: "UTC",
        organizer: { address: "boss@example.com", displayName: "The Boss" },
        attendees: [
            { address: "me@example.com", displayName: "Me", responseStatus: "needs-action" },
            { address: "amy@example.com", responseStatus: "accepted" },
        ],
        recurring: false,
        isOrganizer: false,
        onCalendar: true,
        calendarEventUid: "ev1",
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

afterEach(() => {
    vi.unstubAllGlobals();
    clearInviteCache();
    dismissAll();
});

async function renderCard(invite: MessageInvite, extra: (url: string, init: RequestInit) => Response | undefined = () => undefined) {
    clearInviteCache();
    const fetchMock = mockFetch((url, init) => ((init?.method ?? "GET") === "GET" ? jsonResponse(200, invite) : extra(url, init)));
    render(<InviteCard messageUid="m1" />);
    await screen.findByRole("region");
    return fetchMock;
}

describe("InviteCard: the description, visibility and what guests may do", () => {
    it("shows the description as rich text and its links, never as markup", async () => {
        await renderCard(
            inviteFixture({
                descriptionHtml: '<p>Bring <b>slides</b> and <a href="https://example.com/agenda">the agenda</a></p><script>window.hacked = true</script><img src="https://tracker.example/x.png">',
                description: "Bring slides and the agenda",
            }),
        );
        const region = screen.getByRole("region");
        expect(within(region).getByText("Description")).toBeInTheDocument();
        expect(within(region).getByRole("link", { name: "the agenda" })).toHaveAttribute("href", "https://example.com/agenda");
        expect(within(region).getByRole("link", { name: "the agenda" })).toHaveAttribute("rel", "noopener noreferrer");
        expect(region.querySelector("script, img")).toBeNull();
        expect((window as unknown as { hacked?: boolean }).hacked).toBeUndefined();
    });

    it("shows a plain-text description, and no row when there is none", async () => {
        await renderCard(inviteFixture({ description: "Just words" }));
        expect(screen.getByText("Just words")).toBeInTheDocument();
    });

    it("has no Description row for an invitation without one", async () => {
        await renderCard(inviteFixture());
        expect(screen.queryByText("Description")).not.toBeInTheDocument();
    });

    it("says what guests may do, and the visibility when it is not the default", async () => {
        await renderCard(
            inviteFixture({
                visibility: "confidential",
                guestPermissions: { guestsCanModify: true, guestsCanInviteOthers: true, guestsCanSeeGuestList: true },
            }),
        );
        expect(screen.getByText("Guests can modify the event, invite others and see the guest list.")).toBeInTheDocument();
        expect(screen.getByText("Visibility")).toBeInTheDocument();
        expect(screen.getByText("Confidential")).toBeInTheDocument();
    });

    it("says nothing of the visibility when it is the default, nor of guest permissions an older server did not send", async () => {
        await renderCard(inviteFixture({ visibility: "default" }));
        expect(screen.queryByText("Visibility")).not.toBeInTheDocument();
        expect(screen.queryByText(/^Guests can/)).not.toBeInTheDocument();
    });

    it("reads a permission the server left out as its default", async () => {
        await renderCard(inviteFixture({ guestPermissions: { guestsCanModify: true } }));
        expect(screen.getByText("Guests can modify the event, invite others and see the guest list.")).toBeInTheDocument();
    });

    it("says the organizer hid the guest list, instead of naming the only guest a hidden list leaves", async () => {
        await renderCard(
            inviteFixture({
                attendees: [{ address: "me@example.com", displayName: "Me", responseStatus: "needs-action" }],
                guestPermissions: { guestsCanSeeGuestList: false },
            }),
        );
        expect(screen.getByText("The organizer has hidden the guest list")).toBeInTheDocument();
        expect(screen.queryByText(/1 attendee/)).not.toBeInTheDocument();
    });

    it("lists the guests for the organizer, whatever the flag says", async () => {
        await renderCard(inviteFixture({ isOrganizer: true, canRespond: false, guestPermissions: { guestsCanSeeGuestList: false } }));
        expect(screen.getByText(/2 attendees/)).toBeInTheDocument();
        expect(screen.queryByText("The organizer has hidden the guest list")).not.toBeInTheDocument();
    });

    it("keeps the permissions and description off a cancellation and a reply", async () => {
        await renderCard(inviteFixture({ method: "CANCEL", canRespond: false, guestPermissions: { guestsCanModify: true } }));
        expect(screen.queryByText(/^Guests can/)).not.toBeInTheDocument();
    });
});

describe("InviteCard: Request a change", () => {
    it("is a button when the organizer lets guests change the event, opening the form, sending the request and saying it went out", async () => {
        const user = userEvent.setup();
        const fetchMock = await renderCard(
            inviteFixture({ canRequestChange: true, canRequestInvite: true }),
            (url) => (url === "/api/mail/calendar-events/ev1/request-change" ? jsonResponse(200, { requested: true, changes: ["title"], addAttendees: [] }) : undefined),
        );

        await user.click(screen.getByRole("button", { name: "Request a change" }));
        expect(screen.queryByRole("button", { name: "Request a change" })).not.toBeInTheDocument();
        const form = screen.getByRole("form", { name: "Request a change" });
        expect(within(form).getByLabelText("Title")).toHaveValue("Quarterly planning");
        expect(within(form).getByLabelText("Location")).toHaveValue("Room 4");
        expect(within(form).getByLabelText("Starts")).toHaveValue("2026-06-16T14:00");
        await user.clear(within(form).getByLabelText("Title"));
        await user.type(within(form).getByLabelText("Title"), "Q3 planning");
        await user.click(within(form).getByRole("button", { name: "Send request" }));

        await waitFor(() => expect(screen.queryByRole("form", { name: "Request a change" })).not.toBeInTheDocument());
        const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
        expect(post[0]).toBe("/api/mail/calendar-events/ev1/request-change");
        expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ title: "Q3 planning" });
        expect(screen.getByText("Your change was sent to the organizer.")).toBeInTheDocument();
        expect(getNotificationsSnapshot().visible).toEqual([expect.objectContaining({ kind: "success", title: "Your change was sent to the organizer" })]);
        // The invitation itself is what it was.
        expect(screen.getByRole("button", { name: "Request a change" })).toBeInTheDocument();
    });

    it("is Add guests when only inviting is allowed, with just the guests field", async () => {
        const user = userEvent.setup();
        await renderCard(inviteFixture({ canRequestInvite: true }));

        await user.click(screen.getByRole("button", { name: "Add guests" }));
        const form = screen.getByRole("form", { name: "Add guests" });
        expect(within(form).queryByLabelText("Title")).not.toBeInTheDocument();
        expect(within(form).getByLabelText("Guests to add")).toBeInTheDocument();
        await user.click(within(form).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("form")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add guests" })).toBeInTheDocument();
    });

    it("is not offered without a calendar event to send it about, or when the server says neither is allowed", async () => {
        await renderCard(inviteFixture({ canRequestChange: true, canRequestInvite: true, calendarEventUid: undefined, onCalendar: false }));
        expect(screen.queryByRole("button", { name: "Request a change" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add guests" })).not.toBeInTheDocument();
    });

    it("is not offered when the server does not say guests may", async () => {
        await renderCard(inviteFixture({ canRequestChange: false, canRequestInvite: false }));
        expect(screen.queryByRole("button", { name: "Request a change" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add guests" })).not.toBeInTheDocument();
    });

    it("does not offer the time of a series", async () => {
        const user = userEvent.setup();
        await renderCard(inviteFixture({ canRequestChange: true, recurring: true }));
        await user.click(screen.getByRole("button", { name: "Request a change" }));
        expect(screen.queryByLabelText("Starts")).not.toBeInTheDocument();
    });

    it("starts a title that is missing from the invitation from nothing", async () => {
        const user = userEvent.setup();
        await renderCard(inviteFixture({ canRequestChange: true, summary: undefined }));
        await user.click(screen.getByRole("button", { name: "Request a change" }));
        expect(screen.getByLabelText("Title")).toHaveValue("");
    });
});

describe("InviteCard: a guest's change request received by the organizer", () => {
    const counter = (applied: boolean, overrides: Partial<MessageInvite> = {}) =>
        inviteFixture({
            method: "COUNTER",
            isOrganizer: true,
            canRespond: false,
            reply: { address: "amy@example.com", displayName: "Amy", responseStatus: "accepted" },
            changeRequest: { applied },
            canAcceptProposal: !applied,
            ...overrides,
        });

    it("says whose change was applied, with what it changed the event to", async () => {
        await renderCard(counter(true, { summary: "Q3 planning", description: "New agenda" }));
        const region = screen.getByRole("region", { name: "Change requested" });
        expect(region).toHaveTextContent("Amy’s change was applied.");
        expect(within(region).getByText("Q3 planning")).toBeInTheDocument();
        expect(within(region).getByText("Tue, Jun 16, 2026, 2:00 PM - 3:30 PM UTC".replace(/ /g, " "), { exact: false })).toBeInTheDocument();
        expect(within(region).getByText("Room 4")).toBeInTheDocument();
        expect(within(region).getByText("New agenda")).toBeInTheDocument();
        // It was applied: there is nothing to accept, and no "You accepted the proposed time."
        expect(within(region).queryByRole("button", { name: "Accept proposal" })).not.toBeInTheDocument();
        expect(within(region).queryByText("You accepted the proposed time.")).not.toBeInTheDocument();
        expect(within(region).queryByText(/proposed a new time/)).not.toBeInTheDocument();
    });

    it("says whose change was requested when it was not applied, and still offers to accept the proposed time", async () => {
        await renderCard(counter(false));
        const region = screen.getByRole("region", { name: "Change requested" });
        expect(region).toHaveTextContent("Amy requested a change.");
        expect(within(region).getByRole("button", { name: "Accept proposal" })).toBeInTheDocument();
    });

    it("keeps the wording of a plain proposed time for a COUNTER that is not a change request", async () => {
        await renderCard(counter(false, { changeRequest: undefined }));
        expect(screen.getByRole("region", { name: "New time proposed" })).toHaveTextContent("Amy proposed a new time");
        expect(screen.queryByText(/requested a change/)).not.toBeInTheDocument();
    });

    it("still says the organizer accepted a time they accepted by hand", async () => {
        await renderCard(counter(false, { response: "accepted" }));
        expect(screen.getByText("You accepted the proposed time.")).toBeInTheDocument();
    });
});
