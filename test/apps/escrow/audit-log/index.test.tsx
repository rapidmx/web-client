// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import EscrowAuditLogPage from "../../../../apps/escrow/audit-log/index.js";

const entry = (n: number) => ({
    uid: `eal${n}`,
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    sequence: n,
    hash: `hash${n}`,
    action: "escrow_access_request.created" as const,
    holderUserUid: "u1",
    matterId: "m1",
    mailboxUid: `mb${n}`,
    requestId: `ar${n}`,
    occurredAt: "2026-01-01T00:00:00.000Z",
});

/** Every test needs the `EscrowShell`'s own reachability probe (`GET /escrow/matters?limit=1`) handled
 * alongside whatever this specific test cares about — see `EscrowShell`'s own doc comment. */
function mockAuditLogFetch(handle: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const handled = handle(url, init);
        if (handled) return handled;
        if (url.startsWith("/api/escrow/matters")) return jsonResponse(200, []);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("EscrowAuditLogPage", () => {
    it("shows an empty state when there are no visible entries, without a Verify button for a non-trusted holder", async () => {
        mockAuditLogFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(403, { message: "not trusted" });
            if (url.startsWith("/api/escrow/audit-log")) return jsonResponse(200, []);
        });
        render(<EscrowAuditLogPage userUid="u1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByText("No audit log entries visible to you yet.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Verify chain integrity" })).not.toBeInTheDocument();
    });

    it("lists audit log entries with a human-readable action label", async () => {
        mockAuditLogFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(403, { message: "not trusted" });
            if (url.startsWith("/api/escrow/audit-log")) return jsonResponse(200, [entry(1)]);
        });
        render(<EscrowAuditLogPage userUid="u1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByText("Access request created")).toBeInTheDocument();
        expect(screen.getByText("u1")).toBeInTheDocument();
        expect(screen.getByText("mb1")).toBeInTheDocument();
    });

    it("labels matter export events, and falls back to the raw action name for an unknown one", async () => {
        mockAuditLogFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(403, { message: "not trusted" });
            if (url.startsWith("/api/escrow/audit-log")) {
                return jsonResponse(200, [
                    { ...entry(1), action: "matter_export.requested" },
                    { ...entry(2), action: "matter_export.ready" },
                    { ...entry(3), action: "matter_export.failed" },
                    { ...entry(4), action: "matter.closed" },
                ]);
            }
        });
        render(<EscrowAuditLogPage userUid="u1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByText("Matter export requested")).toBeInTheDocument();
        expect(screen.getByText("Matter export ready")).toBeInTheDocument();
        expect(screen.getByText("Matter export failed")).toBeInTheDocument();
        expect(screen.getByText("matter.closed")).toBeInTheDocument();
    });

    it("shows an error message when the list fails to load", async () => {
        mockAuditLogFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(403, { message: "not trusted" });
            if (url.startsWith("/api/escrow/audit-log")) return jsonResponse(500, { message: "boom" });
        });
        render(<EscrowAuditLogPage userUid="u1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when the list fails with a non-API error", async () => {
        mockAuditLogFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(403, { message: "not trusted" });
            if (url.startsWith("/api/escrow/audit-log")) throw new TypeError("network down");
        });
        render(<EscrowAuditLogPage userUid="u1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Could not load the audit log.")).toBeInTheDocument();
    });

    it("paginates: Next fetches the following page, Previous returns to the first", async () => {
        const fullPage = Array.from({ length: 25 }, (_, i) => entry(i));
        mockAuditLogFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(403, { message: "not trusted" });
            if (url.startsWith("/api/escrow/audit-log") && url.includes("page=0")) return jsonResponse(200, fullPage);
            if (url.startsWith("/api/escrow/audit-log") && url.includes("page=1")) return jsonResponse(200, [entry(99)]);
        });
        const user = userEvent.setup();
        render(<EscrowAuditLogPage userUid="u1" authServerUrl="https://auth.example.com" />);

        await screen.findByText("mb0");
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Next" }));
        await screen.findByText("mb99");
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Previous" }));
        expect(await screen.findByText("mb0")).toBeInTheDocument();
    });

    it("shows the Verify button for a trusted caller and reports a valid chain", async () => {
        mockAuditLogFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/audit-log/verify") return jsonResponse(200, { valid: true });
            if (url.startsWith("/api/escrow/audit-log")) return jsonResponse(200, [entry(1)]);
        });
        const user = userEvent.setup();
        render(<EscrowAuditLogPage userUid="u1" authServerUrl="https://auth.example.com" />);

        await user.click(await screen.findByRole("button", { name: "Verify chain integrity" }));
        expect(await screen.findByText("Chain verified — no tampering detected.")).toBeInTheDocument();
    });

    it("reports a broken chain with its sequence", async () => {
        mockAuditLogFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/audit-log/verify") return jsonResponse(200, { valid: false, brokenAtSequence: 4 });
            if (url.startsWith("/api/escrow/audit-log")) return jsonResponse(200, [entry(1)]);
        });
        const user = userEvent.setup();
        render(<EscrowAuditLogPage userUid="u1" authServerUrl="https://auth.example.com" />);

        await user.click(await screen.findByRole("button", { name: "Verify chain integrity" }));
        expect(await screen.findByText("Chain integrity broken at sequence 4.")).toBeInTheDocument();
    });

    it("shows an error message when verification fails", async () => {
        mockAuditLogFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/audit-log/verify") return jsonResponse(500, { message: "boom" });
            if (url.startsWith("/api/escrow/audit-log")) return jsonResponse(200, [entry(1)]);
        });
        const user = userEvent.setup();
        render(<EscrowAuditLogPage userUid="u1" authServerUrl="https://auth.example.com" />);

        await user.click(await screen.findByRole("button", { name: "Verify chain integrity" }));
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when verification fails with a non-API error", async () => {
        mockAuditLogFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url === "/api/escrow/audit-log/verify") throw new TypeError("network down");
            if (url.startsWith("/api/escrow/audit-log")) return jsonResponse(200, [entry(1)]);
        });
        const user = userEvent.setup();
        render(<EscrowAuditLogPage userUid="u1" authServerUrl="https://auth.example.com" />);

        await user.click(await screen.findByRole("button", { name: "Verify chain integrity" }));
        expect(await screen.findByText("Could not verify the audit chain.")).toBeInTheDocument();
    });
});
