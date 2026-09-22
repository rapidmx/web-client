///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { notifyApiError, notifySessionExpired, setSignInUrl } from "../../../apps/shared/notifications/apiErrors.js";
import { notifySystemError, SYSTEM_ERROR_KEY } from "../../../apps/shared/notifications/systemErrors.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { mockLocation } from "../testUtils.js";

const visible = () => getNotificationsSnapshot().visible;

beforeEach(() => {
    setSignInUrl(undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("notifyApiError", () => {
    it("turns an ApiRequestError into one sticky error with the server's message, the status and the technical lines", () => {
        const err = new ApiRequestError("Some recipients were refused.", 502, "api-9", { details: [{ recipient: "a@b.c", code: 550 }] });
        const id = notifyApiError(err, "Couldn't move the message");
        expect(id).not.toBe("");
        expect(visible()[0]).toMatchObject({
            kind: "error",
            title: "Couldn't move the message",
            message: "Some recipients were refused.",
            sticky: true,
            details: ["Status: 502 (api-9)", "detail 1: recipient=a@b.c code=550"],
        });
    });

    it("shows a status without a code plainly, and a flapping error once with a count", () => {
        notifyApiError(new ApiRequestError("Nope", 500), "Couldn't archive");
        notifyApiError(new ApiRequestError("Nope again", 500), "Couldn't archive");
        expect(visible()).toHaveLength(1);
        expect(visible()[0]).toMatchObject({ count: 2, message: "Nope again", details: ["Status: 500"] });
        notifyApiError(new ApiRequestError("Other status", 503), "Couldn't archive");
        expect(visible()).toHaveLength(2);
    });

    it("takes extra actions and a dedupe key of the caller's", () => {
        notifyApiError(new ApiRequestError("x", 409), "Couldn't save", { actions: [{ label: "Reload" }], dedupeKey: "mine" });
        notifyApiError(new ApiRequestError("y", 409), "Couldn't save something else", { dedupeKey: "mine" });
        expect(visible()).toHaveLength(1);
        expect(visible()[0].actions.map((action) => action.label)).toEqual([]);
    });

    it("turns a 401 into 'Your session expired' with a Sign in action, once", () => {
        const location = mockLocation();
        location.href = "https://mail.example.com/mail?x=1";
        setSignInUrl("https://auth.example.com");
        notifyApiError(new ApiRequestError("Unauthorized", 401), "Couldn't save");
        notifyApiError(new ApiRequestError("Unauthorized", 401), "Couldn't move");
        expect(visible()).toHaveLength(1);
        expect(visible()[0]).toMatchObject({ title: "Your session expired", count: 2, sticky: true });
        visible()[0].actions[0].onClick!();
        expect(location.href).toBe("https://auth.example.com/auth/signin?return_to=" + encodeURIComponent("https://mail.example.com/mail?x=1"));
    });

    it("reloads the page for Sign in when no auth server is known", () => {
        const location = mockLocation();
        notifySessionExpired();
        visible()[0].actions[0].onClick!();
        expect(location.reload).toHaveBeenCalled();
    });

    it("says a request that never got an answer couldn't reach the server", () => {
        notifyApiError(new TypeError("Failed to fetch"), "Couldn't save the task");
        expect(visible()[0]).toMatchObject({
            title: "Couldn't save the task",
            message: "The server couldn't be reached. Check your connection and try again.",
            details: ["Failed to fetch"],
        });
        notifyApiError(new Error("Network request failed"), "Couldn't save the event");
        expect(visible()[1].message).toContain("couldn't be reached");
    });

    it("reports anything else as unexpected, with what it was", () => {
        notifyApiError(new RangeError("bad"), "Couldn't flag");
        notifyApiError("just a string", "Couldn't label");
        expect(visible()[0]).toMatchObject({ message: "Something unexpected went wrong.", details: ["RangeError: bad"] });
        expect(visible()[1]).toMatchObject({ details: ["just a string"] });
    });

    it("says nothing for a request that was cancelled", () => {
        const abort = new DOMException("Aborted", "AbortError");
        expect(notifyApiError(abort, "Couldn't load")).toBe("");
        expect(visible()).toEqual([]);
    });
});

describe("notifySystemError", () => {
    it("shows one 'Something went wrong' pop-up with the message and the top of the stack, however often it happens", () => {
        const error = new Error("kaboom");
        notifySystemError(error, "app.js:1:2");
        notifySystemError(error);
        notifySystemError("plain text failure");
        notifySystemError(undefined);
        expect(visible()).toHaveLength(1);
        expect(visible()[0]).toMatchObject({ title: "Something went wrong", count: 4, sticky: true });
        expect(SYSTEM_ERROR_KEY).toBe("system-error");
        expect(visible()[0].details).toEqual(["An error without a message"]);
    });

    it("lists where it happened and the stack lines", () => {
        notifySystemError(new Error("with stack"), "somewhere");
        expect(visible()[0].details[0]).toBe("Where: somewhere");
        expect(visible()[0].details[1]).toBe("Error: with stack");
        expect(visible()[0].details.length).toBeGreaterThan(2);
    });

    it("ignores what is not a problem: a cancelled request, an expired session (its own pop-up), a harmless layout notice", () => {
        expect(notifySystemError(new DOMException("x", "AbortError"))).toBe("");
        expect(notifySystemError(new ApiRequestError("Unauthorized", 401))).toBe("");
        expect(notifySystemError("ResizeObserver loop completed with undelivered notifications.")).toBe("");
        expect(notifySystemError(new ApiRequestError("Server error", 500))).not.toBe("");
    });
});
