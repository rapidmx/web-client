///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { apiFetch, ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    EscrowAuditLogEntry,
    EscrowAuditVerificationResult,
    listAuditLogEntries,
    verifyAuditChain,
} from "@rapidmx/react-shared/admin/escrowAuditLogApi.js";
import EscrowShell, { EscrowShellProps } from "../../shared/components/escrow/layout/EscrowShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

const PAGE_SIZE = 25;

const ACTION_LABELS: Record<EscrowAuditLogEntry["action"], string> = {
    "escrow_access_request.created": "Access request created",
    "escrow_access_request.approved": "Access request approved",
    "escrow_access_request.material_read": "Material read",
};

export default function EscrowAuditLogPage(props: Omit<EscrowShellProps, "active">) {
    return (
        <EscrowShell {...props} active="auditLog">
            <EscrowAuditLogContent />
        </EscrowShell>
    );
}

function EscrowAuditLogContent() {
    const [page, setPage] = useState(0);
    const [entries, setEntries] = useState<EscrowAuditLogEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // `GET /admin/release-notes` is the same side-effect-free trusted-role canary `AdminShell` itself
    // uses (any `BaseAdminRoute` endpoint works — see that route's own doc comment) — reused here only to
    // decide whether to show the "Verify chain integrity" button at all, not to gate this whole page the
    // way `AdminShell` gates `apps/admin`. `EscrowAuditLogRoute.verify()` is `@RequiresTrustedRole()`-only
    // server-side regardless of what this probe finds; hiding the button for a non-trusted holder just
    // avoids an inevitable, confusing 403 on click, it isn't itself the enforcement.
    const [isTrustedAdmin, setIsTrustedAdmin] = useState(false);

    const [verifying, setVerifying] = useState(false);
    const [verifyError, setVerifyError] = useState<string | null>(null);
    const [verifyResult, setVerifyResult] = useState<EscrowAuditVerificationResult | null>(null);

    useEffect(() => {
        apiFetch("/admin/release-notes")
            .then(() => setIsTrustedAdmin(true))
            .catch(() => setIsTrustedAdmin(false));
    }, []);

    useEffect(() => {
        setLoading(true);
        setError(null);
        listAuditLogEntries({ page, limit: PAGE_SIZE })
            .then(setEntries)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load the audit log."))
            .finally(() => setLoading(false));
    }, [page]);

    async function handleVerify() {
        setVerifying(true);
        setVerifyError(null);
        setVerifyResult(null);
        try {
            setVerifyResult(await verifyAuditChain());
        } catch (err) {
            setVerifyError(err instanceof ApiRequestError ? err.message : "Could not verify the audit chain.");
        } finally {
            setVerifying(false);
        }
    }

    const hasNextPage = entries.length === PAGE_SIZE;

    return (
        <>
            <div className="flex items-center justify-between mb-5">
                <h1 className="text-xl font-bold uppercase tracking-wide">Escrow audit log</h1>
                {isTrustedAdmin && (
                    <Button type="button" className="!w-auto" loading={verifying} disabled={verifying} onClick={handleVerify}>
                        Verify chain integrity
                    </Button>
                )}
            </div>

            <p className="text-sm text-text-muted mb-5">
                Every escrow access lifecycle event visible to you — matters under a scope you hold. A trusted
                administrator sees every entry across every scope instead.
            </p>

            {verifyError && <Alert>{verifyError}</Alert>}
            {verifyResult &&
                (verifyResult.valid ? (
                    <div className="mb-5 py-3 px-3.5 rounded-sm text-sm bg-success/10 text-success font-medium">
                        Chain verified — no tampering detected.
                    </div>
                ) : (
                    <Alert>Chain integrity broken at sequence {verifyResult.brokenAtSequence}.</Alert>
                ))}

            {error && <Alert>{error}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : entries.length === 0 ? (
                <p className="text-sm text-text-muted">No audit log entries visible to you yet.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Sequence", "Action", "Holder", "Mailbox", "Occurred"].map((h) => (
                                    <th
                                        key={h}
                                        className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                    >
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map((entry) => (
                                <tr key={entry.uid}>
                                    <td className="py-2.5 px-2.5 border-b border-border">{entry.sequence}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{ACTION_LABELS[entry.action]}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{entry.holderUserUid}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">{entry.mailboxUid}</td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {new Date(entry.occurredAt).toLocaleString()}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <div className="flex gap-3 items-center mt-4">
                <Button
                    variant="secondary"
                    type="button"
                    className="!w-auto"
                    disabled={page === 0 || loading}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                    Previous
                </Button>
                <span className="text-sm text-text-muted">Page {page + 1}</span>
                <Button
                    variant="secondary"
                    type="button"
                    className="!w-auto"
                    disabled={!hasNextPage || loading}
                    onClick={() => setPage((p) => p + 1)}
                >
                    Next
                </Button>
            </div>
        </>
    );
}
