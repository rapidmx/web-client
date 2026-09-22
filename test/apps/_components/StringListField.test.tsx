// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import StringListField from "../../../apps/shared/components/forms/StringListField.js";

/** A minimal controlled wrapper, the same shape every real caller (`Matter.custodianMailboxUids`) uses. */
function Wrapper({ disabled }: { disabled?: boolean }) {
    const [values, setValues] = useState<string[]>(["mb1"]);
    return (
        <StringListField
            label="Mailbox uids"
            id="custodianMailboxUids"
            values={values}
            onChange={setValues}
            placeholder="Mailbox uid to add"
            emptyMessage="No mailboxes added yet."
            disabled={disabled}
        />
    );
}

describe("StringListField", () => {
    it("adds a value by clicking Add, and shows a custom empty message when the list is emptied", async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        render(<StringListField label="Values" id="values" values={[]} onChange={onChange} emptyMessage="Nothing yet." />);
        expect(screen.getByText("Nothing yet.")).toBeInTheDocument();

        await user.type(screen.getByLabelText("Values"), "v1");
        await user.click(screen.getByRole("button", { name: "Add" }));
        expect(onChange).toHaveBeenCalledWith(["v1"]);
    });

    it("adds a value by pressing Enter, and clears the draft input afterward", async () => {
        const user = userEvent.setup();
        render(<Wrapper />);
        await user.type(screen.getByLabelText("Mailbox uids"), "mb2{Enter}");
        expect(screen.getByText("mb2")).toBeInTheDocument();
        expect(screen.getByLabelText("Mailbox uids")).toHaveValue("");
    });

    it("does not add a blank (whitespace-only) or already-present value", async () => {
        const user = userEvent.setup();
        render(<Wrapper />);

        await user.type(screen.getByLabelText("Mailbox uids"), "   ");
        await user.click(screen.getByRole("button", { name: "Add" }));
        expect(screen.getByText("mb1")).toBeInTheDocument();
        expect(screen.getAllByRole("listitem")).toHaveLength(1);

        await user.clear(screen.getByLabelText("Mailbox uids"));
        await user.type(screen.getByLabelText("Mailbox uids"), "mb1");
        await user.click(screen.getByRole("button", { name: "Add" }));
        expect(screen.getAllByText("mb1")).toHaveLength(1);
    });

    it("removes a value, showing the empty message once the list is empty again", async () => {
        const user = userEvent.setup();
        render(<Wrapper />);
        expect(screen.getByText("mb1")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Remove" }));
        expect(screen.queryByText("mb1")).not.toBeInTheDocument();
        expect(screen.getByText("No mailboxes added yet.")).toBeInTheDocument();
    });

    it("disables the input, Add and Remove controls while disabled", () => {
        render(<Wrapper disabled />);
        expect(screen.getByLabelText("Mailbox uids")).toBeDisabled();
        expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    });

    it("defaults the empty message to 'None added yet.' when none is given", () => {
        render(<StringListField label="Values" id="values" values={[]} onChange={vi.fn()} />);
        expect(screen.getByText("None added yet.")).toBeInTheDocument();
    });
});
