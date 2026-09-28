///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiRequestError } from "../util/api.js";

/** A failed send, ready to show: the plain `message`, and the technical `lines` behind it (none when the server said no more). */
export interface SendFailure {
    message: string;
    /** One line per fact the server gave - a per-recipient SMTP result, a transport error - as `key: value` text. Empty
     * when the response carried nothing beyond its message. */
    lines: string[];
}

/** Keys of an error body that are the message and its bookkeeping, not details. */
const ENVELOPE_KEYS = new Set(["message", "error", "code", "status", "statusCode", "name", "stack"]);

/** The most lines, and the longest line, one failure is reduced to - a transport can put a whole SMTP transcript in a field. */
const MAX_LINES = 50;
const MAX_LINE_LENGTH = 500;

function clip(text: string): string {
    return text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}...` : text;
}

function scalar(value: unknown): string {
    if (value === null || value === undefined) {
        return "";
    }
    return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** An object as `key=value key=value` - one recipient's result on one line. */
function pairs(item: Record<string, unknown>): string {
    return Object.entries(item)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${scalar(value)}`)
        .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function itemLines(label: string, items: unknown[]): string[] {
    return items.map((item, index) => {
        const text = isRecord(item) ? pairs(item) : scalar(item);
        return `${label} ${index + 1}: ${text}`;
    });
}

/** The lines of one details object: each scalar as `key: value`, each list as one `key N: ...` line per entry, a nested
 * object as its `key=value` pairs. */
function objectLines(details: Record<string, unknown>): string[] {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(details)) {
        if (ENVELOPE_KEYS.has(key) || value === undefined || value === null || value === "") {
            continue;
        }
        if (Array.isArray(value)) {
            lines.push(...itemLines(key, value));
        } else if (isRecord(value)) {
            lines.push(`${key}: ${pairs(value)}`);
        } else {
            lines.push(`${key}: ${scalar(value)}`);
        }
    }
    return lines;
}

/**
 * Turns whatever a failed send threw into something a compose window can show. `message` is the server's own
 * (the error's message, else `fallback`); `lines` are the structured `details` the send endpoint adds to its error body
 * - typically per-recipient SMTP codes, enhanced status codes, the remote server's response text and any transport
 * error. That shape is not fixed, so this reads it defensively: the body's `details` (an object or a list), or, without
 * one, whatever else the body carries besides its message and code. Nothing is assumed, nothing throws, and a response
 * with no details gives no lines - the caller then shows the message alone.
 */
export function describeSendFailure(err: unknown, fallback: string): SendFailure {
    if (!(err instanceof ApiRequestError)) {
        return { message: fallback, lines: [] };
    }
    const body = err.details;
    let lines: string[] = [];
    if (isRecord(body)) {
        const details = body.details;
        if (Array.isArray(details)) {
            lines = itemLines("detail", details);
        } else if (isRecord(details)) {
            lines = objectLines(details);
        } else if (details !== undefined && details !== null && details !== "") {
            lines = [`details: ${scalar(details)}`];
        } else {
            lines = objectLines(body);
        }
    }
    return { message: err.message, lines: lines.slice(0, MAX_LINES).map(clip) };
}
