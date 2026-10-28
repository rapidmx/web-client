///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useEffect, useRef, useState } from "react";
import {
    cancelDkimRotation,
    DkimRotationBlocker,
    DkimRotationReason,
    DkimRotationState,
    DkimRotationView,
    DnsRecordCheck,
    Domain,
    getDkimRotation,
    rotateDkim,
    setDkimRotationPaused,
} from "../../../../../lib/admin/domainsApi.js";
import Button from "../../../../../lib/components/buttons/Button.js";
import Modal from "../../../../../lib/components/overlays/Modal.js";
import { ApiRequestError } from "../../../../../lib/util/api.js";
import Alert from "../ActionAlert.js";
import { actionErrorMessage } from "../elevation.js";
import CopyableValue from "./CopyableValue.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a manual domain's new record may stay unpublished before the panel reminds the administrator (spec 6.2). */
const REMINDER_DAYS = 7;

/** Why a domain's key doesn't rotate: restapi's own refusals of "Rotate now" (`DKIM_ROTATION_REFUSALS`). */
const BLOCKER_MESSAGES: Record<DkimRotationBlocker, string> = {
    unsupported: "This deployment's DKIM key provider doesn't rotate keys.",
    ses: "Outbound mail is signed by Amazon SES's Easy DKIM, which rotates its own keys.",
    no_key: "This domain has no DKIM key yet.",
    imported: "This domain's DKIM key was imported by hand, so RapidMX can't rotate it.",
    unknown_key: "The DKIM key provider can't tell whether it holds this domain's key, so it isn't rotated.",
};

const REASON_MESSAGES: Record<DkimRotationReason, string> = {
    scheduled: "Started by the schedule.",
    manual: "Started by an administrator.",
    compromised: "Started because the key was reported compromised.",
};

/** Whole days from `iso` to `now`, never negative. */
function daysSince(iso: string, now: number): number {
    return Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS));
}

function formatDays(days: number): string {
    return days < 1 ? "less than a day" : days === 1 ? "1 day" : `${days} days`;
}

function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString();
}

/** Whether the administrator adds `check`'s record by hand: the checklist says so, or says nothing about how it is published. */
function publishedByHand(check: DnsRecordCheck): boolean {
    return !check.publication || check.publication === "manual";
}

/** The record to add at the DNS host: its name and value to copy, and whether the live check sees it. */
function RecordToPublish({ check, noun, showLive }: { check: DnsRecordCheck; noun: string; showLive: boolean }) {
    return (
        <dl className="grid grid-cols-[auto_1fr] items-start gap-x-4 gap-y-2 text-sm mb-3">
            <dt className="text-text-muted py-2">Type</dt>
            <dd className="py-2">{check.recordKind}</dd>
            <dt className="text-text-muted py-2">Name / host</dt>
            <dd className="bg-surface-alt border border-border rounded-sm py-1.5 px-3">
                <CopyableValue value={check.recordName} copyLabel={`Copy name for the ${noun} record`} />
            </dd>
            <dt className="text-text-muted py-2">Value</dt>
            <dd className="bg-surface-alt border border-border rounded-sm py-1.5 px-3">
                <CopyableValue value={check.recommendedValue ?? ""} copyLabel={`Copy value for the ${noun} record`} />
            </dd>
            {showLive && (
                <>
                    <dt className="text-text-muted py-2">Status</dt>
                    <dd className="py-2">
                        {check.matches ? (
                            <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-success text-white">Live</span>
                        ) : (
                            <span className="text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">Not found yet</span>
                        )}
                    </dd>
                </>
            )}
        </dl>
    );
}

export interface DomainDkimRotationProps {
    domain: Domain;
    /** The domain's DNS checklist, which says how each record is published and carries the rotation's records. */
    checks: DnsRecordCheck[];
    /** Called after a change was made, so the page can load the domain and its checklist again. */
    onChanged: () => void;
}

