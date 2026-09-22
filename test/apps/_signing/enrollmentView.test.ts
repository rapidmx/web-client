// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    CA_UNREACHABLE_TEXT,
    MANUAL_ISSUE_TEXT,
    OVERDUE_AFTER_MS,
    PENDING_FALLBACK_TEXT,
    STALE_REQUEST_TEXT,
    activeStepOf,
    expiryOf,
    formatDate,
    beforeRequestText,
    formatDateTime,
    healthWarning,
    isInstalling,
    isOverdue,
    issueModeOf,
    progressOf,
    requestedFromText,
    relativeTime,
    statusLineOf,
    stepsOf,
    timeOf,
    truncateSerial,
} from "../../../apps/shared/signing/enrollmentView.js";

const NOW = Date.parse("2026-09-21T12:00:00Z");

describe("timeOf", () => {
    it("reads ISO dates and epoch numbers, and nothing else", () => {
        expect(timeOf("2026-09-21T12:00:00Z")).toBe(NOW);
        expect(timeOf(NOW)).toBe(NOW);
        expect(timeOf(undefined)).toBeUndefined();
        expect(timeOf("not a date")).toBeUndefined();
    });
});

describe("relativeTime", () => {
    it.each([
        [0, "just now"],
        [4_000, "just now"],
        [-30_000, "just now"],
        [20_000, "20 s ago"],
        [180_000, "3 min ago"],
        [2 * 3_600_000, "2 h ago"],
        [86_400_000, "1 day ago"],
        [4 * 86_400_000, "4 days ago"],
    ])("says how long ago for %i ms", (ago, expected) => {
        expect(relativeTime(NOW - ago, NOW)).toBe(expected);
    });

    it("has nothing to say without a date", () => {
        expect(relativeTime(undefined, NOW)).toBeUndefined();
        expect(relativeTime("garbage", NOW)).toBeUndefined();
    });
});

describe("dates and serial numbers", () => {
    it("formats a date and a date-time, and falls back to the raw text (or nothing) for a value that is not one", () => {
        expect(formatDate("2027-09-21T12:00:00Z")).toMatch(/2027/);
        expect(formatDateTime("2026-09-21T12:00:00Z")).toMatch(/Sep|9/);
        expect(formatDate("soon")).toBe("soon");
        expect(formatDateTime("soon")).toBe("soon");
        expect(formatDate(undefined)).toBe("");
        expect(formatDateTime(undefined)).toBe("");
    });

    it("shortens a long serial number and leaves a short one whole", () => {
        expect(truncateSerial("0A1B2C3D4E5F60718293A4B5C6D7E8F9")).toBe("0A1B2C3D...C6D7E8F9");
        expect(truncateSerial("0A1B2C3D4E5F60718293A4B5C6D7E8F9", 4)).toBe("0A1B...E8F9");
        expect(truncateSerial("1234ABCD")).toBe("1234ABCD");
    });
});

describe("expiryOf", () => {
    it("is unknown without a date, expired once past, soon inside 30 days and ok beyond", () => {
        expect(expiryOf(undefined, NOW)).toEqual({ state: "unknown" });
        expect(expiryOf(NOW - 1, NOW)).toEqual({ state: "expired", daysLeft: 0 });
        expect(expiryOf(NOW, NOW)).toEqual({ state: "expired", daysLeft: 0 });
        expect(expiryOf(NOW + 5 * 86_400_000, NOW)).toEqual({ state: "soon", daysLeft: 5 });
        expect(expiryOf(NOW + 30 * 86_400_000, NOW)).toEqual({ state: "soon", daysLeft: 30 });
        expect(expiryOf(NOW + 31 * 86_400_000, NOW)).toEqual({ state: "ok", daysLeft: 31 });
    });
});

