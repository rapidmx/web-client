///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineCheckCircle, HiOutlineExclamationTriangle, HiOutlineXCircle } from "react-icons/hi2";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import CopyButton from "@rapidmx/react-shared/components/buttons/CopyButton.js";
import type { EnrollmentResult, SignEnrollmentStep } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import type { EnrollmentSnapshot } from "../../signing/enrollmentTracker.js";
import type { SigningEnrollmentInfo } from "../../signing/signingInfo.js";
import {
    CA_UNREACHABLE_TEXT,
    MANUAL_ISSUE_TEXT,
    PENDING_FALLBACK_TEXT,
    expiryOf,
    formatDate,
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
} from "../../signing/enrollmentView.js";
import { useNow } from "../../signing/useNow.js";

export type SigningCertificateMode = "pending" | "issued" | "failed" | "expired";

export interface SigningCertificateCardProps {
    mode: SigningCertificateMode;
    /** What the server last said about the enrollment (the extended fields are all optional - an older server sends only `status`). */
    enrollment: EnrollmentResult | null;
    /** The tracker's view of it: busy flags, the check cooldown, the last check. Absent when nothing is being followed. */
    snapshot?: EnrollmentSnapshot;
    /** For an issued certificate when the enrollment carries no details (one installed long ago): the active key's own expiry (epoch ms). */
    keyNotAfter?: number;
    /** How this deployment issues certificates (`GET /system/signing-enrollment`): what a pending request says follows it. `null` / absent when it is not known. */
    info?: SigningEnrollmentInfo | null;
    /** The mailbox's address - the one the CA's verification e-mail goes to. */
    address?: string;
    /** Only the mailbox's owner can request a certificate. */
    canRequest: boolean;
    /** "Try again" / "Renew" / "Request a new certificate" is under way. */
    requesting: boolean;
    onCheck?: () => void;
    onRequest?: () => void;
}

const BADGE: Record<SigningCertificateMode, { text: string; className: string }> = {
    pending: { text: "Pending", className: "bg-primary/15 text-primary-dark" },
    issued: { text: "Active", className: "bg-success/15 text-success" },
    failed: { text: "Failed", className: "bg-danger/15 text-danger" },
    expired: { text: "Expired", className: "bg-danger/15 text-danger" },
};

const STEP_TEXT: Record<SignEnrollmentStep["state"], string> = {
    done: "done",
    active: "in progress",
    pending: "waiting",
    failed: "failed",
};

function StepIcon({ state }: { state: SignEnrollmentStep["state"] }) {
    if (state === "done") {
        return <HiOutlineCheckCircle size={18} aria-hidden="true" className="shrink-0 text-success" />;
    }
    if (state === "failed") {
        return <HiOutlineXCircle size={18} aria-hidden="true" className="shrink-0 text-danger" />;
    }
    if (state === "active") {
        return (
            <span aria-hidden="true" className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
                <span className="h-3.5 w-3.5 rounded-full border-2 border-primary/30 border-t-primary motion-safe:animate-spin motion-reduce:border-primary" />
            </span>
        );
    }
    return (
        <span aria-hidden="true" className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
            <span className="h-3 w-3 rounded-full border-2 border-border" />
        </span>
    );
}

function Stepper({ steps }: { steps: SignEnrollmentStep[] }) {
    return (
        <ol aria-label="Certificate steps" className="flex flex-col gap-2">
            {steps.map((step) => (
                <li key={step.id} className="flex items-start gap-2 text-sm" aria-current={step.state === "active" ? "step" : undefined}>
                    <StepIcon state={step.state} />
                    <span className={step.state === "pending" ? "text-text-muted" : "text-text"}>
                        {step.label}
                        <span className="sr-only"> - {STEP_TEXT[step.state]}</span>
                    </span>
                    {step.at && <span className="ml-auto shrink-0 text-xs text-text-muted">{formatDateTime(step.at)}</span>}
                </li>
            ))}
        </ol>
    );
}

/**
 * The progress bar: determinate when the server says how far along it is, an endless shimmer while a step is active and no number is known.
 * `role="progressbar"` with `aria-valuenow` (left off when unknown, as ARIA says for an indeterminate bar) and a `aria-valuetext` in words.
 */