/**
 * A domain's DKIM key rotation (spec 6.2): the active selector and its age, the phase with its next step, "Rotate now", "Key compromised", "Cancel rotation"
 * and the pause of scheduled rotation, and, for a record the administrator publishes by hand, the record to add. Nothing is shown on a server without the
 * rotation route.
 */
export default function DomainDkimRotation({ domain, checks, onChanged }: DomainDkimRotationProps) {
    // `undefined` while loading, `null` where the server has no rotation route (an older server).
    const [view, setView] = useState<DkimRotationView | null | undefined>(undefined);
    // Set when the first read failed for a reason other than a missing route, so the card stays and offers to try again.
    const [loadFailed, setLoadFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<"compromised" | "cancel" | null>(null);
    const latest = useRef(0);

    // Reads the rotation again; an answer to an older request is dropped. Only a 404 means the server has no rotation route; any other failure keeps what
    // is shown, or, where nothing is shown yet, the card with a way to try again.
    function load(): Promise<void> {
        const id = ++latest.current;
        return getDkimRotation(domain.uid).then(
            (answer) => {
                if (id === latest.current) {
                    setView(answer);
                    setLoadFailed(false);
                }
            },
            (err) => {
                if (id === latest.current) {
                    if (err instanceof ApiRequestError && err.status === 404) {
                        setView((current) => current ?? null);
                    } else {
                        setLoadFailed(true);
                    }
                }
            }
        );
    }

    // The domain's version moves with every change the rotation job makes, so the panel follows it.
    useEffect(() => {
        void load();
    }, [domain.uid, domain.version]);

    function card(children: ReactNode) {
        return (
            <div className="bg-surface border border-border rounded-md p-6">
                <h2 className="text-sm font-bold uppercase tracking-wide mb-3">DKIM key rotation</h2>
                {children}
            </div>
        );
    }

    if (view === null || (view === undefined && !loadFailed)) {
        return null;
    }
    if (!view) {
        return card(
            <>
                <Alert>Could not load the DKIM rotation.</Alert>
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => void load()}>
                    Reload the rotation
                </Button>
            </>
        );
    }

    async function run(action: () => Promise<unknown>, fallback: string) {
        setBusy(true);
        setError(null);
        try {
            await action();
            setConfirming(null);
            await load();
            onChanged();
        } catch (err) {
            setError(actionErrorMessage(err, fallback));
        } finally {
            setBusy(false);
        }
    }

    const state: DkimRotationState = view.rotation ?? { phase: "idle" };
    const phase = state.phase;
    const blockerText = <p className="text-sm text-text-muted mb-3">{view.blocker ? BLOCKER_MESSAGES[view.blocker] : "This domain's DKIM key doesn't rotate."}</p>;
    // A key that can't rotate offers nothing, unless a rotation is already in progress (the provider was swapped, the key re-imported): that one can still be
    // seen and cancelled, though nothing new starts.
    if (!view.rotatable && phase === "idle") {
        return card(blockerText);
    }
    const rotatable = view.rotatable;
    const next = state.next;
    const now = Date.now();

    // The active key is the new one from the switch on; before, since the last rotation or the domain's creation.
    const activeSince = (phase === "switching" || phase === "overlap") && state.switchedAt ? state.switchedAt : (state.lastRotatedAt ?? domain.dateCreated);
    const reason: DkimRotationReason | undefined = phase === "pending" ? next?.reason : phase === "idle" ? undefined : state.reason;
    // Once the key being replaced is reported compromised there is nothing more to report; an overlap is retired at once.
    const canCompromise = rotatable && (phase === "idle" || phase === "overlap" || (phase === "pending" && next?.reason !== "compromised") || (phase === "switching" && state.reason !== "compromised"));
    // An overlap finishes on its own.
    const canCancel = phase === "pending" || phase === "switching";

    const nextCheck = checks.find((check) => check.type === "dkim_next" && check.configured);
    const previousCheck = checks.find((check) => check.type === "dkim_previous" && check.configured);
    const retireAt = state.previous?.retireAt;
    const retired = !!retireAt && new Date(retireAt).getTime() <= now;
    const waitingDays = phase === "pending" && next && !next.liveSince ? daysSince(next.createdAt, now) : 0;

    let step: ReactNode;
    if (phase === "pending" && next) {
        const selector = <code className="text-xs">{next.selector}</code>;
        if (!next.publicKey) {
            step = <>Creating the new key (selector {selector}).</>;
        } else if (!next.liveSince) {
            step = (
                <>
                    Waiting for the new record for {selector} to be live.{" "}
                    {next.reason === "compromised" ? "Signing switches to it as soon as it is." : "Signing keeps using the current key until then."}
                </>
            );
        } else if (next.reason === "compromised") {
            step = <>The new record is live (since {formatDate(next.liveSince)}). Signing switches to the new key next.</>;
        } else {
            step = (
                <>
                    The new record has been live since {formatDate(next.liveSince)}. Signing switches to the new key once it has been live long enough for
                    resolvers to drop any cached negative answer.
                </>
            );
        }
    } else if (phase === "switching") {
        step = <>Switching: signing has moved to the new key, and the mail server hasn't confirmed it yet.</>;
    } else if (phase === "overlap") {
        step = retireAt ? (
            <>The old key retires on {formatDate(retireAt)}. Mail signed with it that is still in transit keeps verifying until then.</>
        ) : (
            <>The old key retires shortly.</>
        );
    } else {
        step = <>No rotation is in progress.</>;
    }

    const scheduleNote =
        phase !== "idle" ? null : state.paused ? (
            <p className="text-sm text-text-muted mb-3">Scheduled rotation is paused.</p>
        ) : view.nextScheduledAt ? (
            <p className="text-sm text-text-muted mb-3">Next scheduled rotation: {formatDate(view.nextScheduledAt)}.</p>
        ) : (
            <p className="text-sm text-text-muted mb-3">No rotation is scheduled.</p>
        );

    // A record published by hand is shown to copy; one a provider publishes is only mentioned.
    let records: ReactNode = null;
    if (phase === "pending" && nextCheck && next?.publicKey) {
        if (publishedByHand(nextCheck)) {
            records = (
                <div className="mb-3">
                    <p className="text-sm font-semibold mb-2">{nextCheck.matches ? "The record you published is live." : "Publish this record to finish rotating"}</p>
                    <RecordToPublish check={nextCheck} noun="new DKIM key" showLive />
                    {waitingDays >= REMINDER_DAYS && !nextCheck.matches && (
                        <div role="note" className="text-sm rounded-sm py-3 px-3.5 bg-warning text-warning-contrast">
                            This record has been waiting for {waitingDays} days. Signing doesn't switch until it is live, so add it at your DNS host, or cancel the
                            rotation.
                        </div>
                    )}
                </div>
            );
        } else if (nextCheck.publication === "conflict") {
            records = <p className="text-sm text-text-muted mb-3">The DNS provider can't publish this record while another one is in the way; see the checklist above.</p>;
        } else {
            records = <p className="text-sm text-text-muted mb-3">This record is published automatically by the DNS provider.</p>;
        }
    } else if ((phase === "switching" || phase === "overlap") && previousCheck && publishedByHand(previousCheck)) {
        records = (
            <div className="mb-3">
                <p className="text-sm font-semibold mb-2">
                    {retired
                        ? "The old key has retired: you may now remove this record."
                        : phase === "overlap" && retireAt
                          ? `Keep this record published until ${formatDate(retireAt)}, then you may remove it.`
                          : "Keep this record published until the old key retires."}
                </p>
                <RecordToPublish check={previousCheck} noun="previous DKIM key" showLive={false} />
            </div>
        );
    }

    const compromisedText =
        phase === "overlap"
            ? "The old record and key are removed now, without waiting for the overlap to end. Mail signed with the old key that is still in transit may then fail DKIM."
            : phase === "switching"
              ? "The old record is removed as soon as the mail server confirms the switch, with no overlap. Mail signed with the old key that is still in transit may then fail DKIM."
              : "Signing moves to the new key as soon as its record is live (the publish wait is skipped), and the old record is removed as soon as the mail server confirms the switch, with no overlap. Mail signed with the old key that is still in transit may then fail DKIM.";
    const cancelText =
        phase === "switching"
            ? "Signing goes back to the previous key, and the new key is deleted. The cancel is refused if the previous key is gone or the mail server can't be pointed back at it. The next scheduled rotation counts from now."
            : "The new key is deleted and its record is no longer published. Signing stays with the current key. The next scheduled rotation counts from now.";

    // The refusal a dialog shows belongs to it, so it goes with it rather than moving to the card.
    function closeDialog() {
        if (!busy) {
            setConfirming(null);
            setError(null);
        }
    }

    function openDialog(which: "compromised" | "cancel") {
        setError(null);
        setConfirming(which);
    }

    return (
        <>
            {card(
                <>
                    {!rotatable && blockerText}
                    {domain.dkimSelector && (
                        <p className="text-sm mb-3">
                            Active selector <code className="text-xs">{domain.dkimSelector}</code>, in use for {formatDays(daysSince(activeSince, now))}.
                        </p>
                    )}
                    <p className="text-sm mb-1">{step}</p>
                    {reason && <p className="text-sm text-text-muted mb-3">{REASON_MESSAGES[reason]}</p>}
                    {scheduleNote}
                    {state.lastError && <Alert>{state.lastError}</Alert>}
                    {records}
                    {error && confirming === null && <Alert>{error}</Alert>}
                    <div className="flex flex-wrap items-center gap-3">
                        {rotatable && phase === "idle" && (
                            <Button type="button" className="!w-auto" disabled={busy} onClick={() => void run(() => rotateDkim(domain.uid), "Could not start the rotation.")}>
                                Rotate now
                            </Button>
                        )}
                        {canCompromise && (
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto !border-danger !text-danger hover:!border-danger hover:!text-danger"
                                disabled={busy}
                                onClick={() => openDialog("compromised")}
                            >
                                Key compromised: rotate now
                            </Button>
                        )}
                        {canCancel && (
                            <Button type="button" variant="secondary" className="!w-auto" disabled={busy} onClick={() => openDialog("cancel")}>
                                Cancel rotation
                            </Button>
                        )}
                        {rotatable && (
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto"
                                disabled={busy}
                                onClick={() =>
                                    void run(
                                        () => setDkimRotationPaused(domain.uid, !state.paused),
                                        state.paused ? "Could not resume scheduled rotation." : "Could not pause scheduled rotation."
                                    )
                                }
                            >
                                {state.paused ? "Resume scheduled rotation" : "Pause scheduled rotation"}
                            </Button>
                        )}
                    </div>
                </>
            )}

            <Modal open={confirming === "compromised"} onClose={closeDialog} title="Key compromised">
                <p className="text-sm mb-3">{compromisedText}</p>
                {error && <Alert>{error}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={busy} onClick={closeDialog}>
                        Back
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto"
                        loading={busy}
                        disabled={busy}
                        onClick={() => void run(() => rotateDkim(domain.uid, { compromised: true }), "Could not rotate the key.")}
                    >
                        Confirm
                    </Button>
                </div>
            </Modal>

            <Modal open={confirming === "cancel"} onClose={closeDialog} title="Cancel rotation">
                <p className="text-sm mb-3">{cancelText}</p>
                {error && <Alert>{error}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={busy} onClick={closeDialog}>
                        Back
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto"
                        loading={busy}
                        disabled={busy}
                        onClick={() => void run(() => cancelDkimRotation(domain.uid), "Could not cancel the rotation.")}
                    >
                        Confirm
                    </Button>
                </div>
            </Modal>
        </>
    );
}
