// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import MessageSourceDialog, { MessageSourceDialogProps } from "../../../apps/shared/components/mail/reading/MessageSourceDialog.js";
import { MAX_SOURCE_DISPLAY_CHARS } from "../../../apps/shared/components/mail/reading/messageExport.js";

const RAW = "From: Ann <ann@x.com>\r\nSubject: Hello\r\n\r\nThe body\r\n";

function show(overrides: Partial<MessageSourceDialogProps> = {}) {
    const onClose = vi.fn();
    render(<MessageSourceDialog open onClose={onClose} mode="source" source={{ status: "ready", raw: RAW }} encrypted={false} {...overrides} />);
    return onClose;
}

describe("MessageSourceDialog", () => {
    it("draws nothing while it is closed", () => {
        show({ open: false });
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows the whole source in a monospace block, with a Copy button that copies all of it", async () => {
        const user = userEvent.setup();
        show();
        expect(screen.getByRole("dialog", { name: "Message source" })).toBeInTheDocument();
        const block = screen.getByLabelText("Message source", { selector: "pre" });
        expect(block.className).toContain("font-mono");
        expect(block.textContent).toBe(RAW);
        expect(screen.queryByRole("note")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Copy the message source" }));
        await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(RAW));
        expect(await screen.findByText("Copied")).toBeInTheDocument();
    });

    it("shows only the header lines as the message's details", () => {
        show({ mode: "headers" });
        expect(screen.getByRole("dialog", { name: "Message details" })).toBeInTheDocument();
        const block = screen.getByLabelText("Message details", { selector: "pre" });
        expect(block.textContent).toBe("From: Ann <ann@x.com>\r\nSubject: Hello");
        expect(screen.getByRole("button", { name: "Copy the message headers" })).toBeInTheDocument();
    });

    it("says an encrypted message's source is the ciphertext as stored, not a decrypted message", () => {
        show({ encrypted: true });
        expect(screen.getByRole("note")).toHaveTextContent("This message is encrypted. This is the encrypted message exactly as the server stores it; it is not decrypted here.");
    });

    it("cuts a very long source for display, and says so, while Copy keeps all of it", async () => {
        const user = userEvent.setup();
        const raw = `Subject: long\r\n\r\n${"x".repeat(MAX_SOURCE_DISPLAY_CHARS + 500)}`;
        show({ source: { status: "ready", raw } });
        expect(screen.getByLabelText("Message source", { selector: "pre" }).textContent).toHaveLength(MAX_SOURCE_DISPLAY_CHARS);
        expect(screen.getByText(/Showing the first .* characters/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Copy the message source" }));
        await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(raw));
    });

    it("says it is loading, and shows a failure as an alert", () => {
        show({ source: { status: "loading" } });
        expect(screen.getByRole("status")).toHaveTextContent("Loading the message");
        expect(screen.queryByRole("button", { name: /Copy/ })).not.toBeInTheDocument();
    });

    it("shows why the source could not be loaded", () => {
        show({ source: { status: "error", message: "It is gone" } });
        expect(screen.getByRole("alert")).toHaveTextContent("It is gone");
    });

    it("closes with its Close button", async () => {
        const user = userEvent.setup();
        const onClose = show();
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalled();
    });
});
