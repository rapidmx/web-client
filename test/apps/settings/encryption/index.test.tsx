// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import SettingsEncryptionPage from "../../../../apps/www/settings/encryption/index.js";

const { getKeyVault, addMasterKeyWrap, removeMasterKeyWrap, enrollKey, rekey, startSignEnrollment, checkSignEnrollmentStatus } = vi.hoisted(() => ({
    getKeyVault: vi.fn(),
    addMasterKeyWrap: vi.fn(),
    removeMasterKeyWrap: vi.fn(),
    enrollKey: vi.fn(),
    rekey: vi.fn(),
    startSignEnrollment: vi.fn(),
    checkSignEnrollmentStatus: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", async (importOriginal) => {
    // `findActivePublicKey` is a pure function this page also imports - kept real (via importOriginal)
    // rather than added to every test's mock list, unlike the network-calling functions below.
    const actual = await importOriginal<typeof import("@rapidmx/react-shared/crypto/keyvaultApi.js")>();
    return { ...actual, getKeyVault, addMasterKeyWrap, removeMasterKeyWrap, enrollKey, rekey, startSignEnrollment, checkSignEnrollmentStatus };
});

const { rewrapPrivateKeysUnderNewMasterKey } = vi.hoisted(() => ({ rewrapPrivateKeysUnderNewMasterKey: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keyRotation.js", () => ({ rewrapPrivateKeysUnderNewMasterKey }));

const { getUnlockedKeys, destroyUnlockedKeys, unlockWithPassword } = vi.hoisted(() => ({
    getUnlockedKeys: vi.fn(),
    destroyUnlockedKeys: vi.fn(),
    unlockWithPassword: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({
    MASTER_KEY_AAD_PURPOSE: "master-key",
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE: "encrypt-private-key",
    SIGNING_PRIVATE_KEY_AAD_PURPOSE: "sign-private-key",
    getUnlockedKeys,
    unlockWithPassword,
    destroyUnlockedKeys,
}));

const { buildPasswordWrap, buildRecoveryWraps } = vi.hoisted(() => ({
    buildPasswordWrap: vi.fn(),
    buildRecoveryWraps: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/masterKeyWraps.js", () => ({ buildPasswordWrap, buildRecoveryWraps }));

const { generateKeyPairWithCsr, exportPrivateKeyPkcs8 } = vi.hoisted(() => ({
    generateKeyPairWithCsr: vi.fn(),
    exportPrivateKeyPkcs8: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/keys.js", () => ({ generateKeyPairWithCsr, exportPrivateKeyPkcs8 }));

const { sealWithKey, buildAad } = vi.hoisted(() => ({
    sealWithKey: vi.fn(),
    buildAad: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/masterKey.js", () => ({ sealWithKey, buildAad }));

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
    keys: [
        {
            publicKey: "base64cert",
            type: "x509",
            useType: "encrypt" as const,
            fingerprint: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
            notBefore: 1,
            notAfter: Date.now() + 1_000_000,
        },
    ],
};

const vault = {
    wrappedKeys: [{ ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM", fingerprint: mailbox.keys[0].fingerprint, useType: "encrypt" as const }],
    masterKeyWraps: [
        { method: "password" as const, ciphertext: "ct", nonce: "n", salt: "salt", kdf: "argon2id:m=1,t=1,p=1", schemeVersion: 1, createdAt: 0 },
        {
            method: "recovery" as const,
            methodId: "recovery-1",
            ciphertext: "ct",
            nonce: "n",
            salt: "salt",
            kdf: "hkdf-sha256",
            schemeVersion: 1,
            createdAt: 0,
        },
    ],
};

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
    vi.useRealTimers();
    getKeyVault.mockReset();
    addMasterKeyWrap.mockReset();
    removeMasterKeyWrap.mockReset();
    enrollKey.mockReset();
    rekey.mockReset();
    startSignEnrollment.mockReset();
    checkSignEnrollmentStatus.mockReset();
    getUnlockedKeys.mockReset();
    destroyUnlockedKeys.mockReset();
    unlockWithPassword.mockReset();
    buildPasswordWrap.mockReset();
    buildRecoveryWraps.mockReset();
    rewrapPrivateKeysUnderNewMasterKey.mockReset();
    generateKeyPairWithCsr.mockReset();
    exportPrivateKeyPkcs8.mockReset();
    sealWithKey.mockReset();
    buildAad.mockReset();
    localStorage.clear();
});

describe("SettingsEncryptionPage", () => {
    it("lists the mailbox's enrolled keys and unlock methods", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        render(<SettingsEncryptionPage userUid="u1" />);

        expect(await screen.findByText(/Encryption key: abcd1234/)).toBeInTheDocument();
        expect(await screen.findByText("Password")).toBeInTheDocument();
        expect(screen.getByText("Recovery code")).toBeInTheDocument();
    });

    it("distinguishes a signing key from an encryption key, marks a revoked key, hides Remove for an escrow wrap, and falls back to the raw method name for an unrecognized wrap", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue({
            wrappedKeys: [],
            // "future-method" is deliberately outside MasterKeyWrap["method"]'s known union - simulating a
            // server that has added an unlock method this client doesn't know about yet, to exercise the
            // fallback-to-raw-name display path.
            masterKeyWraps: [
                { method: "escrow", ciphertext: "ct", nonce: "n", salt: "s", kdf: "k", schemeVersion: 1, createdAt: 0 },
                { method: "future-method", ciphertext: "ct", nonce: "n", salt: "s", kdf: "k", schemeVersion: 1, createdAt: 0 },
            ] as unknown as typeof vault.masterKeyWraps,
        });
        const mixedMailbox = {
            ...mailbox,
            keys: [
                { ...mailbox.keys[0], useType: "sign" as const, fingerprint: "sign-fp" },
                { ...mailbox.keys[0], fingerprint: "revoked-fp", revokedAt: Date.now() },
            ],
        };
        mockShell((url) => (url.startsWith("/api/mail/mailboxes") ? jsonResponse(200, [mixedMailbox]) : undefined));
        render(<SettingsEncryptionPage userUid="u1" />);

        expect(await screen.findByText(/Signing key: sign-fp/)).toBeInTheDocument();
        expect(screen.getByText(/Encryption key: revoked-fp/)).toBeInTheDocument();
        expect(screen.getByText("(revoked)")).toBeInTheDocument();
        // Unlike the keys list above (rendered straight from the already-loaded `mailboxes` prop), the
        // unlock-methods list depends on this page's own separate `getKeyVault()` fetch - awaited
        // explicitly so this assertion doesn't race that still-pending promise.
        expect(await screen.findByText("Escrow (managed by your organization)")).toBeInTheDocument();
        expect(screen.getByText("future-method")).toBeInTheDocument();
        const escrowRow = screen.getByText("Escrow (managed by your organization)").closest("li")!;
        expect(within(escrowRow).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    });

    it("shows 'No keys enrolled yet.' when the mailbox has none", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        mockShell((url) => (url.startsWith("/api/mail/mailboxes") ? jsonResponse(200, [{ ...mailbox, keys: undefined }]) : undefined));
        render(<SettingsEncryptionPage userUid="u1" />);

        expect(await screen.findByText("No keys enrolled yet.")).toBeInTheDocument();
        // Depends on this page's own separate getKeyVault() fetch, not the (already-loaded) mailbox keys
        // list above - awaited explicitly so this doesn't race that still-pending promise.
        expect(await screen.findByText("No unlock methods on file.")).toBeInTheDocument();
    });

    it("shows an error when the key vault fails to load", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockRejectedValue(new Error("network down"));
        mockShell();
        render(<SettingsEncryptionPage userUid="u1" />);

        expect(await screen.findByText("Could not load your key vault.")).toBeInTheDocument();
    });

    it("shows the server's own message when loading the vault fails with an ApiRequestError", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockRejectedValue(new ApiRequestError("vault temporarily unavailable", 503));
        mockShell();
        render(<SettingsEncryptionPage userUid="u1" />);

        expect(await screen.findByText("vault temporarily unavailable")).toBeInTheDocument();
    });

    it("removes an unlock method and reloads the vault", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValueOnce(vault).mockResolvedValueOnce({ wrappedKeys: vault.wrappedKeys, masterKeyWraps: [vault.masterKeyWraps[0]] });
        removeMasterKeyWrap.mockResolvedValue(undefined);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Recovery code");

        const recoveryRow = screen.getByText("Recovery code").closest("li")!;
        await user.click(within(recoveryRow).getByRole("button", { name: "Remove" }));

        await waitFor(() => expect(removeMasterKeyWrap).toHaveBeenCalledWith("mb1", "recovery", "recovery-1"));
        await waitFor(() => expect(screen.queryByText("Recovery code")).not.toBeInTheDocument());
    });

    it("shows an error when removing an unlock method fails", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        removeMasterKeyWrap.mockRejectedValue(new ApiRequestError("cannot remove your last unlock method", 400));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        const passwordRow = screen.getByText("Password").closest("li")!;
        await user.click(within(passwordRow).getByRole("button", { name: "Remove" }));

        expect(await screen.findByText("cannot remove your last unlock method")).toBeInTheDocument();
    });

    it("shows a generic error when removing an unlock method fails with a non-API error", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        removeMasterKeyWrap.mockRejectedValue(new Error("network down"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        const passwordRow = screen.getByText("Password").closest("li")!;
        await user.click(within(passwordRow).getByRole("button", { name: "Remove" }));

        expect(await screen.findByText("Could not remove this unlock method.")).toBeInTheDocument();
    });

    it("adds a new password wrap and reloads the vault", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        buildPasswordWrap.mockResolvedValue({
            method: "password",
            ciphertext: "ct2",
            nonce: "n2",
            salt: "salt2",
            kdf: "argon2id:m=1,t=1,p=1",
            schemeVersion: 1,
            createdAt: 0,
        });
        addMasterKeyWrap.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.type(screen.getByLabelText("New password"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        await waitFor(() => expect(buildPasswordWrap).toHaveBeenCalledWith("mb1", expect.any(Uint8Array), "a good password"));
        expect(addMasterKeyWrap).toHaveBeenCalledWith("mb1", expect.objectContaining({ method: "password" }));
        expect(screen.getByLabelText("New password")).toHaveValue("");
    });

    it("rejects a too-short new password without calling the API", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.type(screen.getByLabelText("New password"), "short");
        await user.type(screen.getByLabelText("Confirm new password"), "short");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        expect(await screen.findByText(/at least 8 characters/)).toBeInTheDocument();
        expect(buildPasswordWrap).not.toHaveBeenCalled();
    });

    it("rejects mismatched new passwords", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.type(screen.getByLabelText("New password"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password"), "a different password");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
        expect(buildPasswordWrap).not.toHaveBeenCalled();
    });

    it("shows an error when adding a password fails", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        buildPasswordWrap.mockRejectedValue(new Error("boom"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.type(screen.getByLabelText("New password"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        expect(await screen.findByText("Could not add this password.")).toBeInTheDocument();
    });

    it("shows the server's own message when adding a password fails with an ApiRequestError", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        buildPasswordWrap.mockRejectedValue(new ApiRequestError("password too weak", 400));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.type(screen.getByLabelText("New password"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        expect(await screen.findByText("password too weak")).toBeInTheDocument();
    });

    it("regenerates recovery codes: removes the old ones, adds the new ones, and shows them once", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        removeMasterKeyWrap.mockResolvedValue(undefined);
        const newWraps = Array.from({ length: 8 }, (_, i) => ({
            method: "recovery" as const,
            methodId: `recovery-${i + 1}`,
            ciphertext: "ct",
            nonce: "n",
            salt: "salt",
            kdf: "hkdf-sha256",
            schemeVersion: 1,
            createdAt: 0,
        }));
        const newCodes = Array.from({ length: 8 }, (_, i) => `NEWCODE-${i + 1}`);
        buildRecoveryWraps.mockResolvedValue({ wraps: newWraps, codes: newCodes });
        addMasterKeyWrap.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText("Save your new recovery codes")).toBeInTheDocument();
        for (const code of newCodes) {
            expect(screen.getByText(code)).toBeInTheDocument();
        }
        expect(removeMasterKeyWrap).toHaveBeenCalledWith("mb1", "recovery", "recovery-1");
        expect(addMasterKeyWrap).toHaveBeenCalledTimes(8);

        const doneButton = screen.getByRole("button", { name: "Done" });
        expect(doneButton).toBeDisabled();
        await user.click(screen.getByRole("checkbox"));
        expect(doneButton).toBeEnabled();
        await user.click(doneButton);

        expect(screen.getByText("Password")).toBeInTheDocument();
    });

    it("shows an error when regenerating recovery codes fails", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        removeMasterKeyWrap.mockRejectedValue(new Error("boom"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText("Could not regenerate recovery codes.")).toBeInTheDocument();
    });

    it("shows the server's own message when regenerating recovery codes fails with an ApiRequestError", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        removeMasterKeyWrap.mockRejectedValue(new ApiRequestError("too many requests", 429));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText("too many requests")).toBeInTheDocument();
    });

    it("rotates keys: re-wraps under a new MK, rekeys the vault, re-unlocks with the new password, and shows the new codes", async () => {
        const unlockedFixture = { masterKey: new Uint8Array(32), encryptionPrivateKey: {} as CryptoKey, encryptionFingerprint: mailbox.keys[0].fingerprint };
        getUnlockedKeys.mockReturnValue(unlockedFixture);
        getKeyVault.mockResolvedValue(vault);
        const newMk = new Uint8Array(32).fill(9);
        const rewrappedKeys = [{ ciphertext: "ct2", nonce: "n2", algorithm: "AES-256-GCM", fingerprint: mailbox.keys[0].fingerprint, useType: "encrypt" as const }];
        rewrapPrivateKeysUnderNewMasterKey.mockResolvedValue({ mk: newMk, wrappedKeys: rewrappedKeys });
        buildPasswordWrap.mockResolvedValue({
            method: "password",
            ciphertext: "ct3",
            nonce: "n3",
            salt: "salt3",
            kdf: "argon2id:m=1,t=1,p=1",
            schemeVersion: 1,
            createdAt: 0,
        });
        const newCodes = Array.from({ length: 8 }, (_, i) => `ROTATED-${i + 1}`);
        const newRecoveryWraps = newCodes.map((_, i) => ({
            method: "recovery" as const,
            methodId: `recovery-${i + 1}`,
            ciphertext: "ct",
            nonce: "n",
            salt: "salt",
            kdf: "hkdf-sha256",
            schemeVersion: 1,
            createdAt: 0,
        }));
        buildRecoveryWraps.mockResolvedValue({ wraps: newRecoveryWraps, codes: newCodes });
        rekey.mockResolvedValue(vault);
        unlockWithPassword.mockResolvedValue(undefined);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.type(screen.getByLabelText("New password for rotated keys"), "a good new password");
        await user.type(screen.getByLabelText("Confirm new password for rotated keys"), "a good new password");
        await user.click(screen.getByRole("button", { name: "Rotate keys now" }));

        expect(await screen.findByText("Save your new recovery codes")).toBeInTheDocument();
        expect(screen.getByText(/every previous unlock method/)).toBeInTheDocument();
        for (const code of newCodes) {
            expect(screen.getByText(code)).toBeInTheDocument();
        }
        expect(rewrapPrivateKeysUnderNewMasterKey).toHaveBeenCalledWith("mb1", unlockedFixture);
        expect(buildPasswordWrap).toHaveBeenCalledWith("mb1", newMk, "a good new password");
        expect(buildRecoveryWraps).toHaveBeenCalledWith("mb1", newMk);
        expect(rekey).toHaveBeenCalledWith("mb1", {
            wrappedKeys: rewrappedKeys,
            masterKeyWraps: [expect.objectContaining({ method: "password" }), ...newRecoveryWraps],
            keys: mailbox.keys,
        });
        expect(unlockWithPassword).toHaveBeenCalledWith("mb1", mailbox.keys, "a good new password");
    });

    it("passes an empty keys array to rekey()/unlockWithPassword() when the mailbox has none", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        rewrapPrivateKeysUnderNewMasterKey.mockResolvedValue({ mk: new Uint8Array(32), wrappedKeys: [] });
        buildPasswordWrap.mockResolvedValue({ method: "password", ciphertext: "c", nonce: "n", salt: "s", kdf: "k", schemeVersion: 1, createdAt: 0 });
        buildRecoveryWraps.mockResolvedValue({ wraps: [], codes: [] });
        rekey.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        unlockWithPassword.mockResolvedValue(undefined);
        mockShell((url) => (url.startsWith("/api/mail/mailboxes") ? jsonResponse(200, [{ ...mailbox, keys: undefined }]) : undefined));
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("No keys enrolled yet.");

        await user.type(screen.getByLabelText("New password for rotated keys"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password for rotated keys"), "a good password");
        await user.click(screen.getByRole("button", { name: "Rotate keys now" }));

        await waitFor(() => expect(rekey).toHaveBeenCalledWith("mb1", expect.objectContaining({ keys: [] })));
        expect(unlockWithPassword).toHaveBeenCalledWith("mb1", [], "a good password");
    });

    it("rejects a too-short rotation password without calling rewrapPrivateKeysUnderNewMasterKey", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.type(screen.getByLabelText("New password for rotated keys"), "short");
        await user.type(screen.getByLabelText("Confirm new password for rotated keys"), "short");
        await user.click(screen.getByRole("button", { name: "Rotate keys now" }));

        expect(await screen.findByText(/at least 8 characters/)).toBeInTheDocument();
        expect(rewrapPrivateKeysUnderNewMasterKey).not.toHaveBeenCalled();
    });

    it("rejects mismatched rotation passwords", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.type(screen.getByLabelText("New password for rotated keys"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password for rotated keys"), "a different password");
        await user.click(screen.getByRole("button", { name: "Rotate keys now" }));

        expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
        expect(rewrapPrivateKeysUnderNewMasterKey).not.toHaveBeenCalled();
    });

    it("shows an error when rotation fails with a non-API error", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        rewrapPrivateKeysUnderNewMasterKey.mockRejectedValue(new Error("boom"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.type(screen.getByLabelText("New password for rotated keys"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password for rotated keys"), "a good password");
        await user.click(screen.getByRole("button", { name: "Rotate keys now" }));

        expect(await screen.findByText("Could not rotate your encryption keys.")).toBeInTheDocument();
    });

    it("shows the server's own message when rotation fails with an ApiRequestError", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        rewrapPrivateKeysUnderNewMasterKey.mockResolvedValue({ mk: new Uint8Array(32), wrappedKeys: [] });
        buildPasswordWrap.mockResolvedValue({ method: "password", ciphertext: "c", nonce: "n", salt: "s", kdf: "k", schemeVersion: 1, createdAt: 0 });
        buildRecoveryWraps.mockResolvedValue({ wraps: [], codes: [] });
        rekey.mockRejectedValue(new ApiRequestError("mailbox is not owned by this user", 403));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.type(screen.getByLabelText("New password for rotated keys"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password for rotated keys"), "a good password");
        await user.click(screen.getByRole("button", { name: "Rotate keys now" }));

        expect(await screen.findByText("mailbox is not owned by this user")).toBeInTheDocument();
    });

    it("shows the default session timeout (30 minutes) when nothing has been configured", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        expect(screen.getByLabelText("Session timeout")).toHaveValue("30");
    });

    it("changing the session timeout persists it to localStorage immediately", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.selectOptions(screen.getByLabelText("Session timeout"), "Never");

        expect(screen.getByLabelText("Session timeout")).toHaveValue("0");
        expect(localStorage.getItem("rapidmx:idle-timeout-minutes")).toBe("0");
    });

    it("reflects an already-configured session timeout on load", async () => {
        localStorage.setItem("rapidmx:idle-timeout-minutes", "60");
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        expect(screen.getByLabelText("Session timeout")).toHaveValue("60");
        expect(screen.getByText("1 hour")).toBeInTheDocument();
    });

    it("destroys this session's unlocked keys and shows a confirmation instead of the management UI", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Destroy keys on this device now" }));

        expect(destroyUnlockedKeys).toHaveBeenCalledWith("mb1");
        expect(await screen.findByText(/removed from this session/)).toBeInTheDocument();
        expect(screen.queryByText("Password")).not.toBeInTheDocument();
    });

    it("shows 'Enabled' for digital signatures when an active signing key already exists", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        const signedMailbox = { ...mailbox, keys: [...mailbox.keys, { ...mailbox.keys[0], useType: "sign" as const, fingerprint: "sign-fp" }] };
        mockShell((url) => (url.startsWith("/api/mail/mailboxes") ? jsonResponse(200, [signedMailbox]) : undefined));
        render(<SettingsEncryptionPage userUid="u1" />);

        expect(await screen.findByText(/Enabled — outgoing mail/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Enable digital signatures" })).not.toBeInTheDocument();
    });

    it("enables digital signatures: generates a keypair, wraps it under MK, and starts enrollment", async () => {
        const unlockedFixture = { masterKey: new Uint8Array(32) };
        getUnlockedKeys.mockReturnValue(unlockedFixture);
        getKeyVault.mockResolvedValue(vault);
        const keyPair = { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey };
        generateKeyPairWithCsr.mockResolvedValue({ keyPair, csrPem: "csr-pem" });
        exportPrivateKeyPkcs8.mockResolvedValue(new Uint8Array([1, 2, 3]));
        buildAad.mockReturnValue(new Uint8Array([9]));
        sealWithKey.mockResolvedValue({ ciphertext: "sealed-ct", nonce: "sealed-n" });
        startSignEnrollment.mockResolvedValue({ enrollmentId: "enr-1" });
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));

        expect(await screen.findByText(/Requested/)).toBeInTheDocument();
        expect(generateKeyPairWithCsr).toHaveBeenCalledWith("u1@example.com", "sign");
        expect(exportPrivateKeyPkcs8).toHaveBeenCalledWith(keyPair.privateKey);
        expect(buildAad).toHaveBeenCalledWith("mb1", "sign-private-key");
        expect(sealWithKey).toHaveBeenCalledWith(unlockedFixture.masterKey, expect.any(Uint8Array), expect.any(Uint8Array));
        expect(startSignEnrollment).toHaveBeenCalledWith("mb1", {
            csr: "csr-pem",
            wrappedKey: { ciphertext: "sealed-ct", nonce: "sealed-n", algorithm: "AES-256-GCM" },
        });
    });

    it("shows the server's own message when starting signing enrollment fails", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        generateKeyPairWithCsr.mockResolvedValue({ keyPair: { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey }, csrPem: "csr-pem" });
        exportPrivateKeyPkcs8.mockResolvedValue(new Uint8Array([1]));
        buildAad.mockReturnValue(new Uint8Array([9]));
        sealWithKey.mockResolvedValue({ ciphertext: "ct", nonce: "n" });
        startSignEnrollment.mockRejectedValue(new ApiRequestError("automated signing enrollment is not enabled", 400));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));

        expect(await screen.findByText("automated signing enrollment is not enabled")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Enable digital signatures" })).toBeInTheDocument();
    });

    it("shows a generic error when starting signing enrollment fails with a non-API error", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        generateKeyPairWithCsr.mockRejectedValue(new Error("boom"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));

        expect(await screen.findByText("Could not start signing certificate enrollment.")).toBeInTheDocument();
    });

    it("polls enrollment status and shows the new signing key once issued", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        generateKeyPairWithCsr.mockResolvedValue({ keyPair: { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey }, csrPem: "csr-pem" });
        exportPrivateKeyPkcs8.mockResolvedValue(new Uint8Array([1]));
        buildAad.mockReturnValue(new Uint8Array([9]));
        sealWithKey.mockResolvedValue({ ciphertext: "ct", nonce: "n" });
        startSignEnrollment.mockResolvedValue({ enrollmentId: "enr-1" });
        checkSignEnrollmentStatus.mockResolvedValueOnce({ status: "pending" }).mockResolvedValueOnce({ status: "issued", certificate: "cert-pem" });
        const issuedMailbox = { ...mailbox, keys: [...mailbox.keys, { ...mailbox.keys[0], useType: "sign" as const, fingerprint: "new-sign-fp" }] };
        mockShell((url) => (url === "/api/mail/mailboxes/mb1" ? jsonResponse(200, issuedMailbox) : undefined));

        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));
        expect(await screen.findByText(/Requested/)).toBeInTheDocument();

        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);
        expect(checkSignEnrollmentStatus).toHaveBeenCalledWith("mb1", "enr-1");
        expect(screen.getByText(/Requested/)).toBeInTheDocument();

        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(await screen.findByText(/Signing key: new-sign-fp/)).toBeInTheDocument();
        expect(screen.getByText(/Enabled — outgoing mail/)).toBeInTheDocument();
    });

    it("shows the failure reason and returns to the enroll button when enrollment fails during polling", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        generateKeyPairWithCsr.mockResolvedValue({ keyPair: { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey }, csrPem: "csr-pem" });
        exportPrivateKeyPkcs8.mockResolvedValue(new Uint8Array([1]));
        buildAad.mockReturnValue(new Uint8Array([9]));
        sealWithKey.mockResolvedValue({ ciphertext: "ct", nonce: "n" });
        startSignEnrollment.mockResolvedValue({ enrollmentId: "enr-1" });
        checkSignEnrollmentStatus.mockResolvedValue({ status: "failed", error: "the CA rejected this request" });
        mockShell();

        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));
        expect(await screen.findByText(/Requested/)).toBeInTheDocument();

        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(await screen.findByText("the CA rejected this request")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Enable digital signatures" })).toBeInTheDocument();
    });

    it("ignores a poll response that resolves after the component has unmounted", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        generateKeyPairWithCsr.mockResolvedValue({ keyPair: { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey }, csrPem: "csr-pem" });
        exportPrivateKeyPkcs8.mockResolvedValue(new Uint8Array([1]));
        buildAad.mockReturnValue(new Uint8Array([9]));
        sealWithKey.mockResolvedValue({ ciphertext: "ct", nonce: "n" });
        startSignEnrollment.mockResolvedValue({ enrollmentId: "enr-1" });
        let resolveStatus: ((value: { status: "issued"; certificate: string }) => void) | undefined;
        checkSignEnrollmentStatus.mockReturnValue(
            new Promise((resolve) => {
                resolveStatus = resolve;
            }),
        );
        mockShell();

        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const { unmount } = render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));
        expect(await screen.findByText(/Requested/)).toBeInTheDocument();

        // Starts the poll's in-flight checkSignEnrollmentStatus() call (left pending above), then
        // unmounts before it resolves - exercising the effect's own `cancelled` guard, which is what
        // stops a late resolution from calling setState on an unmounted component.
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        unmount();
        await act(async () => {
            resolveStatus!({ status: "issued", certificate: "cert-pem" });
            await Promise.resolve();
        });
    });

    it("skips applying the refreshed mailbox keys if the component unmounts while re-fetching it", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        generateKeyPairWithCsr.mockResolvedValue({ keyPair: { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey }, csrPem: "csr-pem" });
        exportPrivateKeyPkcs8.mockResolvedValue(new Uint8Array([1]));
        buildAad.mockReturnValue(new Uint8Array([9]));
        sealWithKey.mockResolvedValue({ ciphertext: "ct", nonce: "n" });
        startSignEnrollment.mockResolvedValue({ enrollmentId: "enr-1" });
        checkSignEnrollmentStatus.mockResolvedValue({ status: "issued", certificate: "cert-pem" });
        let resolveMailboxFetch: ((res: Response) => void) | undefined;
        mockShell((url) => {
            if (url === "/api/mail/mailboxes/mb1") {
                return new Promise<Response>((resolve) => {
                    resolveMailboxFetch = resolve;
                });
            }
            return undefined;
        });

        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const { unmount } = render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));
        expect(await screen.findByText(/Requested/)).toBeInTheDocument();

        // Fires the poll, which resolves "issued" and starts the follow-up getMailbox() re-fetch (left
        // pending above) - unmounting here, before that resolves, exercises the same `cancelled` guard
        // that protects the mailbox refresh, not just the status check itself.
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        unmount();
        await act(async () => {
            resolveMailboxFetch!(jsonResponse(200, mailbox));
            await Promise.resolve();
        });
    });

    it("shows a default message when a failed enrollment carries no reason", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        generateKeyPairWithCsr.mockResolvedValue({ keyPair: { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey }, csrPem: "csr-pem" });
        exportPrivateKeyPkcs8.mockResolvedValue(new Uint8Array([1]));
        buildAad.mockReturnValue(new Uint8Array([9]));
        sealWithKey.mockResolvedValue({ ciphertext: "ct", nonce: "n" });
        startSignEnrollment.mockResolvedValue({ enrollmentId: "enr-1" });
        checkSignEnrollmentStatus.mockResolvedValue({ status: "failed" });
        mockShell();

        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));
        expect(await screen.findByText(/Requested/)).toBeInTheDocument();

        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(await screen.findByText("Signing certificate enrollment failed.")).toBeInTheDocument();
    });

    it("treats a refreshed mailbox with no keys at all as having none", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        generateKeyPairWithCsr.mockResolvedValue({ keyPair: { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey }, csrPem: "csr-pem" });
        exportPrivateKeyPkcs8.mockResolvedValue(new Uint8Array([1]));
        buildAad.mockReturnValue(new Uint8Array([9]));
        sealWithKey.mockResolvedValue({ ciphertext: "ct", nonce: "n" });
        startSignEnrollment.mockResolvedValue({ enrollmentId: "enr-1" });
        checkSignEnrollmentStatus.mockResolvedValue({ status: "issued", certificate: "cert-pem" });
        mockShell((url) => (url === "/api/mail/mailboxes/mb1" ? jsonResponse(200, { ...mailbox, keys: undefined }) : undefined));

        vi.useFakeTimers({ shouldAdvanceTime: true });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));
        expect(await screen.findByText(/Requested/)).toBeInTheDocument();

        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(await screen.findByText("No keys enrolled yet.")).toBeInTheDocument();
    });
});
