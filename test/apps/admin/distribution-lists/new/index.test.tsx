// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../../testUtils.js";
import NewDistributionListPage from "../../../../../apps/admin/distribution-lists/new/index.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("NewDistributionListPage", () => {
    it("validates required fields before submitting", async () => {
        mockFetch(() => jsonResponse(200, {}));
        const user = userEvent.setup();
        render(<NewDistributionListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New distribution list");

        await user.click(screen.getByRole("button", { name: "Create distribution list" }));
        expect(await screen.findByText("A primary SMTP address is required.")).toBeInTheDocument();

        await user.type(screen.getByLabelText("Primary SMTP address"), "team@example.com");
        await user.click(screen.getByRole("button", { name: "Create distribution list" }));
        expect(await screen.findByText("A name is required.")).toBeInTheDocument();
    });

    it("creates the distribution list and redirects to its detail page", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/distribution-lists" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "team@example.com" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<NewDistributionListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New distribution list");

        await user.type(screen.getByLabelText("Primary SMTP address"), "team@example.com");
        await user.type(screen.getByLabelText("Name"), "Team");
        await user.type(screen.getByLabelText("Description (optional)"), "Everyone");
        await user.click(screen.getByRole("button", { name: "Create distribution list" }));

        await vi.waitFor(() => expect(location.href).toBe("/admin/distribution-lists/team%40example.com"));
        expect(requestBody.description).toBe("Everyone");
    });

    it("omits description when not given", async () => {
        let requestBody: any;
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/mail/distribution-lists" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "team@example.com" });
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<NewDistributionListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New distribution list");

        await user.type(screen.getByLabelText("Primary SMTP address"), "team@example.com");
        await user.type(screen.getByLabelText("Name"), "Team");
        await user.click(screen.getByRole("button", { name: "Create distribution list" }));

        await vi.waitFor(() => expect(requestBody).toBeDefined());
        expect(requestBody.description).toBeUndefined();
    });

    it("shows an error message when creation fails", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(409, { message: "This address is already in use by another mailbox or distribution list." });
        });
        const user = userEvent.setup();
        render(<NewDistributionListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New distribution list");

        await user.type(screen.getByLabelText("Primary SMTP address"), "team@example.com");
        await user.type(screen.getByLabelText("Name"), "Team");
        await user.click(screen.getByRole("button", { name: "Create distribution list" }));

        expect(
            await screen.findByText("This address is already in use by another mailbox or distribution list."),
        ).toBeInTheDocument();
    });

    it("shows a generic error message when creation fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<NewDistributionListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("New distribution list");

        await user.type(screen.getByLabelText("Primary SMTP address"), "team@example.com");
        await user.type(screen.getByLabelText("Name"), "Team");
        await user.click(screen.getByRole("button", { name: "Create distribution list" }));

        expect(await screen.findByText("Could not create the distribution list.")).toBeInTheDocument();
    });

    it("the Cancel link returns to the distribution lists list", async () => {
        mockFetch(() => jsonResponse(200, {}));
        render(<NewDistributionListPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/admin/distribution-lists");
    });
});
