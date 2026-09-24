// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockMatchMedia } from "../testUtils.js";
import CalendarPageRouted from "../../../apps/www/calendar/index.js";
import { SWIPE_PERIOD_SHIFT } from "../../../apps/shared/components/calendar/swipeNavigation.js";

const CalendarPage = CalendarPageRouted.page;

// See index.test.tsx: the real dnd-kit sensors can't be driven from jsdom, and the swipe under test is a plain touch handler.
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
const standup = {
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
};

function mockShellAndEvents() {
    return mockFetch((url) => {
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [calendarFolder]);
        if (url.startsWith("/api/mail/calendar-events")) return jsonResponse(200, [standup]);
        throw new Error(`unexpected ${url}`);
    });
}

type View = "month" | "week" | "day";

/** The horizontal distance of a swipe that shows the previous (`-1`) or next (`1`) period, whichever way `SWIPE_PERIOD_SHIFT` says. */
function dxFor(shift: 1 | -1, distance = 150): number {
    const direction = (Object.keys(SWIPE_PERIOD_SHIFT) as (keyof typeof SWIPE_PERIOD_SHIFT)[]).find((d) => SWIPE_PERIOD_SHIFT[d] === shift)!;
    return direction === "left" ? -distance : distance;
}

/** One-finger drag on `target` from (200, 300) by (`dx`, `dy`), `ms` long. */
function drag(target: Element, dx: number, dy = 0, ms = 50) {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const from = { clientX: 200, clientY: 300 };
    const to = { clientX: 200 + dx, clientY: 300 + dy };
    fireEvent.touchStart(target, { touches: [from] });
    now += ms;
    fireEvent.touchMove(target, { touches: [to] });
    fireEvent.touchEnd(target, { touches: [], changedTouches: [to] });
    spy.mockRestore();
}

async function renderCalendar(view: View, heading: string) {
    window.history.pushState(null, "", `/calendar?date=2026-06-15&view=${view}`);
    mockShellAndEvents();
    render(<CalendarPage userUid="u1" />);
    await screen.findByRole("heading", { name: heading });
    await screen.findByText(/Standup/);
}

/** An element inside the view area to swipe on: the month grid, or the hour labels of the time grid. */
function body(view: View): Element {
    return view === "month" ? screen.getByRole("grid", { name: "Month" }) : screen.getByText("1AM");
}

const CASES = [
    { view: "month" as const, current: "June 2026", previous: "May 2026", next: "July 2026" },
    { view: "week" as const, current: "Jun 15 – Jun 21, 2026", previous: "Jun 8 – Jun 14, 2026", next: "Jun 22 – Jun 28, 2026" },
    { view: "day" as const, current: "Monday, June 15, 2026", previous: "Sunday, June 14, 2026", next: "Tuesday, June 16, 2026" },
];

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState(null, "", "/");
});

