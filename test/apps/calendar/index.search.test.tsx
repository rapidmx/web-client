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

const standup = calendarEvent();
const retro = calendarEvent({ uid: "e2", title: "Offsite retro", startDate: "2026-01-12T10:00:00.000Z", endDate: "2026-01-12T11:00:00.000Z" });
const sprint = calendarEvent({
    uid: "e3",
    title: "Offsite sprint",
    location: "Lisbon",
    startDate: "2026-09-08T10:00:00.000Z",
    endDate: "2026-09-08T11:00:00.000Z",
});
const june = calendarEvent({ uid: "e4", title: "Offsite planning", startDate: "2026-06-17T10:00:00.000Z", endDate: "2026-06-17T11:00:00.000Z" });

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
    window.history.pushState(null, "", "/calendar?date=2026-06-15&view=month");
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: HTMLElement) {
        scrolled.push(this);
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState(null, "", "/");
});

function searchStatus() {
    return within(screen.getByRole("search")).getByRole("status");
}

async function openPage() {
    const user = userEvent.setup();
    render(<CalendarPage userUid="u1" />);
    await screen.findByRole("heading", { name: "June 2026" });
    await screen.findByText(/Standup/);
    return { user, input: screen.getByRole("textbox", { name: "Search events" }) };
}

describe("CalendarPage search", () => {
    it("shows only matches, jumping to the first one after the viewed day when none is in view, and steps through them with wrap-around", async () => {
        mockShellAndEvents([standup, retro, sprint]);
        const { user, input } = await openPage();

        await user.type(input, "offsite{Enter}");

        expect(await screen.findByRole("heading", { name: "September 2026" })).toBeInTheDocument();
        expect(searchStatus()).toHaveTextContent("2 of 2");
        expect(screen.getByText(/Offsite sprint/)).toBeInTheDocument();
        expect(scrolled.at(-1)).toHaveAttribute("data-active-match", "true");

        await user.click(screen.getByRole("button", { name: "Next match" }));
        expect(await screen.findByRole("heading", { name: "January 2026" })).toBeInTheDocument();
        expect(searchStatus()).toHaveTextContent("1 of 2");
        expect(screen.queryByText(/Standup/)).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Previous match" }));
        expect(await screen.findByRole("heading", { name: "September 2026" })).toBeInTheDocument();

        // Enter on an unchanged query steps on; Shift+Enter steps back.
        await user.type(input, "{Enter}");
        expect(await screen.findByRole("heading", { name: "January 2026" })).toBeInTheDocument();
        await user.type(input, "{Shift>}{Enter}{/Shift}");
        expect(await screen.findByRole("heading", { name: "September 2026" })).toBeInTheDocument();
    });

    it("stays on the viewed month when it holds a match, hiding what does not match", async () => {
        mockShellAndEvents([standup, june, retro]);
        const { user, input } = await openPage();

        await user.type(input, "offsite{Enter}");

        expect(await screen.findByText(/Offsite planning/)).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "June 2026" })).toBeInTheDocument();
        expect(screen.queryByText(/Standup/)).not.toBeInTheDocument();
        expect(searchStatus()).toHaveTextContent("2 of 2");
        // Wrapping round from the last match to the first moves the view to it.
        await user.click(screen.getByRole("button", { name: "Next match" }));
        expect(await screen.findByRole("heading", { name: "January 2026" })).toBeInTheDocument();
    });

    it("goes to the nearest match before when there is none after", async () => {
        mockShellAndEvents([standup, retro]);
        const { user, input } = await openPage();

        await user.type(input, "retro{Enter}");

        expect(await screen.findByRole("heading", { name: "January 2026" })).toBeInTheDocument();
        expect(searchStatus()).toHaveTextContent("1 of 1");
    });

    it("searches the location and runs after a typing pause without Enter", async () => {
        mockShellAndEvents([standup, sprint]);
        const { user, input } = await openPage();

        await user.type(input, "lisbon");

        expect(await screen.findByRole("heading", { name: "September 2026" }, { timeout: 2000 })).toBeInTheDocument();
    });

    it("says there are no matches and leaves the view alone", async () => {
        mockShellAndEvents([standup]);
        const { user, input } = await openPage();

        await user.type(input, "zebra{Enter}");

        await waitFor(() => expect(searchStatus()).toHaveTextContent("No matches"));
        expect(screen.getByRole("heading", { name: "June 2026" })).toBeInTheDocument();
        expect(screen.queryByText(/Standup/)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
        // Stepping with Enter does nothing with no matches.
        await user.type(input, "{Enter}");
        expect(screen.getByRole("heading", { name: "June 2026" })).toBeInTheDocument();
    });

    it("leaves search mode with the clear button or Escape, showing every event again where the view is", async () => {
        mockShellAndEvents([standup, sprint]);
        const { user, input } = await openPage();

        await user.type(input, "sprint{Enter}");
        expect(await screen.findByRole("heading", { name: "September 2026" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Clear search" }));
        expect(input).toHaveValue("");
        expect(screen.queryByRole("button", { name: "Next match" })).not.toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();
        expect(screen.getByText(/Offsite sprint/)).toBeInTheDocument();

        await user.type(input, "sprint{Enter}");
        await screen.findByRole("button", { name: "Next match" });
        await user.type(input, "{Escape}");
        expect(input).toHaveValue("");
        expect(screen.queryByRole("button", { name: "Next match" })).not.toBeInTheDocument();
    });

    it("keeps the view where it is when the events reload under the same search", async () => {
        mockShellAndEvents([], [calendarFolder, secondCalendarFolder], { "f-cal": [standup, sprint], "f-cal2": [june] });
        const { user, input } = await openPage();

        await user.type(input, "offsite{Enter}");
        expect(await screen.findByText(/Offsite planning/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Next match" }));
        expect(await screen.findByRole("heading", { name: "September 2026" })).toBeInTheDocument();

        await user.click(screen.getByRole("checkbox", { name: /Personal/ }));

        await waitFor(() => expect(searchStatus()).toHaveTextContent("1 of 1"));
        expect(screen.getByRole("heading", { name: "September 2026" })).toBeInTheDocument();
    });

    it("is focused by the / shortcut", async () => {
        mockShellAndEvents([standup]);
        const { input } = await openPage();

        fireEvent.keyDown(document.body, { key: "/" });

        expect(input).toHaveFocus();
    });

    describe("the event card", () => {
        it("has Previous/Next match buttons that move the card and the view together, and the arrow keys do the same", async () => {
            mockShellAndEvents([standup, june, retro, sprint]);
            const { user, input } = await openPage();
            await user.type(input, "offsite{Enter}");
            await user.click(await screen.findByText(/Offsite planning/));

            let dialog = await screen.findByRole("dialog", { name: "Event details" });
            expect(within(dialog).getByText("Offsite planning")).toBeInTheDocument();

            await user.click(within(dialog).getByRole("button", { name: "Next match" }));
            expect(await screen.findByRole("heading", { name: "September 2026" })).toBeInTheDocument();
            dialog = screen.getByRole("dialog", { name: "Event details" });
            expect(within(dialog).getByText("Offsite sprint")).toBeInTheDocument();
            expect(searchStatus()).toHaveTextContent("3 of 3");

            await user.click(within(dialog).getByRole("button", { name: "Previous match" }));
            expect(await screen.findByRole("heading", { name: "June 2026" })).toBeInTheDocument();
            expect(within(screen.getByRole("dialog")).getByText("Offsite planning")).toBeInTheDocument();

            await user.keyboard("{ArrowLeft}");
            expect(await screen.findByRole("heading", { name: "January 2026" })).toBeInTheDocument();
            expect(within(screen.getByRole("dialog")).getByText("Offsite retro")).toBeInTheDocument();
            await user.keyboard("{ArrowRight}");
            expect(await screen.findByRole("heading", { name: "June 2026" })).toBeInTheDocument();
            expect(within(screen.getByRole("dialog")).getByText("Offsite planning")).toBeInTheDocument();
        });

        it("slides the next card in from the right and the previous from the left, whichever way the step was made, but not a card that was just opened", async () => {
            const animate = vi.fn();
            Element.prototype.animate = animate;
            try {
                mockShellAndEvents([standup, june, retro, sprint]);
                const { user, input } = await openPage();
                await user.type(input, "offsite{Enter}");
                await user.click(await screen.findByText(/Offsite planning/));

                const slideOf = () => screen.getByRole("dialog").querySelector("[data-slide-from]");
                expect(screen.getByRole("dialog")).toBeInTheDocument();
                expect(slideOf()).toBeNull();
                expect(animate).not.toHaveBeenCalled();

                await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Next match" }));
                await screen.findByRole("heading", { name: "September 2026" });
                expect(slideOf()).toHaveAttribute("data-slide-from", "right");
                expect(animate).toHaveBeenLastCalledWith(
                    [expect.objectContaining({ transform: "translateX(48px)" }), expect.objectContaining({ transform: "translateX(0)" })],
                    { duration: 220, easing: "ease-out" },
                );

                await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Previous match" }));
                await screen.findByRole("heading", { name: "June 2026" });
                expect(slideOf()).toHaveAttribute("data-slide-from", "left");
                expect(animate).toHaveBeenLastCalledWith(
                    [expect.objectContaining({ transform: "translateX(-48px)" }), expect.anything()],
                    { duration: 220, easing: "ease-out" },
                );

                // The search bar's own buttons and the arrow keys step the open card the same way.
                await user.click(within(screen.getByRole("search")).getByRole("button", { name: /next match/i }));
                await screen.findByRole("heading", { name: "September 2026" });
                expect(slideOf()).toHaveAttribute("data-slide-from", "right");
                await user.keyboard("{ArrowLeft}");
                await screen.findByRole("heading", { name: "June 2026" });
                expect(slideOf()).toHaveAttribute("data-slide-from", "left");
                expect(animate).toHaveBeenCalledTimes(4);

                // A card opened afresh does not slide, even for the event the last step arrived at.
                await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
                await user.click(await screen.findByText(/Offsite planning/));
                expect(slideOf()).toBeNull();
                expect(animate).toHaveBeenCalledTimes(4);
            } finally {
                delete (Element.prototype as { animate?: unknown }).animate;
            }
        });

        it("does not animate for someone who asked for less motion", async () => {
            const animate = vi.fn();
            Element.prototype.animate = animate;
            vi.stubGlobal("matchMedia", (query: string) => ({
                matches: query.includes("prefers-reduced-motion"),
                media: query,
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
            }));
            try {
                mockShellAndEvents([standup, june, retro, sprint]);
                const { user, input } = await openPage();
                await user.type(input, "offsite{Enter}");
                await user.click(await screen.findByText(/Offsite planning/));
                await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Next match" }));
                await screen.findByRole("heading", { name: "September 2026" });

                // The direction is still recorded, the animation is not run.
                expect(screen.getByRole("dialog").querySelector("[data-slide-from]")).toHaveAttribute("data-slide-from", "right");
                expect(animate).not.toHaveBeenCalled();
            } finally {
                delete (Element.prototype as { animate?: unknown }).animate;
            }
        });

        it("steps without animating where the browser has no Element.animate()", async () => {
            mockShellAndEvents([standup, june, retro, sprint]);
            const { user, input } = await openPage();
            await user.type(input, "offsite{Enter}");
            await user.click(await screen.findByText(/Offsite planning/));
            await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Next match" }));
            expect(await screen.findByRole("heading", { name: "September 2026" })).toBeInTheDocument();
            expect(within(screen.getByRole("dialog")).getByText("Offsite sprint")).toBeInTheDocument();
        });

        it("has no such buttons without a search, nor while the event is being edited", async () => {
            mockShellAndEvents([standup, june]);
            const { user, input } = await openPage();
            await user.click(screen.getByText(/Standup/));
            let dialog = await screen.findByRole("dialog", { name: "Event details" });
            expect(within(dialog).queryByRole("button", { name: "Next match" })).not.toBeInTheDocument();
            await user.click(within(dialog).getByRole("button", { name: "Close" }));

            await user.type(input, "planning{Enter}");
            await user.click(await screen.findByText(/Offsite planning/));
            dialog = await screen.findByRole("dialog", { name: "Event details" });
            expect(within(dialog).getByRole("button", { name: "Next match" })).toBeInTheDocument();
            await user.click(within(dialog).getByRole("button", { name: "Modify" }));
            dialog = await screen.findByRole("dialog", { name: "Edit event" });
            expect(within(dialog).queryByRole("button", { name: "Next match" })).not.toBeInTheDocument();
        });
    });
});
