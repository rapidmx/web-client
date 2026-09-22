// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SigningCertificatesPage from "../../../../apps/admin/signing-certificates/index.js";
import { getNotificationsSnapshot } from "../../../../apps/shared/notifications/store.js";

type Handler = (url: string, init?: RequestInit) => Response | undefined;

const toasts = () => getNotificationsSnapshot().history;

const enrollment = (overrides: Record<string, unknown> = {}) => ({
    enrollmentId: "e1",
    identity: "alice@example.com",
    mailboxUid: "mb1",
    requestedAt: "2026-09-21T00:00:00.000Z",
    status: "pending" as const,
    provider: "manual" as const,
    stage: "submitted",
    canUpload: true,
    ...overrides,
});

const manualInfo = { backend: "manual" as const, automatic: false, adminUpload: true };
const rfc8823Info = {
    backend: "rfc8823" as const,
    automatic: true,
    ca: { host: "acme.castle.cloud" },
    typicalDurationMinutes: 20,
    adminUpload: false,
    health: { ok: true },
};

function mockShell(options: { info?: unknown; enrollments?: unknown[]; extra?: Handler } = {}) {
    return mockFetch((url, init) => {
        const custom = options.extra?.(url, init);
        if (custom) return custom;
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url === "/api/system/signing-enrollment") return jsonResponse(200, options.info ?? manualInfo);
        if (url === "/api/admin/signing-enrollments") return jsonResponse(200, options.enrollments ?? []);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("SigningCertificatesPage", () => {
    it("shows the manual backend and an empty state with no pending requests", async () => {
        mockShell();
        render(<SigningCertificatesPage userUid="admin-1" />);

        expect(await screen.findByText(/Manual issuance/)).toBeInTheDocument();
        expect(await screen.findByText("No pending signing certificate requests.")).toBeInTheDocument();
    });

    it("shows the automatic backend, its CA and typical duration, and a health failure", async () => {
        mockShell({ info: { ...rfc8823Info, health: { ok: false, lastError: "connect ECONNREFUSED" } } });
        render(<SigningCertificatesPage userUid="admin-1" />);

        expect(await screen.findByText(/Automatic issuance/)).toBeInTheDocument();
        expect(screen.getByText(/acme\.castle\.cloud/)).toBeInTheDocument();
        expect(screen.getByText(/typically 20 minutes/)).toBeInTheDocument();
        expect(await screen.findByText(/could not be reached: connect ECONNREFUSED/)).toBeInTheDocument();
    });

    it("says signing certificates are off, and surfaces a failure to load the backend info", async () => {
        mockShell({ info: { backend: "none", automatic: false, adminUpload: false } });
        render(<SigningCertificatesPage userUid="admin-1" />);
        expect(await screen.findByText("Signing certificates are not enabled in this deployment.")).toBeInTheDocument();

        mockShell({ extra: (url) => (url === "/api/system/signing-enrollment" ? jsonResponse(500, { message: "backend unreachable" }) : undefined) });
        render(<SigningCertificatesPage userUid="admin-1" />);
        expect(await screen.findByText("backend unreachable")).toBeInTheDocument();
    });

    it("lists a pending manual request with its status, Download CSR, Upload and Reject", async () => {
        mockShell({ enrollments: [enrollment()] });
        render(<SigningCertificatesPage userUid="admin-1" />);

        expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
        const row = screen.getByText("alice@example.com").closest("tr")!;
        expect(within(row).getByText("pending")).toBeInTheDocument();
        expect(within(row).getByText("Manual")).toBeInTheDocument();
        expect(within(row).getByRole("link", { name: "Download CSR" })).toHaveAttribute("href", "/api/admin/signing-enrollments/e1/csr");
        expect(within(row).getByRole("button", { name: "Upload certificate" })).toBeInTheDocument();
        expect(within(row).getByRole("button", { name: "Reject" })).toBeInTheDocument();
    });

    it("badges every status, and shows a non-API error (a network failure) with the generic fallback message", async () => {
        mockShell({ enrollments: [enrollment({ enrollmentId: "e-failed", status: "failed" }), enrollment({ enrollmentId: "e-issued", status: "issued", canUpload: false })] });
        render(<SigningCertificatesPage userUid="admin-1" />);
        expect(await screen.findByText("failed")).toBeInTheDocument();
        expect(await screen.findByText("issued")).toBeInTheDocument();

        mockShell({
            extra: (url) => (url === "/api/admin/signing-enrollments" ? Promise.reject(new TypeError("network down")) : undefined),
        });
        render(<SigningCertificatesPage userUid="admin-1" />);
        expect(await screen.findByText("Could not load the pending signing certificate requests.")).toBeInTheDocument();
    });

    it("shows why a request cannot be uploaded to yet, and the last error for a stalled one", async () => {
        mockShell({
            enrollments: [
                enrollment({ enrollmentId: "e2", canUpload: false, uploadBlockedReason: "Ask the user to cancel it and request again." }),
                enrollment({ enrollmentId: "e3", provider: "rfc8823", status: "pending", canUpload: false, lastError: "connect ETIMEDOUT" }),
            ],
        });
        render(<SigningCertificatesPage userUid="admin-1" />);

        expect(await screen.findByText("Ask the user to cancel it and request again.")).toBeInTheDocument();
        expect(screen.getByText("connect ETIMEDOUT")).toBeInTheDocument();
        expect(screen.queryAllByRole("button", { name: "Upload certificate" })).toHaveLength(0);
        // The automatic provider's request (e3) offers no CSR download and no reject (only the manual backend can act) - unlike e2, which is manual.
        const e3Row = screen.getByText("connect ETIMEDOUT").closest("tr")!;
        expect(within(e3Row).queryByRole("link", { name: "Download CSR" })).not.toBeInTheDocument();
        expect(within(e3Row).queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    });

    it("uploads a certificate, notifies success and reloads the list", async () => {
        let reloaded = false;
        mockShell({
            enrollments: [enrollment()],
            extra: (url, init) => {
                if (url === "/api/admin/signing-enrollments/e1/certificate" && init?.method === "POST") {
                    reloaded = true;
                    return jsonResponse(200, {
                        enrollmentId: "e1",
                        identity: "alice@example.com",
                        status: "issued",
                        chainLength: 1,
                        subject: "CN=alice@example.com",
                        issuer: "CN=Test CA",
                        serialNumber: "01",
                        notBefore: "x",
                        notAfter: "y",
                        message: "Installed within a few minutes.",
                    });
                }
                return undefined;
            },
        });
        const user = userEvent.setup();
        render(<SigningCertificatesPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Upload certificate" }));
        const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
        await user.type(screen.getByLabelText("Certificate PEM"), pem);
        expect(screen.queryByText(/doesn't look like a PEM certificate/)).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Upload" }));

        await vi.waitFor(() => expect(reloaded).toBe(true));
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(toasts()).toEqual([
            expect.objectContaining({ kind: "success", title: "Certificate accepted", message: expect.stringContaining("Installed within a few minutes.") }),
        ]);
    });

    it("warns about text that doesn't look like a certificate, and shows a server refusal inline", async () => {
        mockShell({
            enrollments: [enrollment()],
            extra: (url, init) => (url === "/api/admin/signing-enrollments/e1/certificate" && init?.method === "POST" ? jsonResponse(400, { message: "The certificate does not match this request's CSR." }) : undefined),
        });
        const user = userEvent.setup();
        render(<SigningCertificatesPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Upload certificate" }));
        await user.type(screen.getByLabelText("Certificate PEM"), "not a certificate");
        expect(await screen.findByText(/doesn't look like a PEM certificate/)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Upload" }));
        expect(await screen.findByText("The certificate does not match this request's CSR.")).toBeInTheDocument();
        // The dialog stays open on failure.
        expect(screen.getByRole("button", { name: "Upload" })).toBeInTheDocument();
    });

    it("reads a chosen file into the textarea", async () => {
        mockShell({ enrollments: [enrollment()] });
        const user = userEvent.setup();
        render(<SigningCertificatesPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Upload certificate" }));
        const file = new File(["-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----"], "cert.pem", { type: "application/x-pem-file" });
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        await user.upload(input, file);

        await vi.waitFor(() => expect(screen.getByLabelText("Certificate PEM")).toHaveValue("-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----"));
    });

    it("does nothing when the file picker is dismissed with no file chosen, and shows an error when the file can't be read", async () => {
        mockShell({ enrollments: [enrollment()] });
        const user = userEvent.setup();
        render(<SigningCertificatesPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Upload certificate" }));
        await user.click(screen.getByRole("button", { name: /Choose file/ }));
        const input = document.querySelector('input[type="file"]') as HTMLInputElement;
        fireEvent.change(input, { target: { files: [] } });
        expect(screen.getByLabelText("Certificate PEM")).toHaveValue("");

        const unreadable = { text: () => Promise.reject(new Error("read failed")) } as unknown as File;
        Object.defineProperty(input, "files", { value: [unreadable], configurable: true });
        fireEvent.change(input);
        expect(await screen.findByText("Could not read this file.")).toBeInTheDocument();
    });

    it("cancelling the upload dialog clears it for the next open", async () => {
        mockShell({ enrollments: [enrollment()] });
        const user = userEvent.setup();
        render(<SigningCertificatesPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Upload certificate" }));
        await user.type(screen.getByLabelText("Certificate PEM"), "draft text");
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        await user.click(screen.getByRole("button", { name: "Upload certificate" }));
        expect(screen.getByLabelText("Certificate PEM")).toHaveValue("");
    });

    it("cancelling the reject dialog clears the reason for the next open", async () => {
        mockShell({ enrollments: [enrollment()] });
        const user = userEvent.setup();
        render(<SigningCertificatesPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Reject" }));
        const dialog = screen.getByRole("dialog");
        await user.type(within(dialog).getByLabelText("Rejection reason"), "draft reason");
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

        await user.click(screen.getByRole("button", { name: "Reject" }));
        expect(screen.getByLabelText("Rejection reason")).toHaveValue("");
    });

    it("rejects a request with a reason, notifies and reloads", async () => {
        let rejected: unknown;
        mockShell({
            enrollments: [enrollment()],
            extra: (url, init) => {
                if (url === "/api/admin/signing-enrollments/e1/reject" && init?.method === "POST") {
                    rejected = JSON.parse(String(init.body));
                    return jsonResponse(200, { enrollmentId: "e1", status: "failed", error: "Rejected by an administrator: not our employee" });
                }
                return undefined;
            },
        });
        const user = userEvent.setup();
        render(<SigningCertificatesPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Reject" }));
        const dialog = screen.getByRole("dialog");
        await user.type(within(dialog).getByLabelText("Rejection reason"), "not our employee");
        await user.click(within(dialog).getByRole("button", { name: "Reject" }));

        await vi.waitFor(() => expect(rejected).toEqual({ reason: "not our employee" }));
        await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(toasts()).toEqual([expect.objectContaining({ kind: "info", title: "Request rejected", message: expect.stringContaining("was rejected.") })]);
    });

    it("shows a server error on a failed reject and keeps the dialog open", async () => {
        mockShell({
            enrollments: [enrollment()],
            extra: (url, init) => (url === "/api/admin/signing-enrollments/e1/reject" && init?.method === "POST" ? jsonResponse(409, { message: "This request is already issued." }) : undefined),
        });
        const user = userEvent.setup();
        render(<SigningCertificatesPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Reject" }));
        const dialog = screen.getByRole("dialog");
        await user.type(within(dialog).getByLabelText("Rejection reason"), "x");
        await user.click(within(dialog).getByRole("button", { name: "Reject" }));

        expect(await screen.findByText("This request is already issued.")).toBeInTheDocument();
    });

    it("surfaces a failure to load the pending requests", async () => {
        mockShell({ extra: (url) => (url === "/api/admin/signing-enrollments" ? jsonResponse(500, { message: "list failed" }) : undefined) });
        render(<SigningCertificatesPage userUid="admin-1" />);

        expect(await screen.findByText("list failed")).toBeInTheDocument();
    });
});
