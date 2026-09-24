///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Shared by the EventModal test files: the steps that reach each face of the event dialog (details -> Modify, quick create -> More
// options) and fill in its fields.
import { fireEvent, screen } from "@testing-library/react";
import { UserEvent } from "@testing-library/user-event";

/** Modify: the read-only details of an existing event become the full form. */
export function clickModify() {
    fireEvent.click(screen.getByRole("button", { name: "Modify" }));
}

/** More options: the quick-create popover becomes the full form. */
export async function openMoreOptions(user: UserEvent) {
    await user.click(screen.getByRole("button", { name: "More options" }));
}

/** The quick popover's when row (a button showing the date and time), which opens the date, time, zone and repeat controls in place. */
export async function openTimeControls(user: UserEvent) {
    await user.click(screen.getByRole("button", { name: /day, [A-Z][a-z]+ \d+|Pick a date and time/ }));
}

/** Sets the form's start or end from a `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` value, through the date (and time) inputs. */
export function setWhen(which: "Start" | "End", value: string) {
    const [date, time] = value.split("T");
    fireEvent.change(screen.getByLabelText(`Event ${which.toLowerCase()} date`), { target: { value: date } });
    if (time !== undefined) {
        fireEvent.change(screen.getByLabelText(`Event ${which.toLowerCase()} time`), { target: { value: time } });
    }
}

/** Types an address into the guests field and adds it. */
export async function addGuest(user: UserEvent, address: string) {
    await user.type(screen.getByLabelText("Add guests"), `${address}{Enter}`);
}
