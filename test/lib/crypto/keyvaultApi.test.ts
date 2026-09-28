// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { ApiRequestError, createApiClient } from "../../../lib/util/api.js";
import {
    addMasterKeyWrap,
    cancelSignEnrollment,
    checkNowRetryAfterSeconds,
    checkSignEnrollmentNow,
    checkSignEnrollmentStatus,
    enrollKey,
    getEncryptionPolicy,
    getCurrentSignEnrollment,
    getEscrowInfo,
    getKeyVault,
    lookupKeys,
    normalizeEnrollmentResult,
    rekey,
    removeMasterKeyWrap,
    resolveKeyConflict,
    SignerKeyConflictError,
    startSignEnrollment,
    trustSigner,
    updateEncryptionPolicy,
    VaultAlreadyInitializedError,
} from "../../../lib/crypto/keyvaultApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("trustSigner", () => {
    const lookup = {
        keys: [{ publicKey: "MIIB", type: "x509", useType: "sign", fingerprint: "ab12", notBefore: 1, notAfter: 2 }],
        encryptPreference: { preferEncrypt: "mutual" },
    };

    it("posts the address and certificate to the encoded mailbox's keys/trust endpoint and returns the key lookup result", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, lookup));
        const result = await trustSigner("mb/1", { address: "alice@example.com", certificate: "MIIB" });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("/api/mail/mailboxes/mb%2F1/keys/trust");
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({ address: "alice@example.com", certificate: "MIIB" });
        expect(result).toEqual(lookup);
    });

    it("sends only address and certificate, even if the input object carries more", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, lookup));
        await trustSigner("mb1", { address: "a@example.com", certificate: "c", extra: true } as never);
        expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ address: "a@example.com", certificate: "c" });
    });

    it("maps a 409 to SignerKeyConflictError (still an ApiRequestError with status 409)", async () => {
        mockFetch(() => jsonResponse(409, { message: "A different signing key is already pinned.", code: "IDENTIFIER_EXISTS" }));
        const err = await trustSigner("mb1", { address: "a@example.com", certificate: "c" }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SignerKeyConflictError);
        expect(err).toBeInstanceOf(ApiRequestError);
        expect(err).toMatchObject({ name: "SignerKeyConflictError", status: 409, message: "A different signing key is already pinned." });
    });

    it.each([400, 403, 404])("rethrows a %i as a plain ApiRequestError", async (status) => {
        mockFetch(() => jsonResponse(status, { message: "nope" }));
        const err = await trustSigner("mb1", { address: "a@example.com", certificate: "c" }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiRequestError);
        expect(err).not.toBeInstanceOf(SignerKeyConflictError);
        expect((err as ApiRequestError).status).toBe(status);
    });

    it("rethrows a non-API failure unchanged", async () => {
        const boom = new TypeError("network down");
        mockFetch(() => {
            throw boom;
        });
        await expect(trustSigner("mb1", { address: "a@example.com", certificate: "c" })).rejects.toBe(boom);
    });
});

describe("getKeyVault", () => {
    it("fetches the key vault for a mailbox", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
        const result = await getKeyVault("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1/keyvault", expect.anything());
        expect(result).toEqual({ wrappedKeys: [], masterKeyWraps: [] });
    });

    it("encodes a mailbox uid needing escaping", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
        await getKeyVault("mb/1");
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("/api/mail/mailboxes/mb%2F1/keyvault");
    });
});

