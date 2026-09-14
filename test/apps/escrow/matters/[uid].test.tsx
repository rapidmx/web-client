// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import MatterDetailPage from "../../../../apps/escrow/matters/[uid].js";

const matter = {
    uid: "m1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    name: "Smith v. Acme",
    description: "Wrongful termination",
    escrowScopeId: "es1",
    custodianMailboxUids: ["mb1", "mb2"],
    dateRangeStart: "2025-01-01T00:00:00.000Z",
    dateRangeEnd: "2025-12-31T00:00:00.000Z",
};

const pendingRequest = {
    uid: "ar1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    matterId: "m1",
    mailboxUid: "mb1",
    requestedByUserUid: "u1",
    approvals: [{ holderUserUid: "u1", approvedAt: "2026-01-01T00:00:00.000Z" }],
    requiredHoldersAtCreation: 2,
    status: "pending" as const,
};

const approvedRequest = {
    ...pendingRequest,
    uid: "ar2",
    approvals: [
        { holderUserUid: "u1", approvedAt: "2026-01-01T00:00:00.000Z" },
        { holderUserUid: "u2", approvedAt: "2026-01-02T00:00:00.000Z" },
    ],
    status: "approved" as const,
};

const otherMatterRequest = { ...pendingRequest, uid: "ar99", matterId: "m2" };

