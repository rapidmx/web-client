// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import RecurrenceEditor from "../../../apps/shared/components/calendar/RecurrenceEditor.js";
import { RecurrenceRule, WeekdayCode } from "@rapidmx/react-shared/calendar/calendarApi.js";

/** A thin stateful wrapper so interactions can be chained realistically (each onChange re-renders
 * with the new value), rather than asserting only the first onChange call in isolation. */
function Controlled({
    initial,
    onChange,
    allDay,
    startWeekday,
}: {
    initial: RecurrenceRule | null;
    onChange: (v: RecurrenceRule | null) => void;
    allDay?: boolean;
    startWeekday?: WeekdayCode;
}) {
    const [value, setValue] = useState(initial);
    return (
        <RecurrenceEditor
            allDay={allDay}
            startWeekday={startWeekday}
            value={value}
            onChange={(v) => {
                setValue(v);
                onChange(v);
            }}
        />
    );
}

describe("RecurrenceEditor", () => {
    it("shows an unchecked 'Repeats' checkbox and no sub-fields when value is null", () => {
        render(<RecurrenceEditor value={null} onChange={vi.fn()} />);
        expect(screen.getByRole("checkbox", { name: "Repeats" })).not.toBeChecked();
        expect(screen.queryByLabelText("Recurrence frequency")).not.toBeInTheDocument();
    });

    it("enabling 'Repeats' defaults to weekly, every 1 week, on Monday", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={null} onChange={onChange} />);

        await user.click(screen.getByRole("checkbox", { name: "Repeats" }));

        expect(onChange).toHaveBeenLastCalledWith({ freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] });
        expect(screen.getByLabelText("Recurrence frequency")).toHaveValue("weekly");
        expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "true");
    });

    it("disabling 'Repeats' calls onChange(null) and hides the sub-fields", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={{ freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] }} onChange={onChange} />);

        await user.click(screen.getByRole("checkbox", { name: "Repeats" }));

        expect(onChange).toHaveBeenLastCalledWith(null);
        expect(screen.queryByLabelText("Recurrence frequency")).not.toBeInTheDocument();
    });

    it("changing the interval updates it", () => {
        const onChange = vi.fn();
        render(<RecurrenceEditor value={{ freq: "daily", interval: 1, exceptions: [] }} onChange={onChange} />);

        fireEvent.change(screen.getByLabelText("Recurrence interval"), { target: { value: "3" } });
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ interval: 3 }));
    });

    it("changing frequency updates it and shows/hides the weekday picker accordingly", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={{ freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] }} onChange={onChange} />);

        expect(screen.getByRole("button", { name: "Mon" })).toBeInTheDocument();

        await user.selectOptions(screen.getByLabelText("Recurrence frequency"), "monthly");

        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ freq: "monthly" }));
        expect(screen.queryByRole("button", { name: "Mon" })).not.toBeInTheDocument();
    });

    it("switching to weekly from a rule without weekdays starts on the event's start weekday", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={{ freq: "monthly", interval: 1, exceptions: [] }} onChange={onChange} startWeekday="TH" />);

        await user.selectOptions(screen.getByLabelText("Recurrence frequency"), "weekly");
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ freq: "weekly", byDay: ["TH"] }));
        expect(screen.getByRole("button", { name: "Thu" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "false");

        await user.click(screen.getByRole("button", { name: "Mon" }));
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ byDay: ["TH", "MO"] }));
    });

    it("treats a stored weekly rule with no byDay as no days selected", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={{ freq: "weekly", interval: 1, exceptions: [] }} onChange={onChange} />);

        expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "false");
        await user.click(screen.getByRole("button", { name: "Mon" }));
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ byDay: ["MO"] }));
    });

    it("enabling 'Repeats' starts a weekly rule on the event's start weekday", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={null} onChange={onChange} startWeekday="SA" />);

        await user.click(screen.getByRole("checkbox", { name: "Repeats" }));
        expect(onChange).toHaveBeenLastCalledWith({ freq: "weekly", interval: 1, byDay: ["SA"], exceptions: [] });
    });

    it("drops the weekdays when leaving Weekly, so Daily repeats every day rather than only on those days", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={{ freq: "weekly", interval: 1, byDay: ["MO", "WE"], exceptions: [] }} onChange={onChange} startWeekday="FR" />);

        await user.selectOptions(screen.getByLabelText("Recurrence frequency"), "daily");
        const daily = onChange.mock.lastCall![0] as RecurrenceRule;
        expect(daily.freq).toBe("daily");
        expect(daily.byDay).toBeUndefined();
        expect(screen.getByText("Repeats every day.")).toBeInTheDocument();

        // Back to Weekly: re-seeded from the start weekday, not the discarded Mon/Wed.
        await user.selectOptions(screen.getByLabelText("Recurrence frequency"), "weekly");
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ freq: "weekly", byDay: ["FR"] }));
    });

    it("loads an existing weekly rule's weekdays untouched and keeps them through unrelated edits", () => {
        const onChange = vi.fn();
        render(<Controlled initial={{ freq: "weekly", interval: 1, byDay: ["TU", "TH"], count: 5, exceptions: [] }} onChange={onChange} startWeekday="MO" />);

        expect(screen.getByRole("button", { name: "Tue" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "Thu" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "false");
        expect(onChange).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText("Recurrence interval"), { target: { value: "2" } });
        expect(onChange).toHaveBeenLastCalledWith({ freq: "weekly", interval: 2, byDay: ["TU", "TH"], count: 5, exceptions: [] });
    });

    it("toggles a weekday on and back off", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={{ freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] }} onChange={onChange} />);

        const wed = screen.getByRole("button", { name: "Wed" });
        expect(wed).toHaveAttribute("aria-pressed", "false");

        await user.click(wed);
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ byDay: ["MO", "WE"] }));
        expect(screen.getByRole("button", { name: "Wed" })).toHaveAttribute("aria-pressed", "true");

        await user.click(screen.getByRole("button", { name: "Wed" }));
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ byDay: ["MO"] }));
    });

    it("hides the summary line for a weekly rule with no days selected, shows it once one is picked", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={{ freq: "weekly", interval: 1, byDay: [], exceptions: [] }} onChange={onChange} />);

        expect(screen.queryByText(/^Repeats /)).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Mon" }));
        expect(await screen.findByText("Repeats every week on Monday.")).toBeInTheDocument();
    });

    it("defaults to the 'Never' end condition when neither count nor until is set", () => {
        render(<RecurrenceEditor value={{ freq: "daily", interval: 1, exceptions: [] }} onChange={vi.fn()} />);
        expect(screen.getByRole("radio", { name: "Never" })).toBeChecked();
        expect(screen.getByLabelText("Number of occurrences")).toBeDisabled();
        expect(screen.getByLabelText("End date")).toBeDisabled();
    });

    it("selecting 'Never' after count/until was set clears both", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={{ freq: "daily", interval: 1, count: 10, exceptions: [] }} onChange={onChange} />);

        await user.click(screen.getByRole("radio", { name: "Never" }));

        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ count: undefined, until: undefined }));
        expect(screen.getByRole("radio", { name: "Never" })).toBeChecked();
    });

    it("selecting the count end condition sets count and clears until", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={{ freq: "daily", interval: 1, until: "2026-12-31T00:00:00.000Z", exceptions: [] }} onChange={onChange} />);

        await user.click(screen.getByRole("radio", { name: "After" }));

        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ count: 10, until: undefined }));
        expect(screen.getByLabelText("Number of occurrences")).toBeEnabled();
    });

    it("editing the occurrence count updates it", () => {
        const onChange = vi.fn();
        render(<RecurrenceEditor value={{ freq: "daily", interval: 1, count: 10, exceptions: [] }} onChange={onChange} />);

        fireEvent.change(screen.getByLabelText("Number of occurrences"), { target: { value: "5" } });
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ count: 5 }));
    });

    it("selecting the until end condition sets until and clears count", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={{ freq: "daily", interval: 1, count: 10, exceptions: [] }} onChange={onChange} />);

        await user.click(screen.getByRole("radio", { name: "On" }));

        const [call] = onChange.mock.calls.slice(-1);
        expect(call[0].count).toBeUndefined();
        expect(typeof call[0].until).toBe("string");
        expect(screen.getByLabelText("End date")).toBeEnabled();
    });

    it("editing the end date updates until", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(
            <Controlled initial={{ freq: "daily", interval: 1, until: "2026-06-01T00:00:00.000Z", exceptions: [] }} onChange={onChange} />,
        );

        const dateInput = screen.getByLabelText("End date");
        expect(dateInput).toHaveValue("2026-06-01");

        // A real browser's date input only ever fires `onChange` with a complete value (segmented
        // picker input, not free text) — `fireEvent.change` mirrors that; `user.type()`'s keystroke-by-
        // keystroke simulation fires intermediate incomplete values a real date input never would.
        fireEvent.change(dateInput, { target: { value: "2026-12-25" } });
        // Stored as the end of that *local* day (inclusive), not UTC midnight.
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ until: new Date(2026, 11, 25, 23, 59, 59, 999).toISOString() }));
        expect(dateInput).toHaveValue("2026-12-25");

        // Clearing the date input keeps the previous end date instead of throwing on an invalid date.
        onChange.mockClear();
        fireEvent.change(dateInput, { target: { value: "" } });
        expect(onChange).not.toHaveBeenCalled();
    });

    it("keeps the previous interval/count while the field is empty, and clamps invalid values to 1", () => {
        const onChange = vi.fn();
        render(<RecurrenceEditor value={{ freq: "daily", interval: 2, count: 10, exceptions: [] }} onChange={onChange} />);

        fireEvent.change(screen.getByLabelText("Recurrence interval"), { target: { value: "" } });
        fireEvent.change(screen.getByLabelText("Number of occurrences"), { target: { value: "" } });
        expect(onChange).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText("Recurrence interval"), { target: { value: "0" } });
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ interval: 1 }));
        fireEvent.change(screen.getByLabelText("Number of occurrences"), { target: { value: "-3" } });
        expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ count: 1 }));
    });

    it("never unticks a weekly rule's last weekday (which would turn it into a daily rule)", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<Controlled initial={{ freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] }} onChange={onChange} />);

        await user.click(screen.getByRole("button", { name: "Mon" }));

        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByText("Repeats every week on Monday.")).toBeInTheDocument();
    });

    it("stores and shows an all-day series' end date as that UTC day, west of UTC", async () => {
        const originalTz = process.env.TZ;
        process.env.TZ = "America/New_York";
        try {
            const onChange = vi.fn();
            const user = userEvent.setup();
            render(<Controlled initial={{ freq: "daily", interval: 1, until: "2026-09-28T23:59:59.999Z", exceptions: [] }} onChange={onChange} allDay />);

            const dateInput = screen.getByLabelText("End date");
            expect(dateInput).toHaveValue("2026-09-28");
            fireEvent.change(dateInput, { target: { value: "2026-12-25" } });
            expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ until: "2026-12-25T23:59:59.999Z" }));

            await user.click(screen.getByRole("radio", { name: "After" }));
            await user.click(screen.getByRole("radio", { name: "On" }));
            expect(onChange.mock.lastCall![0].until).toMatch(/T23:59:59\.999Z$/);
        } finally {
            process.env.TZ = originalTz;
        }
    });

    it("shows a pluralized unit label when the interval is greater than 1", () => {
        render(<RecurrenceEditor value={{ freq: "monthly", interval: 2, exceptions: [] }} onChange={vi.fn()} />);
        expect(screen.getByRole("option", { name: "months", selected: true })).toBeInTheDocument();
    });
});
