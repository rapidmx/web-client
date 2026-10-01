// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import CalendarPageBase from "../../../apps/www/calendar/index.js";
import { withTestRouter } from "../routerTestUtils.js";

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const CalendarPage = withTestRouter(CalendarPageBase);

// See `index.test.tsx`: dnd-kit's real sensors cannot be driven from jsdom.
vi.mock("@dnd-kit/core", async () => {
    const actual = await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
    return { ...actual, useSensors: () => [] };
});

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};
const calendarFolder = {
    uid: "f-cal",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Calendar",
    type: "calendar" as const,
    unreadCount: 0,
    totalCount: 0,
    color: "#2563eb",
};
const secondCalendarFolder = { ...calendarFolder, uid: "f-cal2", name: "Personal", color: "#dc2626" };

function calendarEvent(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        uid: "e1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        folderUid: "f-cal",
        title: "Standup",
        startDate: "2026-06-15T15:00:00.000Z",
        endDate: "2026-06-15T15:30:00.000Z",
        allDay: false,
        timezone: "UTC",
        organizer: { address: "u1@example.com", type: "to" as const },
        attendees: [],
        status: "confirmed" as const,
        busyStatus: "busy" as const,
        icalUid: "abc",
        sequence: 0,
        ...overrides,
    };
}

const at = (day: number, hour: number, month = 5) => new Date(2026, month, day, hour).toISOString();
const timed = (uid: string, title: string, day: number, month = 5, hour = 10) =>
    calendarEvent({ uid, title, startDate: at(day, hour, month), endDate: at(day, hour + 1, month) });

const early = timed("a", "Offsite early", 10);
const standup = timed("b", "Standup", 15);
const midday = timed("c", "Offsite midday", 15, 5, 13);
const july = timed("d", "Offsite july", 20, 6);
// Own organizer, so that it can be modified.
const mine = calendarEvent({ uid: "m", title: "Mine", startDate: at(16, 10), endDate: at(16, 11), organizer: { address: "u1@example.com", type: "to" as const } });

