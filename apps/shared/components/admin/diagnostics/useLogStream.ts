///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useCallback, useEffect, useRef, useState } from "react";
import { LogClient, LogClientOptions, LogStreamStatus } from "./logClient.js";
import type { LogEntry } from "./logLines.js";
import { LogStore } from "./LogStore.js";

/** Lines arrive in bursts; the view is redrawn at most this often, however many came. */
export const LOG_FLUSH_MS = 100;

/** What a capture has recorded, without the lines (which can be tens of thousands: `LogStream.captureEntries()` has them). */
export interface CaptureSummary {
    active: boolean;
    startedAt: number;
    stoppedAt: number | undefined;
    count: number;
    missed: number;
}

export interface LogStream {
    status: LogStreamStatus;
    /** Why the stream is in the `error` state. */
    error: string | undefined;
    /** Whether the stream is on (connecting, live or trying again), as opposed to stopped or refused. */
    running: boolean;
    /** The display buffer: the most recent lines, oldest first. */
    entries: LogEntry[];
    /** How many older lines the display buffer has dropped. */
    dropped: number;
    capture: CaptureSummary | undefined;
    start: () => void;
    stop: () => void;
    /** Empties the display buffer (not a capture). */
    clear: () => void;
    startCapture: () => void;
    stopCapture: () => void;
    /** Every line of the capture, for a download. */
    captureEntries: () => LogEntry[];
}

interface Snapshot {
    entries: LogEntry[];
    dropped: number;
    capture: CaptureSummary | undefined;
}

function snapshotOf(store: LogStore): Snapshot {
    const capture = store.capture;
    return {
        entries: store.entries.slice(),
        dropped: store.dropped,
        capture: capture && {
            active: capture.active,
            startedAt: capture.startedAt,
            stoppedAt: capture.stoppedAt,
            count: capture.entries.length,
            missed: capture.missed,
        },
    };
}

/**
 * The live log stream of the server for the log view: a `LogClient`, and a `LogStore` holding the lines and any capture. Nothing
 * connects until `start()`. The stream is closed, and the redraw timer cleared, when the component unmounts.
 */
export function useLogStream(options: LogClientOptions = {}): LogStream {
    const [client] = useState(() => new LogClient(options));
    const [store] = useState(() => new LogStore());
    const [connection, setConnection] = useState<{ status: LogStreamStatus; error: string | undefined }>({
        status: client.status,
        error: undefined,
    });
    const [snapshot, setSnapshot] = useState<Snapshot>(() => snapshotOf(store));
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const flush = useCallback(() => {
        clearTimeout(timer.current);
        timer.current = undefined;
        setSnapshot(snapshotOf(store));
    }, [store]);

    useEffect(() => {
        const stopEntries = client.onEntry((entry) => {
            store.add(entry);
            timer.current ??= setTimeout(flush, LOG_FLUSH_MS);
        });
        const stopStatus = client.onStatus((status, error) => setConnection({ status, error }));
        return () => {
            stopEntries();
            stopStatus();
            client.stop();
            clearTimeout(timer.current);
            timer.current = undefined;
        };
    }, [client, store, flush]);

    return {
        status: connection.status,
        error: connection.error,
        running: connection.status === "connecting" || connection.status === "live" || connection.status === "reconnecting",
        entries: snapshot.entries,
        dropped: snapshot.dropped,
        capture: snapshot.capture,
        start: () => client.start(),
        stop: () => client.stop(),
        clear: () => {
            store.clear();
            flush();
        },
        startCapture: () => {
            store.startCapture(Date.now());
            flush();
        },
        stopCapture: () => {
            store.stopCapture(Date.now());
            flush();
        },
        captureEntries: () => store.capture?.entries ?? [],
    };
}
