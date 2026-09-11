// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ScheduleSendPicker from "../../../apps/shared/components/mail/compose/ScheduleSendPicker.js";

// `PopoverPortal`'s own positioning/portal/outside-click behavior is tested in its own file — mocked
// here (matching `EmojiPicker`/`GifPicker`/`ResourcePicker`'s own test files' identical convention) so
// this file only exercises `ScheduleSendPicker`'s own validation/content.
vi.mock("../../../apps/shared/components/mail/compose/PopoverPortal.js", () => ({
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const anchorRef = { current: null };

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ScheduleSendPicker", () => {
    it("shows an error and does not call onSchedule when nothing is picked", async () => {
        const onSchedule = vi.fn();
        const user = userEvent.setup();
        render(<ScheduleSendPicker anchorRef={anchorRef} onClose={vi.fn()} onSchedule={onSchedule} />);

        await user.click(screen.getByRole("button", { name: "Send later" }));

        expect(await screen.findByText("Pick a date and time.")).toBeInTheDocument();
        expect(onSchedule).not.toHaveBeenCalled();
    });

    it("shows an error and does not call onSchedule for a time in the past", async () => {
        const onSchedule = vi.fn();
        const user = userEvent.setup();
        render(<ScheduleSendPicker anchorRef={anchorRef} onClose={vi.fn()} onSchedule={onSchedule} />);

        await user.type(screen.getByLabelText("Send at"), "2020-01-01T09:00");
        await user.click(screen.getByRole("button", { name: "Send later" }));

        expect(await screen.findByText("Pick a time in the future.")).toBeInTheDocument();
        expect(onSchedule).not.toHaveBeenCalled();
    });

    it("calls onSchedule with the chosen time as a UTC ISO string for a time in the future", async () => {
        const onSchedule = vi.fn();
        const user = userEvent.setup();
        render(<ScheduleSendPicker anchorRef={anchorRef} onClose={vi.fn()} onSchedule={onSchedule} />);

        const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const localValue = new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        await user.type(screen.getByLabelText("Send at"), localValue);
        await user.click(screen.getByRole("button", { name: "Send later" }));

        expect(onSchedule).toHaveBeenCalledTimes(1);
        const [iso] = onSchedule.mock.calls[0];
        expect(new Date(iso).getTime()).toBeGreaterThan(Date.now());
    });
});
