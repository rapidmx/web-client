// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The steps after a recovery-code unlock: an optional (or, for the last code, required) new password via
// replacePasswordWrap(), then consumeRecoveryCode(), then the remaining-code count.
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { KeysLockedError } from "@rapidmx/react-shared/crypto/masterKey.js";
import {
    CONSUME_FAILED_MESSAGE,
    RecoveryFollowUp,
    RecoveryFollowUpModal,
    REPLACE_ADD_FAILED_NOT_RESTORED_MESSAGE,
    REPLACE_ADD_FAILED_RESTORED_MESSAGE,
    REPLACE_GENERIC_MESSAGE,
    REPLACE_LOCKED_MESSAGE,
    REPLACE_MULTIPLE_PASSWORDS_MESSAGE,
    REPLACE_NO_OTHER_METHOD_MESSAGE,
    REPLACE_ROTATED_MESSAGE,
    startRecoveryUnlock,
} from "../../../apps/shared/components/layout/RecoveryCodeUnlock.js";

const { getUnlockedKeys, unlockWithRecoveryCode, getKeyVault, replacePasswordWrap, consumeRecoveryCode } = vi.hoisted(() => ({
    getUnlockedKeys: vi.fn(),
    unlockWithRecoveryCode: vi.fn(),
    getKeyVault: vi.fn(),
    replacePasswordWrap: vi.fn(),
    consumeRecoveryCode: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, unlockWithRecoveryCode }));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", () => ({ getKeyVault }));
vi.mock("@rapidmx/react-shared/crypto/masterKeyWraps.js", async (importOriginal) => ({
    PasswordWrapReplaceError: (await importOriginal<typeof import("@rapidmx/react-shared/crypto/masterKeyWraps.js")>()).PasswordWrapReplaceError,
    replacePasswordWrap,
    consumeRecoveryCode,
}));

const { PasswordWrapReplaceError } = await vi.importActual<typeof import("@rapidmx/react-shared/crypto/masterKeyWraps.js")>(
    "@rapidmx/react-shared/crypto/masterKeyWraps.js",
);

const keys = { masterKey: new Uint8Array(32) };

function followUp(overrides: Partial<RecoveryFollowUp> = {}): RecoveryFollowUp {
    return {
        mailboxUid: "mb1",
        recoveryMethodId: "recovery-3",
        remainingRecoveryCodes: 5,
        expectedMasterKeyGeneration: 7,
        unopenableKeys: [],
        ...overrides,
    };
}

function renderModal(overrides: Partial<RecoveryFollowUp> = {}, open?: boolean) {
    const onDone = vi.fn();
    const utils = render(<RecoveryFollowUpModal followUp={followUp(overrides)} open={open} onDone={onDone} />);
    return { onDone, ...utils };
}

async function setPassword(user: ReturnType<typeof userEvent.setup>, password = "new password 1", confirm = password) {
    await user.type(screen.getByLabelText("New encryption password"), password);
    await user.type(screen.getByLabelText("Confirm new password"), confirm);
    await user.click(screen.getByRole("button", { name: "Set password" }));
}

afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
});

describe("startRecoveryUnlock", () => {
    it("reads the vault generation before unlocking and returns the follow-up", async () => {
        getKeyVault.mockResolvedValue({ masterKeyGeneration: 4 });
        unlockWithRecoveryCode.mockResolvedValue({ unopenableKeys: ["fp"], recoveryMethodId: "recovery-2", remainingRecoveryCodes: 3 });

        await expect(startRecoveryUnlock("mb1", [], " abcd-efgh ")).resolves.toEqual({
            mailboxUid: "mb1",
            recoveryMethodId: "recovery-2",
            remainingRecoveryCodes: 3,
            expectedMasterKeyGeneration: 4,
            unopenableKeys: ["fp"],
        });
        expect(unlockWithRecoveryCode).toHaveBeenCalledWith("mb1", [], " abcd-efgh ");
        expect(getKeyVault.mock.invocationCallOrder[0]).toBeLessThan(unlockWithRecoveryCode.mock.invocationCallOrder[0]);
    });

    it("unlocks without a generation when the vault can't be read", async () => {
        getKeyVault.mockRejectedValue(new Error("offline"));
        unlockWithRecoveryCode.mockResolvedValue({ unopenableKeys: [], recoveryMethodId: "recovery-2", remainingRecoveryCodes: 3 });

        await expect(startRecoveryUnlock("mb1", [], "code")).resolves.toMatchObject({ expectedMasterKeyGeneration: undefined });
    });

    it("rejects as the unlock does", async () => {
        getKeyVault.mockResolvedValue({});
        unlockWithRecoveryCode.mockRejectedValue(new Error("wrong code"));

        await expect(startRecoveryUnlock("mb1", [], "code")).rejects.toThrow("wrong code");
    });
});