// Override keys of the form "METHOD path" match a specific method+path pair exactly; a bare "path" (no
// leading METHOD) matches by prefix instead, since the real GET calls it stands in for
// (`/escrow/access-requests`, `/escrow/audit-log`) always carry a `?limit=...&page=...` query string a
// plain `===` could never match.
function mockMatterFetch(overrides: Record<string, (init?: RequestInit) => Response> = {}) {
    return mockFetch((url, init) => {
        const key = `${init?.method ?? "GET"} ${url}`;
        // Longest pattern first, so a specific sub-resource override (e.g. the `/material` sub-route)
        // is tried before a shorter, bare list-endpoint override whose prefix it happens to share.
        const sortedOverrides = Object.entries(overrides).sort(([a], [b]) => b.length - a.length);
        for (const [pattern, handler] of sortedOverrides) {
            const hasMethod = /^[A-Z]+ /.test(pattern);
            if (hasMethod ? key === pattern : url === pattern || url.startsWith(pattern)) {
                return handler(init);
            }
        }
        if (url === "/api/escrow/matters/m1") return jsonResponse(200, matter);
        // The shell's own reachability probe (a plain GET against the list endpoint) - see `EscrowShell`'s
        // own doc comment. Distinct from the `/api/escrow/matters/m1` single-matter fetch above.
        if (url.startsWith("/api/escrow/matters?")) return jsonResponse(200, []);
        if (url.startsWith("/api/escrow/access-requests")) return jsonResponse(200, [pendingRequest, otherMatterRequest]);
        if (url.startsWith("/api/escrow/matter-export-requests")) return jsonResponse(200, []);
        throw new Error(`unexpected ${key}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("MatterDetailPage", () => {
    it("renders the matter's details and only its own matter's access requests (filtering out other matters')", async () => {
        mockMatterFetch();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);

        expect(await screen.findByRole("heading", { name: "Smith v. Acme" })).toBeInTheDocument();
        expect(screen.getByText("Wrongful termination")).toBeInTheDocument();
        expect(screen.getByText("mb1, mb2")).toBeInTheDocument();
        expect(screen.getByText("Open")).toBeInTheDocument();
        expect(screen.getByText("mb1")).toBeInTheDocument();
        expect(screen.queryByText("ar99")).not.toBeInTheDocument();
        // Only one row rendered (ar1) - ar99 belongs to a different matter and must not appear.
        expect(screen.getAllByText(/approvals/)).toHaveLength(1);
    });

    it("shows 'None' for the description when the matter has none", async () => {
        const { description, ...matterWithoutDescription } = matter;
        mockFetch((url) => {
            if (url === "/api/escrow/matters/m1") return jsonResponse(200, matterWithoutDescription);
            if (url.startsWith("/api/escrow/matters?")) return jsonResponse(200, []);
            if (url.startsWith("/api/escrow/access-requests")) return jsonResponse(200, []);
            if (url.startsWith("/api/escrow/matter-export-requests")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);

        expect(await screen.findByRole("heading", { name: "Smith v. Acme" })).toBeInTheDocument();
        expect(screen.getByText("None")).toBeInTheDocument();
    });

    it("shows an error message when the matter fails to load", async () => {
        // The shell's own reachability probe must succeed independently of the matter fetch this test is
        // actually about - see `EscrowShell`'s own doc comment. Without this split, both the shell's and
        // this page's own error text would coincidentally read "not found", masking whichever one this
        // test actually meant to exercise (confirmed via raw v8 branch coverage: the page's own
        // `err instanceof ApiRequestError` consequent was never truly reached under the original,
        // unsplit version of this test).
        mockFetch((url) => {
            if (url.startsWith("/api/escrow/matters?")) return jsonResponse(200, []);
            return jsonResponse(404, { message: "not found" });
        });
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading fails with a non-API error", async () => {
        mockFetch((url) => {
            // The shell's own reachability probe must succeed independently of the matter/request fetches
            // this test is actually about - see `EscrowShell`'s own doc comment.
            if (url.startsWith("/api/escrow/matters?")) return jsonResponse(200, []);
            throw new TypeError("network down");
        });
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        expect(await screen.findByText("Could not load this matter.")).toBeInTheDocument();
    });

    it("falls back to 'Matter not found.' when the load succeeds with no matter and no error", async () => {
        mockFetch((url) => {
            if (url === "/api/escrow/matters/m1") return jsonResponse(200, null);
            if (url.startsWith("/api/escrow/matters?")) return jsonResponse(200, []);
            if (url.startsWith("/api/escrow/access-requests")) return jsonResponse(200, []);
            if (url.startsWith("/api/escrow/matter-export-requests")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        expect(await screen.findByText("Matter not found.")).toBeInTheDocument();
    });

    it("shows 'No access requests yet.' when there are none for this matter", async () => {
        mockMatterFetch({ "/api/escrow/access-requests": () => jsonResponse(200, []) });
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        expect(await screen.findByText("No access requests yet.")).toBeInTheDocument();
    });

    it("closes the matter", async () => {
        mockMatterFetch({
            "POST /api/escrow/matters/m1/close": () => jsonResponse(200, { ...matter, closedAt: "2026-02-01T00:00:00.000Z" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "Close matter" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Close matter" })).getByRole("button", { name: "Close matter" }));

        expect(await screen.findByText(/^Closed/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Close matter" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "+ New access request" })).not.toBeInTheDocument();
    });

    it("shows an error message when closing fails", async () => {
        mockMatterFetch({ "POST /api/escrow/matters/m1/close": () => jsonResponse(403, { message: "not a holder" }) });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "Close matter" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Close matter" })).getByRole("button", { name: "Close matter" }));
        expect(await screen.findByText("not a holder")).toBeInTheDocument();
    });

    it("shows a generic error message when closing fails with a non-API error", async () => {
        mockMatterFetch({
            "POST /api/escrow/matters/m1/close": () => {
                throw new TypeError("network down");
            },
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "Close matter" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Close matter" })).getByRole("button", { name: "Close matter" }));
        expect(await screen.findByText("Could not close this matter.")).toBeInTheDocument();
    });

    it("validates the mailbox uid before creating a new access request", async () => {
        mockMatterFetch();
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "+ New access request" }));
        await user.click(screen.getByRole("button", { name: "Create request" }));

        expect(await screen.findByText("A mailbox uid is required.")).toBeInTheDocument();
    });

    it("creates a new access request and closes the modal, reloading the list", async () => {
        let created = false;
        mockMatterFetch({
            "POST /api/escrow/access-requests": () => {
                created = true;
                return jsonResponse(200, { ...pendingRequest, uid: "ar-new" });
            },
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "+ New access request" }));
        await user.type(screen.getByLabelText("Mailbox uid"), "mb1");
        await user.click(screen.getByRole("button", { name: "Create request" }));

        await vi.waitFor(() => expect(created).toBe(true));
        expect(screen.queryByRole("dialog", { name: "New access request" })).not.toBeInTheDocument();
    });

    it("shows an error message in the new-request modal when creation fails", async () => {
        mockMatterFetch({
            "POST /api/escrow/access-requests": () => jsonResponse(400, { message: "not a custodian" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "+ New access request" }));
        await user.type(screen.getByLabelText("Mailbox uid"), "mb3");
        await user.click(screen.getByRole("button", { name: "Create request" }));

        expect(await screen.findByText("not a custodian")).toBeInTheDocument();
    });

    it("shows a generic error message in the new-request modal when creation fails with a non-API error", async () => {
        mockMatterFetch({
            "POST /api/escrow/access-requests": () => {
                throw new TypeError("network down");
            },
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "+ New access request" }));
        await user.type(screen.getByLabelText("Mailbox uid"), "mb1");
        await user.click(screen.getByRole("button", { name: "Create request" }));

        expect(await screen.findByText("Could not create this access request.")).toBeInTheDocument();
    });

    it("the new-request modal's Cancel button closes it", async () => {
        mockMatterFetch();
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "+ New access request" }));
        const dialog = screen.getByRole("dialog", { name: "New access request" });
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

        expect(screen.queryByRole("dialog", { name: "New access request" })).not.toBeInTheDocument();
    });

    it("the new-request modal's own close (×) button also closes it", async () => {
        mockMatterFetch();
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "+ New access request" }));
        const dialog = screen.getByRole("dialog", { name: "New access request" });
        await user.click(within(dialog).getByRole("button", { name: "Close" }));

        expect(screen.queryByRole("dialog", { name: "New access request" })).not.toBeInTheDocument();
    });

    it("approves a pending request", async () => {
        mockMatterFetch({
            "POST /api/escrow/access-requests/ar1/approve": () => jsonResponse(200, { ...pendingRequest, status: "approved" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(await screen.findByRole("button", { name: "Approve" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Approve access request" })).getByRole("button", { name: "Approve request" }));

        expect(await screen.findByText("approved")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Get material" })).toBeInTheDocument();
    });

    it("approving one request leaves the other visible requests for this matter unchanged", async () => {
        // Two requests under the same matter (ar1 pending, ar2 already approved) - approving ar1 must
        // update only its own row, exercising the `setRequests()` map's "leave this other row as-is"
        // branch for ar2 (`r.uid === updated.uid` false).
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, [pendingRequest, approvedRequest]),
            "POST /api/escrow/access-requests/ar1/approve": () => jsonResponse(200, { ...pendingRequest, status: "approved" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        // ar2 already shows its own "Get material" action before anything is clicked.
        expect(await screen.findAllByRole("button", { name: "Get material" })).toHaveLength(1);
        await user.click(await screen.findByRole("button", { name: "Approve" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Approve access request" })).getByRole("button", { name: "Approve request" }));

        // ar1 is now approved too (both rows render "Get material"), and ar2's own row is still present
        // and untouched - not reset, not removed.
        expect(await screen.findAllByRole("button", { name: "Get material" })).toHaveLength(2);
    });

    it("denying one request leaves the other visible requests for this matter unchanged", async () => {
        // Same "other row" map branch as above, exercised via denyAccessRequest() instead of approve.
        const secondPending = { ...pendingRequest, uid: "ar2", mailboxUid: "mb2" };
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, [pendingRequest, secondPending]),
            "POST /api/escrow/access-requests/ar1/deny": () => jsonResponse(200, { ...pendingRequest, status: "denied" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        expect(await screen.findAllByRole("button", { name: "Deny" })).toHaveLength(2);
        await user.click(screen.getAllByRole("button", { name: "Deny" })[0]);

        // ar1 is now denied; ar2 stays pending, still showing its own Approve/Deny actions untouched.
        expect(await screen.findByText("denied")).toBeInTheDocument();
        expect(screen.getByText("pending")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    });

    it("shows an error message when approving fails", async () => {
        mockMatterFetch({
            "POST /api/escrow/access-requests/ar1/approve": () => jsonResponse(400, { message: "already approved" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(await screen.findByRole("button", { name: "Approve" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Approve access request" })).getByRole("button", { name: "Approve request" }));
        expect(await screen.findByText("already approved")).toBeInTheDocument();
    });

    it("shows a generic error message when approving fails with a non-API error", async () => {
        mockMatterFetch({
            "POST /api/escrow/access-requests/ar1/approve": () => {
                throw new TypeError("network down");
            },
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(await screen.findByRole("button", { name: "Approve" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Approve access request" })).getByRole("button", { name: "Approve request" }));
        expect(await screen.findByText("Could not approve this request.")).toBeInTheDocument();
    });

    it("denies a pending request", async () => {
        mockMatterFetch({
            "POST /api/escrow/access-requests/ar1/deny": () => jsonResponse(200, { ...pendingRequest, status: "denied" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "Deny" }));
        expect(await screen.findByText("denied")).toBeInTheDocument();
    });

    it("shows an error message when denying fails", async () => {
        mockMatterFetch({
            "POST /api/escrow/access-requests/ar1/deny": () => jsonResponse(409, { message: "not pending" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "Deny" }));
        expect(await screen.findByText("not pending")).toBeInTheDocument();
    });

    it("shows a generic error message when denying fails with a non-API error", async () => {
        mockMatterFetch({
            "POST /api/escrow/access-requests/ar1/deny": () => {
                throw new TypeError("network down");
            },
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "Deny" }));
        expect(await screen.findByText("Could not deny this request.")).toBeInTheDocument();
    });

    it("gets material for an approved request and renders it as raw JSON", async () => {
        const material = {
            masterKeyWraps: [
                {
                    method: "escrow",
                    escrowScopeId: "es1",
                    ciphertext: "cipher",
                    nonce: "nonce",
                    salt: "salt",
                    kdf: "argon2id:m=65536,t=3,p=4",
                    schemeVersion: 1,
                    createdAt: 1735689600000,
                },
            ],
        };
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, [approvedRequest]),
            "/api/escrow/access-requests/ar2/material": () => jsonResponse(200, material),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "Get material" }));

        expect(await screen.findByText(/"method": "escrow"/)).toBeInTheDocument();
    });

    it("shows an error message when getting material fails", async () => {
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, [approvedRequest]),
            "/api/escrow/access-requests/ar2/material": () => jsonResponse(403, { message: "dual control not met" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "Get material" }));
        expect(await screen.findByText("dual control not met")).toBeInTheDocument();
    });

    it("shows a generic error message when getting material fails with a non-API error", async () => {
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, [approvedRequest]),
            "/api/escrow/access-requests/ar2/material": () => {
                throw new TypeError("network down");
            },
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "Get material" }));
        expect(await screen.findByText("Could not read this request's material.")).toBeInTheDocument();
    });

    it("the material modal closes via its own close button", async () => {
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, [approvedRequest]),
            "/api/escrow/access-requests/ar2/material": () => jsonResponse(200, { masterKeyWraps: [] }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "Get material" }));
        const dialog = await screen.findByRole("dialog", { name: "Escrow key material" });
        await user.click(within(dialog).getByRole("button", { name: "Close" }));

        expect(screen.queryByRole("dialog", { name: "Escrow key material" })).not.toBeInTheDocument();
    });

    it("shows 'No export requests yet.' when there are none for this matter", async () => {
        mockMatterFetch();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        expect(await screen.findByText("No export requests yet.")).toBeInTheDocument();
    });

    it("renders export requests filtered to this matter, with status pills and a Download link once ready", async () => {
        const pendingExport = {
            uid: "mer1",
            version: 0,
            dateCreated: "2026-01-01T00:00:00.000Z",
            dateModified: "2026-01-01T00:00:00.000Z",
            matterId: "m1",
            requestedByUserUid: "u1",
            status: "pending" as const,
        };
        const readyExport = { ...pendingExport, uid: "mer2", status: "ready" as const, blobKey: "blob1" };
        const failedExport = { ...pendingExport, uid: "mer3", status: "failed" as const, errorMessage: "blob store unavailable" };
        const otherMatterExport = { ...pendingExport, uid: "mer99", matterId: "m2" };
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, []),
            "/api/escrow/matter-export-requests": () =>
                jsonResponse(200, [pendingExport, readyExport, failedExport, otherMatterExport]),
        });
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        expect(await screen.findByText("pending")).toBeInTheDocument();
        expect(screen.getByText("ready")).toBeInTheDocument();
        expect(screen.getByText("failed")).toBeInTheDocument();
        expect(screen.getByText(/blob store unavailable/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
            "href",
            "/api/escrow/matter-export-requests/mer2/download",
        );
    });

    it("creates a new export request and reloads the list", async () => {
        let created = false;
        const newExport = {
            uid: "mer-new",
            version: 0,
            dateCreated: "2026-01-01T00:00:00.000Z",
            dateModified: "2026-01-01T00:00:00.000Z",
            matterId: "m1",
            requestedByUserUid: "u1",
            status: "pending" as const,
        };
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, []),
            "POST /api/escrow/matter-export-requests": () => {
                created = true;
                return jsonResponse(200, newExport);
            },
            "/api/escrow/matter-export-requests": () => jsonResponse(200, created ? [newExport] : []),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });
        expect(await screen.findByText("No export requests yet.")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "+ New export" }));

        // Confirms the list was actually re-fetched and re-rendered with the new request, not just that
        // the create call itself resolved.
        expect(await screen.findByText("pending")).toBeInTheDocument();
        expect(screen.queryByText("No export requests yet.")).not.toBeInTheDocument();
    });

    it("shows an error message when creating an export fails", async () => {
        mockMatterFetch({
            "POST /api/escrow/matter-export-requests": () => jsonResponse(403, { message: "not a holder" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "+ New export" }));
        expect(await screen.findByText("not a holder")).toBeInTheDocument();
    });

    it("shows a generic error message when creating an export fails with a non-API error", async () => {
        mockMatterFetch({
            "POST /api/escrow/matter-export-requests": () => {
                throw new TypeError("network down");
            },
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "+ New export" }));
        expect(await screen.findByText("Could not start this export.")).toBeInTheDocument();
    });

    it("the Search button is disabled until text is entered, then searches and groups results by mailboxUid", async () => {
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, []),
            "/api/escrow/matter-search": () =>
                jsonResponse(200, {
                    mb1: { results: [{ entityType: "message", entityUid: "msg1", score: 1, snippet: "quarterly budget" }] },
                    mb2: { results: [] },
                }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();

        await user.type(screen.getByLabelText("Search this matter"), "budget");
        expect(screen.getByRole("button", { name: "Search" })).toBeEnabled();
        await user.click(screen.getByRole("button", { name: "Search" }));

        expect(await screen.findByRole("heading", { name: "mb1", level: 3 })).toBeInTheDocument();
        expect(screen.getByText(/quarterly budget/)).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "mb2", level: 3 })).toBeInTheDocument();
        expect(screen.getByText("No matches.")).toBeInTheDocument();
    });

    it("parses operator syntax out of the search box before sending it, rather than as literal free text", async () => {
        const fetchMock = mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, []),
            "/api/escrow/matter-search": () => jsonResponse(200, {}),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.type(screen.getByLabelText("Search this matter"), "from:alice@example.com budget");
        await user.click(screen.getByRole("button", { name: "Search" }));

        const call = await vi.waitFor(() => {
            const found = fetchMock.mock.calls.find(([url]) => (url as string).startsWith("/api/escrow/matter-search?"));
            expect(found).toBeDefined();
            return found!;
        });
        const url = new URL(call[0] as string, "http://localhost");
        expect(url.searchParams.get("q")).toBe("budget");
        expect(url.searchParams.get("from")).toBe("alice@example.com");
    });

    it("shows a message when no custodian mailboxes could be searched", async () => {
        mockMatterFetch({ "/api/escrow/matter-search": () => jsonResponse(200, {}) });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.type(screen.getByLabelText("Search this matter"), "budget");
        await user.click(screen.getByRole("button", { name: "Search" }));

        expect(await screen.findByText("No custodian mailboxes could be searched.")).toBeInTheDocument();
    });

    it("shows an error message when searching fails", async () => {
        mockMatterFetch({ "/api/escrow/matter-search": () => jsonResponse(400, { message: "invalid query" }) });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.type(screen.getByLabelText("Search this matter"), "budget");
        await user.click(screen.getByRole("button", { name: "Search" }));

        expect(await screen.findByText("invalid query")).toBeInTheDocument();
    });

    it("shows a generic error message when searching fails with a non-API error", async () => {
        mockMatterFetch({
            "/api/escrow/matter-search": () => {
                throw new TypeError("network down");
            },
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.type(screen.getByLabelText("Search this matter"), "budget");
        await user.click(screen.getByRole("button", { name: "Search" }));

        expect(await screen.findByText("Could not search this matter.")).toBeInTheDocument();
    });

    it("fetches both lists for this matter only, a page at a time, with Load more", async () => {
        const page0 = Array.from({ length: 50 }, (_, i) => ({ ...pendingRequest, uid: `ar-${i}`, mailboxUid: `mbox-${i}` }));
        const fetchMock = mockMatterFetch({
            "GET /api/escrow/access-requests?limit=50&page=0&matterId=m1": () => jsonResponse(200, page0),
            "GET /api/escrow/access-requests?limit=50&page=1&matterId=m1": () =>
                jsonResponse(200, [{ ...pendingRequest, uid: "ar-50", mailboxUid: "mbox-50" }]),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);

        expect(await screen.findByText("mbox-49")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Load more access requests" }));
        expect(await screen.findByText("mbox-50")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Load more access requests" })).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/escrow/matter-export-requests?limit=50&page=0&matterId=m1");
    });

    it("shows list load failures inline without replacing the page", async () => {
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(500, { message: "requests unavailable" }),
            "/api/escrow/matter-export-requests": () => {
                throw new TypeError("network down");
            },
        });
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);

        expect(await screen.findByText("requests unavailable")).toBeInTheDocument();
        expect(await screen.findByText("Could not load this matter's export requests.")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Smith v. Acme" })).toBeInTheDocument();
    });

    it("shows Loading in each list while it's still being fetched", async () => {
        mockMatterFetch({
            "/api/escrow/access-requests": () => new Promise<Response>(() => undefined) as unknown as Response,
            "/api/escrow/matter-export-requests": () => new Promise<Response>(() => undefined) as unknown as Response,
        });
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });
        expect(screen.getAllByText("Loading…")).toHaveLength(2);
    });

    it("confirms closing with the custodians and date range, and Cancel keeps the matter open", async () => {
        let closed = false;
        mockMatterFetch({
            "POST /api/escrow/matters/m1/close": () => {
                closed = true;
                return jsonResponse(200, { ...matter, closedAt: "2026-02-01T00:00:00.000Z" });
            },
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(screen.getByRole("button", { name: "Close matter" }));
        const dialog = await screen.findByRole("dialog", { name: "Close matter" });
        expect(within(dialog).getByText("mb1, mb2")).toBeInTheDocument();
        expect(within(dialog).getByText(/cannot be reopened/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

        expect(screen.queryByRole("dialog", { name: "Close matter" })).not.toBeInTheDocument();
        expect(closed).toBe(false);
        expect(screen.getByText("Open")).toBeInTheDocument();
    });

    it("hides new exports, search, and Get material once the matter is closed", async () => {
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, [approvedRequest]),
            "POST /api/escrow/matters/m1/close": () => jsonResponse(200, { ...matter, closedAt: "2026-02-01T00:00:00.000Z" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });
        expect(await screen.findByRole("button", { name: "Get material" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "+ New export" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Close matter" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Close matter" })).getByRole("button", { name: "Close matter" }));

        expect(await screen.findByText(/^Closed/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "+ New export" })).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Search this matter")).not.toBeInTheDocument();
        expect(screen.getByText(/can no longer be searched or exported/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Get material" })).not.toBeInTheDocument();
    });

    it("confirms an approval with the matter, mailbox, date range, and approval count, and Cancel doesn't approve", async () => {
        let approved = false;
        mockMatterFetch({
            "POST /api/escrow/access-requests/ar1/approve": () => {
                approved = true;
                return jsonResponse(200, { ...pendingRequest, status: "approved" });
            },
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(await screen.findByRole("button", { name: "Approve" }));
        const dialog = await screen.findByRole("dialog", { name: "Approve access request" });
        expect(within(dialog).getByText("Smith v. Acme")).toBeInTheDocument();
        expect(within(dialog).getByText("mb1")).toBeInTheDocument();
        expect(within(dialog).getByText(/1 of 2 so far, including requester u1/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog", { name: "Approve access request" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Approve" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Approve access request" })).getByRole("button", { name: "Close" }));
        expect(screen.queryByRole("dialog", { name: "Approve access request" })).not.toBeInTheDocument();
        expect(approved).toBe(false);
    });

    it("ignores a Get material response (or failure) that arrives after its modal was closed", async () => {
        const pending: ((response: Response) => void)[] = [];
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, [approvedRequest]),
            "/api/escrow/access-requests/ar2/material": () =>
                new Promise<Response>((resolve) => pending.push(resolve)) as unknown as Response,
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.click(await screen.findByRole("button", { name: "Get material" }));
        let dialog = await screen.findByRole("dialog", { name: "Escrow key material" });
        expect(within(dialog).getByText("Loading…")).toBeInTheDocument();
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        pending[0](jsonResponse(200, { masterKeyWraps: [{ method: "escrow", ciphertext: "stale" }] }));

        await user.click(screen.getByRole("button", { name: "Get material" }));
        dialog = await screen.findByRole("dialog", { name: "Escrow key material" });
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        pending[1](jsonResponse(403, { message: "stale failure" }));

        await user.click(screen.getByRole("button", { name: "Get material" }));
        await vi.waitFor(() => expect(pending).toHaveLength(3));
        pending[2](jsonResponse(200, { masterKeyWraps: [{ method: "escrow", ciphertext: "fresh" }] }));
        expect(await screen.findByText(/"ciphertext": "fresh"/)).toBeInTheDocument();
        expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
    });

    it("hides new exports and search for a matter that was already closed when loaded", async () => {
        mockMatterFetch({
            "GET /api/escrow/matters/m1": () => jsonResponse(200, { ...matter, closedAt: "2026-02-01T00:00:00.000Z" }),
        });
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        expect(screen.queryByRole("button", { name: "Close matter" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "+ New export" })).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Search this matter")).not.toBeInTheDocument();
    });

    it("hides Approve/Deny and export Download links on a closed matter", async () => {
        const readyExport = {
            uid: "mer2",
            version: 0,
            dateCreated: "2026-01-01T00:00:00.000Z",
            dateModified: "2026-01-01T00:00:00.000Z",
            matterId: "m1",
            requestedByUserUid: "u1",
            status: "ready" as const,
            blobKey: "blob1",
        };
        mockMatterFetch({
            "GET /api/escrow/matters/m1": () => jsonResponse(200, { ...matter, closedAt: "2026-02-01T00:00:00.000Z" }),
            "/api/escrow/matter-export-requests": () => jsonResponse(200, [readyExport]),
        });
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        expect(await screen.findByText("ready")).toBeInTheDocument();
        expect(await screen.findByText("pending")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
    });

    it("drops a search result (or failure) that arrives after the matter was closed", async () => {
        const pending: ((response: Response) => void)[] = [];
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, []),
            "/api/escrow/matter-search": () => new Promise<Response>((resolve) => pending.push(resolve)) as unknown as Response,
            "POST /api/escrow/matters/m1/close": () => jsonResponse(200, { ...matter, closedAt: "2026-02-01T00:00:00.000Z" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.type(screen.getByLabelText("Search this matter"), "budget");
        await user.click(screen.getByRole("button", { name: "Search" }));
        await vi.waitFor(() => expect(pending).toHaveLength(1));

        await user.click(screen.getByRole("button", { name: "Close matter" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Close matter" })).getByRole("button", { name: "Close matter" }));
        expect(await screen.findByText(/^Closed/)).toBeInTheDocument();

        pending[0](
            jsonResponse(200, { mb1: { results: [{ entityType: "message", entityUid: "msg1", score: 1, snippet: "leaked" }] } }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.queryByText(/leaked/)).not.toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "mb1", level: 3 })).not.toBeInTheDocument();
    });

    it("drops a search failure that arrives after the matter was closed", async () => {
        const pending: ((response: Response) => void)[] = [];
        mockMatterFetch({
            "/api/escrow/access-requests": () => jsonResponse(200, []),
            "/api/escrow/matter-search": () => new Promise<Response>((resolve) => pending.push(resolve)) as unknown as Response,
            "POST /api/escrow/matters/m1/close": () => jsonResponse(200, { ...matter, closedAt: "2026-02-01T00:00:00.000Z" }),
        });
        const user = userEvent.setup();
        render(<MatterDetailPage userUid="u1" authServerUrl="https://auth.example.com" params={{ uid: "m1" }} />);
        await screen.findByRole("heading", { name: "Smith v. Acme" });

        await user.type(screen.getByLabelText("Search this matter"), "budget");
        await user.click(screen.getByRole("button", { name: "Search" }));
        await vi.waitFor(() => expect(pending).toHaveLength(1));

        await user.click(screen.getByRole("button", { name: "Close matter" }));
        await user.click(within(await screen.findByRole("dialog", { name: "Close matter" })).getByRole("button", { name: "Close matter" }));
        expect(await screen.findByText(/^Closed/)).toBeInTheDocument();

        pending[0](jsonResponse(403, { message: "matter closed" }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.queryByText("matter closed")).not.toBeInTheDocument();
    });
});
