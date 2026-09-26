///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { isElevationRequired } from "../elevation.js";

/** What is shown where a number is missing or not a number. */
export const NO_VALUE = "—";

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** `1536` as `1.5 KiB` (binary units, as Kubernetes reports them). */
export function formatBytes(bytes: number | undefined): string {
    if (!isNumber(bytes)) {
        return NO_VALUE;
    }
    let value = Math.abs(bytes);
    let unit = 0;
    while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const text = unit === 0 || value >= 100 ? value.toFixed(0) : value.toFixed(1);
    return `${bytes < 0 ? "-" : ""}${text} ${BYTE_UNITS[unit]}`;
}

/** CPU as cores: `0.25 cores`, `1 core`, `4 cores`. */
export function formatCores(cores: number | undefined): string {
    if (!isNumber(cores)) {
        return NO_VALUE;
    }
    const text = cores >= 10 ? cores.toFixed(0) : String(Number(cores.toFixed(2)));
    return `${text} ${text === "1" ? "core" : "cores"}`;
}

/** `42.34` as `42.3%`. */
export function formatPercent(percent: number | undefined): string {
    return isNumber(percent) ? `${percent.toFixed(1)}%` : NO_VALUE;
}

/** `used` as a percentage of `capacity`, or `undefined` when either is missing or the capacity is not positive. */
export function percentOf(used: number | undefined, capacity: number | undefined): number | undefined {
    return isNumber(used) && isNumber(capacity) && capacity > 0 ? (used / capacity) * 100 : undefined;
}

/** Seconds as `3d 4h`, `4h 12m`, `12m 5s` or `5s`: the two largest units that are not zero. */
export function formatUptime(seconds: number | undefined): string {
    if (!isNumber(seconds) || seconds < 0) {
        return NO_VALUE;
    }
    const total = Math.floor(seconds);
    const parts: [number, string][] = [
        [Math.floor(total / 86400), "d"],
        [Math.floor((total % 86400) / 3600), "h"],
        [Math.floor((total % 3600) / 60), "m"],
        [total % 60, "s"],
    ];
    const start = parts.findIndex(([value]) => value > 0);
    if (start === -1) {
        return "0s";
    }
    return parts
        .slice(start, start + 2)
        .map(([value, unit]) => `${value}${unit}`)
        .join(" ");
}

/** A date as the viewer's local date and time, or a dash for a missing one (an unreadable one is shown as it came). */
export function formatDateTime(value: string | undefined): string {
    if (!value) {
        return NO_VALUE;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** `sha256:0123456789abcdef...` as `0123456789ab`. */
export function shortDigest(digest: string | undefined): string {
    return digest ? digest.replace(/^[a-z0-9]+:/i, "").slice(0, 12) : NO_VALUE;
}

/** Shown when the server wants the administrator to have confirmed their identity recently (`api-104`). */
export const ELEVATION_MESSAGE =
    "Diagnostics needs you to have recently confirmed your identity. Reload this page, or sign in again, then try once more.";

/** Shown for a 403 that is not about elevation, or a 401. */
export const NOT_AUTHORISED_MESSAGE = "You are not authorised to view diagnostics.";

/** Whether the caller is not (or no longer) allowed: retrying the same request would fail the same way. */
export function isPermissionError(err: unknown): boolean {
    return err instanceof ApiRequestError && (err.status === 403 || err.status === 401);
}

/** Why a request failed, in words for the administrator. */
export function describeError(err: unknown, fallback: string): string {
    if (isElevationRequired(err)) {
        return ELEVATION_MESSAGE;
    }
    if (isPermissionError(err)) {
        return NOT_AUTHORISED_MESSAGE;
    }
    return err instanceof ApiRequestError ? err.message || fallback : fallback;
}
