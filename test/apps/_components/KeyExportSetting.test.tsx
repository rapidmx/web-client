// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KeyExportSetting from "../../../apps/shared/components/settings/KeyExportSetting.js";
import type { Mailbox } from "../../../lib/mail/mailApi.js";
import { ApiRequestError } from "../../../lib/util/api.js";

const { notifyApiError, exportKeysAsPkcs12 } = vi.hoisted(() => ({ notifyApiError: vi.fn(), exportKeysAsPkcs12: vi.fn() }));
vi.mock("../../../apps/shared/notifications/apiErrors.js", () => ({ notifyApiError }));
vi.mock("../../../lib/crypto/keyExport.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keyExport.js")>()),
    exportKeysAsPkcs12,
}));

const KEYS = [{ publicKey: "x", type: "x509", useType: "encrypt", fingerprint: "fp", notBefore: 1, notAfter: 2 }];
const MAILBOX = { uid: "mb1", version: 4, ownerUserUid: "u1", primarySmtpAddress: "alice@example.com", displayName: "Alice", keys: KEYS } as unknown as Mailbox;
const PASSPHRASE = "a long file passphrase";

async function fillForm(user: ReturnType<typeof userEvent.setup>, { password = "pw", passphrase = PASSPHRASE, confirm = PASSPHRASE } = {}) {
    await user.click(screen.getByRole("button", { name: /Export keys/ }));
    await user.type(screen.getByLabelText("Encryption password"), password);
    await user.type(screen.getByLabelText("File passphrase"), passphrase);
    await user.type(screen.getByLabelText("Confirm file passphrase"), confirm);
}

const createObjectURL = vi.fn(() => "blob:p12");
const revokeObjectURL = vi.fn();

beforeEach(() => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("KeyExportSetting", () => {
    it("tells a non-owner only the owner can export, with no way to start one", () => {
        render(<KeyExportSetting mailbox={MAILBOX} canManage={false} />);
        expect(screen.getByText(/Only this mailbox.s owner/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Export keys/ })).toBeNull();
    });

    it("exports with the master password and passphrase, downloads the file and closes the form", async () => {
        const user = userEvent.setup();
        exportKeysAsPkcs12.mockResolvedValue({ pkcs12: new Uint8Array([1, 2]), keys: [] });
        const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
        render(<KeyExportSetting mailbox={MAILBOX} canManage />);

        await fillForm(user);
        await user.click(screen.getByRole("checkbox", { name: /Include my signing key/ }));
        await user.click(screen.getByRole("button", { name: "Export" }));

        await waitFor(() => expect(click).toHaveBeenCalled());
        expect(exportKeysAsPkcs12).toHaveBeenCalledWith(
            {
                mailboxUid: "mb1",
                mailboxAddress: "alice@example.com",
                mailboxKeys: KEYS,
                masterPassword: "pw",
                exportPassphrase: PASSPHRASE,
                includeSigningKey: true,
            },
            undefined,
        );
        expect(createObjectURL).toHaveBeenCalled();
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:p12");
        expect(screen.getByRole("button", { name: /Export keys/ })).toBeTruthy();
        click.mockRestore();
    });

    it("passes no keys for a mailbox without any, and leaves the signing key out by default", async () => {
        const user = userEvent.setup();
        exportKeysAsPkcs12.mockResolvedValue({ pkcs12: new Uint8Array([1]), keys: [] });
        const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
        render(<KeyExportSetting mailbox={{ ...MAILBOX, keys: undefined }} canManage />);

        await fillForm(user);
        await user.click(screen.getByRole("button", { name: "Export" }));

        await waitFor(() => expect(exportKeysAsPkcs12).toHaveBeenCalledWith(expect.objectContaining({ mailboxKeys: [], includeSigningKey: false }), undefined));
        click.mockRestore();
    });

    it("checks the passphrase's length and confirmation before exporting", async () => {
        const user = userEvent.setup();
        render(<KeyExportSetting mailbox={MAILBOX} canManage />);

        await fillForm(user, { passphrase: "short", confirm: "short" });
        await user.click(screen.getByRole("button", { name: "Export" }));
        expect(screen.getByText(/at least 12 characters\./)).toBeTruthy();

        await user.type(screen.getByLabelText("File passphrase"), " but longer now");
        await user.click(screen.getByRole("button", { name: "Export" }));
        expect(screen.getByText("The passphrases don't match.")).toBeTruthy();
        expect(exportKeysAsPkcs12).not.toHaveBeenCalled();
    });

    it.each([
        ["a wrong password", new Error("OperationError"), "Incorrect password."],
        ["nothing to export", new (class extends Error {})("unused"), "Incorrect password."],
        ["no password unlock method", new Error("This mailbox has no password unlock method enrolled."), "This mailbox has no password unlock method enrolled."],
    ])("shows %s inline", async (_label, error, message) => {
        const user = userEvent.setup();
        exportKeysAsPkcs12.mockRejectedValue(error);
        render(<KeyExportSetting mailbox={MAILBOX} canManage />);

        await fillForm(user);
        await user.click(screen.getByRole("button", { name: "Export" }));

        expect(await screen.findByText(message)).toBeTruthy();
    });

    it("explains when there are no keys to export", async () => {
        const user = userEvent.setup();
        const { NothingToExportError } = await import("../../../lib/crypto/keyExport.js");
        exportKeysAsPkcs12.mockRejectedValue(new NothingToExportError());
        render(<KeyExportSetting mailbox={MAILBOX} canManage />);

        await fillForm(user);
        await user.click(screen.getByRole("button", { name: "Export" }));

        expect(await screen.findByText("This mailbox has no keys to export yet.")).toBeTruthy();
    });

    it("reports a server refusal as an API error, and Cancel closes the form", async () => {
        const user = userEvent.setup();
        const error = new ApiRequestError("Forbidden", 403);
        exportKeysAsPkcs12.mockRejectedValue(error);
        render(<KeyExportSetting mailbox={MAILBOX} canManage />);

        await fillForm(user);
        await user.click(screen.getByRole("button", { name: "Export" }));
        await waitFor(() => expect(notifyApiError).toHaveBeenCalledWith(error, "Couldn't export your keys"));

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByLabelText("Encryption password")).toBeNull();
    });
});
