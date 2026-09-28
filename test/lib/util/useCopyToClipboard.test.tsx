// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useCopyToClipboard, { COPY_FEEDBACK_MS } from "../../../lib/util/useCopyToClipboard.js";

function Harness({ resetMs }: { resetMs?: number }) {
    const { status, copy } = useCopyToClipboard(resetMs);
    return (
        <button onClick={() => void copy("hello")}>
            <span data-testid="status">{status}</span>
        </button>
    );
}

function setClipboard(value: unknown) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    setClipboard(undefined);
    Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value: undefined });
});

describe("useCopyToClipboard", () => {
    it("starts idle, reports copied, then returns to idle after the default delay", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        setClipboard({ writeText });
        render(<Harness />);
        expect(screen.getByTestId("status")).toHaveTextContent("idle");

        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
        });
        expect(writeText).toHaveBeenCalledWith("hello");
        expect(screen.getByTestId("status")).toHaveTextContent("copied");

        act(() => {
            vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1);
        });
        expect(screen.getByTestId("status")).toHaveTextContent("copied");
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(screen.getByTestId("status")).toHaveTextContent("idle");
    });

    it("reports failed when neither route can copy, and honours a custom delay", async () => {
        setClipboard(undefined);
        render(<Harness resetMs={500} />);

        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
        });
        expect(screen.getByTestId("status")).toHaveTextContent("failed");
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(screen.getByTestId("status")).toHaveTextContent("idle");
    });

    it("restarts the feedback timer when copied again before it expires", async () => {
        setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
        render(<Harness />);

        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
        });
        act(() => {
            vi.advanceTimersByTime(1500);
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
        });
        act(() => {
            vi.advanceTimersByTime(1500);
        });
        expect(screen.getByTestId("status")).toHaveTextContent("copied");
        act(() => {
            vi.advanceTimersByTime(500);
        });
        expect(screen.getByTestId("status")).toHaveTextContent("idle");
    });

    it("does nothing when unmounted while the copy is in flight, and clears its timer on unmount", async () => {
        let resolve!: () => void;
        setClipboard({ writeText: vi.fn(() => new Promise<void>((r) => (resolve = r))) });
        const { unmount } = render(<Harness />);
        fireEvent.click(screen.getByRole("button"));
        unmount();
        await act(async () => {
            resolve();
        });
        expect(vi.getTimerCount()).toBe(0);

        setClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
        const second = render(<Harness />);
        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
        });
        expect(vi.getTimerCount()).toBe(1);
        second.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});
