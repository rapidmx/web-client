// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../../testUtils.js";
import NewMatterPage from "../../../../../apps/escrow/matters/new/index.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

async function fillMinimalRequiredFields(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Name"), "Smith v. Acme");
    await user.type(screen.getByLabelText("Escrow scope uid"), "es1");
    await user.type(screen.getByLabelText("Custodian mailbox uids"), "mb1");
    await user.click(screen.getByRole("button", { name: "Add" }));
}

describe("NewMatterPage", () => {
    it("validates the name before submitting", async () => {
        mockFetch(() => jsonResponse(200, []));
        const user = userEvent.setup();
        render(<NewMatterPage userUid="u1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New matter");

        await user.click(screen.getByRole("button", { name: "Create matter" }));
        expect(await screen.findByText("A name is required.")).toBeInTheDocument();
    });

    it("validates the escrow scope uid is required", async () => {
        mockFetch(() => jsonResponse(200, []));
        const user = userEvent.setup();
        render(<NewMatterPage userUid="u1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New matter");

        await user.type(screen.getByLabelText("Name"), "Smith v. Acme");
        await user.click(screen.getByRole("button", { name: "Create matter" }));
        expect(await screen.findByText("An escrow scope uid is required.")).toBeInTheDocument();
    });

    it("validates at least one custodian mailbox is required", async () => {
        mockFetch(() => jsonResponse(200, []));
        const user = userEvent.setup();
        render(<NewMatterPage userUid="u1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New matter");

        await user.type(screen.getByLabelText("Name"), "Smith v. Acme");
        await user.type(screen.getByLabelText("Escrow scope uid"), "es1");
        await user.click(screen.getByRole("button", { name: "Create matter" }));
        expect(await screen.findByText("At least one custodian mailbox is required.")).toBeInTheDocument();
    });

    it("validates the date range start is before its end", async () => {
        mockFetch(() => jsonResponse(200, []));
        const user = userEvent.setup();
        render(<NewMatterPage userUid="u1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New matter");

        await fillMinimalRequiredFields(user);
        const start = screen.getByLabelText("Date range start") as HTMLInputElement;
        const end = screen.getByLabelText("Date range end") as HTMLInputElement;
        await user.clear(start);
        await user.type(start, "2026-06-01T00:00");
        await user.clear(end);
        await user.type(end, "2026-01-01T00:00");
        await user.click(screen.getByRole("button", { name: "Create matter" }));

        expect(await screen.findByText("The date range start must be before its end.")).toBeInTheDocument();
    });

    it("creates the matter and redirects to its detail page", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/escrow/matters" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "m1" });
            }
            // The shell's own reachability probe (a plain GET) - see `EscrowShell`'s own doc comment.
            if (url.startsWith("/api/escrow/matters") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<NewMatterPage userUid="u1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New matter");

        await fillMinimalRequiredFields(user);
        await user.click(screen.getByRole("button", { name: "Create matter" }));

        await vi.waitFor(() => expect(location.href).toBe("/escrow/matters/m1"));
        expect(requestBody.name).toBe("Smith v. Acme");
        expect(requestBody.escrowScopeId).toBe("es1");
        expect(requestBody.custodianMailboxUids).toEqual(["mb1"]);
        expect(typeof requestBody.dateRangeStart).toBe("string");
        expect(typeof requestBody.dateRangeEnd).toBe("string");
    });

    it("shows an error message when creation fails", async () => {
        mockFetch((url, init) => {
            if (url === "/api/escrow/matters" && init?.method === "POST") return jsonResponse(500, { message: "boom" });
            if (url.startsWith("/api/escrow/matters") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<NewMatterPage userUid="u1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New matter");

        await fillMinimalRequiredFields(user);
        await user.click(screen.getByRole("button", { name: "Create matter" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when creation fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url === "/api/escrow/matters" && init?.method === "POST") throw new TypeError("network down");
            if (url.startsWith("/api/escrow/matters") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<NewMatterPage userUid="u1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New matter");

        await fillMinimalRequiredFields(user);
        await user.click(screen.getByRole("button", { name: "Create matter" }));

        expect(await screen.findByText("Could not create the matter.")).toBeInTheDocument();
    });

    it("accepts a description", async () => {
        mockFetch(() => jsonResponse(200, []));
        const user = userEvent.setup();
        render(<NewMatterPage userUid="u1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New matter");

        await user.type(screen.getByLabelText("Description (optional)"), "Wrongful termination");
        expect(screen.getByLabelText("Description (optional)")).toHaveValue("Wrongful termination");
    });

    it("the Cancel link returns to the matters list", async () => {
        mockFetch(() => jsonResponse(200, []));
        render(<NewMatterPage userUid="u1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/escrow");
    });
});
