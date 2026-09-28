// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../../../lib/util/clipboard.js";

function setClipboard(value: unknown) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

/** Stubs `document.execCommand` (jsdom implements none) and returns the mock. */
function setExecCommand(impl: ((command: string) => boolean) | undefined) {
    const mock = impl ? vi.fn(impl) : undefined;
    Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value: mock });
    return mock;
}

afterEach(() => {
    setClipboard(undefined);
    setExecCommand(undefined);
    vi.restoreAllMocks();
    document.body.innerHTML = "";
});

describe("copyTextToClipboard", () => {
    it("writes through the async Clipboard API when it is available", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        setClipboard({ writeText });
        const exec = setExecCommand(() => true);

        await expect(copyTextToClipboard("v=spf1 mx ~all")).resolves.toBe(true);

        expect(writeText).toHaveBeenCalledWith("v=spf1 mx ~all");
        expect(exec).not.toHaveBeenCalled();
    });

    it("falls back to execCommand when the Clipboard API rejects", async () => {
        setClipboard({ writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) });
        let selected = "";
        const exec = setExecCommand(() => {
            const textarea = document.querySelector("textarea")!;
            selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
            return true;
        });

        await expect(copyTextToClipboard("10 mx.example.com")).resolves.toBe(true);

        expect(exec).toHaveBeenCalledWith("copy");
        expect(selected).toBe("10 mx.example.com");
    });

    it("falls back to execCommand when there is no Clipboard API at all", async () => {
        setClipboard(undefined);
        const exec = setExecCommand(() => true);
        await expect(copyTextToClipboard("x")).resolves.toBe(true);
        expect(exec).toHaveBeenCalledWith("copy");
    });

    it("falls back to execCommand when the Clipboard API has no writeText", async () => {
        setClipboard({});
        const exec = setExecCommand(() => true);
        await expect(copyTextToClipboard("x")).resolves.toBe(true);
        expect(exec).toHaveBeenCalledWith("copy");
    });

    it("removes the hidden textarea and puts focus back where it was", async () => {
        const button = document.createElement("button");
        document.body.appendChild(button);
        button.focus();
        setExecCommand(() => {
            // While copying, the textarea is in the document, hidden from assistive technology.
            const textarea = document.querySelector("textarea")!;
            expect(textarea).toHaveAttribute("aria-hidden", "true");
            expect(textarea).toHaveAttribute("readonly");
            return true;
        });

        await copyTextToClipboard("x");

        expect(document.querySelector("textarea")).toBeNull();
        expect(document.activeElement).toBe(button);
    });

    it("reports failure when the browser declines the copy command", async () => {
        setExecCommand(() => false);
        await expect(copyTextToClipboard("x")).resolves.toBe(false);
        expect(document.querySelector("textarea")).toBeNull();
    });

    it("reports failure, and still cleans up, when the copy command throws", async () => {
        setExecCommand(() => {
            throw new Error("blocked");
        });
        await expect(copyTextToClipboard("x")).resolves.toBe(false);
        expect(document.querySelector("textarea")).toBeNull();
    });

    it("reports failure when execCommand does not exist", async () => {
        setExecCommand(undefined);
        await expect(copyTextToClipboard("x")).resolves.toBe(false);
    });

    it("copes with nothing focused", async () => {
        vi.spyOn(document, "activeElement", "get").mockReturnValue(null);
        setExecCommand(() => true);
        await expect(copyTextToClipboard("x")).resolves.toBe(true);
    });
});