describe("enrollKey", () => {
    it("posts the enrollment body", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
        const input = {
            useType: "encrypt" as const,
            csr: "csr-pem",
            wrappedKey: { ciphertext: "c", nonce: "n", algorithm: "AES-256-GCM" },
        };
        await enrollKey("mb1", input);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/keyvault/keys",
            expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
        );
    });

    describe("a 409 (round-5: vault already set up)", () => {
        const wrap = { method: "password" as const, ciphertext: "c", nonce: "n", salt: "s", kdf: "k", schemeVersion: 1, createdAt: 1 };
        const input = { useType: "encrypt" as const, csr: "csr-pem", wrappedKey: { ciphertext: "c", nonce: "n", algorithm: "AES-256-GCM" }, masterKeyWraps: [wrap] };

        function routes(vault: () => Response) {
            return mockFetch((url, init) =>
                init.method === "POST" ? jsonResponse(409, { message: "already initialized", code: "IDENTIFIER_EXISTS" }) : vault(),
            );
        }

        it("rejects with VaultAlreadyInitializedError when wraps were supplied and the vault really has wraps", async () => {
            routes(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [wrap] }));
            const err = await enrollKey("mb1", input).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(VaultAlreadyInitializedError);
            expect(err).toBeInstanceOf(ApiRequestError);
            expect(err).toMatchObject({ status: 409, code: "IDENTIFIER_EXISTS", message: "already initialized", name: "VaultAlreadyInitializedError" });
        });

        it("rethrows the plain ApiRequestError when the vault has no wraps, can't be read, or no wraps were supplied", async () => {
            routes(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
            const noWraps = await enrollKey("mb1", input).catch((e: unknown) => e);
            expect(noWraps).toBeInstanceOf(ApiRequestError);
            expect(noWraps).not.toBeInstanceOf(VaultAlreadyInitializedError);
            vi.unstubAllGlobals();

            routes(() => jsonResponse(404, { message: "no vault" }));
            expect(await enrollKey("mb1", input).catch((e: unknown) => e)).not.toBeInstanceOf(VaultAlreadyInitializedError);
            vi.unstubAllGlobals();

            const fetchMock = routes(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [wrap] }));
            const err = await enrollKey("mb1", { ...input, masterKeyWraps: undefined }).catch((e: unknown) => e);
            expect(err).toMatchObject({ status: 409, name: "ApiRequestError" });
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });
});

describe("startSignEnrollment", () => {
    it("posts the csr and wrapped key", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { enrollmentId: "enr-1" }));
        const input = {
            csr: "csr-pem",
            wrappedKey: { ciphertext: "c", nonce: "n", algorithm: "AES-256-GCM" },
        };
        const result = await startSignEnrollment("mb1", input);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/keyvault/keys/sign-enrollment",
            expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
        );
        expect(result).toEqual({ enrollmentId: "enr-1" });
    });
});

describe("checkSignEnrollmentStatus", () => {
    it("fetches the enrollment status", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { status: "pending" }));
        const result = await checkSignEnrollmentStatus("mb1", "enr-1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/keyvault/keys/sign-enrollment/enr-1",
            expect.anything(),
        );
        expect(result).toEqual({ status: "pending" });
    });

    it("encodes an enrollment id needing escaping", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { status: "issued", certificate: "cert-pem" }));
        await checkSignEnrollmentStatus("mb1", "enr/1");
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("/api/mail/mailboxes/mb1/keyvault/keys/sign-enrollment/enr%2F1");
    });
});

describe("cancelSignEnrollment", () => {
    it("deletes the encoded enrollment and returns its resulting status", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { status: "failed", error: "Cancelled by the mailbox owner." }));
        const result = await cancelSignEnrollment("mb1", "enr/1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/keyvault/keys/sign-enrollment/enr%2F1",
            expect.objectContaining({ method: "DELETE" }),
        );
        expect(result).toEqual({ status: "failed", error: "Cancelled by the mailbox owner." });
    });
});

