// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import EscrowScopeKeyAndHoldersFields, {
    EscrowScopeKeyAndHoldersValue,
    emptyEscrowScopeKeyAndHoldersValue,
    keyValidityError,
} from "../../../../apps/shared/components/admin/escrowScopes/EscrowScopeKeyAndHoldersFields.js";
import { generateEscrowKeyPair } from "../../../../lib/crypto/escrowKeys.js";

let seen: EscrowScopeKeyAndHoldersValue | undefined;

function Harness({ initial, keyReadOnly, disabled }: { initial: Partial<EscrowScopeKeyAndHoldersValue>; keyReadOnly?: boolean; disabled?: boolean }) {
    const [value, setValue] = useState({ ...emptyEscrowScopeKeyAndHoldersValue(), ...initial });
    seen = value;
    return <EscrowScopeKeyAndHoldersFields value={value} onChange={setValue} keyReadOnly={keyReadOnly} disabled={disabled} />;
}

describe("EscrowScopeKeyAndHoldersFields: the pasted key and its fingerprint", () => {
    it("says nothing until a key is pasted, then confirms a fingerprint that is the key's, however it is written", async () => {
        const { publicKey } = await generateEscrowKeyPair({ name: "Legal", validDays: 30 });
        const user = userEvent.setup();
        render(<Harness initial={{}} />);
        expect(screen.queryByText(/fingerprint of the public key/)).not.toBeInTheDocument();

        await user.click(screen.getByLabelText("Public key (base64)"));
        await user.paste(publicKey.publicKey);
        // The key is a certificate, but the fingerprint box is still empty, so it does not match.
        expect(await screen.findByRole("alert")).toHaveTextContent(publicKey.fingerprint);

        await user.click(screen.getByLabelText("Fingerprint (hex SHA-256)"));
        await user.paste(publicKey.fingerprint.toUpperCase().replace(/(..)(?!$)/g, "$1:"));
        expect(await screen.findByText("This is the fingerprint of the public key above.")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("warns that a fingerprint is not the key's, naming the one that is, and puts it in when asked", async () => {
        const { publicKey } = await generateEscrowKeyPair({ name: "Legal", validDays: 30 });
        const user = userEvent.setup();
        render(<Harness initial={{ publicKey: publicKey.publicKey, fingerprint: "00".repeat(32) }} />);

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("is not the one of the public key above");
        expect(alert).toHaveTextContent(publicKey.fingerprint);
        await user.click(screen.getByRole("button", { name: "Use it" }));
        expect(seen!.fingerprint).toBe(publicKey.fingerprint);
        expect(await screen.findByText("This is the fingerprint of the public key above.")).toBeInTheDocument();
    });

    it("says so when what was pasted is not a certificate, and keeps only the answer for the key as it is now", async () => {
        const { publicKey } = await generateEscrowKeyPair({ name: "Legal", validDays: 30 });
        const user = userEvent.setup();
        render(<Harness initial={{ publicKey: "not a certificate", fingerprint: publicKey.fingerprint }} />);
        expect(await screen.findByRole("alert")).toHaveTextContent("not a base64-encoded certificate");

        // Replaced by the real key one character at a time: the answers for the half-typed ones are dropped.
        const box = screen.getByLabelText("Public key (base64)");
        await user.clear(box);
        await user.click(box);
        await user.paste(publicKey.publicKey);
        await user.type(box, "{Backspace}");
        await user.type(box, publicKey.publicKey.slice(-1));
        expect(await screen.findByText("This is the fingerprint of the public key above.")).toBeInTheDocument();
    });

    it("does not check a key it shows read-only (one generated in the browser), or an empty one", async () => {
        const { publicKey } = await generateEscrowKeyPair({ name: "Legal", validDays: 30 });
        const { rerender } = render(<Harness initial={{ publicKey: publicKey.publicKey, fingerprint: "00" }} keyReadOnly />);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.queryByText(/fingerprint of the public key/)).not.toBeInTheDocument();
        rerender(<Harness initial={{ publicKey: "", fingerprint: "00" }} />);
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("disables the button that fills the fingerprint in while the form is disabled", async () => {
        const { publicKey } = await generateEscrowKeyPair({ name: "Legal", validDays: 30 });
        render(<Harness initial={{ publicKey: publicKey.publicKey, fingerprint: "00" }} disabled />);
        expect(await screen.findByRole("button", { name: "Use it" })).toBeDisabled();
    });
});

describe("EscrowScopeKeyAndHoldersFields: the required-holders box", () => {
    it("can be emptied and typed over, instead of snapping back to 1 under the cursor, and passes 0 on while it is empty", async () => {
        const user = userEvent.setup();
        render(<Harness initial={{ requiredHolders: 2 }} />);
        const box = screen.getByLabelText("Required holders (M-of-N dual control)");
        expect(box).toHaveValue(2);

        await user.clear(box);
        expect(box).toHaveValue(null);
        expect(seen!.requiredHolders).toBe(0);
        await user.type(box, "3");
        expect(box).toHaveValue(3);
        expect(seen!.requiredHolders).toBe(3);
    });

    it("shows a value the page sets from outside, and keeps what is typed when it is the same number", async () => {
        const user = userEvent.setup();
        function Outer() {
            const [value, setValue] = useState({ ...emptyEscrowScopeKeyAndHoldersValue(), requiredHolders: 2 });
            return (
                <>
                    <button type="button" onClick={() => setValue({ ...value, requiredHolders: 4 })}>
                        Set to four
                    </button>
                    <EscrowScopeKeyAndHoldersFields value={value} onChange={setValue} />
                </>
            );
        }
        render(<Outer />);
        const box = screen.getByLabelText("Required holders (M-of-N dual control)");
        fireEvent.change(box, { target: { value: "02" } });
        expect(box).toHaveValue(2);
        await user.click(screen.getByRole("button", { name: "Set to four" }));
        expect(box).toHaveValue(4);
    });
});

describe("keyValidityError", () => {
    it("is null when both dates are there, and says so when either is empty or not a date", () => {
        expect(keyValidityError({ notBefore: "2026-01-01T00:00", notAfter: "2027-01-01T00:00" })).toBeNull();
        expect(keyValidityError({ notBefore: "", notAfter: "2027-01-01T00:00" })).toMatch(/both required/);
        expect(keyValidityError({ notBefore: "2026-01-01T00:00", notAfter: "nope" })).toMatch(/both required/);
    });
});
