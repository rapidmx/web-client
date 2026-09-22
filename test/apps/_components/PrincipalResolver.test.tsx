// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import PrincipalResolver, { describePerson } from "../../../apps/shared/components/sharing/PrincipalResolver.js";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("describePerson", () => {
    it("shows name and address, then whichever is known, then the uid", () => {
        expect(describePerson({ userUid: "u1", displayName: "Ada", address: "ada@example.com" })).toBe("Ada <ada@example.com>");
        expect(describePerson({ userUid: "u1", displayName: "Ada" })).toBe("Ada");
        expect(describePerson({ userUid: "u1", address: "ada@example.com" })).toBe("ada@example.com");
        expect(describePerson({ userUid: "u1" })).toBe("user u1");
    });
});

const DEFAULT_PROPS = {
    placeholder: "Who?",
    ariaLabel: "Person",
    confirmLabel: "Confirm",
    confirmErrorMessage: "Could not confirm this person.",
    describeConfirm: (person: { userUid: string }) => `Use ${person.userUid}?`,
};

describe("PrincipalResolver", () => {
    it("resolves what was typed, shows the person, and calls onResolved only after the caller confirms", async () => {
        const resolve = vi.fn().mockResolvedValue({ userUid: "u-ada", displayName: "Ada", address: "ada@example.com" });
        const onResolved = vi.fn();
        const user = userEvent.setup();
        render(<PrincipalResolver {...DEFAULT_PROPS} resolve={resolve} onResolved={onResolved} />);

        await user.type(screen.getByPlaceholderText("Who?"), " ada ");
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText("Use u-ada?")).toBeInTheDocument();
        expect(resolve).toHaveBeenCalledWith("ada");

        await user.click(screen.getByRole("button", { name: "Confirm" }));
        await waitFor(() => expect(onResolved).toHaveBeenCalledWith({ userUid: "u-ada", displayName: "Ada", address: "ada@example.com" }));
        // Ready for the next person.
        expect(screen.getByLabelText("Person")).toHaveValue("");
        expect(screen.queryByText(/Use /)).not.toBeInTheDocument();
    });

    it("ignores a blank box, and forgets the person when the text changes", async () => {
        const resolve = vi.fn().mockResolvedValue({ userUid: "u1" });
        const user = userEvent.setup();
        render(<PrincipalResolver {...DEFAULT_PROPS} resolve={resolve} onResolved={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(resolve).not.toHaveBeenCalled();

        await user.type(screen.getByLabelText("Person"), "abc");
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText("Use u1?")).toBeInTheDocument();
        await user.type(screen.getByLabelText("Person"), "d");
        expect(screen.queryByText(/Use /)).not.toBeInTheDocument();
    });

    it("says so when nobody is found, and with a generic message when the lookup itself fails", async () => {
        const resolve = vi
            .fn()
            .mockRejectedValueOnce(new ApiRequestError('No user found for "x".', 404))
            .mockRejectedValueOnce(new TypeError("network down"));
        const user = userEvent.setup();
        render(<PrincipalResolver {...DEFAULT_PROPS} resolve={resolve} onResolved={vi.fn()} />);
        await user.type(screen.getByLabelText("Person"), "x");
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText('No user found for "x".')).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText("Could not look that person up.")).toBeInTheDocument();
    });

    it("reports a rejected confirm with the caller's message, or a generic one, and keeps the person to try again", async () => {
        const resolve = vi.fn().mockResolvedValue({ userUid: "u1" });
        const onResolved = vi
            .fn()
            .mockRejectedValueOnce(new ApiRequestError("not allowed", 403))
            .mockRejectedValueOnce(new TypeError("network down"));
        const user = userEvent.setup();
        render(<PrincipalResolver {...DEFAULT_PROPS} resolve={resolve} onResolved={onResolved} />);
        await user.type(screen.getByLabelText("Person"), "x");
        await user.click(screen.getByRole("button", { name: "Find" }));
        await user.click(await screen.findByRole("button", { name: "Confirm" }));
        expect(await screen.findByText("not allowed")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Confirm" }));
        expect(await screen.findByText("Could not confirm this person.")).toBeInTheDocument();
    });

    it("looks a stored entry up at once, and offers Cancel", async () => {
        const resolve = vi.fn().mockResolvedValue({ userUid: "u1", displayName: "Ada" });
        const onCancel = vi.fn();
        const user = userEvent.setup();
        render(<PrincipalResolver {...DEFAULT_PROPS} resolve={resolve} onResolved={vi.fn()} initialPrincipal="ada-name" onCancel={onCancel} />);
        expect(await screen.findByText("Use u1?")).toBeInTheDocument();
        expect(resolve).toHaveBeenCalledWith("ada-name");
        expect(screen.getByLabelText("Person")).toHaveValue("ada-name");
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onCancel).toHaveBeenCalled();
    });

    it("renders extra inline controls (children) between the box and the Find button", () => {
        const resolve = vi.fn().mockResolvedValue({ userUid: "u1" });
        render(
            <PrincipalResolver {...DEFAULT_PROPS} resolve={resolve} onResolved={vi.fn()}>
                <select aria-label="Extra control">
                    <option value="a">A</option>
                </select>
            </PrincipalResolver>,
        );
        expect(screen.getByLabelText("Extra control")).toBeInTheDocument();
    });
});
