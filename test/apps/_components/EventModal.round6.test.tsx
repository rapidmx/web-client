// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The event card opens a listed protected event in full as a write does: a row whose sealed content was opened keeps that title, never
// the older per-field one, on the card, in the form and in what a save sends.
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import type { CalendarOccurrence } from "../../../lib/calendar/recurrence.js";
import { clickModify } from "./eventModalHelpers.js";

const sealed = vi.hoisted(() => ({
    // The row's per-field title is the one its sealed content has since replaced.
    openSealedRecord: vi.fn(async (record: any) => ({ ...record, title: "Budget review", location: "Room 4", description: "Agenda", opened: true })),
    isOpenedRecord: vi.fn((record: any) => !!record?.opened),
}));
vi.mock("../../../lib/zeroAccess/sealedRecords.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/zeroAccess/sealedRecords.js")>()),
    ...sealed,
}));

const { default: EventModal } = await import("../../../apps/shared/components/calendar/EventModal.js");
const { markSealedContentOpened } = await import("../../../lib/calendar/protectedEvents.js");

const listed = markSealedContentOpened<CalendarOccurrence>({
    uid: "e1",
    version: 2,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    folderUid: "f1",
    mailboxUid: "mb1",
    title: "Budget review - moved to Q3",
    location: "Room 4",
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
    sealedFields: { title: "c", location: "c", description: "c" },
    sealedContent: { keyFingerprint: "fp", sealed: "x" },
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EventModal - a listed protected event whose sealed content was opened", () => {
    it("shows, edits and saves the sealed content's title, not the older per-field one it opens with the rest", async () => {
        const fetchMock = mockFetch((url, init) => (url === "/api/mail/calendar-events/e1" && init?.method === "PUT" ? jsonResponse(200, listed) : undefined));
        const onSaved = vi.fn();
        const user = userEvent.setup();
        render(
            <EventModal open onClose={vi.fn()} mailboxUid="mb1" folderUid="f1" organizerAddress="jane@example.com" occurrence={listed} onSaved={onSaved} onDeleted={vi.fn()} />,
        );
        await screen.findByRole("button", { name: "Modify" });
        expect(sealed.openSealedRecord).toHaveBeenCalledWith(listed);
        expect(screen.getByText("Budget review - moved to Q3")).toBeInTheDocument();
        expect(screen.queryByText("Budget review")).not.toBeInTheDocument();
        // The rest of it is opened for the card.
        expect(screen.getByText("Agenda")).toBeInTheDocument();

        clickModify();
        expect(screen.getByLabelText("Title")).toHaveValue("Budget review - moved to Q3");
        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
        const body = JSON.parse((put[1] as RequestInit).body as string);
        expect(body.title).toBe("Budget review - moved to Q3");
        expect(JSON.stringify(body)).not.toContain('"Budget review"');
    });
});