describe("CalendarPage swipe navigation", () => {
    it("maps swiping left to the next period and swiping right to the previous", () => {
        expect(SWIPE_PERIOD_SHIFT).toEqual({ left: 1, right: -1 });
    });

    describe("the mouse wheel", () => {
        beforeEach(() => {
            // A desktop that has not asked for less motion.
            vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
        });

        /** The scroller of a time grid, told how tall it is (jsdom lays nothing out) and where it is scrolled to. */
        function scroller(scrollTop: number, scrollHeight = 1152, clientHeight = 500): HTMLElement {
            const element = document.querySelector("[data-calendar-scroller]") as HTMLElement;
            let top = scrollTop;
            Object.defineProperty(element, "scrollTop", { get: () => top, set: (value: number) => (top = value), configurable: true });
            Object.defineProperty(element, "scrollHeight", { value: scrollHeight, configurable: true });
            Object.defineProperty(element, "clientHeight", { value: clientHeight, configurable: true });
            return element;
        }

        it("steps through the months, one for each notch, for as long as the wheel turns", async () => {
            await renderCalendar("month", "June 2026");
            const grid = body("month");

            expect(fireEvent.wheel(grid, { deltaY: 100 })).toBe(false);
            expect(await screen.findByRole("heading", { name: "July 2026" })).toBeInTheDocument();
            // No waiting for the slide: the next turn steps at once, and a big one steps twice.
            fireEvent.wheel(body("month"), { deltaY: 100 });
            fireEvent.wheel(body("month"), { deltaY: 200 });
            expect(await screen.findByRole("heading", { name: "October 2026" })).toBeInTheDocument();

            for (let i = 0; i < 6; i++) {
                fireEvent.wheel(body("month"), { deltaY: -100 });
            }
            expect(await screen.findByRole("heading", { name: "April 2026" })).toBeInTheDocument();
        });

        it("slides the new month in from below when scrolling on and from above when scrolling back", async () => {
            await renderCalendar("month", "June 2026");
            const slid = () => document.querySelector("[data-swipe-phase] > div") as HTMLElement;

            fireEvent.wheel(body("month"), { deltaY: 100 });
            expect(slid().style.transform).toBe("translate3d(0, 56px, 0)");
            await waitFor(() => expect(slid().style.transform).toBe(""));

            fireEvent.wheel(body("month"), { deltaY: -100 });
            expect(slid().style.transform).toBe("translate3d(0, -56px, 0)");
        });

        it("scrolls the hours of a day with the wheel, and only past the last one carries on into the next day", async () => {
            await renderCalendar("day", "Monday, June 15, 2026");
            const hours = scroller(0);

            // Room to scroll: the browser does it.
            expect(fireEvent.wheel(hours, { deltaY: 200 })).toBe(true);
            expect(screen.getByRole("heading", { name: "Monday, June 15, 2026" })).toBeInTheDocument();

            // At the bottom, pushing on goes to the next day, which starts at its first hour.
            hours.scrollTop = 652;
            expect(fireEvent.wheel(hours, { deltaY: 100 })).toBe(false);
            expect(await screen.findByRole("heading", { name: "Tuesday, June 16, 2026" })).toBeInTheDocument();
            expect(hours.scrollTop).toBe(0);
        });

        it("carries back into the previous day, arriving at its last hour", async () => {
            await renderCalendar("day", "Monday, June 15, 2026");
            const hours = scroller(0);
            expect(fireEvent.wheel(hours, { deltaY: -100 })).toBe(false);
            expect(await screen.findByRole("heading", { name: "Sunday, June 14, 2026" })).toBeInTheDocument();
            expect(hours.scrollTop).toBe(1152);
        });

        it("does the same for the week", async () => {
            await renderCalendar("week", "Jun 15 – Jun 21, 2026");
            const hours = scroller(652);
            fireEvent.wheel(hours, { deltaY: 100 });
            expect(await screen.findByRole("heading", { name: "Jun 22 – Jun 28, 2026" })).toBeInTheDocument();
            expect(hours.scrollTop).toBe(0);
        });

        it("leaves the wheel alone on a phone", async () => {
            vi.stubGlobal("matchMedia", (query: string) => ({ matches: !query.includes("prefers-reduced-motion"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
            await renderCalendar("month", "June 2026");
            expect(fireEvent.wheel(body("month"), { deltaY: 300 })).toBe(true);
            expect(screen.getByRole("heading", { name: "June 2026" })).toBeInTheDocument();
        });

        it("leaves the wheel alone while the event editor is open", async () => {
            await renderCalendar("month", "June 2026");
            await userEvent.setup().click(screen.getByText(/Standup/));
            await screen.findByRole("dialog");
            fireEvent.wheel(body("month"), { deltaY: 300 });
            expect(screen.getByRole("heading", { name: "June 2026" })).toBeInTheDocument();
        });
    });

    describe("the slide", () => {
        beforeEach(() => {
            // A phone that has not asked for less motion (`mockMatchMedia()` answers every query alike, reduced motion included).
            vi.stubGlobal("matchMedia", (query: string) => ({
                matches: !query.includes("prefers-reduced-motion"),
                media: query,
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
            }));
        });

        const content = () => document.querySelector("[data-swipe-phase]") as HTMLElement;

        for (const { view, current, next } of CASES) {
            it(`${view} view: the view follows the finger, slides out, and the next period slides in`, async () => {
                await renderCalendar(view, current);
                expect(content().dataset.swipePhase).toBe("idle");

                const dx = dxFor(1);
                drag(body(view), dx);

                // Leaving the way the finger went: off to that side, animated, and still showing the period it was on.
                expect(content().dataset.swipePhase).toBe("sliding");
                expect(content().style.transform.startsWith(dx < 0 ? "translate3d(-" : "translate3d(")).toBe(true);
                expect(content().style.transform.startsWith("translate3d(-")).toBe(dx < 0);
                expect(content().style.transition).toContain("transform");
                expect(screen.getByRole("heading", { name: current })).toBeInTheDocument();

                // Then the period changes and it arrives from the other side, ending where it started.
                expect(await screen.findByRole("heading", { name: next })).toBeInTheDocument();
                await waitFor(() => expect(content().dataset.swipePhase).toBe("idle"));
                expect(content().style.transform).toBe("");
            });
        }

        it("moves nothing on a desktop, whatever the motion settings", async () => {
            vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
            await renderCalendar("week", "Jun 15 – Jun 21, 2026");
            drag(body("week"), dxFor(1));
            expect(content().dataset.swipePhase).toBe("idle");
            expect(content().style.transform).toBe("");
        });
    });

    describe("on the phone layout", () => {
        beforeEach(() => {
            mockMatchMedia(true);
        });

        for (const { view, current, previous, next } of CASES) {
            it(`${view} view: swipes to the previous and the next period`, async () => {
                await renderCalendar(view, current);

                drag(body(view), dxFor(-1));
                expect(await screen.findByRole("heading", { name: previous })).toBeInTheDocument();

                drag(body(view), dxFor(1));
                drag(body(view), dxFor(1));
                expect(await screen.findByRole("heading", { name: next })).toBeInTheDocument();
            });

            it(`${view} view: a mostly vertical drag, a short drag and a slow one do nothing`, async () => {
                await renderCalendar(view, current);

                drag(body(view), dxFor(-1, 60), 200);
                drag(body(view), dxFor(1, 30));
                drag(body(view), dxFor(1, 60), 0, 1000);
                expect(screen.getByRole("heading", { name: current })).toBeInTheDocument();
            });
        }

        it("a quick fling shorter than the full distance still changes the period", async () => {
            await renderCalendar("month", "June 2026");

            drag(body("month"), dxFor(-1, 50), 0, 40);
            expect(await screen.findByRole("heading", { name: "May 2026" })).toBeInTheDocument();
        });

        it("a tap on a day does not swipe and still opens that day", async () => {
            await renderCalendar("month", "June 2026");
            const grid = body("month");

            fireEvent.touchStart(grid, { touches: [{ clientX: 200, clientY: 300 }] });
            fireEvent.touchEnd(grid, { touches: [], changedTouches: [{ clientX: 200, clientY: 300 }] });
            await userEvent.setup().click(within(grid).getByRole("button", { name: "15" }));

            expect(screen.getByRole("heading", { name: "Monday, June 15, 2026" })).toBeInTheDocument();
        });

        it("ignores swipes on the toolbar", async () => {
            await renderCalendar("month", "June 2026");

            drag(screen.getByRole("heading", { name: "June 2026" }), dxFor(-1));
            expect(screen.getByRole("heading", { name: "June 2026" })).toBeInTheDocument();
        });

        it("ignores swipes while the event editor is open", async () => {
            await renderCalendar("month", "June 2026");
            await userEvent.setup().click(await screen.findByText(/Standup/));
            await screen.findByRole("dialog");

            drag(document.querySelector('[role="grid"]')!, dxFor(-1));
            expect(screen.getByRole("heading", { name: "June 2026", hidden: true })).toBeInTheDocument();
        });
    });

    describe("on the desktop layout", () => {
        beforeEach(() => {
            mockMatchMedia(false);
        });

        for (const { view, current } of CASES) {
            it(`${view} view: touch swipes do nothing`, async () => {
                await renderCalendar(view, current);

                drag(body(view), dxFor(-1));
                drag(body(view), dxFor(1));
                expect(screen.getByRole("heading", { name: current })).toBeInTheDocument();
            });
        }
    });
});
