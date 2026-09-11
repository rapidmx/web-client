// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import TasksToolbar from "../../../apps/shared/components/tasks/TasksToolbar.js";

function renderToolbar(overrides: Partial<React.ComponentProps<typeof TasksToolbar>> = {}) {
    const handlers = {
        onViewModeChange: vi.fn(),
        onComplete: vi.fn(),
        onDelete: vi.fn(),
        onAddToMyDay: vi.fn(),
    };
    render(<TasksToolbar viewMode="list" selectedCount={0} {...handlers} {...overrides} />);
    return handlers;
}

describe("TasksToolbar", () => {
    it("disables Complete/Add to My Day/Delete when nothing is selected.", () => {
        renderToolbar({ selectedCount: 0 });
        for (const label of ["Complete", "Add to My Day", "Delete"]) {
            expect(screen.getByText(label).closest("button")).toBeDisabled();
        }
    });

    it("enables Complete/Add to My Day/Delete once at least one row is selected.", () => {
        renderToolbar({ selectedCount: 2 });
        for (const label of ["Complete", "Add to My Day", "Delete"]) {
            expect(screen.getByText(label).closest("button")).not.toBeDisabled();
        }
    });

    it("marks the current view mode as active/pressed.", () => {
        renderToolbar({ viewMode: "grid" });
        expect(screen.getByText("Grid").closest("button")).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByText("List").closest("button")).toHaveAttribute("aria-pressed", "false");
    });

    it("calls onViewModeChange with the clicked mode.", async () => {
        const user = userEvent.setup();
        const handlers = renderToolbar({ viewMode: "list" });

        await user.click(screen.getByText("Grid"));
        expect(handlers.onViewModeChange).toHaveBeenCalledWith("grid");

        await user.click(screen.getByText("List"));
        expect(handlers.onViewModeChange).toHaveBeenCalledWith("list");
    });

    it("calls the right handler for Complete/Add to My Day/Delete.", async () => {
        const user = userEvent.setup();
        const handlers = renderToolbar({ selectedCount: 1 });

        await user.click(screen.getByText("Complete"));
        expect(handlers.onComplete).toHaveBeenCalledTimes(1);
        await user.click(screen.getByText("Add to My Day"));
        expect(handlers.onAddToMyDay).toHaveBeenCalledTimes(1);
        await user.click(screen.getByText("Delete"));
        expect(handlers.onDelete).toHaveBeenCalledTimes(1);
    });
});
