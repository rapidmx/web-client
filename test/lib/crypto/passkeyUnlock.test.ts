// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBase64Url, toBase64Url } from "../../../lib/crypto/encoding.js";
import { deriveFromPasskey, registerPasskeyForUnlock } from "../../../lib/crypto/passkeyUnlock.js";

function mockCredentials(impl: { create?: (opts: any) => any; get?: (opts: any) => any }): void {
    Object.defineProperty(navigator, "credentials", {
        configurable: true,
        value: {
            create: vi.fn(impl.create ?? (() => Promise.resolve(undefined))),
            get: vi.fn(impl.get ?? (() => Promise.resolve(undefined))),
        },
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("registerPasskeyForUnlock", () => {
    it("requests the prf extension and returns the credential id + prf support flag", async () => {
        const rawId = crypto.getRandomValues(new Uint8Array(16)).buffer;
        mockCredentials({
            create: (opts) => {
                expect(opts.publicKey.rp.id).toBe("mail.example.com");
                expect(opts.publicKey.extensions).toEqual({ prf: {} });
                return Promise.resolve({
                    rawId,
                    getClientExtensionResults: () => ({ prf: { enabled: true } }),
                });
            },
        });

        const result = await registerPasskeyForUnlock("mail.example.com", new TextEncoder().encode("user-1"), "alice");
        expect(result.prfSupported).toBe(true);
        expect(fromBase64Url(result.credentialId)).toEqual(new Uint8Array(rawId));
    });

    it("reports prfSupported: false when the authenticator doesn't advertise it", async () => {
        mockCredentials({
            create: () =>
                Promise.resolve({
                    rawId: new Uint8Array(16).buffer,
                    getClientExtensionResults: () => ({}),
                }),
        });

        const result = await registerPasskeyForUnlock("mail.example.com", new TextEncoder().encode("user-1"), "alice");
        expect(result.prfSupported).toBe(false);
    });
});

describe("deriveFromPasskey", () => {
    it("evaluates the prf extension with the given salt and derives a wrapping key", async () => {
        const credentialId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const prfSecret = crypto.getRandomValues(new Uint8Array(32)).buffer;

        mockCredentials({
            get: (opts) => {
                expect(opts.publicKey.allowCredentials[0].id).toEqual(fromBase64Url(credentialId));
                expect(new Uint8Array(opts.publicKey.extensions.prf.eval.first)).toEqual(salt);
                return Promise.resolve({
                    getClientExtensionResults: () => ({ prf: { results: { first: prfSecret } } }),
                });
            },
        });

        const derived = await deriveFromPasskey("mail.example.com", credentialId, salt);
        expect(derived.length).toBe(32);
    });

    it("is deterministic for the same prf output and salt", async () => {
        const credentialId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const prfSecret = crypto.getRandomValues(new Uint8Array(32)).buffer;
        mockCredentials({
            get: () => Promise.resolve({ getClientExtensionResults: () => ({ prf: { results: { first: prfSecret } } }) }),
        });

        const a = await deriveFromPasskey("mail.example.com", credentialId, salt);
        const b = await deriveFromPasskey("mail.example.com", credentialId, salt);
        expect(a).toEqual(b);
    });

    it("throws when the authenticator returns no prf result", async () => {
        mockCredentials({ get: () => Promise.resolve({ getClientExtensionResults: () => ({}) }) });
        await expect(deriveFromPasskey("mail.example.com", toBase64Url(new Uint8Array(16)), new Uint8Array(16))).rejects.toThrow(
            /did not return a PRF result/,
        );
    });
});
