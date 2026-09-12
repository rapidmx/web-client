// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsLabelsPage from "../../../../apps/www/settings/labels/index.js";

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

function label(n: number, overrides: Record<string, unknown> = {}) {
    return {
        uid: `l${n}`,
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        name: `Label ${n}`,
        color: "#e11d48",
        ...overrides,
    };
}

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("SettingsLabelsPage", () => {
    it("shows an empty state when there are no labels", async () => {
        mockShell((url) => (url.startsWith("/api/mail/labels") ? jsonResponse(200, []) : undefined));
        render(<SettingsLabelsPage userUid="u1" />);
        expect(await screen.findByText("No labels yet.")).toBeInTheDocument();
    });

    it("lists existing labels", async () => {
        mockShell((url) => (url.startsWith("/api/mail/labels") ? jsonResponse(200, [label(1), label(2)]) : undefined));
        render(<SettingsLabelsPage userUid="u1" />);

        expect(await screen.findByText("Label 1")).toBeInTheDocument();
        expect(screen.getByText("Label 2")).toBeInTheDocument();
    });

    it("shows an error message when the list fails to load", async () => {
        mockShell((url) => (url.startsWith("/api/mail/labels") ? jsonResponse(500, { message: "boom" }) : undefined));
        render(<SettingsLabelsPage userUid="u1" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the list fails with a non-API error", async () => {
        mockShell((url) => {
            if (url.startsWith("/api/mail/labels")) throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsLabelsPage userUid="u1" />);
        expect(await screen.findByText("Could not load labels.")).toBeInTheDocument();
    });

    it("creates a new label and adds it to the list", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url.startsWith("/api/mail/labels") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            if (url === "/api/mail/labels" && init?.method === "POST") return jsonResponse(200, label(1, { name: "Urgent" }));
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("No labels yet.");

        await user.click(screen.getByRole("button", { name: "+ New label" }));
        await user.type(screen.getByLabelText("Name"), "Urgent");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Urgent")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/labels",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ mailboxUid: "mb1", name: "Urgent", color: "#6366f1" }),
            }),
        );
    });

    it("shows an error and keeps the form open when creating a label fails", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/labels") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            if (url === "/api/mail/labels" && init?.method === "POST") return jsonResponse(500, { message: "boom" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("No labels yet.");

        await user.click(screen.getByRole("button", { name: "+ New label" }));
        await user.type(screen.getByLabelText("Name"), "Urgent");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
        expect(screen.getByRole("dialog", { name: "New label" })).toBeInTheDocument();
    });

    it("edits an existing label, pre-filling the form with its current name", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/labels") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [label(1)]);
            if (url === "/api/mail/labels/l1" && init?.method === "PUT") return jsonResponse(200, label(1, { name: "Renamed", version: 1 }));
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("Label 1");

        await user.click(screen.getByRole("button", { name: "Edit" }));
        expect(screen.getByLabelText("Name")).toHaveValue("Label 1");

        await user.clear(screen.getByLabelText("Name"));
        await user.type(screen.getByLabelText("Name"), "Renamed");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Renamed")).toBeInTheDocument();
        expect(screen.queryByText("Label 1")).not.toBeInTheDocument();
    });

    it("deletes a label after confirming", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url.startsWith("/api/mail/labels") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [label(1)]);
            if (url === "/api/mail/labels/l1?version=0" && init?.method === "DELETE") return emptyResponse(200);
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("Label 1");

        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(screen.getByRole("dialog", { name: "Delete this label?" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Delete label" }));

        expect(fetchMock).toHaveBeenCalledWith("/api/mail/labels/l1?version=0", expect.objectContaining({ method: "DELETE" }));
        expect(await screen.findByText("No labels yet.")).toBeInTheDocument();
    });

    it("shows an error and keeps the confirmation open when deleting a label fails", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/labels") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [label(1)]);
            if (url === "/api/mail/labels/l1?version=0" && init?.method === "DELETE") return jsonResponse(500, { message: "boom" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("Label 1");

        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getByRole("button", { name: "Delete label" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
        expect(screen.getByRole("dialog", { name: "Delete this label?" })).toBeInTheDocument();
    });

    it("cancels the delete confirmation without calling the API", async () => {
        const fetchMock = mockShell((url) => (url.startsWith("/api/mail/labels") ? jsonResponse(200, [label(1)]) : undefined));
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("Label 1");

        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes("DELETE"))).toBe(false);
        expect(screen.getByText("Label 1")).toBeInTheDocument();
    });

    it("cancels the create form without calling the API", async () => {
        const fetchMock = mockShell((url) => (url.startsWith("/api/mail/labels") ? jsonResponse(200, []) : undefined));
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("No labels yet.");

        await user.click(screen.getByRole("button", { name: "+ New label" }));
        await user.type(screen.getByLabelText("Name"), "Urgent");
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    });

    it("changes the color swatch before saving", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url.startsWith("/api/mail/labels") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            if (url === "/api/mail/labels" && init?.method === "POST") return jsonResponse(200, label(1, { name: "Urgent", color: "#00ff00" }));
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("No labels yet.");

        await user.click(screen.getByRole("button", { name: "+ New label" }));
        await user.type(screen.getByLabelText("Name"), "Urgent");
        fireEvent.change(screen.getByLabelText("Color"), { target: { value: "#00ff00" } });
        await user.click(screen.getByRole("button", { name: "Save" }));

        await screen.findByText("Urgent");
        const body = JSON.parse((fetchMock.mock.calls.find(([, init]) => init?.method === "POST")![1] as RequestInit).body as string);
        expect(body.color).toBe("#00ff00");
    });

    it("closes the create/edit modal via its own close button", async () => {
        mockShell((url) => (url.startsWith("/api/mail/labels") ? jsonResponse(200, []) : undefined));
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("No labels yet.");

        await user.click(screen.getByRole("button", { name: "+ New label" }));
        expect(screen.getByRole("dialog", { name: "New label" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("closes the delete confirmation via its own close button", async () => {
        mockShell((url) => (url.startsWith("/api/mail/labels") ? jsonResponse(200, [label(1)]) : undefined));
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("Label 1");

        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(screen.getByRole("dialog", { name: "Delete this label?" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("falls back to the default color for a label with none set, and edit/delete on one label leaves a sibling untouched", async () => {
        const withColor = label(1);
        const noColor = label(2, { color: undefined });
        const fetchMock = mockShell((url, init) => {
            if (url.startsWith("/api/mail/labels") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [withColor, noColor]);
            if (url === "/api/mail/labels/l2" && init?.method === "PUT") return jsonResponse(200, { ...noColor, name: "Renamed", version: 1 });
            if (url === "/api/mail/labels/l1?version=0" && init?.method === "DELETE") return emptyResponse(200);
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("Label 1");
        await screen.findByText("Label 2");

        // Editing the colorless label pre-fills the form's color with the default (line 64's `??`
        // fallback) rather than an empty/invalid value.
        await user.click(screen.getAllByRole("button", { name: "Edit" })[1]);
        expect(screen.getByLabelText("Color")).toHaveValue("#6366f1");
        await user.clear(screen.getByLabelText("Name"));
        await user.type(screen.getByLabelText("Name"), "Renamed");
        await user.click(screen.getByRole("button", { name: "Save" }));

        // Label 1 (untouched by this edit) is still there, proving the local-state map keeps a
        // non-matching entry as-is rather than only ever handling a single-item list.
        await screen.findByText("Renamed");
        expect(screen.getByText("Label 1")).toBeInTheDocument();

        // Deleting Label 1 now leaves the renamed one behind, same reasoning for the filter path.
        await user.click(screen.getAllByRole("button", { name: "Delete" })[0]);
        await user.click(screen.getByRole("button", { name: "Delete label" }));

        await waitFor(() => expect(screen.queryByText("Label 1")).not.toBeInTheDocument());
        expect(screen.getByText("Renamed")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/labels/l1?version=0", expect.objectContaining({ method: "DELETE" }));
    });

    it("disables Save until a name is entered", async () => {
        mockShell((url) => (url.startsWith("/api/mail/labels") ? jsonResponse(200, []) : undefined));
        const user = userEvent.setup();
        render(<SettingsLabelsPage userUid="u1" />);
        await screen.findByText("No labels yet.");

        await user.click(screen.getByRole("button", { name: "+ New label" }));
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

        await user.type(screen.getByLabelText("Name"), "Urgent");
        expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });
});
