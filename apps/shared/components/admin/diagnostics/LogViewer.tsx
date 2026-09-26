///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef } from "react";
import { entryTime, LogEntry } from "./logLines.js";

/** The most rows the viewer puts in the page: the last this many lines that match. (The buffer behind it is bigger.) */
export const LOG_VISIBLE_ROWS = 500;

/** The tint behind a level's name. The name is always written, so the tint only helps the eye find it. */
const LEVEL_CLASSES: Record<string, string> = {
    error: "bg-danger/20",
    warn: "bg-warning/30",
    info: "bg-primary/15",
    http: "bg-accent/20",
};

/** What is written in a line's level column: the level, or a marker for a line without one. */
export function levelLabel(entry: LogEntry): string {
    if (entry.level) {
        return entry.level.toUpperCase();
    }
    return entry.structured ? "—" : "RAW";
}

/** A line's `stack` (which is shown as lines of its own), and its other extra fields. */
export function splitExtra(extra: Record<string, unknown>): { stack: string | undefined; rest: Record<string, unknown> } {
    const { stack, ...rest } = extra;
    return typeof stack === "string" ? { stack, rest } : { stack: undefined, rest: extra };
}

export function LevelBadge({ entry }: { entry: LogEntry }) {
    return (
        <span
            className={`inline-block w-16 shrink-0 rounded-sm px-1 text-center font-semibold ${LEVEL_CLASSES[entry.level] ?? "bg-surface"}`}
        >
            {levelLabel(entry)}
        </span>
    );
}

function LogRow({ entry }: { entry: LogEntry }) {
    const { stack, rest } = splitExtra(entry.extra);
    return (
        <div className="py-0.5 break-words">
            <span className="text-text-muted">{entryTime(entry)}</span> <LevelBadge entry={entry} /> <span className="whitespace-pre-wrap">{entry.message}</span>
            {Object.keys(rest).length > 0 && <span className="text-text-muted"> {JSON.stringify(rest)}</span>}
            {stack !== undefined && <div className="whitespace-pre-wrap pl-4 text-text-muted">{stack}</div>}
        </div>
    );
}

export interface LogViewerProps {
    /** The lines to show, oldest first; only the last `LOG_VISIBLE_ROWS` are put in the page. */
    entries: LogEntry[];
    /** Whether the view stays scrolled to the newest line. */
    follow: boolean;
    /** Said when there is nothing to show. */
    empty: string;
}

/** The lines, as monospace text in a scrolling box. The box is a live log region, but not announced line by line. */
export default function LogViewer({ entries, follow, empty }: LogViewerProps) {
    const box = useRef<HTMLDivElement>(null);
    const shown = entries.slice(-LOG_VISIBLE_ROWS);

    useEffect(() => {
        if (follow) {
            // Mounted by the time an effect runs.
            box.current!.scrollTop = box.current!.scrollHeight;
        }
    }, [shown.length, entries[entries.length - 1]?.id, follow]);

    return (
        <div
            ref={box}
            role="log"
            aria-label="Server log"
            aria-live="off"
            tabIndex={0}
            className="h-[28rem] overflow-auto rounded-md border border-border bg-surface-alt p-2 font-mono text-xs"
        >
            {shown.length === 0 ? <p className="text-text-muted">{empty}</p> : shown.map((entry) => <LogRow key={entry.id} entry={entry} />)}
        </div>
    );
}
