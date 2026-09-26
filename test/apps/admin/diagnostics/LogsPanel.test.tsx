// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import LogsPanel from "../../../../apps/shared/components/admin/diagnostics/LogsPanel.js";
import LogViewer, { levelLabel, LOG_VISIBLE_ROWS, splitExtra } from "../../../../apps/shared/components/admin/diagnostics/LogViewer.js";
import { isControlFrame, LogEntry, parseLogFrame } from "../../../../apps/shared/components/admin/diagnostics/logLines.js";
import type { LogStreamStatus } from "../../../../apps/shared/components/admin/diagnostics/logClient.js";
import type { CaptureSummary, LogStream } from "../../../../apps/shared/components/admin/diagnostics/useLogStream.js";

let nextId = 0;
function line(message: string, level = "info", extra: Record<string, unknown> = {}): LogEntry {
    const frame = parseLogFrame(JSON.stringify({ level, message, timestamp: "2026-09-26T10:00:00.000Z", ...extra }), ++nextId, 0);
    if (isControlFrame(frame)) {
        throw new Error("control");
    }
    return frame;
}

function stream(overrides: Partial<LogStream> = {}): LogStream {
    return {
        status: "live",
        error: undefined,
        running: true,
        entries: [],
        dropped: 0,
        capture: undefined,
        start: vi.fn(),
        stop: vi.fn(),
        clear: vi.fn(),
        startCapture: vi.fn(),
        stopCapture: vi.fn(),
        captureEntries: () => [],
        ...overrides,
    };
}

const capture = (overrides: Partial<CaptureSummary> = {}): CaptureSummary => ({
    active: true,
    startedAt: Date.parse("2026-09-26T10:00:00.000Z"),
    stoppedAt: undefined,
    count: 0,
    missed: 0,
    ...overrides,
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("LogViewer helpers", () => {
    it("labels the level column, with markers for a line without a level", () => {
        expect(levelLabel(line("a", "warn"))).toBe("WARN");
        expect(levelLabel(line("a", ""))).toBe("—");
        const raw = parseLogFrame("plain", 1, 0) as LogEntry;
        expect(levelLabel(raw)).toBe("RAW");
    });

    it("splits a stack out of the other fields", () => {
        expect(splitExtra({ stack: "a\nb", label: "x" })).toEqual({ stack: "a\nb", rest: { label: "x" } });
        const extra = { stack: 5, label: "x" };
        expect(splitExtra(extra)).toEqual({ stack: undefined, rest: extra });
        expect(splitExtra({})).toEqual({ stack: undefined, rest: {} });
    });
});

describe("LogViewer", () => {
    it("shows each line with its time, level and message, the other fields and the stack", () => {
        render(
            <LogViewer
                entries={[line("Plain", "info"), line("Broke", "error", { label: "db", stack: "Error: x\n    at y" }), line("Deep", "silly")]}
                follow={false}
                empty="nothing"
            />
        );
        const log = within(screen.getByRole("log", { name: "Server log" }));
        expect(log.getAllByText("2026-09-26T10:00:00.000Z")).toHaveLength(3);
        expect(log.getByText("INFO")).toBeInTheDocument();
        expect(log.getByText("ERROR")).toBeInTheDocument();
        expect(log.getByText("SILLY")).toBeInTheDocument();
        expect(log.getByText('{"label":"db"}')).toBeInTheDocument();
        expect(log.getByText(/Error: x/)).toBeInTheDocument();
        expect(screen.getByRole("log")).toHaveAttribute("aria-live", "off");
    });

    it("says what to show when there are no lines", () => {
        render(<LogViewer entries={[]} follow empty="Nothing here yet." />);
        expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
    });

    it("puts only the last 500 lines in the page", () => {
        const entries = Array.from({ length: LOG_VISIBLE_ROWS + 20 }, (_, index) => line(`line ${index}`));
        render(<LogViewer entries={entries} follow={false} empty="" />);
        expect(screen.queryByText("line 19")).not.toBeInTheDocument();
        expect(screen.getByText("line 20")).toBeInTheDocument();
        expect(screen.getByText(`line ${LOG_VISIBLE_ROWS + 19}`)).toBeInTheDocument();
    });

    it("stays scrolled to the newest line while following, and leaves the scroll alone when not", () => {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 900 });
        try {
            const { rerender } = render(<LogViewer entries={[line("a")]} follow empty="" />);
            expect(screen.getByRole("log").scrollTop).toBe(900);
            screen.getByRole("log").scrollTop = 10;
            rerender(<LogViewer entries={[line("a")]} follow={false} empty="" />);
            expect(screen.getByRole("log").scrollTop).toBe(10);
            rerender(<LogViewer entries={[line("a"), line("b")]} follow={false} empty="" />);
            expect(screen.getByRole("log").scrollTop).toBe(10);
            rerender(<LogViewer entries={[line("a"), line("b")]} follow empty="" />);
            expect(screen.getByRole("log").scrollTop).toBe(900);
        } finally {
            delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
        }
    });
});