function ProgressBar({ value, text }: { value: number | undefined; text: string }) {
    return (
        <div
            role="progressbar"
            aria-label="Certificate progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={value}
            aria-valuetext={text}
            className="h-2 w-full overflow-hidden rounded-pill bg-border/60"
        >
            {value === undefined ? (
                <div className="rr-progress-indeterminate h-full w-1/3 rounded-pill bg-primary motion-reduce:w-full motion-reduce:opacity-40" />
            ) : (
                <div
                    className="rr-progress-shimmer h-full rounded-pill bg-primary transition-[width] duration-500"
                    style={{ width: `${Math.max(value, value > 0 ? 3 : 0)}%` }}
                />
            )}
        </div>
    );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[6.5rem_1fr] gap-2 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-text-muted">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

/** The sentence under the button: what the last manual check found, or why it cannot be pressed again yet. */
function checkMessage(snapshot: EnrollmentSnapshot | undefined, statusLine: string | undefined, now: number): string | undefined {
    if (snapshot?.offline) {
        return "Could not reach the server - showing what was last known.";
    }
    const last = snapshot?.lastCheck;
    if (!last) {
        return undefined;
    }
    if (last.outcome === "failed") {
        return "Could not check just now - try again in a moment.";
    }
    if (last.outcome === "limited") {
        return "Checked a moment ago - please wait a few seconds before checking again.";
    }
    if (last.outcome === "changed") {
        return `Updated - ${statusLine ?? "the status changed"}`;
    }
    return `Still waiting - checked ${relativeTime(last.at, now)}`;
}

/**
 * Settings > Encryption's "Digital signature certificate" card: where a signing-certificate enrollment is, in the words of the person waiting for
 * it. A progress bar (determinate from the server's `progress`), the steps with a state icon and time each, a status line, when it was requested
 * and last checked (kept current), and a "Check status" button with a busy state and a cooldown. An issued certificate shows its subject, issuer,
 * serial (copyable) and expiry with a warning (and "Renew") inside 30 days; a failed one shows the reason and "Try again"; an expired one offers a
 * new request. Everything but `mode` is optional so a server that only says `pending`/`issued`/`failed` still gets a useful card.
 */
export default function SigningCertificateCard({ mode, enrollment, snapshot, keyNotAfter, info, address, canRequest, requesting, onCheck, onRequest }: SigningCertificateCardProps) {
    const busy = mode === "pending" || (snapshot?.retryAt ?? 0) > Date.now();
    const now = useNow(busy ? 1000 : 30_000);
    const steps = stepsOf(enrollment);
    const progress = progressOf(enrollment);
    const statusLine = statusLineOf(enrollment);
    // Any of the newer fields gives a percentage (the server's, or the share of steps done), so this is "the server told us more than pending".
    const detailed = progress !== undefined;
    const badge = BADGE[mode];
    // What the words say depends on how this deployment issues certificates: a public CA does it by itself, an administrator uploads it, or nobody has said.
    const issueMode = issueModeOf(enrollment, info);
    const problem = healthWarning(info);

    const notAfter = enrollment?.notAfter ?? keyNotAfter;
    const expiry = expiryOf(notAfter, now);
    const requestedAgo = relativeTime(enrollment?.requestedAt, now);
    const checkedAt = timeOf(enrollment?.lastCheckedAt) ?? snapshot?.answeredAt ?? undefined;
    const checkedAgo = relativeTime(checkedAt, now);
    const waitSeconds = Math.max(0, Math.ceil(((snapshot?.retryAt ?? 0) - now) / 1000));
    const checkingNow = snapshot?.checkingNow ?? false;
    const message = checkMessage(snapshot, statusLine, now);
    const overdue = isOverdue(enrollment, now);

    return (
        <section aria-label="Digital signature certificate" className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Digital signature certificate</h3>
                <span className={["rounded-pill px-2 py-0.5 text-xs font-bold", badge.className].join(" ")}>{badge.text}</span>
            </div>

            {mode === "pending" && (
                <>
                    {issueMode === "manual" ? (
                        <>
                            <p className="text-sm">{MANUAL_ISSUE_TEXT}</p>
                            {info?.contactEmail && <p className="text-xs text-text-muted">Administrator: {info.contactEmail}</p>}
                        </>
                    ) : (
                        <>
                            {issueMode === "automatic" && <p className="text-sm text-text-muted">{requestedFromText(info, address)}</p>}
                            {detailed ? (
                                <>
                                    <p className="text-sm">{statusLine ?? "In progress"}</p>
                                    <ProgressBar value={progress} text={`${progress} percent - ${statusLine ?? "in progress"}`} />
                                </>
                            ) : (
                                <>
                                    <ProgressBar value={undefined} text="In progress" />
                                    {issueMode === "unknown" && <p className="text-sm text-text-muted">{PENDING_FALLBACK_TEXT}</p>}
                                </>
                            )}
                        </>
                    )}
                    {problem && (
                        <div role="alert" className="flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
                            <HiOutlineExclamationTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-danger" />
                            <span>{problem}</span>
                        </div>
                    )}
                    {overdue && (
                        <p className="text-sm">
                            This is taking longer than expected{checkedAgo ? ` - last checked ${checkedAgo}` : ""}. Use Check status to ask again.
                        </p>
                    )}
                    {enrollment?.errorCode === "ca-unreachable" && <p className="text-sm text-text-muted">{CA_UNREACHABLE_TEXT}</p>}
                    {enrollment?.note && <p className="text-xs text-text-muted">{enrollment.note}</p>}
                    {steps.length > 0 && <Stepper steps={steps} />}
                    {issueMode === "automatic" && (
                        <p className="text-xs text-text-muted">You can leave this page - you will be told when the certificate is issued or the request fails.</p>
                    )}
                    {(requestedAgo || checkedAgo) && (
                        <p className="text-xs text-text-muted">
                            {requestedAgo ? `Requested ${issueMode === "manual" ? formatDateTime(enrollment?.requestedAt) : requestedAgo}` : ""}
                            {requestedAgo && checkedAgo ? " - " : ""}
                            {checkedAgo ? `last checked ${checkedAgo}` : ""}
                        </p>
                    )}
                    {onCheck && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto"
                                loading={checkingNow}
                                disabled={checkingNow || waitSeconds > 0}
                                aria-busy={checkingNow}
                                onClick={onCheck}
                            >
                                {checkingNow ? "Checking..." : waitSeconds > 0 ? `Check again in ${waitSeconds} s` : "Check status"}
                            </Button>
                            <span role="status" aria-live="polite" className="text-xs text-text-muted">
                                {message}
                            </span>
                        </div>
                    )}
                </>
            )}

            {mode === "issued" && (
                <>
                    <p className="text-sm">
                        {isInstalling(enrollment)
                            ? statusLineOf(enrollment)
                            : notAfter !== undefined
                              ? `Issued - valid until ${formatDate(notAfter)}`
                              : "Issued"}
                    </p>
                    {enrollment?.note && <p className="text-xs text-text-muted">{enrollment.note}</p>}
                    {expiry.state === "soon" && (
                        <div role="alert" className="flex items-start gap-2 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
                            <HiOutlineExclamationTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-danger" />
                            <span>
                                This certificate expires {expiry.daysLeft === 1 ? "tomorrow" : `in ${expiry.daysLeft} days`}. Renew it so your mail stays signed.
                            </span>
                        </div>
                    )}
                    {(enrollment?.subject || enrollment?.issuer || enrollment?.serialNumber || enrollment?.issuedAt) && (
                        <dl className="flex flex-col gap-1.5">
                            {enrollment.subject && <Detail label="Subject">{enrollment.subject}</Detail>}
                            {enrollment.issuer && <Detail label="Issuer">{enrollment.issuer}</Detail>}
                            {enrollment.serialNumber && (
                                <Detail label="Serial number">
                                    <span className="inline-flex flex-wrap items-center gap-2">
                                        <span className="font-mono text-xs" title={enrollment.serialNumber}>
                                            {truncateSerial(enrollment.serialNumber)}
                                        </span>
                                        <CopyButton value={enrollment.serialNumber} label="Copy the certificate's serial number" />
                                    </span>
                                </Detail>
                            )}
                            {enrollment.issuedAt && <Detail label="Issued">{formatDate(enrollment.issuedAt)}</Detail>}
                            {notAfter !== undefined && <Detail label="Valid until">{formatDate(notAfter)}</Detail>}
                        </dl>
                    )}
                    {canRequest && onRequest && expiry.state === "soon" && (
                        <div>
                            <Button type="button" variant="secondary" className="!w-auto" loading={requesting} disabled={requesting} onClick={onRequest}>
                                Renew
                            </Button>
                        </div>
                    )}
                </>
            )}

            {mode === "failed" && (
                <>
                    <Alert>{statusLine ?? "Failed: the certificate could not be issued."}</Alert>
                    {steps.length > 0 && <Stepper steps={steps} />}
                    {canRequest && onRequest && enrollment?.retryable !== false && (
                        <div>
                            <Button type="button" variant="secondary" className="!w-auto" loading={requesting} disabled={requesting} onClick={onRequest}>
                                Try again
                            </Button>
                        </div>
                    )}
                </>
            )}

            {mode === "expired" && (
                <>
                    <p className="text-sm">{notAfter !== undefined ? `Expired on ${formatDate(notAfter)}. Mail from this mailbox is no longer signed.` : "This certificate has expired. Mail from this mailbox is no longer signed."}</p>
                    {canRequest && onRequest && (
                        <div>
                            <Button type="button" variant="secondary" className="!w-auto" loading={requesting} disabled={requesting} onClick={onRequest}>
                                Request a new certificate
                            </Button>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}
