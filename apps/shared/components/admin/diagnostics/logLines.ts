///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The levels of the server's logger (Winston's npm levels), most severe first. */
export const LOG_LEVELS = ["error", "warn", "info", "http", "verbose", "debug", "silly"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** One line of the server's log stream. */
export interface LogEntry {
    /** Counts up from 1 in the order lines arrived; unique for the life of the stream. */
    id: number;
    /** When this page received it (`Date.now()`). */
    receivedAt: number;
    /** The level as the server wrote it (lower-cased, without colour codes); empty when it wrote none. */
    level: string;
    message: string;
    /** As the server wrote it, when it did. */
    timestamp?: string;
    /** Every other field the server logged with the line (`label`, `service`, `stack`, ...). */
    extra: Record<string, unknown>;
    /** The frame as one line of JSON: what the `.ndjson` download holds. */
    json: string;
    /** Whether the frame was JSON. A frame that was not is shown as it came, with no level. */
    structured: boolean;
}

/** What a frame is, when it is the server's own control message and not a log line. */
export interface ControlFrame {
    control: true;
    success: boolean;
    data: unknown;
}

/** Colour codes a logger writes around a level (`\u001b[32minfo\u001b[39m`). */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

/** A field's value as text: a string as it is, nothing as empty, anything else as JSON. */
function textOf(value: unknown): string {
    if (typeof value === "string") {
        return stripAnsi(value);
    }
    return value === undefined ? "" : JSON.stringify(value);
}

/**
 * Reads one frame of the log stream. It is the control message (`{"id":0,"type":"SUBSCRIBED","success":true,...}`), a Winston
 * `info` object (the JSON of `level`, `message` and whatever else was logged with them), or - since the server's logger can write
 * anything - text that is not JSON at all. Whatever it is, the frame is never refused: a missing field is left empty.
 */
export function parseLogFrame(raw: string, id: number, receivedAt: number): LogEntry | ControlFrame {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        parsed = undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {
            id,
            receivedAt,
            level: "",
            message: stripAnsi(raw),
            extra: {},
            json: JSON.stringify({ raw }),
            structured: false,
        };
    }
    const frame = parsed as Record<string, unknown>;
    if (frame.type === "SUBSCRIBED" && frame.level === undefined) {
        return { control: true, success: frame.success !== false, data: frame.data };
    }
    const { level, message, timestamp, ...extra } = frame;
    return {
        id,
        receivedAt,
        level: textOf(level).toLowerCase(),
        message: textOf(message),
        timestamp: typeof timestamp === "string" ? timestamp : undefined,
        extra,
        json: JSON.stringify(frame),
        structured: true,
    };
}

export const isControlFrame = (frame: LogEntry | ControlFrame): frame is ControlFrame => "control" in frame;

/** When a line happened: what the server stamped it with, else when this page received it. */
export function entryTime(entry: LogEntry): string {
    return entry.timestamp ?? new Date(entry.receivedAt).toISOString();
}

/** `<timestamp> <LEVEL> <message>`: the line of a `.log` download. A line with no level has none written. */
export function formatLogLine(entry: LogEntry): string {
    return [entryTime(entry), entry.level.toUpperCase(), entry.message].filter((part) => part !== "").join(" ");
}

/** The text of a `.log` download: one formatted line for each entry. */
export function entriesToLog(entries: LogEntry[]): string {
    return entries.map((entry) => formatLogLine(entry).replace(/\r?\n/g, " ↵ ")).join("\n") + "\n";
}

/** The text of an `.ndjson` download: each frame as one line of JSON. */
export function entriesToNdjson(entries: LogEntry[]): string {
    return entries.map((entry) => entry.json).join("\n") + "\n";
}

/** Whether `entry` is one of `levels`. A line with no known level (text that was not JSON, an unusual level) is always kept. */
export function levelVisible(entry: LogEntry, levels: ReadonlySet<string>): boolean {
    return !(LOG_LEVELS as readonly string[]).includes(entry.level) || levels.has(entry.level);
}

/** Whether `entry` contains `needle` (already lower-cased) in its time, level, message or other fields. */
export function entryMatches(entry: LogEntry, needle: string): boolean {
    if (needle === "") {
        return true;
    }
    const extra = Object.keys(entry.extra).length > 0 ? JSON.stringify(entry.extra) : "";
    return `${formatLogLine(entry)} ${extra}`.toLowerCase().includes(needle);
}
