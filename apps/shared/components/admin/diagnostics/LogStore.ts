///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { LogEntry } from "./logLines.js";

/** How many lines the log view keeps. Older lines are dropped, and counted. */
export const LOG_BUFFER_LIMIT = 5000;

/** How many lines one capture records. */
export const LOG_CAPTURE_LIMIT = 50_000;

/** What a capture has recorded so far. */
export interface LogCapture {
    /** Whether lines are still being recorded. */
    active: boolean;
    /** When it started and, once stopped, ended (`Date.now()`). */
    startedAt: number;
    stoppedAt: number | undefined;
    entries: LogEntry[];
    /** How many lines arrived after `LOG_CAPTURE_LIMIT` was reached, and so were not recorded. */
    missed: number;
}

/**
 * Where the log view's lines are kept, outside React: a burst of lines is added without a render each. The display buffer holds the
 * last `LOG_BUFFER_LIMIT` lines. A capture is separate: it records every line that arrives while it runs, whatever the display
 * filters show and however many lines the display buffer has since dropped, up to `LOG_CAPTURE_LIMIT`.
 */
export class LogStore {
    entries: LogEntry[] = [];
    /** How many lines have been dropped from the front of `entries`. */
    dropped = 0;
    capture: LogCapture | undefined;

    constructor(
        private readonly bufferLimit = LOG_BUFFER_LIMIT,
        private readonly captureLimit = LOG_CAPTURE_LIMIT
    ) {}

    add(entry: LogEntry): void {
        this.entries.push(entry);
        if (this.entries.length > this.bufferLimit) {
            const excess = this.entries.length - this.bufferLimit;
            this.entries.splice(0, excess);
            this.dropped += excess;
        }
        const capture = this.capture;
        if (capture?.active) {
            if (capture.entries.length < this.captureLimit) {
                capture.entries.push(entry);
            } else {
                capture.missed += 1;
            }
        }
    }

    /** Empties the display buffer. A capture in progress is not touched. */
    clear(): void {
        this.entries = [];
        this.dropped = 0;
    }

    /** Starts recording (from nothing: an earlier capture is replaced). */
    startCapture(now: number): void {
        this.capture = { active: true, startedAt: now, stoppedAt: undefined, entries: [], missed: 0 };
    }

    /** Stops recording. What was recorded is kept for download. */
    stopCapture(now: number): void {
        if (this.capture?.active) {
            this.capture = { ...this.capture, active: false, stoppedAt: now };
        }
    }
}
