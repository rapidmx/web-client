// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../../testUtils.js";
import NewEscrowScopePage from "../../../../../apps/admin/escrow-scopes/new/index.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

async function fillMinimalRequiredFields(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Name"), "Legal Hold Q1");
    await user.type(screen.getByLabelText("Public key (base64)"), "base64cert");
    await user.clear(screen.getByLabelText("Fingerprint (hex SHA-256)"));
    await user.type(screen.getByLabelText("Fingerprint (hex SHA-256)"), "abc123");
    await user.type(screen.getByLabelText("Holder user uids"), "u1");
    await user.click(screen.getByRole("button", { name: "Add" }));
}

describe("NewEscrowScopePage", () => {
    it("validates the name before submitting", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));
        expect(await screen.findByText("A name is required.")).toBeInTheDocument();
    });

    it("validates the public key fields before submitting", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await user.type(screen.getByLabelText("Name"), "Legal Hold Q1");
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));

        expect(
            await screen.findByText("The public key, its type, and its fingerprint are all required."),
        ).toBeInTheDocument();
    });

    it("refuses to make the signed-in admin a holder", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await user.type(screen.getByLabelText("Name"), "Legal Hold Q1");
        await user.type(screen.getByLabelText("Public key (base64)"), "base64cert");
        await user.type(screen.getByLabelText("Fingerprint (hex SHA-256)"), "abc123");
        await user.type(screen.getByLabelText("Holder user uids"), "admin-1");
        await user.click(screen.getByRole("button", { name: "Add" }));
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));

        expect(await screen.findByText(/You can't add yourself as a holder/)).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === "POST")).toBe(false);
    });

    it("validates at least one holder is required", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await user.type(screen.getByLabelText("Name"), "Legal Hold Q1");
        await user.type(screen.getByLabelText("Public key (base64)"), "base64cert");
        await user.type(screen.getByLabelText("Fingerprint (hex SHA-256)"), "abc123");
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));

        expect(await screen.findByText("At least one holder is required.")).toBeInTheDocument();
    });

    it("validates requiredHolders stays within 1..holderUserUids.length", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await fillMinimalRequiredFields(user);
        const requiredHolders = screen.getByLabelText("Required holders (M-of-N dual control)");
        await user.clear(requiredHolders);
        await user.type(requiredHolders, "5");
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));

        expect(
            await screen.findByText("Required holders must be between 1 and the number of holders."),
        ).toBeInTheDocument();
    });

    it("accepts a description", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await user.type(screen.getByLabelText("Description (optional)"), "eDiscovery scope");
        expect(screen.getByLabelText("Description (optional)")).toHaveValue("eDiscovery scope");
    });

    it("creates the escrow scope and redirects to its detail page", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/scopes" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "es1" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await fillMinimalRequiredFields(user);
        await user.clear(screen.getByLabelText("Key type"));
        await user.type(screen.getByLabelText("Key type"), "ec-p256");
        const notBefore = screen.getByLabelText("Not before");
        const notAfter = screen.getByLabelText("Not after");
        await user.clear(notBefore);
        await user.type(notBefore, "2026-01-01T00:00");
        await user.clear(notAfter);
        await user.type(notAfter, "2027-01-01T00:00");
        await user.click(screen.getByRole("checkbox", { name: "Notify subject on access" }));
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));

        await vi.waitFor(() => expect(location.href).toBe("/admin/escrow-scopes/es1"));
        expect(requestBody.name).toBe("Legal Hold Q1");
        expect(requestBody.publicKey.publicKey).toBe("base64cert");
        expect(requestBody.publicKey.type).toBe("ec-p256");
        expect(requestBody.publicKey.fingerprint).toBe("abc123");
        expect(typeof requestBody.publicKey.notBefore).toBe("number");
        expect(typeof requestBody.publicKey.notAfter).toBe("number");
        expect(requestBody.publicKey.notBefore).toBeLessThan(requestBody.publicKey.notAfter);
        expect(requestBody.holderUserUids).toEqual(["u1"]);
        expect(requestBody.requiredHolders).toBe(1);
        expect(requestBody.notifySubjectOnAccess).toBe(true);
    });

    it("supports removing an added holder before submitting", async () => {
        const user = userEvent.setup();
        mockFetch(() => jsonResponse(200, {}));
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await user.type(screen.getByLabelText("Holder user uids"), "u1");
        await user.click(screen.getByRole("button", { name: "Add" }));
        expect(screen.getByText("u1")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Remove" }));
        expect(screen.queryByText("u1")).not.toBeInTheDocument();
        expect(screen.getByText("No holders added yet.")).toBeInTheDocument();
    });

    it("adds a holder by pressing Enter in the input, not just by clicking Add", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await user.type(screen.getByLabelText("Holder user uids"), "u1{Enter}");
        expect(screen.getByText("u1")).toBeInTheDocument();
    });

    it("does not add a blank or already-present holder", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await user.click(screen.getByRole("button", { name: "Add" }));
        expect(screen.getByText("No holders added yet.")).toBeInTheDocument();

        await user.type(screen.getByLabelText("Holder user uids"), "u1");
        await user.click(screen.getByRole("button", { name: "Add" }));
        await user.type(screen.getByLabelText("Holder user uids"), "u1");
        await user.click(screen.getByRole("button", { name: "Add" }));
        expect(screen.getAllByText("u1")).toHaveLength(1);
    });

    it("shows an error message when creation fails", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(500, { message: "boom" });
        });
        const user = userEvent.setup();
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await fillMinimalRequiredFields(user);
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when creation fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New escrow scope");

        await fillMinimalRequiredFields(user);
        await user.click(screen.getByRole("button", { name: "Create escrow scope" }));

        expect(await screen.findByText("Could not create the escrow scope.")).toBeInTheDocument();
    });

    it("the Cancel link returns to the escrow scopes list", async () => {
        mockFetch(() => jsonResponse(200, {}));
        render(<NewEscrowScopePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/admin/escrow-scopes");
    });
});
