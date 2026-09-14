// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UnlockPromptProvider, useUnlockPrompt } from "../../../apps/shared/components/layout/UnlockPromptProvider.js";

const { getUnlockedKeys, unlockWithPassword } = vi.hoisted(() => ({
    getUnlockedKeys: vi.fn(),
    unlockWithPassword: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, unlockWithPassword }));

const fakeUnlockedKeys = { masterKey: new Uint8Array(32) };

/** A minimal stand-in for one of the real `useUnlockPrompt()` call sites (`ComposeWindow`'s sign/encrypt
 * toggle, `MessageDetailPane`'s "Unlock to view") - exercises the hook's contract without needing either
 * of those components' own, unrelated rendering logic. */
function TestConsumer({ mailboxUid = "mb1" }: { mailboxUid?: string }) {
    const { requestUnlock } = useUnlockPrompt();
    const [result, setResult] = useState("idle");
    async function handleClick() {
        try {
            await requestUnlock(mailboxUid, []);
            setResult("unlocked");
        } catch {
            setResult("cancelled");
        }
    }
    return (
        <div>
            <button onClick={handleClick}>Do encrypted thing</button>
            <span>Result: {result}</span>
        </div>
    );
}

describe("UnlockPromptProvider", () => {
    it("resolves immediately with no dialog shown when the mailbox is already unlocked this session", async () => {
        getUnlockedKeys.mockReturnValue(fakeUnlockedKeys);
        const user = userEvent.setup();
        render(
            <UnlockPromptProvider>
                <TestConsumer />
            </UnlockPromptProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Do encrypted thing" }));

        expect(await screen.findByText("Result: unlocked")).toBeInTheDocument();
        expect(screen.queryByText("Unlock your mailbox")).not.toBeInTheDocument();
        expect(unlockWithPassword).not.toHaveBeenCalled();
    });

    it("shows the unlock dialog, unlocks on a correct password, and resolves requestUnlock with the unlocked keys", async () => {
        getUnlockedKeys.mockReturnValueOnce(undefined).mockReturnValue(fakeUnlockedKeys);
        unlockWithPassword.mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(
            <UnlockPromptProvider>
                <TestConsumer />
            </UnlockPromptProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Do encrypted thing" }));
        await screen.findByText("Unlock your mailbox");
        await user.type(screen.getByLabelText("Encryption password"), "a good password");
        await user.click(screen.getByRole("button", { name: "Unlock" }));

        expect(await screen.findByText("Result: unlocked")).toBeInTheDocument();
        expect(unlockWithPassword).toHaveBeenCalledWith("mb1", [], "a good password");
        expect(screen.queryByText("Unlock your mailbox")).not.toBeInTheDocument();
    });

    it("shows a generic error and keeps the dialog open on a wrong password", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        unlockWithPassword.mockRejectedValue(new Error("AEAD authentication failure"));
        const user = userEvent.setup();
        render(
            <UnlockPromptProvider>
                <TestConsumer />
            </UnlockPromptProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Do encrypted thing" }));
        await screen.findByText("Unlock your mailbox");
        await user.type(screen.getByLabelText("Encryption password"), "wrong password");
        await user.click(screen.getByRole("button", { name: "Unlock" }));

        expect(await screen.findByText("Incorrect password.")).toBeInTheDocument();
        expect(screen.getByText("Unlock your mailbox")).toBeInTheDocument();
        expect(screen.getByText("Result: idle")).toBeInTheDocument();
    });

    it("rejects requestUnlock, without calling unlockWithPassword, when the dialog is cancelled", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        const user = userEvent.setup();
        render(
            <UnlockPromptProvider>
                <TestConsumer />
            </UnlockPromptProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Do encrypted thing" }));
        await screen.findByText("Unlock your mailbox");
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(await screen.findByText("Result: cancelled")).toBeInTheDocument();
        expect(screen.queryByText("Unlock your mailbox")).not.toBeInTheDocument();
        expect(unlockWithPassword).not.toHaveBeenCalled();
    });

    it("a second request for the same mailbox joins the open dialog, and one unlock settles both callers", async () => {
        getUnlockedKeys.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined).mockReturnValue(fakeUnlockedKeys);
        unlockWithPassword.mockResolvedValue(undefined);
        let request!: ReturnType<typeof useUnlockPrompt>["requestUnlock"];
        function Capture() {
            request = useUnlockPrompt().requestUnlock;
            return null;
        }
        const user = userEvent.setup();
        render(
            <UnlockPromptProvider>
                <Capture />
            </UnlockPromptProvider>,
        );
        const first = request("mb1", []);
        const second = request("mb1", []);
        await screen.findByText("Unlock your mailbox");
        await user.type(screen.getByLabelText("Encryption password"), "pw");
        await user.click(screen.getByRole("button", { name: "Unlock" }));

        await expect(first).resolves.toBe(fakeUnlockedKeys);
        await expect(second).resolves.toBe(fakeUnlockedKeys);
        expect(unlockWithPassword).toHaveBeenCalledTimes(1);
    });

    it("a request for a different mailbox rejects the earlier caller instead of leaving it pending forever", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        let request!: ReturnType<typeof useUnlockPrompt>["requestUnlock"];
        function Capture() {
            request = useUnlockPrompt().requestUnlock;
            return null;
        }
        const user = userEvent.setup();
        render(
            <UnlockPromptProvider>
                <Capture />
            </UnlockPromptProvider>,
        );
        const first = request("mb1", []);
        const second = request("mb2", []);
        await expect(first).rejects.toThrow("superseded");

        let finishUnlock!: () => void;
        unlockWithPassword.mockReturnValueOnce(new Promise<void>((resolve) => (finishUnlock = resolve)));
        await user.type(await screen.findByLabelText("Encryption password"), "pw");
        await user.click(screen.getByRole("button", { name: "Unlock" }));
        expect(unlockWithPassword).toHaveBeenCalledWith("mb2", [], "pw");

        // A third mailbox's request arrives while mb2's unlock is still in flight: mb2's caller is rejected,
        // and mb2's late success must not close mb3's dialog.
        const third = request("mb3", []);
        const thirdOutcome = expect(third).rejects.toThrow("cancelled");
        await expect(second).rejects.toThrow("superseded");
        getUnlockedKeys.mockReturnValue(fakeUnlockedKeys);
        finishUnlock();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.getByText("Unlock your mailbox")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await thirdOutcome;
    });

    it("useUnlockPrompt() throws when used outside an UnlockPromptProvider", () => {
        function Bare() {
            useUnlockPrompt();
            return null;
        }
        // Expected render-time throw - suppress React's own console.error noise for it.
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(() => render(<Bare />)).toThrow(/useUnlockPrompt\(\) must be used within an UnlockPromptProvider/);
        spy.mockRestore();
    });
});
