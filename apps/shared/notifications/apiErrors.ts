///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { describeSendFailure } from "@rapidmx/react-shared/mail/sendFailure.js";
import { NotificationAction, notify } from "./store.js";

/** Whether `err` is a request that was cancelled (`AbortError`) - by name, since a `DOMException` is not always an `Error` (jsdom's is not). */
export function isAbortError(err: unknown): boolean {
    return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/** Where "Sign in" goes: auth-server's base URL, set once by the app frame. Without one it reloads the page, which redirects when signed out. */
let signInBaseUrl: string | undefined;

export function setSignInUrl(authServerUrl: string | undefined): void {
    signInBaseUrl = authServerUrl;
}

/** The "Your session expired" pop-up: one however many requests noticed, with a "Sign in" action. Returns its id. */
export function notifySessionExpired(): string {
    return notify({
        kind: "error",
        title: "Your session expired",
        message: "Sign in again to keep working. Anything not yet saved in this tab is still here until you leave it.",
        dedupeKey: "session-expired",
        actions: [
            {
                label: "Sign in",
                onClick: () => {
                    if (signInBaseUrl) {
                        window.location.href = `${signInBaseUrl}/auth/signin?return_to=${encodeURIComponent(window.location.href)}`;
                    } else {
                        window.location.reload();
                    }
                },
            },
        ],
    });
}

export interface NotifyApiErrorOptions {
    /** Extra actions (a "Retry"). */
    actions?: NotificationAction[];
    /** Replaces the default key (`api:<context>:<status>`): errors with one key are one pop-up with a count. */
    dedupeKey?: string;
}

/** Whether `err` is a request that never got an answer (offline, DNS, a dropped connection) rather than an error response. */
function isNetworkFailure(err: unknown): boolean {
    return err instanceof TypeError || (err instanceof Error && /network|failed to fetch|load failed/i.test(err.message));
}

/**
 * Turns the failure of something the user did into an `error` pop-up and returns its id - or, for a `401`, into "Your session expired"
 * with a Sign in action, and for a request that was cancelled into nothing (`""`). `context` says what was being attempted, as the
 * pop-up's title ("Couldn't archive this message"); the message is the server's own, and its technical facts (`describeSendFailure()`'s
 * lines, the status and code) are the expandable details. The same failing thing repeating is one pop-up with a count.
 */
export function notifyApiError(err: unknown, context: string, options: NotifyApiErrorOptions = {}): string {
    if (isAbortError(err)) {
        return "";
    }
    if (err instanceof ApiRequestError) {
        if (err.status === 401) {
            return notifySessionExpired();
        }
        const failure = describeSendFailure(err, context);
        const facts = [`Status: ${err.status}${err.code ? ` (${err.code})` : ""}`, ...failure.lines];
        return notify({
            kind: "error",
            title: context,
            message: failure.message,
            details: facts,
            actions: options.actions,
            dedupeKey: options.dedupeKey ?? `api:${context}:${err.status}`,
        });
    }
    if (isNetworkFailure(err)) {
        return notify({
            kind: "error",
            title: context,
            message: "The server couldn't be reached. Check your connection and try again.",
            details: [(err as Error).message],
            actions: options.actions,
            dedupeKey: options.dedupeKey ?? `api:${context}:network`,
        });
    }
    return notify({
        kind: "error",
        title: context,
        message: "Something unexpected went wrong.",
        details: err instanceof Error ? [`${err.name}: ${err.message}`] : [String(err)],
        actions: options.actions,
        dedupeKey: options.dedupeKey ?? `api:${context}:unexpected`,
    });
}
