// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../../lib/util/api.js";
import { describeSendFailure } from "../../../lib/mail/sendFailure.js";

const FALLBACK = "Could not send this message.";

function failure(body: unknown, message = "The message could not be delivered.") {
    return describeSendFailure(new ApiRequestError(message, 502, "api-500", body), FALLBACK);
}

describe("describeSendFailure", () => {
    it("falls back to the given message, with no details, for an error that did not come from the API", () => {
        expect(describeSendFailure(new TypeError("network down"), FALLBACK)).toEqual({ message: FALLBACK, lines: [] });
        expect(describeSendFailure("boom", FALLBACK)).toEqual({ message: FALLBACK, lines: [] });
    });

    it("keeps the server's message and has no lines when the response had no body or nothing beyond its message", () => {
        expect(failure(undefined)).toEqual({ message: "The message could not be delivered.", lines: [] });
        expect(failure("plain text")).toEqual({ message: "The message could not be delivered.", lines: [] });
        expect(failure({ message: "The message could not be delivered.", code: "api-500", status: 502 }).lines).toEqual([]);
    });

    it("lists a per-recipient result on one line each, then the transport error", () => {
        const result = failure({
            message: "The message could not be delivered.",
            code: "api-500",
            details: {
                recipients: [
                    { address: "x@example.com", smtpCode: 550, enhancedStatus: "5.1.1", response: "No such user here", accepted: false },
                    { address: "y@example.com", smtpCode: 452, response: "Mailbox full", note: "", extra: null },
                ],
                transportError: "connect ECONNREFUSED 10.0.0.5:25",
                attempts: 3,
            },
        });
        expect(result.lines).toEqual([
            "recipients 1: address=x@example.com smtpCode=550 enhancedStatus=5.1.1 response=No such user here accepted=false",
            "recipients 2: address=y@example.com smtpCode=452 response=Mailbox full",
            "transportError: connect ECONNREFUSED 10.0.0.5:25",
            "attempts: 3",
        ]);
    });

    it("renders a nested object as its pairs, a list of plain values by position, and skips empty and envelope keys", () => {
        const result = failure({
            details: {
                transport: { host: "mx.example.com", port: 25, tls: { version: "1.3" } },
                rejected: ["x@example.com", 42],
                empty: "",
                nothing: null,
                missing: undefined,
                message: "not repeated",
                code: "not repeated either",
            },
        });
        expect(result.lines).toEqual([
            'transport: host=mx.example.com port=25 tls={"version":"1.3"}',
            "rejected 1: x@example.com",
            "rejected 2: 42",
        ]);
    });

    it("shows an empty entry of a details list as just its label", () => {
        expect(failure({ details: [null, undefined] }).lines).toEqual(["detail 1: ", "detail 2: "]);
    });

    it("reads a details list, and a plain-text details", () => {
        expect(failure({ details: [{ address: "x@example.com", code: 550 }, "second"] }).lines).toEqual([
            "detail 1: address=x@example.com code=550",
            "detail 2: second",
        ]);
        expect(failure({ details: "Relay access denied" }).lines).toEqual(["details: Relay access denied"]);
    });

    it("falls back to the body's other fields when there is no details field at all, or an empty one", () => {
        expect(failure({ message: "m", recipients: [{ address: "x@example.com", smtpCode: 550 }] }).lines).toEqual([
            "recipients 1: address=x@example.com smtpCode=550",
        ]);
        expect(failure({ message: "m", details: null, reason: "bounced" }).lines).toEqual(["reason: bounced"]);
        expect(failure({ message: "m", details: "", reason: "bounced" }).lines).toEqual(["reason: bounced"]);
    });

    it("caps the number of lines and the length of each", () => {
        const many = failure({ details: { rejected: Array.from({ length: 80 }, (_, i) => `r${i}@example.com`) } });
        expect(many.lines).toHaveLength(50);

        const long = failure({ details: { transcript: "x".repeat(2000) } });
        expect(long.lines[0]).toBe(`transcript: ${"x".repeat(488)}...`);
        expect(long.lines[0]).toHaveLength(503);
    });
});
