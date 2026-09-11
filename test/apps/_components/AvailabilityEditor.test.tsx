// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AvailabilityEditor from "../../../apps/shared/components/booking/AvailabilityEditor.js";
import { BookingAvailabilityWindow } from "@rapidmx/react-shared/bookingApi.js";

function Harness({ initial = [] }: { initial?: BookingAvailabilityWindow[] }) {
    const [value, setValue] = React.useState<BookingAvailabilityWindow[]>(initial);
    return <AvailabilityEditor value={value} onChange={setValue} />;
}

describe("AvailabilityEditor", () => {
    it("shows an empty-state message when there are no windows", () => {
        render(<AvailabilityEditor value={[]} onChange={vi.fn()} />);
        expect(screen.getByText("No availability windows yet — add one below.")).toBeInTheDocument();
    });

    it("lists existing windows formatted as Day HH:MM–HH:MM", () => {
        render(
            <AvailabilityEditor
                value={[{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }]}
                onChange={vi.fn()}
            />,
        );
        expect(screen.getByText("Monday 09:00–17:00")).toBeInTheDocument();
    });

    it("adds a window with the selected day/start/end", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await user.selectOptions(screen.getByLabelText("Day of week"), "2");
        const start = screen.getByLabelText("Start time");
        const end = screen.getByLabelText("End time");
        await user.clear(start);
        await user.type(start, "10:00");
        await user.clear(end);
        await user.type(end, "14:30");
        await user.click(screen.getByRole("button", { name: "Add window" }));

        expect(screen.getByText("Tuesday 10:00–14:30")).toBeInTheDocument();
    });

    it("rejects a window whose start is not before its end", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        const start = screen.getByLabelText("Start time");
        const end = screen.getByLabelText("End time");
        await user.clear(start);
        await user.type(start, "17:00");
        await user.clear(end);
        await user.type(end, "09:00");
        await user.click(screen.getByRole("button", { name: "Add window" }));

        expect(screen.getByText("Start time must be before end time.")).toBeInTheDocument();
        expect(screen.getByText("No availability windows yet — add one below.")).toBeInTheDocument();
    });

    it("removes a window", async () => {
        const user = userEvent.setup();
        render(<Harness initial={[{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }]} />);

        expect(screen.getByText("Monday 09:00–17:00")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Remove" }));

        expect(screen.getByText("No availability windows yet — add one below.")).toBeInTheDocument();
    });
});
