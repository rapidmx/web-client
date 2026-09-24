// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ProposeTimeForm from "../../../apps/shared/components/mail/invite/ProposeTimeForm.js";

// The suite runs in UTC (vitest.config.ts), so the reader's own zone is UTC below.

const INVITE = { startDate: "2026-06-16T09:05:00.000Z", endDate: "2026-06-16T10:00:00.000Z" };

function draw(props: Partial<React.ComponentProps<typeof ProposeTimeForm>> = {}) {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(<ProposeTimeForm invite={INVITE} onSubmit={onSubmit} onCancel={onCancel} {...props} />);
    return { onSubmit, onCancel };
}

describe("ProposeTimeForm", () => {
    it("starts out as the invitation's own day and times, zero-padded, with a blank comment", () => {
        draw();
        expect(screen.getByLabelText("Date")).toHaveValue("2026-06-16");
        expect(screen.getByLabelText("Start")).toHaveValue("09:05");
        expect(screen.getByLabelText("End")).toHaveValue("10:00");
        expect(screen.getByLabelText("Comment (optional)")).toHaveValue("");
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("starts blank for an invitation with no usable time, and refuses to send until it is filled in", async () => {
        const user = userEvent.setup();
        const { onSubmit } = draw({ invite: { startDate: undefined, endDate: "garbage" } });
        expect(screen.getByLabelText("Date")).toHaveValue("");
        expect(screen.getByLabelText("Start")).toHaveValue("");
        expect(screen.getByLabelText("End")).toHaveValue("");

        await user.click(screen.getByRole("button", { name: "Send proposal" }));
        expect(screen.getByRole("alert")).toHaveTextContent("Choose a date and a start and end time.");
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it.each([
        ["date", "Date"],
        ["start time", "Start"],
        ["end time", "End"],
    ])("refuses a missing %s", async (_name, label) => {
        const user = userEvent.setup();
        const { onSubmit } = draw();
        fireEvent.change(screen.getByLabelText(label), { target: { value: "" } });
        await user.click(screen.getByRole("button", { name: "Send proposal" }));

        expect(screen.getByRole("alert")).toHaveTextContent("Choose a date and a start and end time.");
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it.each(["09:05", "08:00"])("refuses an end of %s that is not after the start", async (end) => {
        const user = userEvent.setup();
        const { onSubmit } = draw();
        fireEvent.change(screen.getByLabelText("End"), { target: { value: end } });
        await user.click(screen.getByRole("button", { name: "Send proposal" }));

        expect(screen.getByRole("alert")).toHaveTextContent("The end time must be after the start time.");
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it("sends the chosen instants and a trimmed comment, and clears an earlier error", async () => {
        const user = userEvent.setup();
        const { onSubmit } = draw();
        fireEvent.change(screen.getByLabelText("End"), { target: { value: "09:00" } });
        await user.click(screen.getByRole("button", { name: "Send proposal" }));
        expect(screen.getByRole("alert")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-07-01" } });
        fireEvent.change(screen.getByLabelText("Start"), { target: { value: "13:30" } });
        fireEvent.change(screen.getByLabelText("End"), { target: { value: "14:45" } });
        await user.type(screen.getByLabelText("Comment (optional)"), "  after lunch ");
        await user.click(screen.getByRole("button", { name: "Send proposal" }));

        expect(onSubmit).toHaveBeenCalledWith({ startDate: "2026-07-01T13:30:00.000Z", endDate: "2026-07-01T14:45:00.000Z", comment: "after lunch" });
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("leaves the comment out when it is only spaces", async () => {
        const user = userEvent.setup();
        const { onSubmit } = draw();
        await user.type(screen.getByLabelText("Comment (optional)"), "   ");
        await user.click(screen.getByRole("button", { name: "Send proposal" }));
        expect(onSubmit).toHaveBeenCalledWith({ startDate: "2026-06-16T09:05:00.000Z", endDate: "2026-06-16T10:00:00.000Z" });
    });

    it("submits with Enter in a field, and Cancel goes back without sending", async () => {
        const user = userEvent.setup();
        const { onSubmit, onCancel } = draw();
        await user.type(screen.getByLabelText("Date"), "{Enter}");
        expect(onSubmit).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it("turns every field and both buttons off while a proposal is on its way", () => {
        draw({ busy: true });
        for (const label of ["Date", "Start", "End", "Comment (optional)"]) {
            expect(screen.getByLabelText(label)).toBeDisabled();
        }
        expect(screen.getByRole("button", { name: "Send proposal" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Send proposal" })).toHaveAttribute("aria-busy", "true");
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });
});
