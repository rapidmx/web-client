// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { createApiClient } from "../../../lib/util/api.js";
import {
    SIGNING_ENROLLMENT_UNKNOWN,
    getSigningEnrollmentInfo,
    listSigningEnrollments,
    looksLikePemCertificate,
    rejectSigningEnrollment,
    signingEnrollmentCsrUrl,
    uploadSigningEnrollmentCertificate,
} from "../../../lib/crypto/signingProviderApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("signingProviderApi", () => {
    it("reads which backend issues signing certificates and how it is doing", async () => {
        const info = { backend: "rfc8823" as const, automatic: true, ca: { host: "acme.castle.cloud" }, typicalDurationMinutes: 20, adminUpload: false, health: { ok: true } };
        const fetchMock = mockFetch(() => jsonResponse(200, info));

        expect(await getSigningEnrollmentInfo()).toEqual(info);

        expect(fetchMock).toHaveBeenCalledWith("/api/system/signing-enrollment", expect.anything());
    });

    it("lists the pending requests an administrator can act on", async () => {
        const rows = [{ enrollmentId: "e1", identity: "alice@example.com", requestedAt: "2026-09-21T00:00:00.000Z", status: "pending" as const, provider: "manual" as const, canUpload: true }];
        const fetchMock = mockFetch(() => jsonResponse(200, rows));

        expect(await listSigningEnrollments()).toEqual(rows);

        expect(fetchMock).toHaveBeenCalledWith("/api/admin/signing-enrollments", expect.anything());
    });

    it("builds the CSR download URL as a plain link, with the id encoded", () => {
        expect(signingEnrollmentCsrUrl("e1")).toBe("/api/admin/signing-enrollments/e1/csr");
        expect(signingEnrollmentCsrUrl("weird id/1")).toBe("/api/admin/signing-enrollments/weird%20id%2F1/csr");
    });

    it("uploads a certificate for a request, and reports what the server accepted", async () => {
        const result = { enrollmentId: "e1", identity: "alice@example.com", status: "issued" as const, chainLength: 1, subject: "CN=alice@example.com", issuer: "CN=Test CA", serialNumber: "01", notBefore: "x", notAfter: "y", message: "ok" };
        const fetchMock = mockFetch(() => jsonResponse(200, result));

        expect(await uploadSigningEnrollmentCertificate("e1", "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----")).toEqual(result);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/admin/signing-enrollments/e1/certificate",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ certificate: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----" }) }),
        );
    });

    it("surfaces a 400 the server refused an upload with, as an ApiRequestError", async () => {
        mockFetch(() => jsonResponse(400, { message: "The certificate is for bob@example.com, not for alice@example.com.", code: "api-3" }));

        await expect(uploadSigningEnrollmentCertificate("e1", "garbage")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not for alice/) });
    });

    it("rejects a request with a reason", async () => {
        const result = { enrollmentId: "e1", status: "failed" as const, error: "Rejected by an administrator: not our employee" };
        const fetchMock = mockFetch(() => jsonResponse(200, result));

        expect(await rejectSigningEnrollment("e1", "not our employee")).toEqual(result);

        expect(fetchMock).toHaveBeenCalledWith("/api/admin/signing-enrollments/e1/reject", expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "not our employee" }) }));
    });

    it("names the code a client clears a stale enrollment id by", () => {
        expect(SIGNING_ENROLLMENT_UNKNOWN).toBe("signing-enrollment-unknown");
    });

    it("sanity-checks pasted certificate text client-side before it is sent", () => {
        expect(looksLikePemCertificate("-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----")).toBe(true);
        expect(looksLikePemCertificate("-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----")).toBe(true);
        expect(looksLikePemCertificate("")).toBe(false);
        expect(looksLikePemCertificate("-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----")).toBe(false);
        expect(looksLikePemCertificate("not a certificate")).toBe(false);
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, {}));

        await getSigningEnrollmentInfo(client);
        await listSigningEnrollments(client);
        await uploadSigningEnrollmentCertificate("e1", "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----", client);
        await rejectSigningEnrollment("e1", "not our employee", client);

        expect(fetchMock).toHaveBeenCalledTimes(4);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { backend: "none", automatic: false, adminUpload: false }));
        await getSigningEnrollmentInfo();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/signing-enrollment", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
