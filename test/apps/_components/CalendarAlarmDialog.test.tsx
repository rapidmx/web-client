// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import CalendarAlarmDialog from "../../../apps/shared/components/calendar/CalendarAlarmDialog.js";
import type { CalendarAlarms } from "../../../apps/shared/calendar/useCalendarReminders.js";

const navigate = vi.fn();
vi.mock("../../../apps/shared/navigation/index.js", () => ({ useNavigate: () => navigate }));

const NOTICE = { eventUid: "evt1", title: "Team sync", startDate: "2026-09-22T15:00:00.000Z" };

function alarms(overrides: Partial<CalendarAlarms> = {}): CalendarAlarms {
    return { current: NOTICE, waiting: 0, snooze: vi.fn(), dismiss: vi.fn(), ...overrides };
}

afterEach(() => {
    navigate.mockReset();
    vi.restoreAllMocks();
});

describe("CalendarAlarmDialog", () => {
    it("draws nothing while there is no alarm", () => {
        render(<CalendarAlarmDialog alarms={alarms({ current: undefined })} />);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("is a modal named for the event, saying when it starts", () => {
        render(<CalendarAlarmDialog alarms={alarms()} />);
        const dialog = screen.getByRole("dialog", { name: "Team sync" });
        expect(dialog).toHaveTextContent(/Starting/);
    });

    it("offers View and Snooze, and no Join or Open for an event with no location", () => {
        render(<CalendarAlarmDialog alarms={alarms()} />);
        expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Snooze" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Join" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    });

    it("shows a location that is not a web address as text, with no Join or Open button", () => {
        render(<CalendarAlarmDialog alarms={alarms({ current: { ...NOTICE, location: "Room 12" } })} />);
        expect(screen.getByText("Room 12")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Join|Open/ })).not.toBeInTheDocument();
    });

    it("View opens the event's card in the Calendar and dismisses the alarm", async () => {
        const dismiss = vi.fn();
        const user = userEvent.setup();
        render(<CalendarAlarmDialog alarms={alarms({ dismiss })} />);

        await user.click(screen.getByRole("button", { name: "View" }));

        expect(navigate).toHaveBeenCalledWith("/calendar?event=evt1&start=2026-09-22T15%3A00%3A00.000Z");
        expect(dismiss).toHaveBeenCalledTimes(1);
    });

    it("Join opens a meeting's link in a new tab, naming the site, and dismisses the alarm", async () => {
        const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
        const dismiss = vi.fn();
        const user = userEvent.setup();
        render(<CalendarAlarmDialog alarms={alarms({ dismiss, current: { ...NOTICE, location: "https://us06web.zoom.us/j/86056299697" } })} />);

        expect(screen.getByText("Join opens us06web.zoom.us")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Join" }));

        expect(openSpy).toHaveBeenCalledWith("https://us06web.zoom.us/j/86056299697", "_blank", "noopener,noreferrer");
        expect(dismiss).toHaveBeenCalledTimes(1);
    });

    it("calls the button Open when the location is an ordinary web page", async () => {
        const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
        const user = userEvent.setup();
        render(<CalendarAlarmDialog alarms={alarms({ current: { ...NOTICE, location: "https://www.example.com/venue" } })} />);

        expect(screen.queryByRole("button", { name: "Join" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Open" }));
        expect(openSpy).toHaveBeenCalledWith("https://www.example.com/venue", "_blank", "noopener,noreferrer");
    });

    it("Snooze snoozes, without dismissing", async () => {
        const snooze = vi.fn();
        const dismiss = vi.fn();
        const user = userEvent.setup();
        render(<CalendarAlarmDialog alarms={alarms({ snooze, dismiss })} />);

        await user.click(screen.getByRole("button", { name: "Snooze" }));

        expect(snooze).toHaveBeenCalledTimes(1);
        expect(dismiss).not.toHaveBeenCalled();
    });

    it("closing it with the close button or Escape dismisses the alarm", async () => {
        const dismiss = vi.fn();
        const user = userEvent.setup();
        render(<CalendarAlarmDialog alarms={alarms({ dismiss })} />);

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(dismiss).toHaveBeenCalledTimes(1);

        await user.keyboard("{Escape}");
        expect(dismiss).toHaveBeenCalledTimes(2);
    });

    it("says how many more alarms wait behind this one", () => {
        const { rerender } = render(<CalendarAlarmDialog alarms={alarms({ waiting: 1 })} />);
        expect(screen.getByText("1 more alarm after this one")).toBeInTheDocument();
        rerender(<CalendarAlarmDialog alarms={alarms({ waiting: 3 })} />);
        expect(screen.getByText("3 more alarms after this one")).toBeInTheDocument();
    });
});
