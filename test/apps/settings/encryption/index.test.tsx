// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { resetEnrollmentTracker } from "../../../../apps/shared/signing/enrollmentTracker.js";
import SettingsEncryptionPageBase from "../../../../apps/www/settings/encryption/index.js";
import { withTestRouter } from "../../routerTestUtils.js";

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const SettingsEncryptionPage = withTestRouter(SettingsEncryptionPageBase);

const {
    getKeyVault,
    addMasterKeyWrap,
    removeMasterKeyWrap,
    enrollKey,
    rekey,
    startSignEnrollment,
    checkSignEnrollmentStatus,
    checkSignEnrollmentNow,
    getCurrentSignEnrollment,
    cancelSignEnrollment,
    getEscrowInfo,
} = vi.hoisted(() => ({
    getKeyVault: vi.fn(),
    addMasterKeyWrap: vi.fn(),
    removeMasterKeyWrap: vi.fn(),
    enrollKey: vi.fn(),
    rekey: vi.fn(),
    startSignEnrollment: vi.fn(),
    checkSignEnrollmentStatus: vi.fn(),
    checkSignEnrollmentNow: vi.fn(),
    getCurrentSignEnrollment: vi.fn(),
    cancelSignEnrollment: vi.fn(),
    getEscrowInfo: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", async (importOriginal) => {
    // `findActivePublicKey` is a pure function this page also imports - kept real (via importOriginal)
    // rather than added to every test's mock list, unlike the network-calling functions below.
    const actual = await importOriginal<typeof import("@rapidmx/react-shared/crypto/keyvaultApi.js")>();
    return { ...actual, getKeyVault, addMasterKeyWrap, removeMasterKeyWrap, enrollKey, rekey, startSignEnrollment, checkSignEnrollmentStatus, checkSignEnrollmentNow, getCurrentSignEnrollment, cancelSignEnrollment, getEscrowInfo };
});

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

const { buildPasswordWrap, buildRecoveryWraps, buildEscrowWrap } = vi.hoisted(() => ({
    buildPasswordWrap: vi.fn(),
    buildRecoveryWraps: vi.fn(),
    buildEscrowWrap: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/masterKeyWraps.js", () => ({ buildPasswordWrap, buildRecoveryWraps, buildEscrowWrap }));

const { generateKeyPairWithCsr, exportPrivateKeyPkcs8 } = vi.hoisted(() => ({
    generateKeyPairWithCsr: vi.fn(),
    exportPrivateKeyPkcs8: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/keys.js", () => ({ generateKeyPairWithCsr, exportPrivateKeyPkcs8 }));

const { sealWithKey, buildAad, openWithKey, generateMasterKey, KeysLockedError } = vi.hoisted(() => ({
    sealWithKey: vi.fn(),
    buildAad: vi.fn(),
    openWithKey: vi.fn(),
    generateMasterKey: vi.fn(),
    KeysLockedError: class KeysLockedError extends Error {},
}));
vi.mock("@rapidmx/react-shared/crypto/masterKey.js", () => ({ sealWithKey, buildAad, openWithKey, generateMasterKey, KeysLockedError }));

// jsdom's `navigator.clipboard` is a getter-only property — `Object.assign` throws against it, so
// `writeText` must be installed via `defineProperty` instead (matches admin/domains/[uid].test.tsx's
// identical helper). Must be called AFTER `userEvent.setup()` in each test - that call installs its own
// clipboard stub, which would otherwise clobber this override.
function mockClipboard(writeText: ReturnType<typeof vi.fn>): void {
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

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

/** Serves `mb` for both the shell's mailbox list and this page's own `getMailbox()` refetch. */
function mailboxRoutes(mb: Record<string, unknown>) {
    return (url: string) => {
        if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, mb);
        if (url.startsWith("/api/mail/mailboxes") && !url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(200, [mb]);
        return undefined;
    };
}

/** A vault with no password wrap - the only state that offers "Add a password". */
const noPasswordVault = { wrappedKeys: vault.wrappedKeys, masterKeyWraps: [vault.masterKeyWraps[1], { ...vault.masterKeyWraps[1], methodId: "recovery-2" }] };

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url === "/api/mail/mailboxes/mb1") return jsonResponse(200, mailbox);
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

// Every write checks that the session master key still opens the vault (round 6) - by default it does.
beforeEach(() => {
    openWithKey.mockImplementation(async () => new Uint8Array(4));
    // No enrollment on the server, unless a test says there is one.
    getCurrentSignEnrollment.mockResolvedValue(null);
});

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
    checkSignEnrollmentNow.mockReset();
    getCurrentSignEnrollment.mockReset();
    cancelSignEnrollment.mockReset();
    getEscrowInfo.mockReset();
    getUnlockedKeys.mockReset();
    destroyUnlockedKeys.mockReset();
    unlockWithPassword.mockReset();
    buildPasswordWrap.mockReset();
    buildRecoveryWraps.mockReset();
    buildEscrowWrap.mockReset();
    openWithKey.mockReset();
    generateMasterKey.mockReset();
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
                { ...mailbox.keys[0], fingerprint: "compromised-fp", revokedAt: Date.now(), revocationReason: "compromised" as const },
                { ...mailbox.keys[0], fingerprint: "superseded-fp", revokedAt: Date.now(), revocationReason: "superseded" as const },
            ],
        };
        mockShell((url) => (url.startsWith("/api/mail/mailboxes") ? jsonResponse(200, [mixedMailbox]) : undefined));
        render(<SettingsEncryptionPage userUid="u1" />);

        expect(await screen.findByText(/Signing key: sign-fp/)).toBeInTheDocument();
        expect(screen.getByText(/Encryption key: revoked-fp/)).toBeInTheDocument();
        // A reasonless or compromised revocation reads "revoked"; a routine rotation's superseded key doesn't.
        expect(screen.getAllByText("(revoked)")).toHaveLength(2);
        expect(screen.getByText(/Encryption key: superseded-fp/)).toHaveTextContent("(superseded)");
        expect(screen.getByText(/Encryption key: superseded-fp/)).not.toHaveTextContent("(revoked)");
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
        await user.click(await screen.findByRole("button", { name: "Remove method" }));

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
        await screen.findByText("Recovery code");

        const recoveryRow = screen.getByText("Recovery code").closest("li")!;
        await user.click(within(recoveryRow).getByRole("button", { name: "Remove" }));
        await user.click(await screen.findByRole("button", { name: "Remove method" }));

        // A pop-up (see `NotificationCenter`): the server's message under a title saying what failed.
        expect(await screen.findByText("cannot remove your last unlock method")).toBeInTheDocument();
        expect(screen.getByText("Couldn't remove this unlock method")).toBeInTheDocument();
    });

    it("shows a generic error when removing an unlock method fails with a non-API error", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        removeMasterKeyWrap.mockRejectedValue(new Error("network down"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Recovery code");

        const recoveryRow = screen.getByText("Recovery code").closest("li")!;
        await user.click(within(recoveryRow).getByRole("button", { name: "Remove" }));
        await user.click(await screen.findByRole("button", { name: "Remove method" }));

        expect(await screen.findByText("Couldn't remove this unlock method")).toBeInTheDocument();
        expect(screen.getByText("The server couldn't be reached. Check your connection and try again.")).toBeInTheDocument();
    });

    it("never offers removing the last password wrap, even alongside other unlock methods, but does when there are two", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValueOnce(vault);
        mockShell();
        const { unmount } = render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        const passwordRow = screen.getByText("Password").closest("li")!;
        expect(within(passwordRow).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
        expect(within(passwordRow).getByText("Needed to unlock")).toBeInTheDocument();
        const recoveryRow = screen.getByText("Recovery code").closest("li")!;
        expect(within(recoveryRow).getByRole("button", { name: "Remove" })).toBeInTheDocument();
        unmount();

        getKeyVault.mockResolvedValue({ wrappedKeys: vault.wrappedKeys, masterKeyWraps: [vault.masterKeyWraps[0], { ...vault.masterKeyWraps[0], methodId: "pw-2" }] });
        render(<SettingsEncryptionPage userUid="u1" />);
        await waitFor(() => expect(screen.getAllByText("Password")).toHaveLength(2));
        for (const row of screen.getAllByText("Password")) {
            expect(within(row.closest("li")!).getByRole("button", { name: "Remove" })).toBeInTheDocument();
        }

        removeMasterKeyWrap.mockResolvedValue(undefined);
        const user = userEvent.setup();
        await user.click(within(screen.getAllByText("Password")[0].closest("li")!).getByRole("button", { name: "Remove" }));
        await user.click(await screen.findByRole("button", { name: "Remove method" }));
        await waitFor(() => expect(removeMasterKeyWrap).toHaveBeenCalledWith("mb1", "password", undefined));
    });

    it("doesn't offer adding a second password while one exists, pointing at key rotation instead", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add password" })).not.toBeInTheDocument();
        expect(screen.getByText(/Only one password can unlock this mailbox/)).toBeInTheDocument();
    });

    it("adds a new password wrap and reloads the vault", async () => {
        const unlockedFixture = { masterKey: new Uint8Array(32) };
        getUnlockedKeys.mockReturnValue(unlockedFixture);
        getKeyVault.mockResolvedValue(noPasswordVault);
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
        await screen.findByLabelText("New password");

        await user.type(screen.getByLabelText("New password"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        await waitFor(() => expect(buildPasswordWrap).toHaveBeenCalledWith("mb1", unlockedFixture.masterKey, "a good password"));
        expect(addMasterKeyWrap).toHaveBeenCalledWith("mb1", expect.objectContaining({ method: "password" }));
        await waitFor(() => expect(screen.getByLabelText("New password")).toHaveValue(""));
    });

    it("rejects a too-short new password without calling the API", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(noPasswordVault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByLabelText("New password");

        await user.type(screen.getByLabelText("New password"), "short");
        await user.type(screen.getByLabelText("Confirm new password"), "short");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        expect(await screen.findByText(/at least 8 characters/)).toBeInTheDocument();
        expect(buildPasswordWrap).not.toHaveBeenCalled();
    });

    it("rejects mismatched new passwords", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(noPasswordVault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByLabelText("New password");

        await user.type(screen.getByLabelText("New password"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password"), "a different password");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
        expect(buildPasswordWrap).not.toHaveBeenCalled();
    });

    it("shows an error when adding a password fails", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(noPasswordVault);
        buildPasswordWrap.mockRejectedValue(new Error("boom"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByLabelText("New password");

        await user.type(screen.getByLabelText("New password"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        expect(await screen.findByText("Could not add this password.")).toBeInTheDocument();
    });

    it("shows the server's own message when adding a password fails with an ApiRequestError", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(noPasswordVault);
        buildPasswordWrap.mockRejectedValue(new ApiRequestError("password too weak", 400));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByLabelText("New password");

        await user.type(screen.getByLabelText("New password"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        expect(await screen.findByText("password too weak")).toBeInTheDocument();
    });

    it("tells the user to unlock again when the keys were locked while adding a password", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(noPasswordVault);
        buildPasswordWrap.mockRejectedValue(new KeysLockedError("locked"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByLabelText("New password");

        await user.type(screen.getByLabelText("New password"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        expect(await screen.findByText(/were locked before this could finish/)).toBeInTheDocument();
    });

    it("re-reads the session keys at action time and prompts to unlock when they've since been locked", async () => {
        const liveKeys = { masterKey: new Uint8Array(32).fill(1) };
        let locked = false;
        getUnlockedKeys.mockImplementation(() => (locked ? undefined : liveKeys));
        getKeyVault.mockResolvedValue(noPasswordVault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByLabelText("New password");

        locked = true;
        await user.type(screen.getByLabelText("New password"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Add password" }));

        expect(await screen.findByText("Unlock your mailbox")).toBeInTheDocument();
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
        expect(await screen.findByText("Could not add this password.")).toBeInTheDocument();
        expect(buildPasswordWrap).not.toHaveBeenCalled();
    });

    it("treats a destroyed session keys object as locked", async () => {
        const destroyedKeys = { masterKey: new Uint8Array(32), destroyed: true };
        const freshKeys = { masterKey: new Uint8Array(32).fill(2) };
        // The page's own read sees the destroyed object; the unlock prompt's read sees fresh keys (as if the
        // user had just unlocked in another tab), so it resolves without a dialog.
        getUnlockedKeys.mockReturnValue(destroyedKeys);
        getKeyVault.mockResolvedValue(noPasswordVault);
        buildPasswordWrap.mockResolvedValue({ method: "password", ciphertext: "c", nonce: "n", salt: "s", kdf: "k", schemeVersion: 1, createdAt: 0 });
        addMasterKeyWrap.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByLabelText("New password");

        await user.type(screen.getByLabelText("New password"), "a good password");
        await user.type(screen.getByLabelText("Confirm new password"), "a good password");
        getUnlockedKeys.mockReturnValueOnce(destroyedKeys).mockReturnValueOnce(freshKeys);
        await user.click(screen.getByRole("button", { name: "Add password" }));

        await waitFor(() => expect(buildPasswordWrap).toHaveBeenCalledWith("mb1", freshKeys.masterKey, "a good password"));
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
        expect(addMasterKeyWrap).toHaveBeenCalledTimes(8);
        // Each new wrap gets a batch-unique methodId, so removing the old "recovery-1" can't also match it.
        const addedIds = addMasterKeyWrap.mock.calls.map((call) => call[1].methodId as string);
        expect(new Set(addedIds).size).toBe(8);
        for (const id of addedIds) {
            expect(id).toMatch(/^recovery-[0-9a-z]+-[1-8]$/);
        }
        expect(removeMasterKeyWrap).toHaveBeenCalledTimes(1);
        expect(removeMasterKeyWrap).toHaveBeenCalledWith("mb1", "recovery", "recovery-1");
        // New wraps are all added before any old one is removed.
        expect(addMasterKeyWrap.mock.invocationCallOrder[7]).toBeLessThan(removeMasterKeyWrap.mock.invocationCallOrder[0]);
        expect(screen.getByText(/Your old recovery codes no longer work/)).toBeInTheDocument();

        const doneButton = screen.getByRole("button", { name: "Done" });
        expect(doneButton).toBeDisabled();
        await user.click(screen.getByRole("checkbox"));
        expect(doneButton).toBeEnabled();
        await user.click(doneButton);

        expect(screen.getByText("Password")).toBeInTheDocument();
    });

    it("copies every new recovery code (newline-joined) to the clipboard and shows a confirmation", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        removeMasterKeyWrap.mockResolvedValue(undefined);
        const newCodes = Array.from({ length: 8 }, (_, i) => `NEWCODE-${i + 1}`);
        buildRecoveryWraps.mockResolvedValue({ wraps: recoveryFixture(8).wraps, codes: newCodes });
        addMasterKeyWrap.mockResolvedValue(vault);
        mockShell();
        const writeText = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        mockClipboard(writeText);
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));
        await screen.findByText("Save your new recovery codes");

        await user.click(screen.getByRole("button", { name: "Copy codes to clipboard" }));

        expect(writeText).toHaveBeenCalledWith(newCodes.join("\n"));
        expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    });

    it("silently ignores a clipboard write failure when copying new recovery codes", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        removeMasterKeyWrap.mockResolvedValue(undefined);
        const newCodes = Array.from({ length: 8 }, (_, i) => `NEWCODE-${i + 1}`);
        buildRecoveryWraps.mockResolvedValue({ wraps: recoveryFixture(8).wraps, codes: newCodes });
        addMasterKeyWrap.mockResolvedValue(vault);
        mockShell();
        const writeText = vi.fn().mockRejectedValue(new Error("denied"));
        const user = userEvent.setup();
        mockClipboard(writeText);
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));
        await screen.findByText("Save your new recovery codes");

        await user.click(screen.getByRole("button", { name: "Copy codes to clipboard" }));

        expect(writeText).toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Copied" })).not.toBeInTheDocument();
    });

    function recoveryFixture(count: number) {
        return {
            wraps: Array.from({ length: count }, (_, i) => ({
                method: "recovery" as const,
                methodId: `recovery-${i + 1}`,
                ciphertext: "ct",
                nonce: "n",
                salt: "salt",
                kdf: "hkdf-sha256",
                schemeVersion: 1,
                createdAt: 0,
            })),
            codes: Array.from({ length: count }, (_, i) => `NEWCODE-${i + 1}`),
        };
    }

    it("disables regenerating recovery codes until the vault has loaded", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockRejectedValue(new Error("network down"));
        mockShell();
        render(<SettingsEncryptionPage userUid="u1" />);

        expect(await screen.findByText("Could not load your key vault.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Regenerate recovery codes" })).toBeDisabled();
    });

    it("shows an error and removes nothing when building the new recovery codes fails", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        buildRecoveryWraps.mockRejectedValue(new Error("boom"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText("Could not regenerate recovery codes.")).toBeInTheDocument();
        expect(addMasterKeyWrap).not.toHaveBeenCalled();
        expect(removeMasterKeyWrap).not.toHaveBeenCalled();
    });

    it("shows the server's own message when building the new recovery codes fails with an ApiRequestError", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        buildRecoveryWraps.mockRejectedValue(new ApiRequestError("too many requests", 429));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText("too many requests")).toBeInTheDocument();
    });

    it("keeps the old recovery codes and shows an error when no new code could be saved", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        buildRecoveryWraps.mockResolvedValue(recoveryFixture(8));
        addMasterKeyWrap.mockRejectedValue(new ApiRequestError("A key vault cannot hold more than 20 master key wraps.", 400));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText("A key vault cannot hold more than 20 master key wraps.")).toBeInTheDocument();
        expect(removeMasterKeyWrap).not.toHaveBeenCalled();
        expect(screen.queryByText("Save your new recovery codes")).not.toBeInTheDocument();
    });

    it("shows a generic error when no new code could be saved due to a non-API error", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        buildRecoveryWraps.mockResolvedValue(recoveryFixture(8));
        addMasterKeyWrap.mockRejectedValue(new Error("network down"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText("Could not regenerate recovery codes.")).toBeInTheDocument();
    });

    it("shows the codes that did save, keeps the old ones, and explains a partial regeneration", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        buildRecoveryWraps.mockResolvedValue(recoveryFixture(8));
        addMasterKeyWrap
            .mockResolvedValueOnce(vault)
            .mockResolvedValueOnce(vault)
            .mockRejectedValueOnce(new ApiRequestError("vault is full", 400));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText("Save your new recovery codes")).toBeInTheDocument();
        expect(screen.getByText(/Only 2 of 8 new recovery codes could be saved \(vault is full\)\. Your old recovery codes were kept/)).toBeInTheDocument();
        expect(screen.queryByText(/Your old recovery codes no longer work/)).not.toBeInTheDocument();
        expect(screen.getByText("NEWCODE-1")).toBeInTheDocument();
        expect(screen.getByText("NEWCODE-2")).toBeInTheDocument();
        expect(screen.queryByText("NEWCODE-3")).not.toBeInTheDocument();
        expect(addMasterKeyWrap).toHaveBeenCalledTimes(3);
        expect(removeMasterKeyWrap).not.toHaveBeenCalled();
    });

    it("omits the server message from a partial regeneration warning for a non-API error", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        buildRecoveryWraps.mockResolvedValue(recoveryFixture(2));
        addMasterKeyWrap.mockResolvedValueOnce(vault).mockRejectedValueOnce(new Error("network down"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText(/^Only 1 of 2 new recovery codes could be saved\. Your old/)).toBeInTheDocument();
    });

    it("warns on the codes screen when some old recovery codes couldn't be removed", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue({
            wrappedKeys: vault.wrappedKeys,
            masterKeyWraps: [...vault.masterKeyWraps, { ...vault.masterKeyWraps[1], methodId: "recovery-2" }],
        });
        buildRecoveryWraps.mockResolvedValue(recoveryFixture(2));
        addMasterKeyWrap.mockResolvedValue(vault);
        removeMasterKeyWrap.mockResolvedValueOnce(vault).mockRejectedValueOnce(new ApiRequestError("conflict", 409));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText(/1 of your old recovery codes could not be removed and still work/)).toBeInTheDocument();
        expect(screen.getByText("NEWCODE-2")).toBeInTheDocument();
        expect(removeMasterKeyWrap).toHaveBeenCalledWith("mb1", "recovery", "recovery-1");
        expect(removeMasterKeyWrap).toHaveBeenCalledWith("mb1", "recovery", "recovery-2");
    });

    /** A vault holding `total` wraps: one password, `recovery` old recovery codes, the rest passkeys. */
    function vaultWithWraps(total: number, recovery: number) {
        const passkeys = total - 1 - recovery;
        return {
            wrappedKeys: vault.wrappedKeys,
            masterKeyWraps: [
                vault.masterKeyWraps[0],
                ...Array.from({ length: recovery }, (_, i) => ({ ...vault.masterKeyWraps[1], methodId: `old-recovery-${i + 1}` })),
                ...Array.from({ length: passkeys }, (_, i) => ({ ...vault.masterKeyWraps[1], method: "passkey" as const, methodId: `passkey-${i + 1}` })),
            ],
        };
    }

    it("refuses to regenerate, writing nothing, when the new codes can't fit under the vault's wrap cap even after removing the old ones", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        // 20 wraps, only 2 of them old recovery codes: 8 new codes need 6 more free slots.
        getKeyVault.mockResolvedValueOnce(vault).mockResolvedValue(vaultWithWraps(20, 2));
        buildRecoveryWraps.mockResolvedValue(recoveryFixture(8));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(
            await screen.findByText(/can hold at most 20 unlock methods and already has 20\. Regenerating needs room for 8 new recovery codes, so remove 6 other unlock methods/),
        ).toBeInTheDocument();
        expect(addMasterKeyWrap).not.toHaveBeenCalled();
        expect(removeMasterKeyWrap).not.toHaveBeenCalled();
        // The list reflects the fresh vault the check used.
        expect(screen.getAllByText("Passkey")).toHaveLength(17);
    });

    it("uses singular wording when one more unlock method must be removed", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vaultWithWraps(19, 0));
        buildRecoveryWraps.mockResolvedValue(recoveryFixture(2));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText(/so remove 1 other unlock method \(/)).toBeInTheDocument();
    });

    it("near the wrap cap, removes an old recovery code just before each new one that has no room, never dropping below a full set", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        // 20 wraps with 3 old recovery codes and 2 new ones: no free slot, so each add is preceded by one removal.
        getKeyVault.mockResolvedValue(vaultWithWraps(20, 3));
        buildRecoveryWraps.mockResolvedValue(recoveryFixture(2));
        addMasterKeyWrap.mockResolvedValue(vault);
        removeMasterKeyWrap.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText("Save your new recovery codes")).toBeInTheDocument();
        expect(screen.getByText(/Your old recovery codes no longer work/)).toBeInTheDocument();
        const calls = [
            ...removeMasterKeyWrap.mock.calls.map((c, i) => ({ order: removeMasterKeyWrap.mock.invocationCallOrder[i], what: `remove ${c[2]}` })),
            ...addMasterKeyWrap.mock.calls.map((c, i) => ({ order: addMasterKeyWrap.mock.invocationCallOrder[i], what: `add ${c[1].methodId.replace(/-[0-9a-z]+-/, "-N-")}` })),
        ]
            .sort((x, y) => x.order - y.order)
            .map((c) => c.what);
        expect(calls).toEqual(["remove old-recovery-1", "add recovery-N-1", "remove old-recovery-2", "add recovery-N-2", "remove old-recovery-3"]);
    });

    it("explains which old codes were already removed to make room when a later new code fails to save", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vaultWithWraps(20, 3));
        buildRecoveryWraps.mockResolvedValue(recoveryFixture(3));
        addMasterKeyWrap.mockResolvedValueOnce(vault).mockRejectedValueOnce(new ApiRequestError("conflict", 409));
        removeMasterKeyWrap.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        // The old code removed for the failed add is put back, so only the first removal still counts.
        expect(
            await screen.findByText(/Only 1 of 3 new recovery codes could be saved \(conflict\)\. 1 of your old recovery codes had to be removed to make room; the rest were kept and still work/),
        ).toBeInTheDocument();
        expect(removeMasterKeyWrap).toHaveBeenCalledTimes(2);
        expect(addMasterKeyWrap).toHaveBeenLastCalledWith("mb1", expect.objectContaining({ methodId: "old-recovery-2" }));
    });

    it("reports a first new code that fails to save after an old code was already removed to make room", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vaultWithWraps(20, 3));
        buildRecoveryWraps.mockResolvedValue(recoveryFixture(2));
        removeMasterKeyWrap.mockResolvedValueOnce(vault);
        // The new code fails, and so does putting the removed old code back.
        addMasterKeyWrap.mockRejectedValueOnce(new Error("network down")).mockRejectedValueOnce(new Error("still down"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(
            await screen.findByText("Could not regenerate recovery codes. 1 of your old recovery codes had to be removed to make room; the rest were kept and still work."),
        ).toBeInTheDocument();
        expect(screen.queryByText("Save your new recovery codes")).not.toBeInTheDocument();
        expect(addMasterKeyWrap).toHaveBeenLastCalledWith("mb1", expect.objectContaining({ methodId: "old-recovery-1" }));
    });

    it("puts back the old recovery code it removed to make room when the new code then fails to save", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        const full = vaultWithWraps(20, 3);
        getKeyVault.mockResolvedValue(full);
        buildRecoveryWraps.mockResolvedValue(recoveryFixture(2));
        removeMasterKeyWrap.mockResolvedValueOnce(vault);
        addMasterKeyWrap.mockRejectedValueOnce(new ApiRequestError("vault is full", 400)).mockResolvedValueOnce(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText("vault is full")).toBeInTheDocument();
        expect(addMasterKeyWrap).toHaveBeenCalledTimes(2);
        expect(addMasterKeyWrap).toHaveBeenLastCalledWith("mb1", full.masterKeyWraps[1]);
    });

    it("shows an error when the fresh vault can't be fetched before regenerating", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValueOnce(vault).mockRejectedValueOnce(new ApiRequestError("vault busy", 503));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

        expect(await screen.findByText("vault busy")).toBeInTheDocument();
        expect(buildRecoveryWraps).not.toHaveBeenCalled();
    });

    it("asks for confirmation before removing an unlock method, and does nothing when cancelled", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Recovery code");

        const recoveryRow = screen.getByText("Recovery code").closest("li")!;
        await user.click(within(recoveryRow).getByRole("button", { name: "Remove" }));
        expect(await screen.findByText(/Remove this unlock method\?/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        await waitFor(() => expect(screen.queryByText(/Remove this unlock method\?/)).not.toBeInTheDocument());
        expect(removeMasterKeyWrap).not.toHaveBeenCalled();

        await user.click(within(recoveryRow).getByRole("button", { name: "Remove" }));
        expect(await screen.findByText(/Remove this unlock method\?/)).toBeInTheDocument();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByText(/Remove this unlock method\?/)).not.toBeInTheDocument());
        expect(removeMasterKeyWrap).not.toHaveBeenCalled();
    });

    it("doesn't offer removing the mailbox's only non-escrow unlock method", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue({
            wrappedKeys: vault.wrappedKeys,
            masterKeyWraps: [
                vault.masterKeyWraps[0],
                { method: "escrow" as const, escrowScopeId: "scope-1", ciphertext: "ct", nonce: "n/a", salt: "n/a", kdf: "cms-enveloped-data", schemeVersion: 1, createdAt: 0 },
            ],
        });
        mockShell();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        const passwordRow = screen.getByText("Password").closest("li")!;
        expect(within(passwordRow).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
        expect(within(passwordRow).getByText("Your only unlock method")).toBeInTheDocument();
    });

    it("doesn't offer removing a lone recovery code when it's the only non-escrow unlock method", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue({ wrappedKeys: vault.wrappedKeys, masterKeyWraps: [vault.masterKeyWraps[1]] });
        mockShell();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Recovery code");

        const recoveryRow = screen.getByText("Recovery code").closest("li")!;
        expect(within(recoveryRow).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
        expect(within(recoveryRow).getByText("Your only unlock method")).toBeInTheDocument();
    });

    function passwordWrapFixture() {
        return { method: "password" as const, ciphertext: "c", nonce: "n", salt: "s", kdf: "k", schemeVersion: 1, createdAt: 0 };
    }

    async function submitRotation(user: ReturnType<typeof userEvent.setup>, password = "a good new password") {
        await user.type(screen.getByLabelText("New password for rotated keys"), password);
        await user.type(screen.getByLabelText("Confirm new password for rotated keys"), password);
        await user.click(screen.getByRole("button", { name: "Rotate keys now" }));
    }

    /** Default crypto mocks for a rotation: every vault entry opens, and re-seals to a recognizable ciphertext. */
    function mockRotationCrypto(newMk = new Uint8Array(32).fill(9)) {
        openWithKey.mockImplementation(async () => new Uint8Array([7, 7, 7]));
        generateMasterKey.mockReturnValue(newMk);
        buildAad.mockImplementation((mailboxUid: string, purpose: string) => new TextEncoder().encode(`${mailboxUid}:${purpose}`));
        sealWithKey.mockImplementation(async (_key: Uint8Array, _plain: Uint8Array, aad: Uint8Array) => ({
            ciphertext: `sealed:${new TextDecoder().decode(aad)}`,
            nonce: "fresh-nonce",
        }));
        return newMk;
    }

    it("refuses to rotate, changing nothing, when any vault entry can't be opened with the current master key", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        const staleEntry = { ...vault.wrappedKeys[0], fingerprint: "old-fp", ciphertext: "old-ct" };
        getKeyVault.mockResolvedValue({ wrappedKeys: [...vault.wrappedKeys, staleEntry], masterKeyWraps: vault.masterKeyWraps });
        mockRotationCrypto();
        openWithKey.mockImplementation(async (_key: Uint8Array, sealed: { ciphertext: string }) => {
            if (sealed.ciphertext === "old-ct") throw new DOMException("OperationError");
            return new Uint8Array([1]);
        });
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await submitRotation(user);

        expect(await screen.findByText(/a private key this session can't open \(old-fp\), so rotating now would lose it/)).toBeInTheDocument();
        expect(generateMasterKey).not.toHaveBeenCalled();
        expect(rekey).not.toHaveBeenCalled();
    });

    it("names every vault entry it can't open", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue({
            wrappedKeys: [
                { ...vault.wrappedKeys[0], fingerprint: "fp-a" },
                { ...vault.wrappedKeys[0], fingerprint: "fp-b", useType: "sign" as const },
                { ...vault.wrappedKeys[0], fingerprint: "fp-ok" },
            ],
            masterKeyWraps: vault.masterKeyWraps,
        });
        // One entry still opens, so the session key isn't stale - two just can't be opened with it.
        openWithKey.mockImplementation(async (_key: Uint8Array, sealed: { fingerprint: string }) => {
            if (sealed.fingerprint !== "fp-ok") throw new Error("bad tag");
            return new Uint8Array([1]);
        });
        buildAad.mockReturnValue(new Uint8Array([1]));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await submitRotation(user);

        expect(await screen.findByText(/2 private keys this session can't open \(fp-a, fp-b\), so rotating now would lose them/)).toBeInTheDocument();
    });

    it("tells the user to unlock again when the master key was destroyed mid-rotation", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        // The vault check still opens the key; the lock lands while re-wrapping.
        openWithKey.mockResolvedValueOnce(new Uint8Array([1])).mockRejectedValue(new KeysLockedError("locked"));
        buildAad.mockReturnValue(new Uint8Array([1]));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await submitRotation(user);

        expect(await screen.findByText(/were locked before this could finish/)).toBeInTheDocument();
        expect(rekey).not.toHaveBeenCalled();
    });

    it("destroys this session's stale keys when re-unlocking after a rotation fails, after the codes are acknowledged", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockRotationCrypto();
        buildPasswordWrap.mockResolvedValue(passwordWrapFixture());
        buildRecoveryWraps.mockResolvedValue({ wraps: [], codes: ["ROTATED-1"] });
        rekey.mockResolvedValue(vault);
        unlockWithPassword.mockRejectedValue(new Error("wrong password"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await submitRotation(user);

        expect(await screen.findByText("ROTATED-1")).toBeInTheDocument();
        await waitFor(() => expect(destroyUnlockedKeys).toHaveBeenCalledWith("mb1"));
        await user.click(screen.getByRole("checkbox"));
        await user.click(screen.getByRole("button", { name: "Done" }));

        expect(await screen.findByText(/couldn't unlock them again with your new password/)).toBeInTheDocument();
    });

    it("rotates keys: re-wraps every vault entry (inactive ones too) under a new MK, rekeys with fresh mailbox keys, re-unlocks, and shows the new codes", async () => {
        const unlockedFixture = { masterKey: new Uint8Array(32).fill(3), encryptionFingerprint: mailbox.keys[0].fingerprint };
        getUnlockedKeys.mockReturnValue(unlockedFixture);
        const inactiveSigning = { ciphertext: "old-sign-ct", nonce: "n0", algorithm: "AES-256-GCM", fingerprint: "old-sign-fp", useType: "sign" as const };
        // The page loads with the stale single-entry vault; the rotation must fetch the vault again and see both.
        getKeyVault.mockResolvedValueOnce(vault).mockResolvedValue({ wrappedKeys: [...vault.wrappedKeys, inactiveSigning], masterKeyWraps: vault.masterKeyWraps });
        const newMk = mockRotationCrypto();
        const openedBuffers: Uint8Array[] = [];
        openWithKey.mockImplementation(async () => {
            const buf = new Uint8Array([5, 5, 5]);
            openedBuffers.push(buf);
            return buf;
        });
        buildPasswordWrap.mockResolvedValue({ ...passwordWrapFixture(), ciphertext: "ct3" });
        const newCodes = Array.from({ length: 8 }, (_, i) => `ROTATED-${i + 1}`);
        const newRecoveryWraps = recoveryFixture(8).wraps;
        buildRecoveryWraps.mockResolvedValue({ wraps: newRecoveryWraps, codes: newCodes });
        rekey.mockResolvedValue(vault);
        unlockWithPassword.mockResolvedValue({ unopenableKeys: [] });
        // A signing key the shell's one-time mailbox list never saw - only the page's fresh getMailbox() has it.
        const freshKeys = [...mailbox.keys, { ...mailbox.keys[0], useType: "sign" as const, fingerprint: "new-sign-fp" }];
        mockShell((url) => (url === "/api/mail/mailboxes/mb1" ? jsonResponse(200, { ...mailbox, keys: freshKeys }) : undefined));
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await submitRotation(user);

        expect(await screen.findByText("Save your new recovery codes")).toBeInTheDocument();
        expect(screen.getByText(/every previous unlock method/)).toBeInTheDocument();
        for (const code of newCodes) {
            expect(screen.getByText(code)).toBeInTheDocument();
        }
        expect(openWithKey).toHaveBeenCalledWith(unlockedFixture.masterKey, vault.wrappedKeys[0], expect.anything());
        expect(openWithKey).toHaveBeenCalledWith(unlockedFixture.masterKey, inactiveSigning, expect.anything());
        expect(buildAad).toHaveBeenCalledWith("mb1", "encrypt-private-key");
        expect(buildAad).toHaveBeenCalledWith("mb1", "sign-private-key");
        for (const buf of openedBuffers) {
            expect(Array.from(buf)).toEqual([0, 0, 0]);
        }
        expect(buildPasswordWrap).toHaveBeenCalledWith("mb1", newMk, "a good new password");
        expect(buildRecoveryWraps).toHaveBeenCalledWith("mb1", newMk);
        expect(rekey).toHaveBeenCalledWith("mb1", {
            wrappedKeys: [
                { ciphertext: "sealed:mb1:encrypt-private-key", nonce: "fresh-nonce", algorithm: "AES-256-GCM", fingerprint: mailbox.keys[0].fingerprint, useType: "encrypt" },
                { ciphertext: "sealed:mb1:sign-private-key", nonce: "fresh-nonce", algorithm: "AES-256-GCM", fingerprint: "old-sign-fp", useType: "sign" },
            ],
            masterKeyWraps: [expect.objectContaining({ method: "password" }), ...newRecoveryWraps],
            keys: freshKeys,
        });
        expect(unlockWithPassword).toHaveBeenCalledWith("mb1", freshKeys, "a good new password");

        await user.click(screen.getByRole("checkbox"));
        await user.click(screen.getByRole("button", { name: "Done" }));
        expect(await screen.findByText(/Signing key: new-sign-fp/)).toBeInTheDocument();
    });

    describe("round 5: escrow in the rekey request", () => {
        const escrowInfo = { escrowScopeId: "scope-1", publicKey: { publicKey: "Y2VydA==", type: "x509", fingerprint: "fp1", notBefore: 0, notAfter: 1 } };
        const freshEscrowWrap = {
            method: "escrow" as const,
            escrowScopeId: "scope-1",
            ciphertext: "fresh-ct",
            nonce: "n/a",
            salt: "n/a",
            kdf: "cms-enveloped-data",
            schemeVersion: 1,
            createdAt: 5,
        };

        function mockRotation() {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue({ wrappedKeys: vault.wrappedKeys, masterKeyWraps: [...vault.masterKeyWraps, { ...freshEscrowWrap, ciphertext: "old-ct" }] });
            const newMk = mockRotationCrypto();
            buildPasswordWrap.mockResolvedValue(passwordWrapFixture());
            buildRecoveryWraps.mockResolvedValue({ wraps: recoveryFixture(1).wraps, codes: ["ROTATED-1"] });
            rekey.mockResolvedValue(vault);
            unlockWithPassword.mockResolvedValue({ unopenableKeys: [] });
            return newMk;
        }

        it("builds an escrow wrap of the new master key and sends it in the same rekey, never re-adding it afterwards", async () => {
            const newMk = mockRotation();
            getEscrowInfo.mockResolvedValue(escrowInfo);
            buildEscrowWrap.mockResolvedValue(freshEscrowWrap);
            mockShell(mailboxRoutes({ ...mailbox, escrowScopeId: "scope-1" }));
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            await submitRotation(user);

            expect(await screen.findByText("ROTATED-1")).toBeInTheDocument();
            expect(buildEscrowWrap).toHaveBeenCalledWith(newMk, "scope-1", expect.any(Uint8Array));
            expect(rekey).toHaveBeenCalledWith(
                "mb1",
                expect.objectContaining({ masterKeyWraps: [expect.objectContaining({ method: "password" }), recoveryFixture(1).wraps[0], freshEscrowWrap] }),
            );
            expect(getEscrowInfo.mock.invocationCallOrder[0]).toBeLessThan(rekey.mock.invocationCallOrder[0]);
            await waitFor(() => expect(unlockWithPassword).toHaveBeenCalled());
            expect(addMasterKeyWrap).not.toHaveBeenCalled();
        });

        it("aborts the rotation, rekeying nothing, when the escrow wrap can't be prepared", async () => {
            mockRotation();
            getEscrowInfo.mockRejectedValue(new ApiRequestError("escrow service unavailable", 503));
            mockShell(mailboxRoutes({ ...mailbox, escrowScopeId: "scope-1" }));
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            await submitRotation(user);

            expect(
                await screen.findByText(
                    "Your keys were not rotated: this mailbox is under escrow, and escrow protection for the new keys couldn't be prepared (escrow service unavailable). Nothing was changed.",
                ),
            ).toBeInTheDocument();
            expect(rekey).not.toHaveBeenCalled();
            expect(screen.queryByText("ROTATED-1")).not.toBeInTheDocument();
        });

        it("leaves out the reason when building the escrow wrap fails with a non-API error", async () => {
            mockRotation();
            getEscrowInfo.mockResolvedValue(escrowInfo);
            buildEscrowWrap.mockRejectedValue(new Error("bad certificate"));
            mockShell(mailboxRoutes({ ...mailbox, escrowScopeId: "scope-1" }));
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            await submitRotation(user);

            expect(await screen.findByText(/escrow protection for the new keys couldn't be prepared\. Nothing was changed\./)).toBeInTheDocument();
            expect(rekey).not.toHaveBeenCalled();
        });

        it("rotates without an escrow wrap when the vault's escrow scope is gone (escrow-info 404s)", async () => {
            mockRotation();
            getEscrowInfo.mockRejectedValue(new ApiRequestError("escrow scope no longer exists", 404));
            mockShell(mailboxRoutes({ ...mailbox, escrowScopeId: "scope-deleted" }));
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            await submitRotation(user);

            expect(await screen.findByText("ROTATED-1")).toBeInTheDocument();
            expect(getEscrowInfo).toHaveBeenCalledWith("mb1");
            expect(buildEscrowWrap).not.toHaveBeenCalled();
            expect(rekey.mock.calls[0][1].masterKeyWraps.some((w: { method: string }) => w.method === "escrow")).toBe(false);
        });

        it("never escrows a mailbox by rotating it when its vault holds no escrow wrap, even with a scope assigned", async () => {
            mockRotation();
            getKeyVault.mockResolvedValue(vault);
            mockShell(mailboxRoutes({ ...mailbox, escrowScopeId: "scope-1" }));
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            await submitRotation(user);

            expect(await screen.findByText("ROTATED-1")).toBeInTheDocument();
            expect(getEscrowInfo).not.toHaveBeenCalled();
            expect(rekey.mock.calls[0][1].masterKeyWraps.some((w: { method: string }) => w.method === "escrow")).toBe(false);
        });
    });
    it("passes an empty keys array to rekey()/unlockWithPassword() when the mailbox has none", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        mockRotationCrypto();
        buildPasswordWrap.mockResolvedValue(passwordWrapFixture());
        buildRecoveryWraps.mockResolvedValue({ wraps: [], codes: [] });
        rekey.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        unlockWithPassword.mockResolvedValue({ unopenableKeys: [] });
        mockShell(mailboxRoutes({ ...mailbox, keys: undefined }));
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("No keys enrolled yet.");
        await screen.findByText("No unlock methods on file.");

        await submitRotation(user, "a good password");

        await waitFor(() => expect(rekey).toHaveBeenCalledWith("mb1", expect.objectContaining({ keys: [], wrappedKeys: [] })));
        await waitFor(() => expect(unlockWithPassword).toHaveBeenCalledWith("mb1", [], "a good password"));
    });

    it("rejects a too-short rotation password without touching the vault", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await submitRotation(user, "short");

        expect(await screen.findByText(/at least 8 characters/)).toBeInTheDocument();
        expect(openWithKey).not.toHaveBeenCalled();
        expect(getKeyVault).toHaveBeenCalledTimes(1);
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
        expect(openWithKey).not.toHaveBeenCalled();
    });

    it("shows an error when rotation fails with a non-API error", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockRotationCrypto();
        buildPasswordWrap.mockRejectedValue(new Error("boom"));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await submitRotation(user, "a good password");

        expect(await screen.findByText("Could not rotate your encryption keys.")).toBeInTheDocument();
    });

    it("shows the server's own message when rotation fails with an ApiRequestError", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockRotationCrypto();
        buildPasswordWrap.mockResolvedValue(passwordWrapFixture());
        buildRecoveryWraps.mockResolvedValue({ wraps: [], codes: [] });
        rekey.mockRejectedValue(new ApiRequestError("mailbox is not owned by this user", 403));
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");

        await submitRotation(user, "a good password");

        expect(await screen.findByText("mailbox is not owned by this user")).toBeInTheDocument();
    });

    it("hides every key-vault write action from a non-owner, and never provisions a vault for them", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [vault.masterKeyWraps[1], { ...vault.masterKeyWraps[1], methodId: "recovery-2" }] });
        mockShell(mailboxRoutes({ ...mailbox, ownerUserUid: "someone-else", escrowScopeId: "scope-1" }));
        render(<SettingsEncryptionPage userUid="u1" />);

        expect(await screen.findByText(/Only this mailbox.s owner, signed in as themselves/)).toBeInTheDocument();
        expect(screen.queryByText("Protect your mailbox")).not.toBeInTheDocument();
        await screen.findAllByText("Recovery code");
        expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add password" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Regenerate recovery codes" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Rotate keys now" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Enable digital signatures" })).not.toBeInTheDocument();
        expect(screen.getByText("Not enabled.")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add escrow protection" })).not.toBeInTheDocument();
        // Session-local actions still apply to a delegate.
        expect(screen.getByRole("button", { name: "Destroy keys on this device now" })).toBeInTheDocument();
    });

    it("treats an impersonated session as a non-owner", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        render(<SettingsEncryptionPage userUid="u1" impersonating />);

        expect(await screen.findByText(/Only this mailbox.s owner, signed in as themselves/)).toBeInTheDocument();
        await screen.findByText("Password");
        expect(screen.queryByRole("button", { name: "Rotate keys now" })).not.toBeInTheDocument();
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

    it("changing the local search index size persists it to localStorage immediately", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByText("Password");
        expect(screen.getByText(/Defaults to 500 MB on this device/)).toBeInTheDocument();

        await user.selectOptions(screen.getByLabelText("Local search index size"), "2 GB");

        expect(screen.getByLabelText("Local search index size")).toHaveValue(String(2 * 1024 * 1024 * 1024));
        expect(localStorage.getItem("rapidmx:local-index-byte-budget")).toBe(String(2 * 1024 * 1024 * 1024));
        localStorage.removeItem("rapidmx:local-index-byte-budget");
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

        // The backoff: the next look is 30 s after the first (then 60 s).
        await act(() => vi.advanceTimersByTimeAsync(15_000));
        expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);
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
        expect(await screen.findByText("Failed: the CA rejected this request")).toBeInTheDocument();
        // A failed certificate is a card of its own with "Try again" (which starts a new request the way "Enable digital signatures" did).
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Enable digital signatures" })).not.toBeInTheDocument();
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
        expect(await screen.findByText("Failed: the certificate authority did not issue a certificate.")).toBeInTheDocument();
    });

    it("shows no Escrow section when the mailbox has no escrow scope assigned", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        mockShell();
        render(<SettingsEncryptionPage userUid="u1" />);

        await screen.findByText("Password");
        expect(screen.queryByRole("heading", { name: "Escrow" })).not.toBeInTheDocument();
    });

    it("offers 'Add escrow protection' when the mailbox is assigned a scope but has no escrow wrap yet", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        const scopedMailbox = { ...mailbox, escrowScopeId: "scope-1" };
        mockShell((url) => (url.startsWith("/api/mail/mailboxes") ? jsonResponse(200, [scopedMailbox]) : undefined));
        render(<SettingsEncryptionPage userUid="u1" />);

        expect(await screen.findByRole("heading", { name: "Escrow" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Add escrow protection" })).toBeInTheDocument();
    });

    it("shows the already-protected message when the mailbox already has an escrow wrap", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue({
            wrappedKeys: vault.wrappedKeys,
            masterKeyWraps: [
                ...vault.masterKeyWraps,
                { method: "escrow" as const, escrowScopeId: "scope-1", ciphertext: "ct", nonce: "n/a", salt: "n/a", kdf: "cms-enveloped-data", schemeVersion: 1, createdAt: 0 },
            ],
        });
        const scopedMailbox = { ...mailbox, escrowScopeId: "scope-1" };
        mockShell((url) => (url.startsWith("/api/mail/mailboxes") ? jsonResponse(200, [scopedMailbox]) : undefined));
        render(<SettingsEncryptionPage userUid="u1" />);

        expect(await screen.findByText(/under legal\/compliance escrow/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Add escrow protection" })).not.toBeInTheDocument();
    });

    it("adds escrow protection: fetches the scope's public key, builds the wrap, submits it, and reloads the vault", async () => {
        const unlockedFixture = { masterKey: new Uint8Array(32) };
        getUnlockedKeys.mockReturnValue(unlockedFixture);
        const escrowWrap = { method: "escrow" as const, escrowScopeId: "scope-1", ciphertext: "ct", nonce: "n/a", salt: "n/a", kdf: "cms-enveloped-data", schemeVersion: 1, createdAt: 0 };
        getKeyVault.mockResolvedValueOnce(vault).mockResolvedValueOnce(vault).mockResolvedValueOnce({ wrappedKeys: vault.wrappedKeys, masterKeyWraps: [...vault.masterKeyWraps, escrowWrap] });
        getEscrowInfo.mockResolvedValue({ escrowScopeId: "scope-1", publicKey: { publicKey: "Y2VydA==", type: "x509", fingerprint: "fp1", notBefore: 0, notAfter: 1 } });
        buildEscrowWrap.mockResolvedValue(escrowWrap);
        addMasterKeyWrap.mockResolvedValue(vault);
        const scopedMailbox = { ...mailbox, escrowScopeId: "scope-1" };
        mockShell((url) => (url.startsWith("/api/mail/mailboxes") ? jsonResponse(200, [scopedMailbox]) : undefined));
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByRole("button", { name: "Add escrow protection" });

        await user.click(screen.getByRole("button", { name: "Add escrow protection" }));

        expect(getEscrowInfo).toHaveBeenCalledWith("mb1");
        await waitFor(() =>
            expect(buildEscrowWrap).toHaveBeenCalledWith(unlockedFixture.masterKey, "scope-1", expect.any(Uint8Array)),
        );
        expect(addMasterKeyWrap).toHaveBeenCalledWith("mb1", escrowWrap);
        expect(await screen.findByText(/under legal\/compliance escrow/)).toBeInTheDocument();
    });

    it("shows the server's own message when fetching escrow info fails", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        getEscrowInfo.mockRejectedValue(new ApiRequestError("this mailbox's escrow scope no longer exists", 404));
        const scopedMailbox = { ...mailbox, escrowScopeId: "scope-1" };
        mockShell((url) => (url.startsWith("/api/mail/mailboxes") ? jsonResponse(200, [scopedMailbox]) : undefined));
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByRole("button", { name: "Add escrow protection" });

        await user.click(screen.getByRole("button", { name: "Add escrow protection" }));

        expect(await screen.findByText("this mailbox's escrow scope no longer exists")).toBeInTheDocument();
    });

    it("shows a generic error when adding escrow protection fails with a non-API error", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        getKeyVault.mockResolvedValue(vault);
        getEscrowInfo.mockResolvedValue({ escrowScopeId: "scope-1", publicKey: { publicKey: "Y2VydA==", type: "x509", fingerprint: "fp1", notBefore: 0, notAfter: 1 } });
        buildEscrowWrap.mockRejectedValue(new Error("boom"));
        const scopedMailbox = { ...mailbox, escrowScopeId: "scope-1" };
        mockShell((url) => (url.startsWith("/api/mail/mailboxes") ? jsonResponse(200, [scopedMailbox]) : undefined));
        const user = userEvent.setup();
        render(<SettingsEncryptionPage userUid="u1" />);
        await screen.findByRole("button", { name: "Add escrow protection" });

        await user.click(screen.getByRole("button", { name: "Add escrow protection" }));

        expect(await screen.findByText("Could not add escrow protection for this mailbox.")).toBeInTheDocument();
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

    describe("round 5: rotation vs a pending signing enrollment", () => {
        const STORAGE_KEY = "rapidmx.signEnrollment.mb1";

        function mockSigningCrypto() {
            generateKeyPairWithCsr.mockResolvedValue({ keyPair: { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey }, csrPem: "csr-pem" });
            exportPrivateKeyPkcs8.mockResolvedValue(new Uint8Array([1]));
            buildAad.mockReturnValue(new Uint8Array([9]));
            sealWithKey.mockResolvedValue({ ciphertext: "ct", nonce: "n" });
        }

        it("disables rotation once an enrollment starts, and remembers it for a reload", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            mockSigningCrypto();
            startSignEnrollment.mockResolvedValue({ enrollmentId: "enr-1" });
            mockShell();
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled();

            await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));

            expect(await screen.findByText(/Rotation is unavailable while a signing certificate enrollment is in progress/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeDisabled();
            expect(screen.getByLabelText("New password for rotated keys")).toBeDisabled();
            expect(localStorage.getItem(STORAGE_KEY)).toBe("enr-1");
        });

        it("ignores an implicit submit of the rotation form while blocked", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            localStorage.setItem(STORAGE_KEY, "enr-1");
            checkSignEnrollmentStatus.mockResolvedValue({ status: "pending" });
            mockShell();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText(/Rotation is unavailable/);

            const form = screen.getByRole("button", { name: "Rotate keys now" }).closest("form")!;
            await act(async () => {
                form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
            });

            expect(screen.queryByText(/Password must be at least/)).not.toBeInTheDocument();
            expect(getKeyVault).toHaveBeenCalledTimes(1);
            expect(rekey).not.toHaveBeenCalled();
        });

        it("after a reload, asks the server about the stored enrollment and keeps rotation disabled while it is pending", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            localStorage.setItem(STORAGE_KEY, "enr-1");
            let resolveStatus: (value: { status: "pending" }) => void = () => undefined;
            checkSignEnrollmentStatus.mockReturnValue(new Promise((resolve) => (resolveStatus = resolve)));
            mockShell();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            expect(screen.getByText(/Checking whether a signing certificate enrollment is still in progress/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeDisabled();
            expect(screen.getByRole("button", { name: "Enable digital signatures" })).toBeDisabled();
            expect(checkSignEnrollmentStatus).toHaveBeenCalledWith("mb1", "enr-1");

            await act(async () => resolveStatus({ status: "pending" }));

            expect(await screen.findByText(/Requested/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeDisabled();
            expect(localStorage.getItem(STORAGE_KEY)).toBe("enr-1");
        });

        it("after a reload, re-enables rotation and shows the new key once the server says the enrollment was issued", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            localStorage.setItem(STORAGE_KEY, "enr-1");
            checkSignEnrollmentStatus.mockResolvedValue({ status: "issued", certificate: "pem" });
            const issuedMailbox = { ...mailbox, keys: [...mailbox.keys, { ...mailbox.keys[0], useType: "sign" as const, fingerprint: "new-sign-fp" }] };
            mockShell((url) => (url === "/api/mail/mailboxes/mb1" ? jsonResponse(200, issuedMailbox) : undefined));
            render(<SettingsEncryptionPage userUid="u1" />);

            expect(await screen.findByText(/Signing key: new-sign-fp/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled();
            expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        });

        it("after a reload, shows a failed enrollment's reason and re-enables rotation", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            localStorage.setItem(STORAGE_KEY, "enr-1");
            checkSignEnrollmentStatus.mockResolvedValue({ status: "failed", error: "CA said no" });
            mockShell();
            render(<SettingsEncryptionPage userUid="u1" />);

            expect(await screen.findByText("Failed: CA said no")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled();
            expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        });

        it("still finishes an issued enrollment when refreshing the mailbox's keys fails", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            localStorage.setItem(STORAGE_KEY, "enr-1");
            checkSignEnrollmentStatus.mockResolvedValue({ status: "issued", certificate: "pem" });
            mockShell((url) => (url === "/api/mail/mailboxes/mb1" ? jsonResponse(500, { message: "down" }) : undefined));
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            await waitFor(() => expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled());
            expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        });

        it("after a reload, forgets an enrollment the server no longer knows (404)", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            localStorage.setItem(STORAGE_KEY, "enr-gone");
            checkSignEnrollmentStatus.mockRejectedValue(new ApiRequestError("not found", 404));
            mockShell();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            await waitFor(() => expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled());
            expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        });

        it("after a reload, treats an unanswered status check as still pending and keeps polling", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            localStorage.setItem(STORAGE_KEY, "enr-1");
            checkSignEnrollmentStatus.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ status: "failed" });
            mockShell();
            vi.useFakeTimers({ shouldAdvanceTime: true });
            render(<SettingsEncryptionPage userUid="u1" />);

            expect(await screen.findByText(/Requested/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeDisabled();

            await act(() => vi.advanceTimersByTimeAsync(15_000));
            expect(await screen.findByText(/^Failed: /)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled();
        });

        it("keeps following after the page is left: an answer that arrives later still ends the enrollment (the stored id is forgotten), a 404 too", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            localStorage.setItem(STORAGE_KEY, "enr-1");
            let resolveStatus: (value: { status: "failed" }) => void = () => undefined;
            checkSignEnrollmentStatus.mockReturnValueOnce(new Promise((resolve) => (resolveStatus = resolve)));
            mockShell();

            const first = render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");
            first.unmount();
            await act(async () => resolveStatus({ status: "failed" }));
            expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

            localStorage.setItem(STORAGE_KEY, "enr-2");
            let rejectStatus: (err: Error) => void = () => undefined;
            checkSignEnrollmentStatus.mockReturnValueOnce(new Promise((_resolve, reject) => (rejectStatus = reject)));
            const second = render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");
            second.unmount();
            await act(async () => rejectStatus(new ApiRequestError("not found", 404)));
            expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        });

        it("still works when localStorage is blocked", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            mockSigningCrypto();
            startSignEnrollment.mockResolvedValue({ enrollmentId: "enr-1" });
            checkSignEnrollmentStatus.mockResolvedValue({ status: "failed", error: "nope" });
            const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
                throw new Error("blocked");
            });
            const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
                throw new Error("blocked");
            });
            const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
                throw new Error("blocked");
            });
            try {
                mockShell();
                vi.useFakeTimers({ shouldAdvanceTime: true });
                const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
                render(<SettingsEncryptionPage userUid="u1" />);
                await screen.findByText("Password");
                expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled();

                await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));
                expect(await screen.findByText(/Requested/)).toBeInTheDocument();
                await act(() => vi.advanceTimersByTimeAsync(15_000));
                expect(await screen.findByText("Failed: nope")).toBeInTheDocument();
                expect(setItem).toHaveBeenCalled();
                expect(removeItem).toHaveBeenCalled();
            } finally {
                getItem.mockRestore();
                setItem.mockRestore();
                removeItem.mockRestore();
            }
        });

        it("explains a 409 from rekey as a possible pending enrollment elsewhere", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            mockRotationCrypto();
            buildPasswordWrap.mockResolvedValue(passwordWrapFixture());
            buildRecoveryWraps.mockResolvedValue({ wraps: [], codes: ["X"] });
            rekey.mockRejectedValue(new ApiRequestError("A signing enrollment is pending.", 409));
            mockShell();
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            await submitRotation(user);

            expect(await screen.findByText(/signing certificate enrollment is still in progress for this mailbox \(it may have been started on another device\)/)).toBeInTheDocument();
            expect(screen.queryByText("Save your new recovery codes")).not.toBeInTheDocument();
        });
    });

    describe("round 5: cancelling a pending signing enrollment", () => {
        const STORAGE_KEY = "rapidmx.signEnrollment.mb1";

        async function renderPending() {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            localStorage.setItem(STORAGE_KEY, "enr-1");
            checkSignEnrollmentStatus.mockResolvedValue({ status: "pending" });
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText(/Rotation is unavailable/);
            return user;
        }

        it("cancels the enrollment and re-enables rotation", async () => {
            cancelSignEnrollment.mockResolvedValue({ status: "failed", error: "Cancelled by the mailbox owner." });
            mockShell();
            const user = await renderPending();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeDisabled();

            await user.click(screen.getByRole("button", { name: "Cancel enrollment" }));

            await waitFor(() => expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled());
            expect(cancelSignEnrollment).toHaveBeenCalledWith("mb1", "enr-1");
            expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
            expect(screen.queryByText("Cancelled by the mailbox owner.")).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Cancel enrollment" })).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Enable digital signatures" })).toBeEnabled();
        });

        it("says so, and stays blocked, when the enrollment is still pending after the cancel", async () => {
            cancelSignEnrollment.mockResolvedValue({ status: "pending" });
            mockShell();
            const user = await renderPending();

            await user.click(screen.getByRole("button", { name: "Cancel enrollment" }));

            expect(await screen.findByText("The enrollment couldn't be cancelled yet. Try again.")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeDisabled();
        });

        it("finishes an enrollment that was issued before the cancel landed", async () => {
            cancelSignEnrollment.mockResolvedValue({ status: "issued", certificate: "pem" });
            const issuedMailbox = { ...mailbox, keys: [...mailbox.keys, { ...mailbox.keys[0], useType: "sign" as const, fingerprint: "new-sign-fp" }] };
            mockShell((url) => (url === "/api/mail/mailboxes/mb1" ? jsonResponse(200, issuedMailbox) : undefined));
            const user = await renderPending();

            await user.click(screen.getByRole("button", { name: "Cancel enrollment" }));

            expect(await screen.findByText(/Signing key: new-sign-fp/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled();
        });

        it("forgets an enrollment the server no longer knows (404)", async () => {
            cancelSignEnrollment.mockRejectedValue(new ApiRequestError("not found", 404));
            mockShell();
            const user = await renderPending();

            await user.click(screen.getByRole("button", { name: "Cancel enrollment" }));

            await waitFor(() => expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled());
            expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        });

        it.each([
            [new ApiRequestError("only the owner can cancel", 403), "only the owner can cancel"],
            [new Error("network down"), "Could not cancel the signing certificate enrollment."],
        ])("shows why cancelling failed (%s)", async (error, message) => {
            cancelSignEnrollment.mockRejectedValue(error);
            mockShell();
            const user = await renderPending();

            await user.click(screen.getByRole("button", { name: "Cancel enrollment" }));

            expect(await screen.findByText(message)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeDisabled();
            expect(screen.getByRole("button", { name: "Cancel enrollment" })).toBeEnabled();
        });
    });

    describe("round 6: a session master key that no longer opens the vault", () => {
        /** The session holds a master key from before a rotation on another device: it opens nothing in the vault.
         * Destroying the session keys really locks them, so the unlock prompt shows its dialog. */
        function staleSession() {
            let destroyed = false;
            getUnlockedKeys.mockImplementation(() => (destroyed ? undefined : { masterKey: new Uint8Array(32) }));
            destroyUnlockedKeys.mockImplementation(() => {
                destroyed = true;
            });
            openWithKey.mockImplementation(async () => {
                throw new DOMException("The operation failed", "OperationError");
            });
        }

        async function expectRelocked() {
            expect(await screen.findByText(/changed on another device \(for example, rotated\)/)).toBeInTheDocument();
            expect(destroyUnlockedKeys).toHaveBeenCalledWith("mb1");
            expect(await screen.findByText("Unlock your mailbox")).toBeInTheDocument();
            expect(addMasterKeyWrap).not.toHaveBeenCalled();
            expect(removeMasterKeyWrap).not.toHaveBeenCalled();
        }

        it("adds no password wrap, and asks to unlock again", async () => {
            staleSession();
            getKeyVault.mockResolvedValue(noPasswordVault);
            mockShell();
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByLabelText("New password");

            await user.type(screen.getByLabelText("New password"), "a good password");
            await user.type(screen.getByLabelText("Confirm new password"), "a good password");
            await user.click(screen.getByRole("button", { name: "Add password" }));

            await expectRelocked();
            expect(buildPasswordWrap).not.toHaveBeenCalled();
            // Dismissing that prompt just leaves the explanation up.
            await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
            await waitFor(() => expect(screen.queryByText("Unlock your mailbox")).not.toBeInTheDocument());
            expect(screen.getByText(/changed on another device/)).toBeInTheDocument();
        });

        it("keeps the existing recovery codes instead of replacing them with wraps of a dead key", async () => {
            staleSession();
            getKeyVault.mockResolvedValue(vault);
            mockShell();
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            await user.click(screen.getByRole("button", { name: "Regenerate recovery codes" }));

            await expectRelocked();
            expect(buildRecoveryWraps).not.toHaveBeenCalled();
        });

        it("seals no signing key and starts no enrollment", async () => {
            staleSession();
            getKeyVault.mockResolvedValue(vault);
            mockShell();
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            await user.click(screen.getByRole("button", { name: "Enable digital signatures" }));

            await expectRelocked();
            expect(generateKeyPairWithCsr).not.toHaveBeenCalled();
            expect(sealWithKey).not.toHaveBeenCalled();
            expect(startSignEnrollment).not.toHaveBeenCalled();
        });

        it("adds no escrow wrap", async () => {
            staleSession();
            getKeyVault.mockResolvedValue(vault);
            const scopedMailbox = { ...mailbox, escrowScopeId: "scope-1" };
            mockShell((url) => (url.startsWith("/api/mail/mailboxes") ? jsonResponse(200, [scopedMailbox]) : undefined));
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);

            await user.click(await screen.findByRole("button", { name: "Add escrow protection" }));

            await expectRelocked();
            expect(getEscrowInfo).not.toHaveBeenCalled();
            expect(buildEscrowWrap).not.toHaveBeenCalled();
        });

        it("doesn't rotate, and says why rather than naming every key as unopenable", async () => {
            staleSession();
            getKeyVault.mockResolvedValue(vault);
            mockShell();
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            await submitRotation(user);

            await expectRelocked();
            expect(screen.queryByText(/this session can't open/)).not.toBeInTheDocument();
            expect(generateMasterKey).not.toHaveBeenCalled();
            expect(rekey).not.toHaveBeenCalled();
        });

        it("tries each wrapped key until one opens", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue({ ...noPasswordVault, wrappedKeys: [{ ...vault.wrappedKeys[0], fingerprint: "fp-other" }, vault.wrappedKeys[0]] });
            openWithKey.mockImplementation(async (_key: Uint8Array, sealed: { fingerprint: string }) => {
                if (sealed.fingerprint === "fp-other") throw new DOMException("The operation failed", "OperationError");
                return new Uint8Array([1]);
            });
            buildPasswordWrap.mockResolvedValue({ method: "password", ciphertext: "c", nonce: "n", salt: "s", kdf: "k", schemeVersion: 1, createdAt: 0 });
            addMasterKeyWrap.mockResolvedValue(vault);
            mockShell();
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByLabelText("New password");

            await user.type(screen.getByLabelText("New password"), "a good password");
            await user.type(screen.getByLabelText("Confirm new password"), "a good password");
            await user.click(screen.getByRole("button", { name: "Add password" }));

            await waitFor(() => expect(addMasterKeyWrap).toHaveBeenCalled());
            expect(destroyUnlockedKeys).not.toHaveBeenCalled();
        });

        it("reports keys locked while checking the vault as locked, not as stale", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(noPasswordVault);
            openWithKey.mockRejectedValue(new KeysLockedError("locked"));
            mockShell();
            const user = userEvent.setup();
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByLabelText("New password");

            await user.type(screen.getByLabelText("New password"), "a good password");
            await user.type(screen.getByLabelText("Confirm new password"), "a good password");
            await user.click(screen.getByRole("button", { name: "Add password" }));

            expect(await screen.findByText(/were locked before this could finish/)).toBeInTheDocument();
            expect(destroyUnlockedKeys).not.toHaveBeenCalled();
            expect(buildPasswordWrap).not.toHaveBeenCalled();
        });
    });

    describe("the digital signature certificate card", () => {
        const STORAGE_KEY = "rapidmx.signEnrollment.mb1";
        const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
        const signKey = (notAfter: number, extra: Record<string, unknown> = {}) => ({
            ...mailbox.keys[0],
            useType: "sign" as const,
            fingerprint: "sign-fp-" + notAfter,
            notAfter,
            ...extra,
        });
        const withKeys = (...keys: unknown[]) => ({ ...mailbox, keys: [...mailbox.keys, ...keys] });

        function mockSigningCrypto() {
            generateKeyPairWithCsr.mockResolvedValue({ keyPair: { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey }, csrPem: "csr-pem" });
            exportPrivateKeyPkcs8.mockResolvedValue(new Uint8Array([1]));
            buildAad.mockReturnValue(new Uint8Array([9]));
            sealWithKey.mockResolvedValue({ ciphertext: "ct", nonce: "n" });
        }

        async function renderPage(mb: Record<string, unknown> = mailbox) {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            mockShell(mailboxRoutes(mb));
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");
        }

        it("shows a progress bar, the steps and a plain status line for a pending certificate, with when it was requested and checked", async () => {
            localStorage.setItem(STORAGE_KEY, "enr-1");
            checkSignEnrollmentStatus.mockResolvedValue({
                status: "pending",
                stage: "awaiting-challenge",
                progress: 35,
                requestedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
                lastCheckedAt: new Date(Date.now() - 20_000).toISOString(),
                stages: [
                    { id: "submitted", label: "Request sent", state: "done", at: new Date(Date.now() - 3 * 60_000).toISOString() },
                    { id: "awaiting-challenge", label: "Verification e-mail from the CA", state: "active" },
                    { id: "issued", label: "Certificate installed", state: "pending" },
                ],
            });
            await renderPage();

            expect(await screen.findByRole("progressbar", { name: "Certificate progress" })).toHaveAttribute("aria-valuenow", "35");
            expect(screen.getByText("Waiting for the CA's verification e-mail", { selector: "p" })).toBeInTheDocument();
            expect(within(screen.getByRole("list", { name: "Certificate steps" })).getAllByRole("listitem")).toHaveLength(3);
            expect(screen.getByText(/^Requested 3 min ago - last checked /)).toBeInTheDocument();
            // Rotation stays blocked while it is pending.
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeDisabled();
        });

        it("'Check status' asks the server to re-check, shows it busy, updates at once and says what came of it", async () => {
            localStorage.setItem(STORAGE_KEY, "enr-1");
            checkSignEnrollmentStatus.mockResolvedValue({ status: "pending", stage: "awaiting-challenge", progress: 30 });
            let answer: (value: unknown) => void = () => undefined;
            checkSignEnrollmentNow.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
            await renderPage();
            const user = userEvent.setup();

            await user.click(await screen.findByRole("button", { name: "Check status" }));
            expect(checkSignEnrollmentNow).toHaveBeenCalledWith("mb1", "enr-1");
            expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();

            await act(async () => answer({ status: "pending", stage: "challenge-answered", progress: 60 }));
            expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");
            expect(screen.getByText(/^Updated - Verification answered - waiting for the certificate/)).toBeInTheDocument();
            // Not again straight away: the server would answer 429.
            expect(screen.getByRole("button", { name: /^Check again in \d+ s$/ })).toBeDisabled();
        });

        it("reports 'Still waiting' when the check finds nothing new", async () => {
            localStorage.setItem(STORAGE_KEY, "enr-1");
            checkSignEnrollmentStatus.mockResolvedValue({ status: "pending", stage: "awaiting-challenge", progress: 30 });
            checkSignEnrollmentNow.mockResolvedValueOnce({ status: "pending", stage: "awaiting-challenge", progress: 30 });
            await renderPage();
            const user = userEvent.setup();
            await user.click(await screen.findByRole("button", { name: "Check status" }));
            expect(await screen.findByText(/^Still waiting - checked just now/)).toBeInTheDocument();
        });

        it("shows an issued certificate's details, copyable serial number and expiry, and refreshes the keys so the new key is listed", async () => {
            localStorage.setItem(STORAGE_KEY, "enr-1");
            checkSignEnrollmentStatus.mockResolvedValue({
                status: "issued",
                subject: "E=jane@example.com",
                issuer: "CN=Example CA",
                serialNumber: "0A1B2C3D4E5F60718293A4B5C6D7E8F9",
                notAfter: inDays(300),
            });
            const issued = withKeys(signKey(Date.now() + 300 * 86_400_000));
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            mockShell((url) => (url === "/api/mail/mailboxes/mb1" ? jsonResponse(200, issued) : undefined));
            render(<SettingsEncryptionPage userUid="u1" />);

            expect(await screen.findByText("E=jane@example.com")).toBeInTheDocument();
            expect(screen.getByText("CN=Example CA")).toBeInTheDocument();
            expect(screen.getByText("0A1B2C3D...C6D7E8F9")).toBeInTheDocument();
            expect(await screen.findByText(/Signing key: sign-fp-/)).toBeInTheDocument();
            expect(screen.getByText(/Enabled — outgoing mail/)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled();
            expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        });

        it("shows the active certificate with its expiry when nothing is being enrolled, warns inside 30 days and Renew starts a new request", async () => {
            mockSigningCrypto();
            startSignEnrollment.mockResolvedValue({ enrollmentId: "enr-2" });
            await renderPage(withKeys(signKey(Date.now() + 9 * 86_400_000)));
            const user = userEvent.setup();

            expect(await screen.findByRole("alert")).toHaveTextContent("This certificate expires in 9 days.");
            await user.click(screen.getByRole("button", { name: "Renew" }));

            expect(startSignEnrollment).toHaveBeenCalledTimes(1);
            // The renewal is pending at once (the server has just accepted it): the card is the pending one, and the old certificate's expiry warning is gone.
            expect(await screen.findByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
            expect(screen.queryByRole("alert")).not.toBeInTheDocument();
            expect(localStorage.getItem(STORAGE_KEY)).toBe("enr-2");
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeDisabled();
        });

        it("shows an expired certificate as expired and offers a new one", async () => {
            await renderPage(withKeys(signKey(Date.now() - 86_400_000)));
            expect(await screen.findByText("Expired", { selector: "span" })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Request a new certificate" })).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Enable digital signatures" })).not.toBeInTheDocument();
        });

        it("says when the newest of several expired certificates expired, and keeps the original flow when the server cannot say what the current enrollment is", async () => {
            getCurrentSignEnrollment.mockRejectedValue(new Error("network"));
            await renderPage(withKeys(signKey(Date.now() - 40 * 86_400_000), signKey(Date.now() - 2 * 86_400_000)));
            expect(await screen.findByText(/^Expired on /)).toBeInTheDocument();
            expect(getCurrentSignEnrollment).toHaveBeenCalled();
        });

        it("still offers Enable digital signatures when looking up the current enrollment fails", async () => {
            getCurrentSignEnrollment.mockRejectedValue(new Error("network"));
            await renderPage();
            expect(await screen.findByRole("button", { name: "Enable digital signatures" })).toBeEnabled();
        });

        it("shows a certificate that is issued but not installed yet as installing - never the Enable button - and asks for the mailbox's keys every 15 s until the key is there", async () => {
            const issuedAt = new Date(Date.now() - 60_000).toISOString();
            getCurrentSignEnrollment.mockResolvedValue({ enrollmentId: "done", status: "issued", issuedAt, notAfter: inDays(300), subject: "E=jane@example.com", note: "A background job installs it." });
            let installed = false;
            let mailboxReads = 0;
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            mockShell((url) => {
                if (url !== "/api/mail/mailboxes/mb1") return undefined;
                mailboxReads++;
                return jsonResponse(200, installed ? withKeys(signKey(Date.now() + 300 * 86_400_000)) : mailbox);
            });
            vi.useFakeTimers({ shouldAdvanceTime: true });
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");

            expect(await screen.findByText("Issued - installing it on your mailbox (this takes a few minutes)")).toBeInTheDocument();
            expect(screen.getByText("A background job installs it.")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Enable digital signatures" })).not.toBeInTheDocument();
            const readsBefore = mailboxReads;

            installed = true;
            await act(() => vi.advanceTimersByTimeAsync(15_000));
            expect(await screen.findByText(/Signing key: sign-fp-/)).toBeInTheDocument();
            expect(mailboxReads).toBeGreaterThan(readsBefore);
            // It stops asking once the key is there.
            const readsAfter = mailboxReads;
            await act(() => vi.advanceTimersByTimeAsync(60_000));
            expect(mailboxReads).toBe(readsAfter);
        });

        it("gives up asking for the keys of a certificate that stays uninstalled after ten minutes", async () => {
            getCurrentSignEnrollment.mockResolvedValue({ enrollmentId: "done", status: "issued", issuedAt: new Date().toISOString(), notAfter: inDays(300) });
            let mailboxReads = 0;
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            mockShell((url) => {
                if (url === "/api/mail/mailboxes/mb1") {
                    mailboxReads++;
                    return jsonResponse(200, mailbox);
                }
                return undefined;
            });
            vi.useFakeTimers({ shouldAdvanceTime: true });
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");
            await screen.findByText(/installing it on your mailbox/);

            await act(() => vi.advanceTimersByTimeAsync(11 * 60_000));
            const reads = mailboxReads;
            await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
            expect(mailboxReads).toBe(reads);
            expect(reads).toBeGreaterThan(30);
        });

        it("clears an enrollment id the server does not know any more, says the request is no longer active, and offers a new one - never spinning", async () => {
            localStorage.setItem(STORAGE_KEY, "left-over");
            checkSignEnrollmentStatus.mockRejectedValue(new ApiRequestError("Unknown.", 404, "signing-enrollment-unknown"));
            await renderPage();

            expect(await screen.findByText("This request is no longer active - request a new certificate.")).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Enable digital signatures" })).toBeEnabled();
            expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
            expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeEnabled();
            expect(checkSignEnrollmentStatus).toHaveBeenCalledTimes(1);
        });

        describe("what the deployment says about how certificates are issued", () => {
            const answers = (info: unknown) => (url: string) => (url === "/api/system/signing-enrollment" ? (info ? jsonResponse(200, info) : jsonResponse(404, { message: "no" })) : undefined);

            async function renderWith(info: unknown, mb: Record<string, unknown> = mailbox) {
                getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
                getKeyVault.mockResolvedValue(vault);
                const routes = mailboxRoutes(mb);
                mockShell((url, init) => answers(info)(url) ?? routes(url));
                render(<SettingsEncryptionPage userUid="u1" />);
                await screen.findByText("Password");
            }

            it("tells a manual deployment's user, before they ask, that an administrator has to upload the certificate", async () => {
                await renderWith({ backend: "manual", automatic: false, adminUpload: true });
                expect(await screen.findByText(/^This server issues signing certificates manually: an administrator has to upload/)).toBeInTheDocument();
                expect(screen.getByRole("button", { name: "Enable digital signatures" })).toBeEnabled();
            });

            it("tells an automatic deployment's user which CA it will ask and where its e-mail goes", async () => {
                await renderWith({ backend: "rfc8823", automatic: true, adminUpload: false, ca: { host: "acme.ca.example" }, typicalDurationMinutes: 5 });
                expect(
                    await screen.findByText("A certificate is issued automatically by acme.ca.example: it sends a verification e-mail to u1@example.com, usually within about 5 minutes."),
                ).toBeInTheDocument();
            });

            it("offers no request where the server issues no certificates, and warns when the CA has been reporting a problem", async () => {
                await renderWith({ backend: "none", automatic: false, adminUpload: false, health: { ok: false, lastError: "Down", lastSuccessAt: "2026-09-21T09:00:00Z" } });
                expect(await screen.findByText("This server does not issue signing certificates.")).toBeInTheDocument();
                expect(screen.queryByRole("button", { name: "Enable digital signatures" })).not.toBeInTheDocument();
                expect(screen.getByText(/^The certificate authority reported a problem: Down/)).toBeInTheDocument();
            });

            it("words a pending request by the deployment: a manual one waits for an administrator, an automatic one names its CA", async () => {
                localStorage.setItem(STORAGE_KEY, "enr-1");
                checkSignEnrollmentStatus.mockResolvedValue({ status: "pending", provider: "manual", requestedAt: new Date(Date.now() - 60_000).toISOString() });
                await renderWith({ backend: "manual", automatic: false, adminUpload: true, contactEmail: "admin@example.com" });
                expect(await screen.findByText(/^This server issues signing certificates manually.*Contact your administrator\.$/)).toBeInTheDocument();
                expect(screen.getByText("Administrator: admin@example.com")).toBeInTheDocument();
                expect(screen.queryByText(/takes effect automatically/)).not.toBeInTheDocument();
                cleanup();
                resetEnrollmentTracker();

                localStorage.setItem(STORAGE_KEY, "enr-1");
                checkSignEnrollmentStatus.mockResolvedValue({ status: "pending", provider: "rfc8823", stage: "awaiting-challenge", progress: 30 });
                await renderWith({ backend: "rfc8823", automatic: true, adminUpload: false, ca: { host: "acme.ca.example" }, typicalDurationMinutes: 5 });
                expect(await screen.findByText("Requested from acme.ca.example. The CA sends a verification e-mail to u1@example.com; this usually takes about 5 minutes.")).toBeInTheDocument();
            });
        });

        it("keeps the original 'Enable digital signatures' flow for a mailbox that never asked for one", async () => {
            await renderPage();
            expect(await screen.findByRole("button", { name: "Enable digital signatures" })).toBeEnabled();
            expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
        });

        it("shows a failed enrollment (found on the server) with its reason and Try again, which starts a new request", async () => {
            getCurrentSignEnrollment.mockResolvedValue({ enrollmentId: "old", status: "failed", error: "The CA refused.", stage: "failed" });
            mockSigningCrypto();
            startSignEnrollment.mockResolvedValue({ enrollmentId: "enr-3" });
            checkSignEnrollmentStatus.mockResolvedValue({ status: "pending" });
            await renderPage();
            const user = userEvent.setup();

            expect(await screen.findByText("Failed: The CA refused.")).toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Try again" }));

            expect(await screen.findByText(/^Requested - waiting for the certificate/)).toBeInTheDocument();
            expect(screen.queryByText("Failed: The CA refused.")).not.toBeInTheDocument();
        });

        it("shows why a new request could not be started, above the failed card", async () => {
            getCurrentSignEnrollment.mockResolvedValue({ enrollmentId: "old", status: "failed", error: "The CA refused." });
            mockSigningCrypto();
            startSignEnrollment.mockRejectedValue(new ApiRequestError("Too many requests.", 429));
            await renderPage();
            const user = userEvent.setup();

            await user.click(await screen.findByRole("button", { name: "Try again" }));

            expect(await screen.findByText("Too many requests.")).toBeInTheDocument();
            expect(screen.getByText("Failed: The CA refused.")).toBeInTheDocument();
        });

        it("adopts a pending enrollment started on another device: progress, Check status and blocked rotation", async () => {
            getCurrentSignEnrollment.mockResolvedValue({ enrollmentId: "elsewhere", status: "pending", stage: "validating", progress: 70 });
            checkSignEnrollmentNow.mockResolvedValue({ status: "issued" });
            await renderPage();

            expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "70");
            expect(localStorage.getItem(STORAGE_KEY)).toBe("elsewhere");
            expect(screen.getByRole("button", { name: "Rotate keys now" })).toBeDisabled();
        });

        it("shows a certificate issued long ago from the server's record when the mailbox's keys carry it", async () => {
            getCurrentSignEnrollment.mockResolvedValue({ enrollmentId: "done", status: "issued", subject: "E=old@example.com", notAfter: inDays(200) });
            await renderPage(withKeys(signKey(Date.now() + 200 * 86_400_000)));
            expect(await screen.findByText("E=old@example.com")).toBeInTheDocument();

        });

        it("shows a pending enrollment of a mailbox the user does not own without a way to check it", async () => {
            localStorage.setItem(STORAGE_KEY, "enr-1");
            checkSignEnrollmentStatus.mockResolvedValue({ status: "pending", progress: 20, stage: "submitted" });
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            mockShell(mailboxRoutes({ ...mailbox, ownerUserUid: "someone-else" }));
            render(<SettingsEncryptionPage userUid="u1" />);
            expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "20");
            expect(screen.queryByRole("button", { name: "Check status" })).not.toBeInTheDocument();
        });

        it("offers a mailbox that is not the user's own no way to check or request, only what is known", async () => {
            getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
            getKeyVault.mockResolvedValue(vault);
            mockShell(mailboxRoutes({ ...withKeys(signKey(Date.now() + 5 * 86_400_000)), ownerUserUid: "someone-else" }));
            render(<SettingsEncryptionPage userUid="u1" />);
            await screen.findByText("Password");
            expect(await screen.findByText(/Enabled — outgoing mail/)).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Renew" })).not.toBeInTheDocument();
            expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
            expect(getCurrentSignEnrollment).not.toHaveBeenCalled();
        });
    });
});
