///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { EscrowScope, listEscrowScopes } from "@rapidmx/react-shared/admin/escrowScopesApi.js";
import { Mailbox, updateMailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const SELECT_CLASS =
    "text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** Enough for any realistic deployment's scopes in one list. */
const SCOPE_LIST_LIMIT = 200;

export interface EscrowScopeCardProps {
    mailbox: Mailbox;
    /** Called with the saved mailbox, same push-up pattern as `ResourceSettingsCard`. */
    onUpdate: (mailbox: Mailbox) => void;
}

/**
 * Assigns a mailbox to an escrow scope (or none), which decides whose holders can recover its encrypted mail. Only
 * shown in the admin console, whose trusted-role gate the server enforces again for `escrowScopeId`.
 */
export default function EscrowScopeCard({ mailbox, onUpdate }: EscrowScopeCardProps) {
    const [scopes, setScopes] = useState<EscrowScope[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [escrowScopeId, setEscrowScopeId] = useState(mailbox.escrowScopeId ?? "");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [confirming, setConfirming] = useState(false);

    useEffect(() => {
        listEscrowScopes({ limit: SCOPE_LIST_LIMIT })
            .then(setScopes)
            .catch((err) => setLoadError(err instanceof ApiRequestError ? err.message : "Could not load escrow scopes."));
    }, []);

    // Changing the scope changes who can recover this mailbox's encrypted mail, so it's confirmed first.
    function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setConfirming(true);
    }

    async function save() {
        setConfirming(false);
        setSaveError(null);
        setSaved(false);
        setSaving(true);
        try {
            const updated = await updateMailbox({ uid: mailbox.uid, version: mailbox.version, escrowScopeId: escrowScopeId || null });
            onUpdate(updated);
            setSaved(true);
        } catch (err) {
            setSaveError(err instanceof ApiRequestError ? err.message : "Could not save the escrow scope.");
        } finally {
            setSaving(false);
        }
    }

    const current = mailbox.escrowScopeId ?? "";
    const unknownCurrent = !!current && !!scopes && !scopes.some((scope) => scope.uid === current);

    return (
        <div className="bg-surface border border-border rounded-md p-6">
            <h2 className="text-base font-bold uppercase tracking-wide mb-1">Escrow scope</h2>
            <p className="text-sm text-text-muted mb-4">
                The holders of this scope can jointly recover this mailbox&rsquo;s encrypted mail, for example for legal
                discovery. With no scope, nobody can.
            </p>

            {loadError && <Alert>{loadError}</Alert>}
            {saveError && <Alert>{saveError}</Alert>}
            {saved && !saveError && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

            {scopes && (
                <form onSubmit={handleSubmit} className="flex items-end gap-3 flex-wrap">
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">Scope</span>
                        <select
                            aria-label="Escrow scope"
                            className={SELECT_CLASS}
                            value={escrowScopeId}
                            onChange={(e) => {
                                setEscrowScopeId(e.target.value);
                                setSaved(false);
                            }}
                        >
                            <option value="">No escrow</option>
                            {unknownCurrent && <option value={current}>Unknown scope ({current})</option>}
                            {scopes.map((scope) => (
                                <option key={scope.uid} value={scope.uid}>
                                    {scope.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <Button type="submit" className="!w-auto" loading={saving} disabled={saving || escrowScopeId === current}>
                        Save escrow scope
                    </Button>
                </form>
            )}

            <Modal open={confirming} onClose={() => setConfirming(false)} title="Change escrow scope">
                <p className="text-sm mb-3">
                    This changes who can jointly recover <strong className="break-all">{mailbox.primarySmtpAddress}</strong>
                    &rsquo;s encrypted mail.
                </p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm mb-4">
                    <dt className="text-text-muted">From</dt>
                    <dd className="break-all">
                        <ScopeSummary uid={current} scopes={scopes ?? []} />
                    </dd>
                    <dt className="text-text-muted">To</dt>
                    <dd className="break-all">
                        <ScopeSummary uid={escrowScopeId} scopes={scopes ?? []} />
                    </dd>
                </dl>
                <div className="flex gap-3 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setConfirming(false)}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto" onClick={() => void save()}>
                        Confirm and save
                    </Button>
                </div>
            </Modal>
        </div>
    );
}

/** A scope's name, holders and required approvals - or what having no (or an unlisted) scope means. */
function ScopeSummary({ uid, scopes }: { uid: string; scopes: EscrowScope[] }) {
    if (!uid) {
        return <span>No escrow - nobody can recover this mailbox&rsquo;s encrypted mail</span>;
    }
    const scope = scopes.find((candidate) => candidate.uid === uid);
    if (!scope) {
        return <span>Unknown scope ({uid})</span>;
    }
    return (
        <span>
            <strong>{scope.name}</strong> - holders {scope.holderUserUids.join(", ")}; {scope.requiredHolders} of{" "}
            {scope.holderUserUids.length} must approve
        </span>
    );
}
