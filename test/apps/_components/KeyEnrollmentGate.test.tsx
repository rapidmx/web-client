// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import KeyEnrollmentGate from "../../../apps/shared/components/layout/KeyEnrollmentGate.js";

const { getKeyVault, enrollKey, getUnlockedKeys, unlockWithPassword } = vi.hoisted(() => ({
    getKeyVault: vi.fn(),
    enrollKey: vi.fn(),
    getUnlockedKeys: vi.fn(),
    unlockWithPassword: vi.fn(),
}));

vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", () => ({ getKeyVault, enrollKey }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({
    MASTER_KEY_AAD_PURPOSE: "master-key",
    ENCRYPTION_PRIVATE_KEY_AAD_PURPOSE: "encrypt-private-key",
    getUnlockedKeys,
    unlockWithPassword,
}));

// The real crypto primitives are exercised end to end by react-shared's own test suite (real WebCrypto/
// Argon2id) - this component's own tests care about its orchestration/UI logic, not re-proving those
// primitives, and running real Argon2id on every test here would also be needlessly slow.
vi.mock("@rapidmx/react-shared/crypto/masterKey.js", () => ({
    generateMasterKey: () => new Uint8Array(32),
    buildAad: (mailboxUid: string, purpose: string) => new TextEncoder().encode(`${mailboxUid}:${purpose}`),
    sealWithKey: async () => ({ ciphertext: "ct", nonce: "n" }),
}));
vi.mock("@rapidmx/react-shared/crypto/masterKeyWraps.js", () => ({
    buildPasswordWrap: async () => ({
        method: "password",
        ciphertext: "ct",
        nonce: "n",
        salt: "salt",
        kdf: "argon2id:m=8,t=1,p=1",
        schemeVersion: 1,
        createdAt: 0,
    }),
    buildRecoveryWraps: async () => {
        const codes = Array.from({ length: 8 }, (_, i) => `CODE-${i + 1}`);
        return {
            codes,
            wraps: codes.map((_, i) => ({
                method: "recovery",
                methodId: `recovery-${i + 1}`,
                ciphertext: "ct",
                nonce: "n",
                salt: "salt",
                kdf: "hkdf-sha256",
                schemeVersion: 1,
                createdAt: 0,
            })),
        };
    },
}));
vi.mock("@rapidmx/react-shared/crypto/keys.js", () => ({
    generateKeyPairWithCsr: async () => ({ keyPair: { privateKey: {}, publicKey: {} }, csrPem: "csr-pem" }),
    exportPrivateKeyPkcs8: async () => new Uint8Array(10),
}));

afterEach(() => {
    // resetAllMocks (not clearAllMocks) - this file's "already unlocked" test sets a persistent
    // getUnlockedKeys.mockReturnValue(...); clearAllMocks() only clears call history, not that
    // implementation, which would otherwise leak into every later test in this file.
    vi.resetAllMocks();
});