describe("normalizeEnrollmentResult", () => {
    it("keeps an older server's answer exactly as it was", () => {
        expect(normalizeEnrollmentResult({ status: "issued", certificate: "pem" })).toEqual({ status: "issued", certificate: "pem" });
        expect(normalizeEnrollmentResult({ status: "failed", error: "No." })).toEqual({ status: "failed", error: "No." });
    });

    it("reads every extended field", () => {
        const raw = {
            status: "issued",
            stage: "issued",
            stages: [{ id: "a", label: "Requested", state: "done", at: "2026-09-21T10:00:00Z" }, { id: "b", label: "Issued", state: "done" }],
            progress: 100,
            requestedAt: "2026-09-21T10:00:00Z",
            updatedAt: "2026-09-21T10:05:00Z",
            lastCheckedAt: "2026-09-21T10:05:00Z",
            nextCheckAt: "2026-09-21T10:06:00Z",
            provider: "rfc8823",
            errorCode: "none",
            note: "Installing the certificate.",
            retryable: false,
            issuedAt: "2026-09-21T10:05:00Z",
            installedAt: "2026-09-21T10:09:00Z",
            notAfter: "2027-09-21T10:05:00Z",
            serialNumber: "0A1B",
            issuer: "CN=CA",
            subject: "E=a@b.c",
        };
        expect(normalizeEnrollmentResult(raw)).toEqual(raw);
    });

    it("keeps a known provider and drops an unknown one", () => {
        expect(normalizeEnrollmentResult({ status: "pending", provider: "manual" })).toEqual({ status: "pending", provider: "manual" });
        expect(normalizeEnrollmentResult({ status: "pending", provider: "carrier-pigeon" })).toEqual({ status: "pending" });
    });

    it("treats a missing or unknown status as still pending and anything that is not an object as empty", () => {
        expect(normalizeEnrollmentResult({ status: "weird" })).toEqual({ status: "pending" });
        expect(normalizeEnrollmentResult(null)).toEqual({ status: "pending" });
        expect(normalizeEnrollmentResult([1])).toEqual({ status: "pending" });
        expect(normalizeEnrollmentResult("x")).toEqual({ status: "pending" });
    });

    it("drops fields of the wrong type and steps that are malformed, and clamps progress", () => {
        expect(
            normalizeEnrollmentResult({
                status: "pending",
                stage: "nonsense",
                stages: [null, { id: "a", label: "A", state: "bogus" }, { id: 1, label: "A", state: "done" }, { id: "ok", label: "OK", state: "active", at: 5 }],
                progress: 250,
                requestedAt: 5,
                retryable: "yes",
                subject: {},
            }),
        ).toEqual({ status: "pending", stages: [{ id: "ok", label: "OK", state: "active" }], progress: 100 });
        expect(normalizeEnrollmentResult({ status: "pending", progress: -3, stages: "no" })).toEqual({ status: "pending", progress: 0 });
        expect(normalizeEnrollmentResult({ status: "pending", progress: Number.NaN })).toEqual({ status: "pending" });
    });
});

describe("getCurrentSignEnrollment", () => {
    it("returns the mailbox's current enrollment with its id", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { enrollmentId: "enr-9", status: "pending", stage: "awaiting-challenge", progress: 30 }));
        const result = await getCurrentSignEnrollment("mb/1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb%2F1/keyvault/keys/sign-enrollment", expect.anything());
        expect(result).toEqual({ enrollmentId: "enr-9", status: "pending", stage: "awaiting-challenge", progress: 30 });
    });

    it("returns null when there is none (404), or the answer names no enrollment", async () => {
        mockFetch(() => jsonResponse(404, { message: "None." }));
        expect(await getCurrentSignEnrollment("mb1")).toBeNull();
        mockFetch(() => jsonResponse(200, { status: "pending" }));
        expect(await getCurrentSignEnrollment("mb1")).toBeNull();
    });

    it("rejects with any other failure", async () => {
        mockFetch(() => jsonResponse(500, { message: "Boom." }));
        await expect(getCurrentSignEnrollment("mb1")).rejects.toThrow("Boom.");
    });
});

describe("checkSignEnrollmentNow", () => {
    it("posts to the check endpoint and returns the normalized status", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { status: "pending", progress: 55, lastCheckedAt: "2026-09-21T10:00:00Z" }));
        const result = await checkSignEnrollmentNow("mb1", "enr/1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/keyvault/keys/sign-enrollment/enr%2F1/check",
            expect.objectContaining({ method: "POST" }),
        );
        expect(result).toEqual({ status: "pending", progress: 55, lastCheckedAt: "2026-09-21T10:00:00Z" });
    });

    it("rejects with the 429 that says to wait", async () => {
        mockFetch(() => jsonResponse(429, { message: "Too soon." }));
        await expect(checkSignEnrollmentNow("mb1", "e")).rejects.toMatchObject({ status: 429 });
    });
});

