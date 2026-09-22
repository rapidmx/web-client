// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import PrincipalPicker, { describePerson } from "../../../apps/shared/components/sharing/PrincipalPicker.js";

const ROLE_LABELS = { viewer: "Can view", manager: "Can manage" };
const RESOLVE = "/api/mail/mailboxes/mb1/access/resolve";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("describePerson", () => {
    it("shows name and address, then whichever is known, then the uid", () => {
        expect(describePerson({ userUid: "u1", displayName: "Ada", address: "ada@example.com" })).toBe("Ada <ada@example.com>");
        expect(describePerson({ userUid: "u1", displayName: "Ada" })).toBe("Ada");
        expect(describePerson({ userUid: "u1", address: "ada@example.com" })).toBe("ada@example.com");
        expect(describePerson({ userUid: "u1" })).toBe("user u1");
    });
});

describe("PrincipalPicker", () => {
    it("resolves what was typed, shows the person, and grants their uid only after the caller confirms", async () => {
        const onGranted = vi.fn();
        const fetchMock = mockFetch((url, init) => {
            if (url.startsWith(RESOLVE)) return jsonResponse(200, { userUid: "u-ada", displayName: "Ada", address: "ada@example.com" });
            return jsonResponse(200, { userOrRoleId: "u-ada", role: "manager" });
        });
        const user = userEvent.setup();
        render(<PrincipalPicker mailboxUid="mb1" roleLabels={ROLE_LABELS} onGranted={onGranted} placeholder="Who?" />);

        await user.selectOptions(screen.getByLabelText("Access level"), "manager");
        await user.type(screen.getByPlaceholderText("Who?"), " ada ");
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText("Ada <ada@example.com>")).toBeInTheDocument();
        expect(screen.getByText("Can manage", { selector: "em" })).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: "Grant" }));
        await waitFor(() => expect(onGranted).toHaveBeenCalledWith({ userUid: "u-ada", displayName: "Ada", address: "ada@example.com" }, "manager"));
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1/access/u-ada", expect.objectContaining({ method: "PUT", body: JSON.stringify({ role: "manager" }) }));
        // Ready for the next person.
        expect(screen.getByLabelText("Who to share with")).toHaveValue("");
        expect(screen.queryByText(/Share with/)).not.toBeInTheDocument();
    });

    it("uses the default placeholder, ignores a blank box, and forgets the person when the text changes", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { userUid: "u1" }));
        const user = userEvent.setup();
        render(<PrincipalPicker mailboxUid="mb1" roleLabels={ROLE_LABELS} onGranted={vi.fn()} />);

        expect(screen.getByPlaceholderText("Email address, username or user id")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(fetchMock).not.toHaveBeenCalled();

        await user.type(screen.getByLabelText("Who to share with"), "abc");
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText("user u1")).toBeInTheDocument();
        await user.type(screen.getByLabelText("Who to share with"), "d");
        expect(screen.queryByText(/Share with/)).not.toBeInTheDocument();
    });

    it("says so when nobody is found, and with a generic message when the lookup itself fails", async () => {
        let network = false;
        mockFetch(() => {
            if (network) throw new TypeError("network down");
            return jsonResponse(404, { message: 'No user found for "x".' });
        });
        const user = userEvent.setup();
        render(<PrincipalPicker mailboxUid="mb1" roleLabels={ROLE_LABELS} onGranted={vi.fn()} />);
        await user.type(screen.getByLabelText("Who to share with"), "x");
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText('No user found for "x".')).toBeInTheDocument();
        network = true;
        await user.click(screen.getByRole("button", { name: "Find" }));
        expect(await screen.findByText("Could not look that person up.")).toBeInTheDocument();
    });

    it("reports a refused grant with the server's message, or a generic one, and keeps the person to try again", async () => {
        let network = false;
        mockFetch((url) => {
            if (url.startsWith(RESOLVE)) return jsonResponse(200, { userUid: "u1" });
            if (network) throw new TypeError("network down");
            return jsonResponse(403, { message: "not allowed" });
        });
        const user = userEvent.setup();
        render(<PrincipalPicker mailboxUid="mb1" roleLabels={ROLE_LABELS} onGranted={vi.fn()} />);
        await user.type(screen.getByLabelText("Who to share with"), "x");
        await user.click(screen.getByRole("button", { name: "Find" }));
        await user.click(await screen.findByRole("button", { name: "Grant" }));
        expect(await screen.findByText("not allowed")).toBeInTheDocument();
        network = true;
        await user.click(screen.getByRole("button", { name: "Grant" }));
        expect(await screen.findByText("Could not grant access.")).toBeInTheDocument();
    });

    it("looks a stored entry up at once when replacing it, pre-selects its access level, and offers Cancel", async () => {
        const onCancel = vi.fn();
        const fetchMock = mockFetch(() => jsonResponse(200, { userUid: "u1", displayName: "Ada" }));
        const user = userEvent.setup();
        render(<PrincipalPicker mailboxUid="mb1" roleLabels={ROLE_LABELS} initialPrincipal="ada-name" defaultRole="manager" onGranted={vi.fn()} onCancel={onCancel} />);
        expect(await screen.findByText("Ada")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(`${RESOLVE}?principal=ada-name`, expect.anything());
        expect(screen.getByLabelText("Who to share with")).toHaveValue("ada-name");
        expect(screen.getByLabelText("Access level")).toHaveValue("manager");
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onCancel).toHaveBeenCalled();
    });
});