describe("stepsOf, progressOf and activeStepOf", () => {
    it("uses the server's own steps", () => {
        const stages = [
            { id: "a", label: "A", state: "done" as const },
            { id: "b", label: "B", state: "active" as const },
        ];
        expect(stepsOf({ status: "pending", stages })).toBe(stages);
        expect(activeStepOf({ status: "pending", stages })?.id).toBe("b");
        expect(progressOf({ status: "pending", stages })).toBe(50);
    });

    it("builds the usual five from a stage alone: earlier ones done, that one active, later ones waiting", () => {
        const steps = stepsOf({ status: "pending", stage: "challenge-answered" });
        expect(steps.map((step) => step.state)).toEqual(["done", "done", "active", "pending", "pending"]);
        expect(activeStepOf({ status: "pending", stage: "challenge-answered" })?.label).toBe("Verification answered");
        expect(progressOf({ status: "pending", stage: "challenge-answered" })).toBe(40);
    });

    it("has every step done for an issued enrollment, and none claimed for a failed one or a stage that is not a step", () => {
        expect(stepsOf({ status: "issued", stage: "issued" }).every((step) => step.state === "done")).toBe(true);
        expect(stepsOf({ status: "issued", stage: "issuing" }).every((step) => step.state === "done")).toBe(true);
        expect(stepsOf({ status: "failed", stage: "failed" }).every((step) => step.state === "pending")).toBe(true);
        expect(stepsOf({ status: "failed", stage: "validating" }).every((step) => step.state === "pending")).toBe(true);
        expect(stepsOf({ status: "pending", stage: "issued" }).every((step) => step.state === "done")).toBe(true);
        expect(stepsOf({ status: "pending", stage: "failed" }).every((step) => step.state === "pending")).toBe(true);
    });

    it("has no steps for an older server's answer, an empty list or nothing", () => {
        expect(stepsOf({ status: "pending" })).toEqual([]);
        expect(stepsOf({ status: "pending", stages: [] })).toEqual([]);
        expect(stepsOf(null)).toEqual([]);
        expect(stepsOf(undefined)).toEqual([]);
        expect(activeStepOf({ status: "pending" })).toBeUndefined();
    });

    it("takes the server's progress (rounded), else 100 for an issued one, else what the steps say, else unknown", () => {
        expect(progressOf({ status: "pending", progress: 33.4 })).toBe(33);
        expect(progressOf({ status: "issued" })).toBe(100);
        expect(progressOf({ status: "pending" })).toBeUndefined();
        expect(progressOf(null)).toBeUndefined();
    });
});

describe("issueModeOf", () => {
    const info = (backend: "manual" | "rfc8823" | "none", automatic: boolean) => ({ backend, automatic, adminUpload: backend === "manual" });

    it("takes the enrollment's own provider first, then what the deployment says, else it does not know", () => {
        expect(issueModeOf({ status: "pending", provider: "manual" }, info("rfc8823", true))).toBe("manual");
        expect(issueModeOf({ status: "pending", provider: "rfc8823" }, info("manual", false))).toBe("automatic");
        expect(issueModeOf({ status: "pending" }, info("manual", false))).toBe("manual");
        expect(issueModeOf({ status: "pending" }, info("rfc8823", true))).toBe("automatic");
        expect(issueModeOf({ status: "pending" }, info("none", false))).toBe("unknown");
        expect(issueModeOf({ status: "pending" }, null)).toBe("unknown");
        expect(issueModeOf(null, undefined)).toBe("unknown");
    });
});