describe("checkNowRetryAfterSeconds", () => {
    it("uses the body's retryAfter, rounded up, else a default, for a 429 only", () => {
        expect(checkNowRetryAfterSeconds(new ApiRequestError("Too soon.", 429, undefined, { retryAfter: 7.2 }))).toBe(8);
        expect(checkNowRetryAfterSeconds(new ApiRequestError("Too soon.", 429, undefined, { retryAfter: "soon" }))).toBe(10);
        expect(checkNowRetryAfterSeconds(new ApiRequestError("Too soon.", 429, undefined, { retryAfter: 0 }))).toBe(10);
        expect(checkNowRetryAfterSeconds(new ApiRequestError("Too soon.", 429))).toBe(10);
        expect(checkNowRetryAfterSeconds(new ApiRequestError("Nope.", 500))).toBeUndefined();
        expect(checkNowRetryAfterSeconds(new Error("x"))).toBeUndefined();
    });
});

describe("getEscrowInfo", () => {
    it("fetches this mailbox's assigned escrow scope's public key", async () => {
        const escrowInfo = {
            escrowScopeId: "scope-1",
            publicKey: { publicKey: "base64cert", type: "x509", fingerprint: "fp1", notBefore: 0, notAfter: 1 },
        };
        const fetchMock = mockFetch(() => jsonResponse(200, escrowInfo));
        const result = await getEscrowInfo("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1/escrow-info", expect.anything());
        expect(result).toEqual(escrowInfo);
    });

    it("encodes a mailbox uid needing escaping", async () => {
        const fetchMock = mockFetch(() =>
            jsonResponse(200, { escrowScopeId: "scope-1", publicKey: { publicKey: "c", type: "x509", fingerprint: "f", notBefore: 0, notAfter: 1 } }),
        );
        await getEscrowInfo("mb/1");
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("/api/mail/mailboxes/mb%2F1/escrow-info");
    });
});

describe("addMasterKeyWrap", () => {
    it("posts the wrap", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
        const wrap = {
            method: "password" as const,
            ciphertext: "c",
            nonce: "n",
            salt: "s",
            kdf: "argon2id:m=65536,t=3,p=4",
            schemeVersion: 1,
            createdAt: 0,
        };
        await addMasterKeyWrap("mb1", wrap);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/keyvault/wraps",
            expect.objectContaining({ method: "POST", body: JSON.stringify(wrap) }),
        );
    });
});

describe("removeMasterKeyWrap", () => {
    it("omits the methodId query param when not given", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
        await removeMasterKeyWrap("mb1", "password");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/keyvault/wraps/password",
            expect.objectContaining({ method: "DELETE" }),
        );
    });

    it("includes methodId when given", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
        await removeMasterKeyWrap("mb1", "passkey", "cred-1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/keyvault/wraps/passkey?methodId=cred-1",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});

describe("rekey", () => {
    it("puts the full replacement body", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
        const input = { wrappedKeys: [], masterKeyWraps: [], keys: [] };
        await rekey("mb1", input);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/keyvault/rekey",
            expect.objectContaining({ method: "PUT", body: JSON.stringify(input) }),
        );
    });
});

describe("lookupKeys", () => {
    it("fetches with the addr query param", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { keys: [] }));
        const result = await lookupKeys("mb1", "alice@example.com");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/mailboxes/mb1/keys/lookup?addr=alice%40example.com",
            expect.anything(),
        );
        expect(result).toEqual({ keys: [] });
    });
});

describe("getEncryptionPolicy", () => {
    it("fetches the system-wide policy", async () => {
        const fetchMock = mockFetch(() =>
            jsonResponse(200, { encryptSameOrg: "optional", encryptFederated: "optional", encryptExternal: "optional" }),
        );
        const result = await getEncryptionPolicy();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/encryption-policy", expect.anything());
        expect(result.encryptSameOrg).toBe("optional");
    });
});

