// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrincipalListField from "../../../apps/shared/components/sharing/PrincipalListField.js";

afterEach(() => {
    vi.restoreAllMocks();
});

/** A minimal controlled wrapper, the same shape every real caller (`EscrowScopeKeyAndHoldersFields`) uses. */
function Wrapper({ resolve, disabled }: { resolve: (principal: string) => Promise<any>; disabled?: boolean }) {
    const [values, setValues] = useState<string[]>(["existing-1"]);
    return <PrincipalListField label="Holder user uids" values={values} onChange={setValues} resolve={resolve} disabled={disabled} emptyMessage="No holders added yet." />;
}

describe("PrincipalListField", () => {
    it("shows already-added uids as plain text, each removable, and never re-resolves them", async () => {
        const resolve = vi.fn();
        const user = userEvent.setup();
        render(<Wrapper resolve={resolve} />);
        expect(screen.getByText("existing-1")).toBeInTheDocument();
        expect(resolve).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Remove" }));
        expect(screen.queryByText("existing-1")).not.toBeInTheDocument();
        expect(screen.getByText("No holders added yet.")).toBeInTheDocument();
    });

    it("only adds a uid once it's been looked up and confirmed - never from the raw typed text", async () => {
        const resolve = vi.fn().mockResolvedValue({ userUid: "u-new", displayName: "Ada", address: "ada@example.com" });
        const user = userEvent.setup();
        render(<Wrapper resolve={resolve} />);

        await user.type(screen.getByLabelText("Holder user uids"), "ada");
        expect(screen.queryByText("ada")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText("Ada <ada@example.com>")).toBeInTheDocument();
        // Not added yet - only the confirm row shows the resolved person so far.
        expect(screen.getAllByText(/Ada|u-new/).length).toBe(1);

        await user.click(screen.getByRole("button", { name: "Add" }));
        expect(await screen.findByText("u-new")).toBeInTheDocument();
        expect(resolve).toHaveBeenCalledWith("ada");
    });

    it("does not add a uid that's already in the list twice", async () => {
        const resolve = vi.fn().mockResolvedValue({ userUid: "existing-1" });
        const user = userEvent.setup();
        render(<Wrapper resolve={resolve} />);

        await user.type(screen.getByLabelText("Holder user uids"), "existing-1");
        await user.click(screen.getByRole("button", { name: "Find" }));
        await user.click(await screen.findByRole("button", { name: "Add" }));
        expect(screen.getAllByText("existing-1")).toHaveLength(1);
    });

    it("hides the add-lookup widget while disabled, keeping the list and Remove buttons", () => {
        const resolve = vi.fn();
        render(<Wrapper resolve={resolve} disabled />);
        expect(screen.queryByLabelText("Holder user uids")).not.toBeInTheDocument();
        expect(screen.getByText("existing-1")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    });
});
