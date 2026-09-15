///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { PinnedKeyChangedError, resolveKeyConflict, type KeyConflict } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { conflictSourceLabel, formatDate, groupFingerprint, keyChangeErrorMessage } from "./contactKeys.js";

export interface KeyChangeReviewProps {
    /** The mailbox whose contact holds the pinned key. */
    mailboxUid: string;
    /** The contact's address `resolveKeyConflict()` looks the contact up by; absent hides the actions. */
    address?: string;
    useType: "sign" | "encrypt";
    /** Who the key belongs to, for the advice ("confirm with <name>"). */
    ownerName: string;
    /** The currently pinned key and when it was first trusted; absent (couldn't be loaded) hides the actions. */
    current?: { fingerprint: string; since: number };
    /** The new key: its fingerprint, the addresses its certificate names, and when and how it was recorded (absent when
     * it's only known from the message being read). */
    proposed: { fingerprint: string; emails?: string[]; observedAt?: number; source?: KeyConflict["source"] };
    /** For accepting a key seen in a message: its certificate. Omitted, accepting pins the recorded conflict's key. */
    certificate?: string;
    /** Whether "Keep current key" applies - only when a conflict for this exact key is recorded. */
    canReject: boolean;
    /** `false` when the reader is known to lack the rights to change the contact's keys. */
    canResolve?: boolean;
    /** After a successful accept or reject - the caller refreshes what it shows. */
    onResolved: (action: "accept" | "reject") => void;
    /** After a 409: the pinned key changed meanwhile. The caller reloads and says so (`KEY_CHANGE_STALE_MESSAGE`). */
    onPinnedKeyChanged: () => void;
}

/**
 * The old-versus-new comparison for a changed contact key, with Accept new key (confirmed in a dialog) and Keep current
 * key, calling `resolveKeyConflict()` against the pinned fingerprint shown. Shared by a message's "signing key changed"
 * notice and a contact's recorded key conflicts.
 */
export default function KeyChangeReview({
    mailboxUid,
    address,
    useType,
    ownerName,
    current,
    proposed,
    certificate,
    canReject,
    canResolve,
    onResolved,
    onPinnedKeyChanged,
}: KeyChangeReviewProps) {
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [forbidden, setForbidden] = useState(false);
    const kind = useType === "sign" ? "signing" : "encryption";
    const actionable = !!address && !!current && canResolve !== false && !forbidden;

    async function resolve(action: "accept" | "reject") {
        setBusy(action);
        setError(null);
        try {
            await resolveKeyConflict(mailboxUid, {
                address: address!,
                useType,
                action,
                expectedPinnedFingerprint: current!.fingerprint,
                ...(action === "accept" && certificate !== undefined ? { certificate } : {}),
            });
            setConfirmOpen(false);
            onResolved(action);
        } catch (err) {
            setConfirmOpen(false);
            if (err instanceof PinnedKeyChangedError) {
                onPinnedKeyChanged();
                return;
            }
            if (err instanceof ApiRequestError && err.status === 403) {
                setForbidden(true);
            }
            setError(keyChangeErrorMessage(err));
        } finally {
            setBusy(null);
        }
    }

    const proposedSeen =
        proposed.observedAt !== undefined
            ? `First seen ${formatDate(proposed.observedAt)}${proposed.source ? `, ${conflictSourceLabel(proposed.source)}` : ""}`
            : "Only seen in this message";

    return (
        <div className="flex flex-col gap-2">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="rounded-sm bg-surface p-2">
                    <dt className="text-xs text-text-muted">Current key</dt>
                    {current ? (
                        <dd>
                            <span className="font-mono text-xs break-all">{groupFingerprint(current.fingerprint)}</span>
                            <span className="block text-xs text-text-muted">First seen {formatDate(current.since)}</span>
                        </dd>
                    ) : (
                        <dd className="text-xs text-text-muted">The key you trust couldn&rsquo;t be loaded.</dd>
                    )}
                </div>
                <div className="rounded-sm bg-surface p-2">
                    <dt className="text-xs text-text-muted">New key</dt>
                    <dd>
                        <span className="font-mono text-xs break-all">{groupFingerprint(proposed.fingerprint)}</span>
                        {proposed.emails && (
                            <span className="block text-xs text-text-muted">
                                Certificate for {proposed.emails.length > 0 ? proposed.emails.join(", ") : "no email address"}
                            </span>
                        )}
                        <span className="block text-xs text-text-muted">{proposedSeen}</span>
                    </dd>
                </div>
            </dl>
            <p>
                This is routine when {ownerName} renews a certificate, but it can also mean someone is impersonating them.
                Confirm the new fingerprint with {ownerName} another way, such as a phone call, before accepting it.
            </p>
            {error && <Alert>{error}</Alert>}
            {actionable && (
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        className="!w-auto"
                        disabled={busy !== null}
                        onClick={() => {
                            setError(null);
                            setConfirmOpen(true);
                        }}
                    >
                        Accept new key
                    </Button>
                    {canReject && (
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto"
                            loading={busy === "reject"}
                            disabled={busy !== null}
                            onClick={() => resolve("reject")}
                        >
                            Keep current key
                        </Button>
                    )}
                </div>
            )}
            <Modal open={confirmOpen} onClose={() => busy === null && setConfirmOpen(false)} title="Accept the new key?">
                <div className="flex flex-col gap-3 text-sm">
                    <p>
                        {useType === "sign"
                            ? `Mail from ${address} signed with this key will show as verified.`
                            : `Mail you send to ${address} will be encrypted to this key.`}{" "}
                        The current {kind} key moves to this contact&rsquo;s key history.
                    </p>
                    <dl className="flex flex-col gap-1">
                        <dt className="text-xs text-text-muted">New key fingerprint</dt>
                        <dd className="font-mono text-xs break-all">{groupFingerprint(proposed.fingerprint)}</dd>
                    </dl>
                    <p className="text-text-muted">Only accept it once you&rsquo;ve confirmed this fingerprint with {ownerName}.</p>
                    <div className="flex gap-3">
                        <Button
                            type="button"
                            className="!w-auto"
                            loading={busy === "accept"}
                            disabled={busy !== null}
                            onClick={() => resolve("accept")}
                        >
                            Accept new key
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto"
                            disabled={busy !== null}
                            onClick={() => setConfirmOpen(false)}
                        >
                            Cancel
                        </Button>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
