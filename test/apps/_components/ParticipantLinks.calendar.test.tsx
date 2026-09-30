// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The people of an event (its details) and of an invitation (the card in a message) open their contact card when clicked.
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attendee } from "../../../lib/calendar/calendarApi.js";
import type { MessageInvite } from "../../../lib/calendar/inviteApi.js";
import type { CalendarOccurrence } from "../../../lib/calendar/recurrence.js";
import type { Mailbox } from "../../../lib/mail/mailApi.js";
import ContactCardProvider from "../../../apps/shared/components/contacts/ContactCardProvider.js";
import EventModal from "../../../apps/shared/components/calendar/EventModal.js";
import InviteCard from "../../../apps/shared/components/mail/InviteCard.js";
import { clearInviteCache } from "../../../apps/shared/components/mail/invite/inviteStore.js";
import { MailConnectionContext, type MailConnection } from "../../../apps/shared/mail/useMailConnection.js";
import { jsonResponse, mockFetch } from "../testUtils.js";

afterEach(() => {
    vi.unstubAllGlobals();
    clearInviteCache();
});

const ME = { uid: "mb1", ownerUserUid: "u1", primarySmtpAddress: "me@example.com", aliasAddresses: [], displayName: "Me", dateCreated: "2026-01-01T00:00:00.000Z", accessRole: "owner" } as Mailbox;
const CONNECTION = { status: "ready", mailboxes: [ME] } as MailConnection;

function withCards(ui: React.ReactElement) {
    return render(
        <MailConnectionContext.Provider value={CONNECTION}>
            <ContactCardProvider userUid="u1">{ui}</ContactCardProvider>
        </MailConnectionContext.Provider>,
    );
}

function serve(invite?: MessageInvite) {
    mockFetch((url) => {
        const path = url.split("?")[0];
        if (path === "/api/mail/calendar-events/invite/m1") {
            return invite ? jsonResponse(200, invite) : jsonResponse(404, { message: "none" });
        }
        if (path === "/api/mail/search") {
            return jsonResponse(200, { results: [] });
        }
        return jsonResponse(200, []);
    });
}

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
        organizer: { address: "jane@other.org", displayName: "Jane Doe", type: "to" },
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

function inviteFixture(overrides: Partial<MessageInvite> = {}): MessageInvite {
    return {
        method: "REQUEST",
        uid: "ical-1",
        sequence: 0,
        summary: "Quarterly planning",
        startDate: "2026-06-16T14:00:00.000Z",
        endDate: "2026-06-16T15:30:00.000Z",
        allDay: false,
        timezone: "UTC",
        organizer: { address: "boss@other.org", displayName: "The Boss" },
        attendees: [
            { address: "amy@other.org", displayName: "Amy", responseStatus: "accepted" },
            { address: "bob@other.org", responseStatus: "needs-action" },
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

describe("an event's people", () => {
    function renderEvent(occ: CalendarOccurrence) {
        serve();
        return withCards(
            <EventModal open mailboxUid="mb1" folderUid="f1" calendars={[{ uid: "f1", name: "Work" }]} folderColors={{ f1: "rgb(10, 20, 30)" }} organizerAddress="me@example.com" occurrence={occ} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={vi.fn()} />,
        );
    }

    it("opens the organizer's card above the event, and closes back to it", async () => {
        const user = userEvent.setup();
        renderEvent(occurrence());
        await user.click(screen.getByRole("button", { name: "Jane Doe" }));
        expect(await screen.findByRole("dialog", { name: "Jane Doe" })).toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog", { name: "Jane Doe" })).not.toBeInTheDocument();
        expect(screen.getByRole("dialog", { name: "Event details" })).toBeInTheDocument();
    });

    it("opens a guest's card", async () => {
        const user = userEvent.setup();
        renderEvent(occurrence({ attendees: [guest("bob@other.org", { displayName: "Bob Brown" }), guest("amy@other.org")] }));
        await user.click(screen.getByRole("button", { name: "Bob Brown" }));
        expect(await screen.findByRole("dialog", { name: "Bob Brown" })).toBeInTheDocument();
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "amy@other.org" }));
        expect(await screen.findByRole("dialog", { name: "amy" })).toBeInTheDocument();
    });
});

describe("an invitation's people", () => {
    it("opens the organizer's card, with the name and address the invitation gives", async () => {
        serve(inviteFixture());
        const user = userEvent.setup();
        withCards(<InviteCard messageUid="m1" />);
        await user.click(await screen.findByRole("button", { name: "The Boss <boss@other.org>" }));
        expect(await screen.findByRole("dialog", { name: "The Boss" })).toBeInTheDocument();
    });

    it("opens an attendee's card from the list of a few", async () => {
        serve(inviteFixture());
        const user = userEvent.setup();
        withCards(<InviteCard messageUid="m1" />);
        const attendees = (await screen.findByText("Attendees")).nextElementSibling as HTMLElement;
        expect(attendees).toHaveTextContent("2 attendees: Amy, bob@other.org");
        await user.click(within(attendees).getByRole("button", { name: "Amy" }));
        expect(await screen.findByRole("dialog", { name: "Amy" })).toBeInTheDocument();
    });

    it("counts a long list of attendees without naming them", async () => {
        serve(inviteFixture({ attendees: Array.from({ length: 6 }, (_, i) => ({ address: `p${i}@other.org` })) }));
        withCards(<InviteCard messageUid="m1" />);
        expect((await screen.findByText("Attendees")).nextElementSibling).toHaveTextContent(/^6 attendees$/);
    });

    it("opens the card of the person who answered or proposed a time", async () => {
        serve(inviteFixture({ method: "REPLY", reply: { address: "amy@other.org", displayName: "Amy", responseStatus: "declined" }, isOrganizer: true }));
        const user = userEvent.setup();
        withCards(<InviteCard messageUid="m1" />);
        await user.click(await screen.findByRole("button", { name: "Amy" }));
        expect(await screen.findByRole("dialog", { name: "Amy" })).toBeInTheDocument();
    });

    it("names a sender it does not know as plain text", async () => {
        serve(inviteFixture({ method: "REPLY", reply: undefined, attendees: [], isOrganizer: true }));
        withCards(<InviteCard messageUid="m1" />);
        expect(await screen.findByText("Someone")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Someone" })).not.toBeInTheDocument();
    });
});