describe("the words that follow the deployment", () => {
    it("says where a request went, in as much detail as is known", () => {
        expect(requestedFromText({ backend: "rfc8823", automatic: true, adminUpload: false, ca: { host: "ca.example" }, typicalDurationMinutes: 5 }, "jane@example.com")).toBe(
            "Requested from ca.example. The CA sends a verification e-mail to jane@example.com; this usually takes about 5 minutes.",
        );
        expect(requestedFromText({ backend: "rfc8823", automatic: true, adminUpload: false, typicalDurationMinutes: 1 }, undefined)).toBe(
            "Requested from the certificate authority. The CA sends a verification e-mail to this mailbox; this usually takes about 1 minute.",
        );
        expect(requestedFromText(null, "jane@example.com")).toBe("Requested from the certificate authority. The CA sends a verification e-mail to jane@example.com.");
    });

    it("says what to expect before anything has been asked for: nothing when it is not known, and that there is nothing when the server issues none", () => {
        expect(beforeRequestText(null, "a@b.c")).toBeUndefined();
        expect(beforeRequestText({ backend: "none", automatic: false, adminUpload: false }, "a@b.c")).toBe("This server does not issue signing certificates.");
        expect(beforeRequestText({ backend: "manual", automatic: false, adminUpload: true }, "a@b.c")).toBe(MANUAL_ISSUE_TEXT);
        expect(beforeRequestText({ backend: "rfc8823", automatic: true, adminUpload: false, ca: { host: "ca.example" }, typicalDurationMinutes: 10 }, "a@b.c")).toBe(
            "A certificate is issued automatically by ca.example: it sends a verification e-mail to a@b.c, usually within about 10 minutes.",
        );
        expect(beforeRequestText({ backend: "rfc8823", automatic: true, adminUpload: false }, undefined)).toBe(
            "A certificate is issued automatically by a public certificate authority: it sends a verification e-mail to this mailbox.",
        );
        expect(STALE_REQUEST_TEXT).toBe("This request is no longer active - request a new certificate.");
    });

    it("warns with what the CA reported and when it last worked, and only when it reported something", () => {
        expect(healthWarning(null)).toBeUndefined();
        expect(healthWarning({ backend: "rfc8823", automatic: true, adminUpload: false, health: { ok: true } })).toBeUndefined();
        expect(healthWarning({ backend: "rfc8823", automatic: true, adminUpload: false, health: { ok: false, lastError: "Down" } })).toBe(
            "The certificate authority reported a problem: Down (last successful contact never)",
        );
        expect(healthWarning({ backend: "rfc8823", automatic: true, adminUpload: false, health: { ok: false, lastError: "Down", lastSuccessAt: "2026-09-21T09:15:00Z" } })).toMatch(
            /^The certificate authority reported a problem: Down \(last successful contact .*\)$/,
        );
    });

    it("says a pending request is late after an hour with no change - the last change, else the request, counts - and nothing else is", () => {
        const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
        expect(OVERDUE_AFTER_MS).toBe(3_600_000);
        expect(isOverdue({ status: "pending", requestedAt: at(2 * 3_600_000), updatedAt: at(2 * 3_600_000) }, NOW)).toBe(true);
        expect(isOverdue({ status: "pending", requestedAt: at(2 * 3_600_000) }, NOW)).toBe(true);
        expect(isOverdue({ status: "pending", requestedAt: at(2 * 3_600_000), updatedAt: at(60_000) }, NOW)).toBe(false);
        expect(isOverdue({ status: "pending", requestedAt: at(30 * 60_000) }, NOW)).toBe(false);
        expect(isOverdue({ status: "pending" }, NOW)).toBe(false);
        expect(isOverdue({ status: "issued", requestedAt: at(2 * 3_600_000) }, NOW)).toBe(false);
        expect(isOverdue(null, NOW)).toBe(false);
    });
});

describe("statusLineOf", () => {
    it.each([
        ["submitted", "Request sent - waiting for the certificate authority to answer"],
        ["awaiting-challenge", "Waiting for the CA's verification e-mail"],
        ["challenge-answered", "Verification answered - waiting for the certificate"],
        ["validating", "The CA is validating the answer"],
        ["issuing", "The certificate is being issued"],
    ] as const)("says what %s means", (stage, text) => {
        expect(statusLineOf({ status: "pending", stage })).toBe(text);
    });

    it("says when it was issued or why it failed, and has nothing for a bare pending answer", () => {
        expect(statusLineOf({ status: "issued", notAfter: "2027-09-21T12:00:00Z" })).toMatch(/^Issued - valid until .*2027/);
        expect(statusLineOf({ status: "issued" })).toBe("Issued");
        expect(statusLineOf({ status: "failed", error: "The CA refused." })).toBe("Failed: The CA refused.");
        expect(statusLineOf({ status: "failed" })).toBe("Failed: the certificate authority did not issue a certificate.");
        expect(statusLineOf({ status: "pending" })).toBeUndefined();
        expect(statusLineOf(null)).toBeUndefined();
        expect(PENDING_FALLBACK_TEXT).toMatch(/^Requested/);
        expect(CA_UNREACHABLE_TEXT).toMatch(/could not be reached/);
    });

    it("says a certificate that is issued but not installed yet is being installed - and only for a server that says when it was issued", () => {
        expect(isInstalling({ status: "issued", issuedAt: "2026-09-21T10:00:00Z" })).toBe(true);
        expect(isInstalling({ status: "issued", issuedAt: "2026-09-21T10:00:00Z", installedAt: "2026-09-21T10:04:00Z" })).toBe(false);
        expect(isInstalling({ status: "issued" })).toBe(false);
        expect(isInstalling({ status: "pending", issuedAt: "2026-09-21T10:00:00Z" })).toBe(false);
        expect(isInstalling(null)).toBe(false);
        expect(statusLineOf({ status: "issued", issuedAt: "2026-09-21T10:00:00Z", notAfter: "2027-09-21T12:00:00Z" })).toBe("Issued - installing it on your mailbox (this takes a few minutes)");
        expect(statusLineOf({ status: "issued", issuedAt: "2026-09-21T10:00:00Z", installedAt: "2026-09-21T10:04:00Z", notAfter: "2027-09-21T12:00:00Z" })).toMatch(/^Issued - valid until/);
    });
});