describe("RecoveryFollowUpModal", () => {
    describe("optional new password", () => {
        it("validates, replaces the password before using up the code, and reports what's left", async () => {
            getUnlockedKeys.mockReturnValue(keys);
            replacePasswordWrap.mockResolvedValue({});
            consumeRecoveryCode.mockResolvedValue({});
            const user = userEvent.setup();
            const { onDone } = renderModal();

            expect(screen.getByText(/If you.ve forgotten your encryption password, set a new one now/)).toBeInTheDocument();
            await setPassword(user, "short");
            expect(screen.getByText("Password must be at least 8 characters.")).toBeInTheDocument();
            await user.clear(screen.getByLabelText("New encryption password"));
            await user.clear(screen.getByLabelText("Confirm new password"));
            await setPassword(user, "new password 1", "different password");
            expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
            await user.clear(screen.getByLabelText("New encryption password"));
            await user.clear(screen.getByLabelText("Confirm new password"));
            await setPassword(user);

            expect(await screen.findByText("Your new encryption password is set.")).toBeInTheDocument();
            expect(replacePasswordWrap).toHaveBeenCalledWith("mb1", keys, "new password 1", 7);
            expect(consumeRecoveryCode).toHaveBeenCalledWith("mb1", "recovery-3");
            expect(replacePasswordWrap.mock.invocationCallOrder[0]).toBeLessThan(consumeRecoveryCode.mock.invocationCallOrder[0]);
            expect(screen.getByText(/has been used up and won.t work again/)).toBeInTheDocument();
            expect(screen.getByText("You have 5 recovery codes left.")).toBeInTheDocument();
            expect(screen.queryByRole("link", { name: /Settings/ })).not.toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Done" }));
            expect(onDone).toHaveBeenCalledTimes(1);
        });

        it("Skip uses up the code without touching the password, and nudges when 2 or fewer are left", async () => {
            consumeRecoveryCode.mockResolvedValue({});
            const user = userEvent.setup();
            renderModal({ remainingRecoveryCodes: 2 });

            await user.click(screen.getByRole("button", { name: "Skip" }));

            expect(await screen.findByText(/You have 2 recovery codes left\. Generate a new set in/)).toBeInTheDocument();
            expect(screen.getByRole("link", { name: "Settings > Encryption" })).toHaveAttribute("href", "/settings/encryption");
            expect(replacePasswordWrap).not.toHaveBeenCalled();
            expect(consumeRecoveryCode).toHaveBeenCalledWith("mb1", "recovery-3");
            expect(screen.queryByText("Your new encryption password is set.")).not.toBeInTheDocument();
        });

        it("says 1 code for a single remaining code", async () => {
            consumeRecoveryCode.mockResolvedValue({});
            const user = userEvent.setup();
            renderModal({ remainingRecoveryCodes: 1 });

            await user.click(screen.getByRole("button", { name: "Skip" }));
            expect(await screen.findByText(/You have 1 recovery code left\./)).toBeInTheDocument();
        });

        it("closing the dialog counts as Skip", async () => {
            consumeRecoveryCode.mockResolvedValue({});
            const user = userEvent.setup();
            const { onDone } = renderModal();

            await user.keyboard("{Escape}");
            expect(await screen.findByText("You have 5 recovery codes left.")).toBeInTheDocument();
            expect(consumeRecoveryCode).toHaveBeenCalled();
            expect(onDone).not.toHaveBeenCalled();
            await user.keyboard("{Escape}");
            expect(onDone).toHaveBeenCalledTimes(1);
        });

        it("ignores closing while a step is running", async () => {
            let finish!: () => void;
            consumeRecoveryCode.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
            const user = userEvent.setup();
            const { onDone } = renderModal();

            await user.click(screen.getByRole("button", { name: "Skip" }));
            await waitFor(() => expect(screen.getByRole("button", { name: "Skip" })).toBeDisabled());
            await user.keyboard("{Escape}");
            expect(consumeRecoveryCode).toHaveBeenCalledTimes(1);
            expect(onDone).not.toHaveBeenCalled();
            finish();
            expect(await screen.findByText("You have 5 recovery codes left.")).toBeInTheDocument();
        });

        it("renders nothing while hidden", () => {
            renderModal({}, false);
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        });
    });

    describe("the last code", () => {
        it("requires a new password, explains why, and offers keeping the code instead of Skip", async () => {
            const user = userEvent.setup();
            const { onDone } = renderModal({ remainingRecoveryCodes: 0 });

            expect(screen.getByText(/That was your last recovery code\. Set a new encryption password before it.s used up/)).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Keep this code for now" }));

            expect(onDone).toHaveBeenCalledTimes(1);
            expect(consumeRecoveryCode).not.toHaveBeenCalled();
        });

        it("closing the dialog keeps the code", async () => {
            const user = userEvent.setup();
            const { onDone } = renderModal({ remainingRecoveryCodes: 0 });

            await user.keyboard("{Escape}");
            expect(onDone).toHaveBeenCalledTimes(1);
            expect(consumeRecoveryCode).not.toHaveBeenCalled();
        });

        it("uses up the code once the new password is set", async () => {
            getUnlockedKeys.mockReturnValue(keys);
            replacePasswordWrap.mockResolvedValue({});
            consumeRecoveryCode.mockResolvedValue({});
            const user = userEvent.setup();
            renderModal({ remainingRecoveryCodes: 0, expectedMasterKeyGeneration: undefined });

            await setPassword(user);

            expect(await screen.findByText(/You have no recovery codes left\. Generate a new set in/)).toBeInTheDocument();
            expect(replacePasswordWrap).toHaveBeenCalledWith("mb1", keys, "new password 1", undefined);
            expect(consumeRecoveryCode).toHaveBeenCalledWith("mb1", "recovery-3");
        });
    });

    describe("using up the code", () => {
        it("warns, without blocking, when the code couldn't be removed", async () => {
            consumeRecoveryCode.mockRejectedValue(new ApiRequestError("server error", 500));
            const user = userEvent.setup();
            renderModal();

            await user.click(screen.getByRole("button", { name: "Skip" }));

            expect(await screen.findByText(CONSUME_FAILED_MESSAGE)).toBeInTheDocument();
            expect(screen.queryByText(/has been used up/)).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
        });

        it("treats an already-removed code (404) as used up", async () => {
            consumeRecoveryCode.mockRejectedValue(new ApiRequestError("not found", 404));
            const user = userEvent.setup();
            renderModal();

            await user.click(screen.getByRole("button", { name: "Skip" }));
            expect(await screen.findByText(/has been used up/)).toBeInTheDocument();
            expect(screen.queryByText(CONSUME_FAILED_MESSAGE)).not.toBeInTheDocument();
        });

        it("warns when the unlock didn't name the wrap to remove", async () => {
            const user = userEvent.setup();
            renderModal({ recoveryMethodId: undefined });

            await user.click(screen.getByRole("button", { name: "Skip" }));
            expect(await screen.findByText(CONSUME_FAILED_MESSAGE)).toBeInTheDocument();
            expect(consumeRecoveryCode).not.toHaveBeenCalled();
        });
    });

    describe("replacing the password fails", () => {
        it("master_key_rotated: asks for a reload, never uses up the code", async () => {
            const reload = vi.fn();
            vi.stubGlobal("location", { ...window.location, reload });
            getUnlockedKeys.mockReturnValue(keys);
            replacePasswordWrap.mockRejectedValue(new PasswordWrapReplaceError("master_key_rotated", "rotated"));
            const user = userEvent.setup();
            const { onDone } = renderModal();

            await setPassword(user);

            expect(await screen.findByText(REPLACE_ROTATED_MESSAGE)).toBeInTheDocument();
            expect(screen.queryByLabelText("New encryption password")).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Reload page" }));
            expect(reload).toHaveBeenCalled();
            // Closing now just closes - a skip would consume a code the rotation already replaced.
            await user.keyboard("{Escape}");
            expect(onDone).toHaveBeenCalledTimes(1);
            await user.click(screen.getByText("Close"));
            expect(onDone).toHaveBeenCalledTimes(2);
            expect(consumeRecoveryCode).not.toHaveBeenCalled();
        });

        it("multiple_password_wraps: explains, hides the form, still offers Skip", async () => {
            getUnlockedKeys.mockReturnValue(keys);
            replacePasswordWrap.mockRejectedValue(new PasswordWrapReplaceError("multiple_password_wraps", "two"));
            consumeRecoveryCode.mockResolvedValue({});
            const user = userEvent.setup();
            renderModal();

            await setPassword(user);

            expect(await screen.findByText(REPLACE_MULTIPLE_PASSWORDS_MESSAGE)).toBeInTheDocument();
            expect(screen.queryByLabelText("New encryption password")).not.toBeInTheDocument();
            expect(screen.queryByText("Close")).not.toBeInTheDocument();
            await user.click(screen.getByRole("button", { name: "Skip" }));
            expect(await screen.findByText("You have 5 recovery codes left.")).toBeInTheDocument();
        });

        it("multiple_password_wraps on the last code: only keeping the code is offered", async () => {
            getUnlockedKeys.mockReturnValue(keys);
            replacePasswordWrap.mockRejectedValue(new PasswordWrapReplaceError("multiple_password_wraps", "two"));
            const user = userEvent.setup();
            const { onDone } = renderModal({ remainingRecoveryCodes: 0 });

            await setPassword(user);
            await screen.findByText(REPLACE_MULTIPLE_PASSWORDS_MESSAGE);
            await user.click(screen.getByRole("button", { name: "Keep this code for now" }));
            expect(onDone).toHaveBeenCalled();
            expect(consumeRecoveryCode).not.toHaveBeenCalled();
        });

        it("no_other_unlock_method: explains and only offers Close", async () => {
            getUnlockedKeys.mockReturnValue(keys);
            replacePasswordWrap.mockRejectedValue(new PasswordWrapReplaceError("no_other_unlock_method", "none"));
            const user = userEvent.setup();
            const { onDone } = renderModal();

            await setPassword(user);

            expect(await screen.findByText(REPLACE_NO_OTHER_METHOD_MESSAGE)).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Reload page" })).not.toBeInTheDocument();
            await user.click(screen.getByText("Close"));
            expect(onDone).toHaveBeenCalled();
            expect(consumeRecoveryCode).not.toHaveBeenCalled();
        });

        it("add_failed, restored: the old password still works, and retrying can succeed", async () => {
            getUnlockedKeys.mockReturnValue(keys);
            replacePasswordWrap
                .mockRejectedValueOnce(new PasswordWrapReplaceError("add_failed", "add", { restored: true }))
                .mockResolvedValue({});
            consumeRecoveryCode.mockResolvedValue({});
            const user = userEvent.setup();
            renderModal();

            await setPassword(user);
            expect(await screen.findByText(REPLACE_ADD_FAILED_RESTORED_MESSAGE)).toBeInTheDocument();
            expect(consumeRecoveryCode).not.toHaveBeenCalled();

            await user.click(screen.getByRole("button", { name: "Set password" }));
            expect(await screen.findByText("Your new encryption password is set.")).toBeInTheDocument();
            expect(consumeRecoveryCode).toHaveBeenCalledTimes(1);
        });

        it("add_failed, not restored: says there's no password now and the code still works", async () => {
            getUnlockedKeys.mockReturnValue(keys);
            replacePasswordWrap.mockRejectedValue(new PasswordWrapReplaceError("add_failed", "add", { restored: false }));
            const user = userEvent.setup();
            renderModal();

            await setPassword(user);
            expect(await screen.findByText(REPLACE_ADD_FAILED_NOT_RESTORED_MESSAGE)).toBeInTheDocument();
            expect(screen.getByLabelText("New encryption password")).toBeInTheDocument();
            expect(consumeRecoveryCode).not.toHaveBeenCalled();
        });

        it.each([
            ["the session was locked (no keys)", () => getUnlockedKeys.mockReturnValue(undefined), 0],
            ["the held keys were destroyed", () => getUnlockedKeys.mockReturnValue({ ...keys, destroyed: true }), 0],
            [
                "replacePasswordWrap found the keys locked",
                () => {
                    getUnlockedKeys.mockReturnValue(keys);
                    replacePasswordWrap.mockRejectedValue(new KeysLockedError());
                },
                1,
            ],
        ])("locked because %s: nothing changes and only Close is offered", async (_label, arrange, replaceCalls) => {
            arrange();
            const user = userEvent.setup();
            const { onDone } = renderModal();

            await setPassword(user);

            expect(await screen.findByText(REPLACE_LOCKED_MESSAGE)).toBeInTheDocument();
            await user.click(screen.getByText("Close"));
            expect(onDone).toHaveBeenCalled();
            expect(consumeRecoveryCode).not.toHaveBeenCalled();
            expect(replacePasswordWrap).toHaveBeenCalledTimes(replaceCalls);
        });

        it.each([
            [new ApiRequestError("Service unavailable", 503), `${REPLACE_GENERIC_MESSAGE} (Service unavailable)`],
            [new Error("offline"), REPLACE_GENERIC_MESSAGE],
        ])("anything else (%s): a retryable error", async (err, expected) => {
            getUnlockedKeys.mockReturnValue(keys);
            replacePasswordWrap.mockRejectedValue(err);
            const user = userEvent.setup();
            renderModal();

            await setPassword(user);
            expect(await screen.findByText(expected)).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Set password" })).toBeEnabled();
            expect(screen.getByRole("button", { name: "Skip" })).toBeEnabled();
        });
    });
});
