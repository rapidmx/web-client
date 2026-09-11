// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import AuditLogPage from "../../../../apps/admin/audit-log/index.js";

const entry = (n: number) => ({
    uid: `al${n}`,
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    actorUserUid: `u${n}`,
    action: "domain.create",
    targetType: "Domain",
    targetUid: `example${n}.com`,
});

beforeEach(() => {
    window.history.pushState(null, "", "/admin/audit-log");
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState(null, "", "/");
});

describe("AuditLogPage", () => {
    it("lists entries with actor/action/target/mailbox columns", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/audit-log")) {
                return jsonResponse(200, [{ ...entry(1), mailboxUid: "mb1" }, { ...entry(2), actorUserUid: undefined }]);
            }
            throw new Error(`unexpected ${url}`);
        });
        render(<AuditLogPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findAllByText("domain.create")).toHaveLength(2);
        expect(screen.getByText("Domain · example1.com")).toBeInTheDocument();
        expect(screen.getByText("mb1")).toBeInTheDocument();
        expect(screen.getByText("System")).toBeInTheDocument();
    });

    it("shows an empty state when there are no matching entries", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/audit-log")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<AuditLogPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("No matching audit log entries.")).toBeInTheDocument();
    });

    it("shows a Details disclosure only for entries with details, expandable to the raw JSON", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/audit-log")) {
                return jsonResponse(200, [
                    { ...entry(1), details: { name: "example1.com" } },
                    { ...entry(2), details: undefined },
                ]);
            }
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<AuditLogPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        const summaries = await screen.findAllByText("Details");
        expect(summaries).toHaveLength(1);
        await user.click(summaries[0]);
        expect(screen.getByText(/"name": "example1.com"/)).toBeInTheDocument();
    });

    it("seeds filters from the query string and reflects filter changes back into the URL", async () => {
        window.history.pushState(null, "", "/admin/audit-log?mailboxUid=mb1&actorUserUid=u1&action=domain.create&targetType=Domain");
        let lastUrl: string | undefined;
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/audit-log")) {
                lastUrl = url;
                return jsonResponse(200, []);
            }
            throw new Error(`unexpected ${url}`);
        });
        render(<AuditLogPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await vi.waitFor(() =>
            expect(lastUrl).toBe("/api/mail/audit-log?limit=25&page=0&mailboxUid=mb1&actorUserUid=u1&action=domain.create&targetType=Domain"),
        );
        expect(screen.getByLabelText("Mailbox uid")).toHaveValue("mb1");
        expect(screen.getByLabelText("Actor user uid")).toHaveValue("u1");
        expect(screen.getByLabelText("Action")).toHaveValue("domain.create");
        expect(screen.getByLabelText("Target type")).toHaveValue("Domain");

        const user = userEvent.setup();
        await user.clear(screen.getByLabelText("Mailbox uid"));
        await vi.waitFor(() => expect(window.location.search).not.toContain("mailboxUid"));
        expect(window.location.search).toContain("actorUserUid=u1");

        await user.clear(screen.getByLabelText("Actor user uid"));
        await vi.waitFor(() => expect(window.location.search).not.toContain("actorUserUid"));
        await user.clear(screen.getByLabelText("Action"));
        await vi.waitFor(() => expect(window.location.search).not.toContain("action="));
        await user.clear(screen.getByLabelText("Target type"));
        await vi.waitFor(() => expect(window.location.search).toBe(""));
    });

    it("clears the query string entirely once every filter is empty", async () => {
        window.history.pushState(null, "", "/admin/audit-log?mailboxUid=mb1");
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/audit-log")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<AuditLogPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByDisplayValue("mb1")).toBeInTheDocument();
        await user.clear(screen.getByLabelText("Mailbox uid"));
        await vi.waitFor(() => expect(window.location.search).toBe(""));
    });

    it("shows an error message when loading the audit log fails", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(500, { message: "boom" });
        });
        render(<AuditLogPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading the audit log fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<AuditLogPage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Could not load the audit log.")).toBeInTheDocument();
    });

    it("paginates: Next fetches the following page, Previous returns to the first", async () => {
        const fullPage = Array.from({ length: 25 }, (_, i) => entry(i));
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.includes("page=0")) return jsonResponse(200, fullPage);
            if (url.includes("page=1")) return jsonResponse(200, [entry(99)]);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<AuditLogPage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        await screen.findByText("Domain · example0.com");
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("Domain · example99.com")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Previous" }));
        expect(await screen.findByText("Domain · example0.com")).toBeInTheDocument();
    });
});
