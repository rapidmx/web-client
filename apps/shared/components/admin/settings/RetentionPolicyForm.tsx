///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { MIN_AUDIT_LOG_RETENTION_DAYS, RetentionPolicy, RetentionPolicyUpdate, updateRetentionPolicy } from "@rapidmx/react-shared/admin/retentionPolicyApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** Whether saving `next` days newly starts purging (nothing was configured) or purges sooner than `saved` days. */
function shortensRetention(next: number | null | undefined, saved: number | null | undefined): boolean {
    return next != null && (saved == null || next < saved);
}

/** The retention policy editor, shared by the Retention Policy page and the setup wizard. */
export default function RetentionPolicyForm({
    policy,
    onChange,
    onDirtyChange,
}: {
    policy: RetentionPolicy;
    onChange: (p: RetentionPolicy) => void;
    /** Told whether the form has edits that haven't been saved. */
    onDirtyChange?: (dirty: boolean) => void;
}) {
    const [messageRetentionDays, setMessageRetentionDays] = useState(policy.messageRetentionDays?.toString() ?? "");
    const [auditLogRetentionDays, setAuditLogRetentionDays] = useState(policy.auditLogRetentionDays?.toString() ?? "");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    // Edits are unsaved until they match what was loaded or last saved.
    const snapshot = JSON.stringify([messageRetentionDays, auditLogRetentionDays]);
    const [savedSnapshot, setSavedSnapshot] = useState(snapshot);
    const dirty: boolean = snapshot !== savedSnapshot;
    useEffect(() => onDirtyChange?.(dirty), [dirty]);

    // The retention currently in effect, and a pending save that would newly start or shorten either period - which
    // permanently deletes existing mail or audit-log entries on the next purge run, so it's confirmed first.
    const [savedMessageDays, setSavedMessageDays] = useState(policy.messageRetentionDays);
    const [savedAuditDays, setSavedAuditDays] = useState(policy.auditLogRetentionDays);
    const [pendingPatch, setPendingPatch] = useState<RetentionPolicyUpdate | null>(null);

    function handleSubmit(e: FormEvent) {
        e.preventDefault();
        // A blank field is sent as `null`, which clears a configured age back to no automatic purge.
        const patch: RetentionPolicyUpdate = {
            messageRetentionDays: messageRetentionDays.trim() === "" ? null : Number(messageRetentionDays),
            auditLogRetentionDays: auditLogRetentionDays.trim() === "" ? null : Number(auditLogRetentionDays),
        };
        if (
            shortensRetention(patch.messageRetentionDays, savedMessageDays) ||
            shortensRetention(patch.auditLogRetentionDays, savedAuditDays)
        ) {
            setPendingPatch(patch);
            return;
        }
        void save(patch);
    }

    async function save(patch: RetentionPolicyUpdate) {
        setPendingPatch(null);
        setError(null);
        setSaved(false);
        setSaving(true);
        try {
            const updated = await updateRetentionPolicy(patch);
            setSavedMessageDays(updated.messageRetentionDays);
            setSavedAuditDays(updated.auditLogRetentionDays);
            onChange(updated);
            setSavedSnapshot(snapshot);
            setSaved(true);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save the retention policy.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="max-w-xl">
            <h1 className="text-xl font-bold uppercase tracking-wide mb-1">Retention Policy</h1>
            <p className="text-sm text-text-muted mb-5">
                Automatically and permanently deletes mail/audit-log entries older than the configured age.
                Leave a field blank for no automatic purge. This does not apply to a mailbox that is a
                custodian on an active legal hold — a held message is skipped and retried on a later run once
                the hold is lifted.
            </p>

            {error && <Alert>{error}</Alert>}
            {saved && !error && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Message retention (days)</span>
                    <input
                        aria-label="Message retention (days)"
                        type="number"
                        min={1}
                        className={INPUT_CLASS}
                        value={messageRetentionDays}
                        onChange={(e) => setMessageRetentionDays(e.target.value)}
                        placeholder="No automatic purge"
                    />
                    <span className="text-xs text-text-muted">
                        Applies to any message, in any folder, regardless of age.
                    </span>
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Audit log retention (days)</span>
                    <input
                        aria-label="Audit log retention (days)"
                        type="number"
                        min={MIN_AUDIT_LOG_RETENTION_DAYS}
                        className={INPUT_CLASS}
                        value={auditLogRetentionDays}
                        onChange={(e) => setAuditLogRetentionDays(e.target.value)}
                        placeholder="Keep forever"
                    />
                    <span className="text-xs text-text-muted">
                        Cannot be set below {MIN_AUDIT_LOG_RETENTION_DAYS} days. Never applies to the
                        tamper-evident escrow audit chain.
                    </span>
                </label>
                <div>
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Save
                    </Button>
                </div>
            </form>

            <Modal open={pendingPatch !== null} onClose={() => setPendingPatch(null)} title="Delete older data?">
                {shortensRetention(pendingPatch?.messageRetentionDays, savedMessageDays) && (
                    <p className="text-sm mb-3">
                        {savedMessageDays == null
                            ? "Mail isn't deleted automatically today."
                            : `Mail is currently kept for ${savedMessageDays} days.`}{" "}
                        With this change, every message older than <strong>{pendingPatch?.messageRetentionDays} days</strong>,
                        in every mailbox and folder, is permanently deleted on the next purge run - and so on from then on.
                        Mailboxes on an active legal hold are skipped.
                    </p>
                )}
                {shortensRetention(pendingPatch?.auditLogRetentionDays, savedAuditDays) && (
                    <p className="text-sm mb-3">
                        {savedAuditDays == null
                            ? "Audit-log entries are kept forever today."
                            : `Audit-log entries are currently kept for ${savedAuditDays} days.`}{" "}
                        With this change, every audit-log entry older than{" "}
                        <strong>{pendingPatch?.auditLogRetentionDays} days</strong> is permanently deleted on the next purge
                        run. The escrow audit chain is never purged.
                    </p>
                )}
                <p className="text-sm font-semibold text-danger mb-4">Deleted data can&rsquo;t be recovered.</p>
                <div className="flex gap-3 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setPendingPatch(null)}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                        onClick={() => void save(pendingPatch!)}
                    >
                        Save and delete older data
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
