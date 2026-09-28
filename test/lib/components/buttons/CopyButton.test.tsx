// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CopyButton from "../../../../lib/components/buttons/CopyButton.js";

function setClipboard(value: unknown) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

function setExecCommand(value: unknown) {
    Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value });
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    setClipboard(undefined);
    setExecCommand(undefined);
});

describe("CopyButton", () => {
    it("renders a Copy button named by its label, with an empty polite live region beside it", () => {
        render(<CopyButton value="v" label="Copy value for the SPF record" />);
        const button = screen.getByRole("button", { name: "Copy value for the SPF record" });
        expect(button).toHaveTextContent("Copy");
        expect(button).toHaveAttribute("type", "button");
        const status = screen.getByRole("status");
        expect(status).toHaveAttribute("aria-live", "polite");
        expect(status).toBeEmptyDOMElement();
    });

    it("uses custom children as the caption and merges a class name", () => {
        render(
            <CopyButton value="v" label="Copy name" className="ml-2">
                Copy name
            </CopyButton>,
        );
        const button = screen.getByRole("button", { name: "Copy name" });
        expect(button).toHaveTextContent("Copy name");
        expect(button.className).toContain("ml-2");
    });

    it("copies the value and announces Copied, then goes quiet again", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        setClipboard({ writeText });
        render(<CopyButton value="10 mx.example.com" label="Copy value" />);

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Copy value" }));
        });
        expect(writeText).toHaveBeenCalledWith("10 mx.example.com");
        expect(screen.getByRole("status")).toHaveTextContent("Copied");
        expect(screen.getByRole("status").className).toContain("text-success");

        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(screen.getByRole("status")).toBeEmptyDOMElement();
    });

    it("falls back to execCommand when the Clipboard API rejects", async () => {
        setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
        const exec = vi.fn(() => true);
        setExecCommand(exec);
        render(<CopyButton value="x" label="Copy value" />);

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Copy value" }));
        });
        expect(exec).toHaveBeenCalledWith("copy");
        expect(screen.getByRole("status")).toHaveTextContent("Copied");
    });

    it("says it couldn't copy when the Clipboard API is unavailable and the fallback fails", async () => {
        setClipboard(undefined);
        setExecCommand(vi.fn(() => false));
        render(<CopyButton value="x" label="Copy value" />);

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Copy value" }));
        });
        expect(screen.getByRole("status")).toHaveTextContent("Couldn’t copy");
        expect(screen.getByRole("status").className).toContain("text-danger");
    });
});
