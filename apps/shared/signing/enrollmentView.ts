///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { EnrollmentResult, SignEnrollmentStage, SignEnrollmentStep } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import type { SigningEnrollmentInfo } from "./signingInfo.js";

/** Warn about an expiring certificate this many days ahead. */
export const EXPIRY_WARNING_DAYS = 30;

const DAY_MS = 86_400_000;

/** Epoch ms of a date the server sent, or `undefined` for a missing or unparseable one. */
export function timeOf(value: string | number | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const time = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(time) ? time : undefined;
}

/** "just now", "20 s ago", "3 min ago", "2 h ago", "4 days ago" - `undefined` when there is no date. A time slightly in the future (clock skew) is "just now". */
export function relativeTime(value: string | number | undefined, now: number): string | undefined {
    const time = timeOf(value);
    if (time === undefined) {
        return undefined;
    }
    const seconds = Math.max(0, Math.floor((now - time) / 1000));
    if (seconds < 5) {
        return "just now";
    }
    if (seconds < 60) {
        return `${seconds} s ago`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    const days = Math.floor(hours / 24);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** A calendar date in the reader's language ("21 Sep 2027"); the raw text if it is not a date. */
export function formatDate(value: string | number | undefined): string {
    const time = timeOf(value);
    if (time === undefined) {
        return typeof value === "string" ? value : "";
    }
    return new Date(time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A date and time for a step's timestamp. */
export function formatDateTime(value: string | number | undefined): string {
    const time = timeOf(value);
    if (time === undefined) {
        return typeof value === "string" ? value : "";
    }
    return new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A long serial number as `0A1B2C3D...9F8E7D` (the whole value is what gets copied). */
export function truncateSerial(serial: string, keep = 8): string {
    return serial.length > keep * 2 + 3 ? `${serial.slice(0, keep)}...${serial.slice(-keep)}` : serial;
}

export type ExpiryState = "ok" | "soon" | "expired" | "unknown";

/** How long a certificate has left: `soon` inside `EXPIRY_WARNING_DAYS`, `expired` once past. */
export function expiryOf(notAfter: string | number | undefined, now: number): { state: ExpiryState; daysLeft?: number } {
    const time = timeOf(notAfter);
    if (time === undefined) {
        return { state: "unknown" };
    }
    if (time <= now) {
        return { state: "expired", daysLeft: 0 };
    }
    const daysLeft = Math.ceil((time - now) / DAY_MS);
    return { state: daysLeft <= EXPIRY_WARNING_DAYS ? "soon" : "ok", daysLeft };
}

/** The order the server's steps normally go in, with the words for a server that names a stage but not the steps. */
const STAGE_STEPS: { stage: SignEnrollmentStage; label: string }[] = [
    { stage: "submitted", label: "Request sent to the certificate authority" },
    { stage: "awaiting-challenge", label: "Verification e-mail from the CA" },
    { stage: "challenge-answered", label: "Verification answered" },
    { stage: "validating", label: "CA validates the answer" },
    { stage: "issuing", label: "Certificate issued and installed" },
];

/** What each stage means, for the line under the bar. */
const STAGE_TEXT: Record<SignEnrollmentStage, string> = {
    submitted: "Request sent - waiting for the certificate authority to answer",
    "awaiting-challenge": "Waiting for the CA's verification e-mail",
    "challenge-answered": "Verification answered - waiting for the certificate",
    validating: "The CA is validating the answer",
    issuing: "The certificate is being issued",
    issued: "Issued",
    failed: "Failed",
};

/**
 * The steps to draw: the server's own `stages` when it sent them, else - for a server that only says which `stage` it is at - the usual five
 * with everything before it done and it active, else none (an older server: the card falls back to a plain sentence).
 */
export function stepsOf(result: EnrollmentResult | null | undefined): SignEnrollmentStep[] {
    if (!result) {
        return [];
    }
    if (result.stages && result.stages.length > 0) {
        return result.stages;
    }
    if (!result.stage) {
        return [];
    }
    const index = STAGE_STEPS.findIndex((step) => step.stage === result.stage);
    const failed = result.stage === "failed" || result.status === "failed";
    const issued = result.stage === "issued" || result.status === "issued";
    // An issued enrollment has done every step; a failed one stopped at an unknown step, so none is claimed done or active.
    return STAGE_STEPS.map((step, position): SignEnrollmentStep => {
        if (issued) {
            return { id: step.stage, label: step.label, state: "done" };
        }
        if (failed || index === -1) {
            return { id: step.stage, label: step.label, state: "pending" };
        }
        return { id: step.stage, label: step.label, state: position < index ? "done" : position === index ? "active" : "pending" };
    });
}

/** The percentage the bar shows: the server's `progress`, else what the steps say (done steps out of all), else `undefined` - unknown. */
export function progressOf(result: EnrollmentResult | null | undefined): number | undefined {
    if (!result) {
        return undefined;
    }
    if (typeof result.progress === "number") {
        return Math.round(result.progress);
    }
    if (result.status === "issued") {
        return 100;
    }
    const steps = stepsOf(result);
    return steps.length > 0 ? Math.round((steps.filter((step) => step.state === "done").length / steps.length) * 100) : undefined;
}

/** The step doing the work now, if any. */
export function activeStepOf(result: EnrollmentResult | null | undefined): SignEnrollmentStep | undefined {
    return stepsOf(result).find((step) => step.state === "active");
}

/**
 * A certificate that is issued but not in the mailbox yet: the server installs it with a job a few minutes after the CA issues it, and says when it
 * has (`installedAt`). An older server sends neither date, so its issued certificates are never "installing".
 */
export function isInstalling(result: EnrollmentResult | null | undefined): boolean {
    return result?.status === "issued" && !!result.issuedAt && !result.installedAt;
}

/** What the server says about a CA it could not reach: still pending, to be retried - not a failure. */
export const CA_UNREACHABLE_TEXT = "The certificate authority could not be reached just now - it will be asked again.";

/** The plain-language line: what the enrollment is waiting for, when it was issued, why it failed. `undefined` when the server said nothing to go on. */
export function statusLineOf(result: EnrollmentResult | null | undefined): string | undefined {
    if (!result) {
        return undefined;
    }
    if (result.status === "issued") {
        if (isInstalling(result)) {
            return "Issued - installing it on your mailbox (this takes a few minutes)";
        }
        return result.notAfter ? `Issued - valid until ${formatDate(result.notAfter)}` : "Issued";
    }
    if (result.status === "failed") {
        return `Failed: ${result.error ?? "the certificate authority did not issue a certificate."}`;
    }
    return result.stage ? STAGE_TEXT[result.stage] : undefined;
}

/** What a pending request says when the server has not said how it issues certificates (an older server): nothing that is only true of one way of issuing them. */
export const PENDING_FALLBACK_TEXT = "Requested - waiting for the certificate. Use Check status to see where the request is.";

/** A manual deployment: nobody but an administrator can make the certificate. Never "takes effect automatically". */
export const MANUAL_ISSUE_TEXT = "This server issues signing certificates manually: an administrator has to upload the certificate for your request. Contact your administrator.";

/** The enrollment id the browser kept is one the server does not know any more (another provider after a configuration change, a cancelled request). */
export const STALE_REQUEST_TEXT = "This request is no longer active - request a new certificate.";

/** How a request is being turned into a certificate: by a public CA on its own, by an administrator, or not known. The enrollment's own `provider` wins over what the deployment says now. */
export type IssueMode = "automatic" | "manual" | "unknown";

export function issueModeOf(result: EnrollmentResult | null | undefined, info: SigningEnrollmentInfo | null | undefined): IssueMode {
    const provider = result?.provider;
    if (provider === "manual" || (!provider && info?.backend === "manual")) {
        return "manual";
    }
    if (provider === "rfc8823" || (!provider && info?.automatic)) {
        return "automatic";
    }
    return "unknown";
}

function minutes(count: number): string {
    return `${count} ${count === 1 ? "minute" : "minutes"}`;
}

/** "Requested from ca.example. The CA sends a verification e-mail to jane@example.com; this usually takes about 5 minutes." - each part only as far as it is known. */
export function requestedFromText(info: SigningEnrollmentInfo | null | undefined, address: string | undefined): string {
    const host = info?.ca?.host ? `Requested from ${info.ca.host}.` : "Requested from the certificate authority.";
    const sentence = `The CA sends a verification e-mail to ${address ?? "this mailbox"}`;
    const duration = info?.typicalDurationMinutes ? `; this usually takes about ${minutes(info.typicalDurationMinutes)}` : "";
    return `${host} ${sentence}${duration}.`;
}

/** What to say before anyone has asked for a certificate: how this deployment will issue it (or that it does not). `undefined` when nothing is known. */
export function beforeRequestText(info: SigningEnrollmentInfo | null | undefined, address: string | undefined): string | undefined {
    if (!info || info.backend === "none") {
        return info ? "This server does not issue signing certificates." : undefined;
    }
    if (info.backend === "manual") {
        return MANUAL_ISSUE_TEXT;
    }
    const from = info.ca?.host ?? "a public certificate authority";
    const duration = info.typicalDurationMinutes ? `, usually within about ${minutes(info.typicalDurationMinutes)}` : "";
    return `A certificate is issued automatically by ${from}: it sends a verification e-mail to ${address ?? "this mailbox"}${duration}.`;
}

/** The warning when the CA has been reporting a problem: what it said and when it last worked. `undefined` when it has not. */
export function healthWarning(info: SigningEnrollmentInfo | null | undefined): string | undefined {
    const error = info?.health?.lastError;
    if (!error) {
        return undefined;
    }
    const last = info.health!.lastSuccessAt ? formatDateTime(info.health!.lastSuccessAt) : "never";
    return `The certificate authority reported a problem: ${error} (last successful contact ${last})`;
}

/** A pending request is "taking longer than expected" after this long without a change. */
export const OVERDUE_AFTER_MS = 60 * 60_000;

/** Whether a pending request was made more than an hour ago and nothing has changed in the last hour: say so instead of staying silent. */
export function isOverdue(result: EnrollmentResult | null | undefined, now: number): boolean {
    if (result?.status !== "pending") {
        return false;
    }
    const requested = timeOf(result.requestedAt);
    const changed = timeOf(result.updatedAt) ?? requested;
    return requested !== undefined && changed !== undefined && now - requested > OVERDUE_AFTER_MS && now - changed > OVERDUE_AFTER_MS;
}
