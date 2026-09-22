///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { isAbortError } from "./apiErrors.js";
import { notify } from "./store.js";

/** The one key every unexpected failure shares: a page that throws in a loop is one pop-up with a count, never a flood. */
export const SYSTEM_ERROR_KEY = "system-error";

/** Browsers report this harmless layout notice through `error` events; it is not something wrong. */
const IGNORED_MESSAGE = /ResizeObserver loop/i;

/** The lines of a stack worth showing: the first few. */
function stackLines(error: unknown): string[] {
    return error instanceof Error && error.stack ? error.stack.split("\n").slice(0, 6).map((line) => line.trim()) : [];
}

/** Raises the "Something went wrong" pop-up for something nothing handled. Returns its id, or `""` when it is not worth showing. */
export function notifySystemError(error: unknown, where?: string): string {
    if (isAbortError(error)) {
        return "";
    }
    // An unhandled request that was refused for a session that ended is already the "session expired" pop-up.
    if (error instanceof ApiRequestError && error.status === 401) {
        return "";
    }
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (IGNORED_MESSAGE.test(message)) {
        return "";
    }
    const lines = [message ? `${error instanceof Error ? error.name : "Error"}: ${message}` : "An error without a message", ...stackLines(error)];
    return notify({
        kind: "error",
        title: "Something went wrong",
        message: "An unexpected error happened. Your work is unaffected unless something on the page stopped responding; reloading the page is safe.",
        details: where ? [`Where: ${where}`, ...lines] : lines,
        dedupeKey: SYSTEM_ERROR_KEY,
    });
}

/**
 * Catches what nothing else did - an unhandled promise rejection or an uncaught error anywhere on the page - and shows one
 * "Something went wrong" pop-up with the details, however many follow. Mounted once, in the app frame.
 */
export function useSystemErrorNotifications(): void {
    useEffect(() => {
        function handleError(event: ErrorEvent) {
            notifySystemError(event.error ?? event.message, event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined);
        }
        function handleRejection(event: PromiseRejectionEvent) {
            notifySystemError(event.reason, "unhandled promise rejection");
        }
        window.addEventListener("error", handleError);
        window.addEventListener("unhandledrejection", handleRejection);
        return () => {
            window.removeEventListener("error", handleError);
            window.removeEventListener("unhandledrejection", handleRejection);
        };
    }, []);
}
