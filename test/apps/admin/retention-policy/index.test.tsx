// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import RetentionPolicyPage from "../../../../apps/admin/retention-policy/index.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

describe("RetentionPolicyPage", () => {
    it("renders the loaded policy's configured values", async () => {
        mockShell((url) =>
            url === "/api/system/retention-policy" ? jsonResponse(200, { messageRetentionDays: 90, auditLogRetentionDays: 2555 }) : undefined,
        );
        render(<RetentionPolicyPage userUid="admin-1" />);

        expect(await screen.findByLabelText("Message retention (days)")).toHaveValue(90);
        expect(screen.getByLabelText("Audit log retention (days)")).toHaveValue(2555);
    });

    it("shows both fields empty when nothing has been configured yet", async () => {
        mockShell((url) => (url === "/api/system/retention-policy" ? jsonResponse(200, {}) : undefined));
        render(<RetentionPolicyPage userUid="admin-1" />);

        expect(await screen.findByLabelText("Message retention (days)")).toHaveValue(null);
        expect(screen.getByLabelText("Audit log retention (days)")).toHaveValue(null);
    });

    it("shows an error when the policy fails to load", async () => {
        mockShell((url) => (url === "/api/system/retention-policy" ? jsonResponse(403, { message: "not an admin" }) : undefined));
        render(<RetentionPolicyPage userUid="admin-1" />);

        expect(await screen.findByText("not an admin")).toBeInTheDocument();
    });

    it("shows a generic error when loading the policy fails with a non-API error", async () => {
        mockShell((url) => {
            if (url === "/api/system/retention-policy") throw new TypeError("network down");
            return undefined;
        });
        render(<RetentionPolicyPage userUid="admin-1" />);

        expect(await screen.findByText("Could not load the retention policy.")).toBeInTheDocument();
    });

    it("saves both fields", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/system/retention-policy" && (init?.method ?? "GET") === "GET") return jsonResponse(200, {});
            if (url === "/api/system/retention-policy" && init?.method === "PUT") {
                return jsonResponse(200, { messageRetentionDays: 30, auditLogRetentionDays: 2190 });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<RetentionPolicyPage userUid="admin-1" />);
        await screen.findByLabelText("Message retention (days)");

        await user.type(screen.getByLabelText("Message retention (days)"), "30");
        await user.type(screen.getByLabelText("Audit log retention (days)"), "2190");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
        expect(JSON.parse(putCall[1]!.body as string)).toEqual({ messageRetentionDays: 30, auditLogRetentionDays: 2190 });
    });

    it("sends a blank message-retention field as null, saving the audit-log field", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/system/retention-policy" && (init?.method ?? "GET") === "GET") return jsonResponse(200, {});
            if (url === "/api/system/retention-policy" && init?.method === "PUT") return jsonResponse(200, { auditLogRetentionDays: 2190 });
            return undefined;
        });
        const user = userEvent.setup();
        render(<RetentionPolicyPage userUid="admin-1" />);
        await screen.findByLabelText("Message retention (days)");

        await user.type(screen.getByLabelText("Audit log retention (days)"), "2190");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await vi.waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
        const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
        expect(JSON.parse(putCall[1]!.body as string)).toEqual({ messageRetentionDays: null, auditLogRetentionDays: 2190 });
    });

    it("sends a blank audit-log field as null, saving the message-retention field", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/system/retention-policy" && (init?.method ?? "GET") === "GET") return jsonResponse(200, {});
            if (url === "/api/system/retention-policy" && init?.method === "PUT") return jsonResponse(200, { messageRetentionDays: 30 });
            return undefined;
        });
        const user = userEvent.setup();
        render(<RetentionPolicyPage userUid="admin-1" />);
        await screen.findByLabelText("Message retention (days)");

        await user.type(screen.getByLabelText("Message retention (days)"), "30");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await vi.waitFor(() => expect(screen.getByText("Saved.")).toBeInTheDocument());
        const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
        expect(JSON.parse(putCall[1]!.body as string)).toEqual({ messageRetentionDays: 30, auditLogRetentionDays: null });
    });

    it("clears an already-configured period by sending null", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/system/retention-policy" && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, { messageRetentionDays: 90, auditLogRetentionDays: 2555 });
            }
            if (url === "/api/system/retention-policy" && init?.method === "PUT") return jsonResponse(200, { auditLogRetentionDays: 2555 });
            return undefined;
        });
        const user = userEvent.setup();
        render(<RetentionPolicyPage userUid="admin-1" />);
        const message = await screen.findByLabelText("Message retention (days)");

        await user.clear(message);
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
        expect(JSON.parse(putCall[1]!.body as string)).toEqual({ messageRetentionDays: null, auditLogRetentionDays: 2555 });
    });

    it("shows the server's own message when saving fails with an ApiRequestError", async () => {
        mockShell((url, init) => {
            if (url === "/api/system/retention-policy" && (init?.method ?? "GET") === "GET") return jsonResponse(200, {});
            if (url === "/api/system/retention-policy" && init?.method === "PUT") {
                return jsonResponse(400, { message: "'messageRetentionDays' must be a positive integer number of days." });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<RetentionPolicyPage userUid="admin-1" />);
        await screen.findByLabelText("Message retention (days)");

        await user.type(screen.getByLabelText("Message retention (days)"), "30");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("'messageRetentionDays' must be a positive integer number of days.")).toBeInTheDocument();
    });

    it("shows a generic error when saving fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/system/retention-policy" && (init?.method ?? "GET") === "GET") return jsonResponse(200, {});
            if (url === "/api/system/retention-policy" && init?.method === "PUT") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<RetentionPolicyPage userUid="admin-1" />);
        await screen.findByLabelText("Message retention (days)");

        await user.type(screen.getByLabelText("Message retention (days)"), "30");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByText("Could not save the retention policy.")).toBeInTheDocument();
    });
});
