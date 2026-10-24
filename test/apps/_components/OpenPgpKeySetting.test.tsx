// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OpenPgpKeySetting from "../../../apps/shared/components/settings/OpenPgpKeySetting.js";
import type { Mailbox } from "../../../lib/mail/mailApi.js";
import { ApiRequestError } from "../../../lib/util/api.js";

const { notifyApiError, exportOpenPgpSecretKey, readPublicKey, armorPublicKey } = vi.hoisted(() => ({
    notifyApiError: vi.fn(),
    exportOpenPgpSecretKey: vi.fn(),
    readPublicKey: vi.fn(),
    armorPublicKey: vi.fn(),
}));
vi.mock("../../../apps/shared/notifications/apiErrors.js", () => ({ notifyApiError }));
vi.mock("../../../lib/crypto/openPgpKey.js", () => ({ exportOpenPgpSecretKey }));
vi.mock("../../../lib/crypto/openpgp.js", () => ({ readPublicKey, armorPublicKey }));

const FINGERPRINT = "0123456789abcdef".repeat(4);
const OPENPGP_KEY = { publicKey: "cGdw", type: "openpgp", useType: "encrypt", fingerprint: FINGERPRINT, notBefore: 1, notAfter: 8.64e15 };
const SMIME_KEY = { publicKey: "eDUwOQ==", type: "x509", useType: "encrypt", fingerprint: "smime", notBefore: 1, notAfter: 8.64e15 };
const mailbox = (keys: unknown[]) =>
    ({ uid: "mb1", version: 4, ownerUserUid: "u1", primarySmtpAddress: "alice@example.com", displayName: "Alice", keys }) as unknown as Mailbox;
const MAILBOX = mailbox([SMIME_KEY, OPENPGP_KEY]);
const PASSPHRASE = "a long key passphrase";

async function fillForm(user: ReturnType<typeof userEvent.setup>, { password = "pw", passphrase = PASSPHRASE, confirm = PASSPHRASE } = {}) {
    await user.click(screen.getByRole("button", { name: /Export secret key/ }));
    await user.type(screen.getByLabelText("Encryption password"), password);
    await user.type(screen.getByLabelText("Key passphrase"), passphrase);
    await user.type(screen.getByLabelText("Confirm key passphrase"), confirm);
}

const createObjectURL = vi.fn(() => "blob:key");
const revokeObjectURL = vi.fn();
let click: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    click.mockRestore();
});

describe("OpenPgpKeySetting", () => {
    it("shows nothing while the mailbox has no OpenPGP key", () => {
        const { container } = render(<OpenPgpKeySetting mailbox={mailbox([SMIME_KEY])} canManage />);
        expect(container.innerHTML).toBe("");
        expect(render(<OpenPgpKeySetting mailbox={mailbox(undefined as unknown as unknown[])} canManage />).container.innerHTML).toBe("");
    });

    it("shows the fingerprint in groups of four and tells a non-owner only the owner can export", () => {
        render(<OpenPgpKeySetting mailbox={MAILBOX} canManage={false} />);
        expect(screen.getByText("0123 4567 89AB CDEF 0123 4567 89AB CDEF 0123 4567 89AB CDEF 0123 4567 89AB CDEF")).toBeTruthy();
        expect(screen.getByText(/Only this mailbox.s owner/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Export secret key/ })).toBeNull();
    });

    it("downloads the armored public key", async () => {
        const user = userEvent.setup();
        const certificate = { certificate: true };
        readPublicKey.mockResolvedValue(certificate);
        armorPublicKey.mockReturnValue("-----BEGIN PGP PUBLIC KEY BLOCK-----");
        render(<OpenPgpKeySetting mailbox={MAILBOX} canManage />);

        await user.click(screen.getByRole("button", { name: "Download public key" }));

        await waitFor(() => expect(click).toHaveBeenCalled());
        expect(readPublicKey).toHaveBeenCalledWith("cGdw");
        expect(armorPublicKey).toHaveBeenCalledWith(certificate);
        expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe("alice@example.com-openpgp-public.asc");
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:key");
    });

    it("downloads nothing when the stored certificate can't be read", async () => {
        const user = userEvent.setup();
        readPublicKey.mockResolvedValue(undefined);
        render(<OpenPgpKeySetting mailbox={MAILBOX} canManage />);
        await user.click(screen.getByRole("button", { name: "Download public key" }));
        await waitFor(() => expect(readPublicKey).toHaveBeenCalled());
        expect(click).not.toHaveBeenCalled();
    });

    it("exports the secret key with the master password and passphrase, downloads it and closes the form", async () => {
        const user = userEvent.setup();
        exportOpenPgpSecretKey.mockResolvedValue({ armored: "-----BEGIN PGP PRIVATE KEY BLOCK-----", fingerprint: FINGERPRINT });
        render(<OpenPgpKeySetting mailbox={MAILBOX} canManage />);

        await fillForm(user);
        await user.click(screen.getByRole("button", { name: "Export" }));

        await waitFor(() => expect(click).toHaveBeenCalled());
        expect(exportOpenPgpSecretKey.mock.calls[0].slice(0, 3)).toEqual(["mb1", "pw", PASSPHRASE]);
        expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe("alice@example.com-openpgp-secret.asc");
        expect(screen.queryByLabelText("Encryption password")).toBeNull();
        expect(screen.getByRole("button", { name: /Export secret key/ })).toBeTruthy();
    });

    it("refuses a short or mismatched passphrase without exporting", async () => {
        const user = userEvent.setup();
        render(<OpenPgpKeySetting mailbox={MAILBOX} canManage />);

        await fillForm(user, { passphrase: "short", confirm: "short" });
        await user.click(screen.getByRole("button", { name: "Export" }));
        expect(screen.getByText(/must be at least/)).toBeTruthy();

        await user.type(screen.getByLabelText("Key passphrase"), " and then some more");
        await user.click(screen.getByRole("button", { name: "Export" }));
        expect(screen.getByText("The passphrases don't match.")).toBeTruthy();
        expect(exportOpenPgpSecretKey).not.toHaveBeenCalled();
    });

    it("says the password is wrong when the vault won't open, and reports server errors", async () => {
        const user = userEvent.setup();
        exportOpenPgpSecretKey.mockRejectedValueOnce(new Error("decrypt failed")).mockRejectedValueOnce(new ApiRequestError("Service unavailable", 503));
        render(<OpenPgpKeySetting mailbox={MAILBOX} canManage />);

        await fillForm(user);
        await user.click(screen.getByRole("button", { name: "Export" }));
        expect(await screen.findByText("Incorrect password.")).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "Export" }));
        await waitFor(() => expect(notifyApiError).toHaveBeenCalledWith(expect.any(ApiRequestError), "Couldn't export your OpenPGP key"));
        expect(click).not.toHaveBeenCalled();
    });

    it("cancels and clears the form", async () => {
        const user = userEvent.setup();
        render(<OpenPgpKeySetting mailbox={MAILBOX} canManage />);
        await fillForm(user);
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await user.click(screen.getByRole("button", { name: /Export secret key/ }));
        expect(screen.getByLabelText<HTMLInputElement>("Encryption password").value).toBe("");
    });
});