describe("updateEncryptionPolicy", () => {
    it("puts the patch", async () => {
        const fetchMock = mockFetch(() =>
            jsonResponse(200, { encryptSameOrg: "prohibited", encryptFederated: "optional", encryptExternal: "optional" }),
        );
        await updateEncryptionPolicy({ encryptSameOrg: "prohibited" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/encryption-policy",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ encryptSameOrg: "prohibited" }) }),
        );
    });
});

describe("round 6: expectedMasterKeyGeneration", () => {
    const wrappedKey = { ciphertext: "c", nonce: "n", algorithm: "AES-256-GCM" };
    const wrap = { method: "passkey" as const, methodId: "cred-1", ciphertext: "c", nonce: "n", salt: "s", kdf: "k", schemeVersion: 1, createdAt: 1 };
    const bodyOf = (fetchMock: ReturnType<typeof mockFetch>) => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);

    it("reads the vault's masterKeyGeneration", async () => {
        mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [], masterKeyGeneration: 3 }));
        expect((await getKeyVault("mb1")).masterKeyGeneration).toBe(3);
    });

    it("passes it through on enrollKey, startSignEnrollment and rekey bodies when given", async () => {
        let fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [], masterKeyGeneration: 2 }));
        await enrollKey("mb1", { useType: "encrypt", csr: "csr", wrappedKey, expectedMasterKeyGeneration: 2 });
        expect(bodyOf(fetchMock)).toEqual({ useType: "encrypt", csr: "csr", wrappedKey, expectedMasterKeyGeneration: 2 });

        fetchMock = mockFetch(() => jsonResponse(200, { enrollmentId: "enr-1" }));
        await startSignEnrollment("mb1", { csr: "csr", wrappedKey, expectedMasterKeyGeneration: 0 });
        expect(bodyOf(fetchMock)).toEqual({ csr: "csr", wrappedKey, expectedMasterKeyGeneration: 0 });

        fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
        await rekey("mb1", { wrappedKeys: [], masterKeyWraps: [], keys: [], expectedMasterKeyGeneration: 5 });
        expect(bodyOf(fetchMock)).toEqual({ wrappedKeys: [], masterKeyWraps: [], keys: [], expectedMasterKeyGeneration: 5 });
    });

    it("sends addMasterKeyWrap's generation (0 included) alongside the wrap, and the bare wrap without one", async () => {
        let fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
        await addMasterKeyWrap("mb1", wrap, 0);
        expect(bodyOf(fetchMock)).toEqual({ ...wrap, expectedMasterKeyGeneration: 0 });

        fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
        await addMasterKeyWrap("mb1", wrap);
        expect(bodyOf(fetchMock)).toEqual(wrap);
        expect(bodyOf(fetchMock)).not.toHaveProperty("expectedMasterKeyGeneration");
    });

    it("surfaces the server's 409 for a rotated master key as an ordinary ApiRequestError", async () => {
        mockFetch(() => jsonResponse(409, { message: "The master key was rotated." }));
        const err = await addMasterKeyWrap("mb1", wrap, 1).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApiRequestError);
        expect(err).not.toBeInstanceOf(VaultAlreadyInitializedError);
        expect((err as ApiRequestError).status).toBe(409);
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [], keys: [] }));
        const wrappedKey = { ciphertext: "c", nonce: "n", algorithm: "AES-256-GCM" };
        const wrap = { method: "passkey" as const, methodId: "cred-1", ciphertext: "c", nonce: "n", salt: "s", kdf: "k", schemeVersion: 1, createdAt: 1 };

        await getKeyVault("mb1", client);
        await enrollKey("mb1", { useType: "encrypt", csr: "csr", wrappedKey }, client);
        await startSignEnrollment("mb1", { csr: "csr", wrappedKey }, client);
        await checkSignEnrollmentStatus("mb1", "enr-1", client);
        await getCurrentSignEnrollment("mb1", client);
        await checkSignEnrollmentNow("mb1", "enr-1", client);
        await cancelSignEnrollment("mb1", "enr-1", client);
        await getEscrowInfo("mb1", client);
        await addMasterKeyWrap("mb1", wrap, 1, client);
        await removeMasterKeyWrap("mb1", "passkey", "cred-1", client);
        await rekey("mb1", { wrappedKeys: [], masterKeyWraps: [], keys: [] }, client);
        await lookupKeys("mb1", "alice@example.com", client);
        await trustSigner("mb1", { address: "a@example.com", certificate: "c" }, client);
        await resolveKeyConflict("mb1", { address: "a@example.com", useType: "sign", action: "accept", expectedPinnedFingerprint: "fp" }, client);
        await getEncryptionPolicy(client);
        await updateEncryptionPolicy({ encryptSameOrg: "optional" }, client);

        expect(fetchMock).toHaveBeenCalledTimes(16);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [] }));
        await getKeyVault("mb1");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/mailboxes/mb1/keyvault", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