describe("LogsPanel connection", () => {
    const statuses: [LogStreamStatus, string][] = [
        ["connecting", "Connecting"],
        ["live", "Live"],
        ["reconnecting", "Reconnecting"],
        ["closed", "Stopped"],
        ["error", "Error"],
    ];

    it.each(statuses)("says %s in words", (status, label) => {
        render(<LogsPanel stream={stream({ status })} saveFile={vi.fn()} />);
        expect(screen.getByText(label)).toBeInTheDocument();
    });

    it("stops a running stream", async () => {
        const user = userEvent.setup();
        const s = stream();
        render(<LogsPanel stream={s} saveFile={vi.fn()} />);
        expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Stop" }));
        expect(s.stop).toHaveBeenCalledOnce();
    });

    it("starts a stopped stream, and shows why one was refused", async () => {
        const user = userEvent.setup();
        const s = stream({ running: false, status: "error", error: "The server refused the log stream (api-103)." });
        render(<LogsPanel stream={s} saveFile={vi.fn()} />);
        expect(screen.getByText("The server refused the log stream (api-103).")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Start" }));
        expect(s.start).toHaveBeenCalledOnce();
    });

    it("clears the buffer", async () => {
        const user = userEvent.setup();
        const s = stream();
        render(<LogsPanel stream={s} saveFile={vi.fn()} />);
        await user.click(screen.getByRole("button", { name: "Clear" }));
        expect(s.clear).toHaveBeenCalledOnce();
    });

    it("toggles scrolling with the newest line", async () => {
        const user = userEvent.setup();
        render(<LogsPanel stream={stream()} saveFile={vi.fn()} />);
        const pause = screen.getByRole("button", { name: "Pause scrolling" });
        expect(pause).toHaveAttribute("aria-pressed", "false");
        await user.click(pause);
        const resume = screen.getByRole("button", { name: "Resume scrolling" });
        expect(resume).toHaveAttribute("aria-pressed", "true");
        await user.click(resume);
        expect(screen.getByRole("button", { name: "Pause scrolling" })).toBeInTheDocument();
    });
});

describe("LogsPanel filters", () => {
    const entries = [line("Server started", "info"), line("Query was slow", "warn"), line("Boom", "error"), line("Details", "debug"), line("Odd", "notice")];

    it("says how many lines are buffered, and what to do with none", () => {
        const { rerender } = render(<LogsPanel stream={stream({ entries: [] })} saveFile={vi.fn()} />);
        expect(screen.getByText("0 buffered lines.")).toBeInTheDocument();
        expect(screen.getByText("No log lines yet.")).toBeInTheDocument();
        rerender(<LogsPanel stream={stream({ entries: [entries[0]] })} saveFile={vi.fn()} />);
        expect(screen.getByText("1 buffered line.")).toBeInTheDocument();
    });

    it("hides a level turned off, and shows it again, keeping a line with no known level", async () => {
        const user = userEvent.setup();
        render(<LogsPanel stream={stream({ entries })} saveFile={vi.fn()} />);
        expect(screen.getByText("Details")).toBeInTheDocument();
        const debug = screen.getByRole("button", { name: "debug" });
        expect(debug).toHaveAttribute("aria-pressed", "true");
        await user.click(debug);
        expect(debug).toHaveAttribute("aria-pressed", "false");
        expect(screen.queryByText("Details")).not.toBeInTheDocument();
        expect(screen.getByText("Odd")).toBeInTheDocument();
        expect(screen.getByText("4 of 5 buffered lines match.")).toBeInTheDocument();

        await user.click(debug);
        expect(screen.getByText("Details")).toBeInTheDocument();
        expect(screen.getByText("5 buffered lines.")).toBeInTheDocument();
    });

    it("searches the text, ignoring case, and says when nothing matches", async () => {
        const user = userEvent.setup();
        render(<LogsPanel stream={stream({ entries })} saveFile={vi.fn()} />);
        await user.type(screen.getByRole("searchbox", { name: "Search the log" }), "  SLOW ");
        expect(screen.getByText("Query was slow")).toBeInTheDocument();
        expect(screen.queryByText("Boom")).not.toBeInTheDocument();
        expect(screen.getByText("1 of 5 buffered lines match.")).toBeInTheDocument();

        await user.type(screen.getByRole("searchbox", { name: "Search the log" }), "zzz");
        expect(screen.getByText("No buffered line matches the filters.")).toBeInTheDocument();
    });

    it("says how many older lines were dropped, and that only the last 500 are shown", () => {
        const many = Array.from({ length: 600 }, (_, index) => line(`m${index}`));
        const { rerender } = render(<LogsPanel stream={stream({ entries: many, dropped: 1200 })} saveFile={vi.fn()} />);
        const status = screen.getAllByRole("status")[0];
        expect(status).toHaveTextContent("600 buffered lines. Showing the last 500. 1200 older lines dropped (the buffer keeps the last 5000).");
        rerender(<LogsPanel stream={stream({ entries: many, dropped: 1 })} saveFile={vi.fn()} />);
        expect(screen.getAllByRole("status")[0]).toHaveTextContent("1 older line dropped");
    });
});

describe("LogsPanel captures and downloads", () => {
    const entries = [line("one"), line("two", "error")];

    it("starts a capture", async () => {
        const user = userEvent.setup();
        const s = stream();
        render(<LogsPanel stream={s} saveFile={vi.fn()} />);
        expect(screen.queryByRole("button", { name: "Stop capture" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Start capture" }));
        expect(s.startCapture).toHaveBeenCalledOnce();
    });

    it("shows a running capture's line count and elapsed time, counting up each second, and stops it", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-09-26T10:01:05.000Z"));
        const s = stream({ capture: capture({ count: 1234 }) });
        const { rerender } = render(<LogsPanel stream={s} saveFile={vi.fn()} />);
        expect(screen.getByText(/Recording: 1,234 lines in 1m 5s/)).toBeInTheDocument();
        act(() => void vi.advanceTimersByTime(3000));
        expect(screen.getByText(/Recording: 1,234 lines in 1m 8s/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Stop capture" }));
        expect(s.stopCapture).toHaveBeenCalledOnce();

        // Once stopped the time is frozen, and the clock is not ticking.
        rerender(<LogsPanel stream={stream({ capture: capture({ active: false, count: 1, stoppedAt: Date.parse("2026-09-26T10:00:42.000Z") }) })} saveFile={vi.fn()} />);
        expect(screen.getByText(/Capture stopped: 1 line in 42s/)).toBeInTheDocument();
        expect(vi.getTimerCount()).toBe(0);
        act(() => void vi.advanceTimersByTime(5000));
        expect(screen.getByText(/Capture stopped: 1 line in 42s/)).toBeInTheDocument();
    });

    it("says when the capture is full and lines were not recorded", () => {
        const { rerender } = render(<LogsPanel stream={stream({ capture: capture({ active: false, stoppedAt: 1, count: 50_000, missed: 1 }) })} saveFile={vi.fn()} />);
        expect(screen.getByText("The capture is full: 1 later line was not recorded.")).toBeInTheDocument();
        rerender(<LogsPanel stream={stream({ capture: capture({ active: false, stoppedAt: 1, count: 50_000, missed: 12_345 }) })} saveFile={vi.fn()} />);
        expect(screen.getByText("The capture is full: 12,345 later lines were not recorded.")).toBeInTheDocument();
        expect(screen.getByText(/up to 50,000 lines/)).toBeInTheDocument();
    });

    it("downloads the buffer as .log and .ndjson without a capture, all lines whatever the filters show", async () => {
        const user = userEvent.setup();
        const saveFile = vi.fn();
        render(<LogsPanel stream={stream({ entries })} saveFile={saveFile} />);
        await user.type(screen.getByRole("searchbox", { name: "Search the log" }), "one");
        expect(screen.queryByRole("button", { name: /Capture \(/ })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Buffer (.log)" }));
        expect(saveFile).toHaveBeenLastCalledWith(
            expect.stringMatching(/^rapidmx-server-logs-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.log$/),
            "2026-09-26T10:00:00.000Z INFO one\n2026-09-26T10:00:00.000Z ERROR two\n",
            "text/plain;charset=utf-8"
        );

        await user.click(screen.getByRole("button", { name: "Buffer (.ndjson)" }));
        const [name, content, mime] = saveFile.mock.calls[1];
        expect(name).toMatch(/\.ndjson$/);
        expect(mime).toBe("application/x-ndjson");
        expect(content.trimEnd().split("\n").map((text: string) => JSON.parse(text).message)).toEqual(["one", "two"]);
    });

    it("disables the buffer downloads while the buffer is empty", () => {
        render(<LogsPanel stream={stream({ entries: [] })} saveFile={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Buffer (.log)" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Buffer (.ndjson)" })).toBeDisabled();
    });

    it("downloads the capture, which is not what the display shows", async () => {
        const user = userEvent.setup();
        const saveFile = vi.fn();
        const recorded = [line("early"), line("late", "warn")];
        render(
            <LogsPanel
                stream={stream({ entries: [line("only this")], capture: capture({ active: false, stoppedAt: 1, count: 2 }), captureEntries: () => recorded })}
                saveFile={saveFile}
            />
        );
        await user.click(screen.getByRole("button", { name: "Capture (.log)" }));
        expect(saveFile).toHaveBeenLastCalledWith(
            expect.stringMatching(/\.log$/),
            "2026-09-26T10:00:00.000Z INFO early\n2026-09-26T10:00:00.000Z WARN late\n",
            "text/plain;charset=utf-8"
        );
        await user.click(screen.getByRole("button", { name: "Capture (.ndjson)" }));
        expect(saveFile.mock.calls[1][0]).toMatch(/\.ndjson$/);
        expect(saveFile.mock.calls[1][1].trimEnd().split("\n")).toHaveLength(2);
    });

    it("disables the capture downloads until it has recorded something", () => {
        render(<LogsPanel stream={stream({ capture: capture({ count: 0 }) })} saveFile={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Capture (.log)" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Capture (.ndjson)" })).toBeDisabled();
    });
});
