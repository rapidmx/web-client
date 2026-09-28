// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { describeSendEventError, parseSendEvent } from "../../../lib/mail/sendEvents.js";

function event(action: string, data: unknown, type = "MessageMongo") {
    return { type, action, data };
}

describe("parseSendEvent", () => {
    it("reads a send-succeeded event", () => {
        expect(
            parseSendEvent(
                event("send-succeeded", { uid: "m1", mailboxUid: "mb1", subject: "Hello", recipients: ["a@example.com", 7, "b@example.com"], attempt: 2 }),
            ),
        ).toEqual({
            action: "send-succeeded",
            uid: "m1",
            mailboxUid: "mb1",
            subject: "Hello",
            recipients: ["a@example.com", "b@example.com"],
            attempt: 2,
            nextAttemptAt: undefined,
            error: undefined,
        });
    });

    it("reads a retrying event's next attempt and a failed event's error", () => {
        const retrying = parseSendEvent(
            event("send-retrying", { uid: "m1", subject: "S", recipients: [], attempt: 1, nextAttemptAt: "2026-09-21T10:00:00.000Z", error: { message: "timeout" } }, "MessageSQL"),
        );
        expect(retrying).toMatchObject({ action: "send-retrying", nextAttemptAt: "2026-09-21T10:00:00.000Z", error: { message: "timeout", details: undefined } });
        const failed = parseSendEvent(event("send-failed", { uid: "m1", error: { message: "rejected", details: [{ recipient: "a@b.c", code: 550 }] } }));
        expect(failed?.error).toEqual({ message: "rejected", details: [{ recipient: "a@b.c", code: 550 }] });
    });

    it("defaults what is missing or malformed", () => {
        const parsed = parseSendEvent(event("send-failed", { uid: "m1", attempt: "x", subject: 3, recipients: "nope", error: { details: [] } }));
        expect(parsed).toMatchObject({ subject: "", recipients: [], attempt: 1, error: { message: "", details: [] } });
        expect(parseSendEvent(event("send-failed", { uid: "m1", attempt: 0 }))?.attempt).toBe(1);
        expect(parseSendEvent(event("send-failed", { uid: "m1", attempt: 2.9 }))?.attempt).toBe(2);
        expect(parseSendEvent(event("send-failed", { uid: "m1", error: "boom" }))?.error).toBeUndefined();
    });

    it("ignores everything that is not a well-formed send outcome", () => {
        expect(parseSendEvent(event("create", { uid: "m1" }))).toBeUndefined();
        expect(parseSendEvent({ type: "MessageMongo", data: { uid: "m1" } })).toBeUndefined();
        expect(parseSendEvent(event("send-failed", { uid: "m1" }, "FolderMongo"))).toBeUndefined();
        expect(parseSendEvent(event("send-failed", { subject: "no uid" }))).toBeUndefined();
        expect(parseSendEvent(event("send-failed", null))).toBeUndefined();
        expect(parseSendEvent(event("send-failed", undefined))).toBeUndefined();
    });
});

describe("describeSendEventError", () => {
    it("uses the fallback when there is no error", () => {
        expect(describeSendEventError(undefined, "It failed.")).toEqual({ message: "It failed.", lines: [] });
    });

    it("gives the message and the technical lines of the details, as a synchronous failure does", () => {
        const failure = describeSendEventError({ message: "Some recipients were refused.", details: [{ recipient: "a@b.c", code: 550 }] }, "x");
        expect(failure.message).toBe("Some recipients were refused.");
        expect(failure.lines).toEqual(["detail 1: recipient=a@b.c code=550"]);
    });

    it("falls back to the fallback message when the error has none, and reads details given as an object", () => {
        expect(describeSendEventError({ message: "" }, "Could not send.")).toEqual({ message: "Could not send.", lines: [] });
        expect(describeSendEventError({ message: "m", details: { transport: "smtp", response: "421" } }, "x").lines).toEqual(["transport: smtp", "response: 421"]);
    });
});