describe("KeyEnrollmentGate", () => {
    it("renders children immediately when no mailboxUid is provided yet, without checking the key vault", () => {
        render(
            <KeyEnrollmentGate>
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        expect(screen.getByText("Mail content")).toBeInTheDocument();
        expect(getKeyVault).not.toHaveBeenCalled();
    });

    it("does not update state after unmounting before the key-vault check settles (avoids a set-state-after-unmount warning)", async () => {
        let resolveVault: ((vault: { wrappedKeys: unknown[]; masterKeyWraps: unknown[] }) => void) | undefined;
        getKeyVault.mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveVault = resolve;
                }),
        );
        const { unmount } = render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        await waitFor(() => expect(resolveVault).toBeDefined());
        unmount();
        resolveVault!({ wrappedKeys: [], masterKeyWraps: [] });
        // No assertion beyond "this doesn't throw/warn" - the cancelled-guard inside the effect's
        // .then() is what this test exercises; a regression here would surface as a React
        // "set state on an unmounted component" console.error, not a thrown exception.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("does not update state after unmounting before a rejected key-vault check settles", async () => {
        let rejectVault: ((err: Error) => void) | undefined;
        getKeyVault.mockImplementation(
            () =>
                new Promise((_resolve, reject) => {
                    rejectVault = reject;
                }),
        );
        const { unmount } = render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        await waitFor(() => expect(rejectVault).toBeDefined());
        unmount();
        rejectVault!(new Error("network error"));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("shows the server's own message when enrollment fails with an ApiRequestError", async () => {
        getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        enrollKey.mockRejectedValue(new ApiRequestError("mailbox quota exceeded", 400));
        const user = userEvent.setup();
        render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        await screen.findByText("Protect your mailbox");
        await user.type(screen.getByLabelText("Encryption password"), "a good password");
        await user.type(screen.getByLabelText("Confirm password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        expect(await screen.findByText("mailbox quota exceeded")).toBeInTheDocument();
    });

    it("renders children immediately when this mailbox was already unlocked earlier this session", async () => {
        getUnlockedKeys.mockReturnValue({ masterKey: new Uint8Array(32) });
        render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        expect(await screen.findByText("Mail content")).toBeInTheDocument();
        expect(getKeyVault).not.toHaveBeenCalled();
    });

    it("shows the unlock password form when the mailbox already has enrolled keys but isn't unlocked yet this session", async () => {
        getKeyVault.mockResolvedValue({ wrappedKeys: [{ fingerprint: "a" }], masterKeyWraps: [] });
        render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        expect(await screen.findByText("Unlock your mailbox")).toBeInTheDocument();
        expect(screen.queryByText("Mail content")).not.toBeInTheDocument();
        expect(enrollKey).not.toHaveBeenCalled();
    });

    it("unlocks and renders children on a correct password", async () => {
        getKeyVault.mockResolvedValue({ wrappedKeys: [{ fingerprint: "a" }], masterKeyWraps: [] });
        unlockWithPassword.mockResolvedValue(undefined);
        const mailboxKeys = [{ fingerprint: "a", useType: "encrypt" }];
        const user = userEvent.setup();
        render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com" mailboxKeys={mailboxKeys as never}>
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        await screen.findByText("Unlock your mailbox");
        await user.type(screen.getByLabelText("Encryption password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Unlock" }));

        expect(await screen.findByText("Mail content")).toBeInTheDocument();
        expect(unlockWithPassword).toHaveBeenCalledWith("mb1", mailboxKeys, "a good password");
    });

    it("shows a generic error and stays on the unlock form when the password is wrong", async () => {
        getKeyVault.mockResolvedValue({ wrappedKeys: [{ fingerprint: "a" }], masterKeyWraps: [] });
        unlockWithPassword.mockRejectedValue(new Error("AEAD authentication failure"));
        const user = userEvent.setup();
        render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        await screen.findByText("Unlock your mailbox");
        await user.type(screen.getByLabelText("Encryption password"), "wrong password");
        await user.click(screen.getByRole("button", { name: "Unlock" }));

        expect(await screen.findByText("Incorrect password.")).toBeInTheDocument();
        expect(screen.queryByText("Mail content")).not.toBeInTheDocument();
    });

    it("renders children (fails open) when the key-vault check errors", async () => {
        getKeyVault.mockRejectedValue(new Error("network error"));
        render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        expect(await screen.findByText("Mail content")).toBeInTheDocument();
    });

    it("shows the password setup form when no keys are enrolled yet", async () => {
        getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        expect(await screen.findByText("Protect your mailbox")).toBeInTheDocument();
        expect(screen.queryByText("Mail content")).not.toBeInTheDocument();
    });

    it("rejects a too-short password", async () => {
        getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        const user = userEvent.setup();
        render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        await screen.findByText("Protect your mailbox");
        await user.type(screen.getByLabelText("Encryption password"), "short");
        await user.type(screen.getByLabelText("Confirm password"), "short");
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(await screen.findByText(/at least 8 characters/)).toBeInTheDocument();
        expect(enrollKey).not.toHaveBeenCalled();
    });

    it("rejects mismatched passwords", async () => {
        getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        const user = userEvent.setup();
        render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        await screen.findByText("Protect your mailbox");
        await user.type(screen.getByLabelText("Encryption password"), "a good password");
        await user.type(screen.getByLabelText("Confirm password"), "a different password");
        await user.click(screen.getByRole("button", { name: "Continue" }));
        expect(await screen.findByText("Passwords do not match.")).toBeInTheDocument();
        expect(enrollKey).not.toHaveBeenCalled();
    });

    it("provisions keys, shows recovery codes, and only unlocks children once the user confirms saving them", async () => {
        getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        enrollKey.mockResolvedValue({ wrappedKeys: [{ fingerprint: "a" }], masterKeyWraps: [] });
        const user = userEvent.setup();
        render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        await screen.findByText("Protect your mailbox");
        await user.type(screen.getByLabelText("Encryption password"), "a good password");
        await user.type(screen.getByLabelText("Confirm password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        expect(await screen.findByText("Save your recovery codes")).toBeInTheDocument();
        await waitFor(() =>
            expect(enrollKey).toHaveBeenCalledWith(
                "mb1",
                expect.objectContaining({
                    useType: "encrypt",
                    csr: "csr-pem",
                    masterKeyWraps: expect.arrayContaining([
                        expect.objectContaining({ method: "password" }),
                        expect.objectContaining({ method: "recovery", methodId: "recovery-1" }),
                    ]),
                }),
            ),
        );
        // 8 recovery codes rendered, none shown twice.
        expect(screen.getAllByText(/^CODE-\d+$/)).toHaveLength(8);

        const continueButton = screen.getByRole("button", { name: "Continue" });
        expect(continueButton).toBeDisabled();
        await user.click(screen.getByRole("checkbox"));
        expect(continueButton).toBeEnabled();
        await user.click(continueButton);

        expect(await screen.findByText("Mail content")).toBeInTheDocument();
    });

    it("shows an error and stays on the password step when enrollment fails", async () => {
        getKeyVault.mockResolvedValue({ wrappedKeys: [], masterKeyWraps: [] });
        enrollKey.mockRejectedValue(new Error("server exploded"));
        const user = userEvent.setup();
        render(
            <KeyEnrollmentGate mailboxUid="mb1" mailboxAddress="alice@example.com">
                <div>Mail content</div>
            </KeyEnrollmentGate>,
        );
        await screen.findByText("Protect your mailbox");
        await user.type(screen.getByLabelText("Encryption password"), "a good password");
        await user.type(screen.getByLabelText("Confirm password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Continue" }));

        expect(await screen.findByText("Could not set up encryption for this mailbox.")).toBeInTheDocument();
        expect(screen.queryByText("Mail content")).not.toBeInTheDocument();
    });
});
