// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../../testUtils.js";
import NewDomainPage from "../../../../../apps/admin/domains/new/index.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("NewDomainPage", () => {
    it("validates the domain name before submitting", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewDomainPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New domain");

        await user.click(screen.getByRole("button", { name: "Create domain" }));
        expect(await screen.findByText("A domain name is required.")).toBeInTheDocument();
    });

    it("creates the domain and redirects to its detail page", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/domains" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "example.com" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<NewDomainPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New domain");

        await user.type(screen.getByLabelText("Domain name"), "example.com");
        await user.click(screen.getByRole("button", { name: "Create domain" }));

        await vi.waitFor(() => expect(location.href).toBe("/admin/domains/example.com"));
        expect(requestBody).toEqual({ enabled: true, name: "example.com" });
    });

    it("shows an error message when creation fails", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(409, { message: "This domain has already been added." });
        });
        const user = userEvent.setup();
        render(<NewDomainPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New domain");

        await user.type(screen.getByLabelText("Domain name"), "example.com");
        await user.click(screen.getByRole("button", { name: "Create domain" }));

        expect(await screen.findByText("This domain has already been added.")).toBeInTheDocument();
    });

    it("shows a generic error message when creation fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<NewDomainPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New domain");

        await user.type(screen.getByLabelText("Domain name"), "example.com");
        await user.click(screen.getByRole("button", { name: "Create domain" }));

        expect(await screen.findByText("Could not create the domain.")).toBeInTheDocument();
    });

    it("the Cancel link returns to the domains list", async () => {
        mockFetch(() => jsonResponse(200, {}));
        render(<NewDomainPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/admin/domains");
    });
});
