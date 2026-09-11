// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import MiniDatePicker from "../../../apps/shared/components/calendar/MiniDatePicker.js";

afterEach(() => {
    vi.useRealTimers();
});

describe("MiniDatePicker", () => {
    it("shows the selected date's month and highlights that day", () => {
        render(<MiniDatePicker selected={new Date("2026-06-15T00:00:00.000Z")} onSelect={vi.fn()} />);
        expect(screen.getByText("June 2026")).toBeInTheDocument();
        expect(screen.getByText("15").className).toContain("bg-primary text-white");
    });

    it("calls onSelect with the clicked day", async () => {
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<MiniDatePicker selected={new Date("2026-06-15T00:00:00.000Z")} onSelect={onSelect} />);

        await user.click(screen.getByText("20"));

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect.mock.calls[0][0].toISOString().slice(0, 10)).toBe("2026-06-20");
    });

    it("pages to the previous/next month independently of `selected`, without calling onSelect", async () => {
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<MiniDatePicker selected={new Date("2026-06-15T00:00:00.000Z")} onSelect={onSelect} />);

        await user.click(screen.getByLabelText("Next month"));
        expect(screen.getByText("July 2026")).toBeInTheDocument();

        await user.click(screen.getByLabelText("Previous month"));
        await user.click(screen.getByLabelText("Previous month"));
        expect(screen.getByText("May 2026")).toBeInTheDocument();
        expect(onSelect).not.toHaveBeenCalled();
    });

    it("resyncs its shown month when `selected` moves to a different month", () => {
        const { rerender } = render(<MiniDatePicker selected={new Date("2026-06-15T00:00:00.000Z")} onSelect={vi.fn()} />);
        expect(screen.getByText("June 2026")).toBeInTheDocument();

        rerender(<MiniDatePicker selected={new Date("2026-08-01T00:00:00.000Z")} onSelect={vi.fn()} />);
        expect(screen.getByText("August 2026")).toBeInTheDocument();
    });

    it("highlights today distinctly from the selected day, and mutes days outside the shown month", () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
        render(<MiniDatePicker selected={new Date("2026-06-15T00:00:00.000Z")} onSelect={vi.fn()} />);

        expect(screen.getByText("10").className).toContain("text-primary-dark font-semibold");
        // June 2026 starts on a Monday (so its grid has no leading May days) but doesn't end on a
        // Sunday, so the grid's trailing days spill into July — always muted.
        const dayButtons = screen.getAllByRole("button").filter((b) => /^\d+$/.test(b.textContent ?? ""));
        expect(dayButtons[dayButtons.length - 1].className).toContain("text-text-muted/50");
    });

    it("clicking a day from an adjacent month (shown in the grid) also pages the picker to that month", async () => {
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<MiniDatePicker selected={new Date("2026-06-15T00:00:00.000Z")} onSelect={onSelect} />);

        // June 2026 doesn't end on a Sunday, so the grid's trailing days spill into July. Click one of those.
        const dayButtons = screen.getAllByRole("button").filter((b) => /^\d+$/.test(b.textContent ?? ""));
        const julyDay = dayButtons[dayButtons.length - 1];
        await user.click(julyDay);

        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(screen.getByText("July 2026")).toBeInTheDocument();
    });
});