function mockShellAndEvents(events: unknown[], folders: unknown[] = [calendarFolder], byFolder?: Record<string, unknown[]>) {
    return mockFetch((url, init) => {
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
        if (url.startsWith("/api/mail/calendar-events") && (init?.method ?? "GET") === "GET") {
            const folderUid = new URL(url, "http://x").searchParams.get("folderUid") ?? "";
            return jsonResponse(200, byFolder?.[folderUid] ?? events);
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}



let scrolled: HTMLElement[] = [];
beforeEach(() => {
    window.history.pushState(null, "", "/calendar?date=2026-06-15");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T09:00:00"));
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: HTMLElement) {
        scrolled.push(this);
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (Element.prototype as { animate?: unknown }).animate;
    window.history.pushState(null, "", "/");
});

const dialog = () => screen.getByRole("dialog", { name: "Event details" });
const slideOf = () => dialog().querySelector("[data-slide-from]")?.getAttribute("data-slide-from");

async function openCard(title: string, url = "/calendar?date=2026-06-15&view=month") {
    window.history.pushState(null, "", url);
    const user = userEvent.setup();
    render(<CalendarPage userUid="u1" />);
    await user.click(await screen.findByText(new RegExp(title)));
    await screen.findByRole("dialog", { name: "Event details" });
    return user;
}

describe("the event card's Previous and Next, without a search", () => {
    it("steps through every event in order, moving the view with it and sliding from the side of the button", async () => {
        const animate = vi.fn();
        Element.prototype.animate = animate;
        mockShellAndEvents([timed("z", "Zebra", 15, 5, 10), midday, standup, early, july]);
        const user = await openCard("Standup");

        // Standup 10:00 and Zebra 10:00 tie on start (title breaks it); then midday.
        expect(within(dialog()).getByRole("button", { name: "Previous event" })).not.toHaveAttribute("aria-disabled");
        await user.click(within(dialog()).getByRole("button", { name: "Next event" }));
        expect(within(dialog()).getByText("Zebra")).toBeInTheDocument();
        expect(slideOf()).toBe("right");
        await user.keyboard("{ArrowRight}");
        expect(within(dialog()).getByText("Offsite midday")).toBeInTheDocument();
        await user.click(within(dialog()).getByRole("button", { name: "Next event" }));
        expect(within(dialog()).getByText("Offsite july")).toBeInTheDocument();
        expect(await screen.findByRole("heading", { name: "July 2026" })).toBeInTheDocument();
        expect(animate).toHaveBeenCalledTimes(3);

        // No wrap-around: the last event has nothing after it, and nothing moves.
        const next = within(dialog()).getByRole("button", { name: "Next event" });
        expect(next).toHaveAttribute("aria-disabled", "true");
        await user.click(next);
        await user.keyboard("{ArrowRight}");
        expect(within(dialog()).getByText("Offsite july")).toBeInTheDocument();
        expect(animate).toHaveBeenCalledTimes(3);

        await user.click(within(dialog()).getByRole("button", { name: "Previous event" }));
        expect(slideOf()).toBe("left");
        expect(await screen.findByRole("heading", { name: "June 2026" })).toBeInTheDocument();
        await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
        expect(within(dialog()).getByText("Offsite early")).toBeInTheDocument();
        expect(within(dialog()).getByRole("button", { name: "Previous event" })).toHaveAttribute("aria-disabled", "true");
        await user.keyboard("{ArrowLeft}");
        expect(within(dialog()).getByText("Offsite early")).toBeInTheDocument();
    });

    for (const view of ["week", "workWeek", "day", "split", "list"]) {
        it(`is on the card in the ${view} view`, async () => {
            mockShellAndEvents([standup, july]);
            const user = await openCard("Standup", `/calendar?date=2026-06-15&view=${view}`);

            expect(within(dialog()).getByRole("button", { name: "Previous event" })).toBeInTheDocument();
            await user.click(within(dialog()).getByRole("button", { name: "Next event" }));
            expect(within(dialog()).getByText("Offsite july")).toBeInTheDocument();
        });
    }

    it("keeps the view's type and, in the list, only goes through what is from today on", async () => {
        mockShellAndEvents([early, standup]);
        const user = await openCard("Standup", "/calendar?date=2026-06-15&view=list");

        // The 10th is past: nothing in the List before today.
        expect(within(dialog()).getByRole("button", { name: "Previous event" })).toHaveAttribute("aria-disabled", "true");
        await user.click(within(dialog()).getByRole("button", { name: "Close" }));

        await user.click(screen.getByRole("button", { name: "Week" }));
        await user.click(await screen.findByText(/Standup/));
        await user.click(within(dialog()).getByRole("button", { name: "Previous event" }));
        expect(within(dialog()).getByText("Offsite early")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Week" })).toHaveClass("bg-primary");
    });

    it("steps on from where the event was when it is no longer in the sequence", async () => {
        mockShellAndEvents([early, standup, july]);
        const user = await openCard("Standup");
        // A search that the open event is not a match of: Next and Previous go to the matches either side of where it stands.
        fireEvent.change(screen.getByRole("textbox", { name: "Search events" }), { target: { value: "offsite" } });
        await waitFor(() => expect(within(dialog()).getByRole("button", { name: "Next match" })).toBeInTheDocument());
        await user.click(within(dialog()).getByRole("button", { name: "Next match" }));
        expect(within(dialog()).getByText("Offsite july")).toBeInTheDocument();
    });

    it("is not on a card being edited", async () => {
        mockShellAndEvents([mine, standup]);
        const user = await openCard("Mine");
        expect(within(dialog()).getByRole("button", { name: "Next event" })).toBeInTheDocument();

        await user.click(within(dialog()).getByRole("button", { name: "Modify" }));
        const editor = await screen.findByRole("dialog", { name: "Edit event" });
        expect(within(editor).queryByRole("button", { name: "Next event" })).not.toBeInTheDocument();
        expect(within(editor).queryByRole("button", { name: "Previous event" })).not.toBeInTheDocument();
    });
});
