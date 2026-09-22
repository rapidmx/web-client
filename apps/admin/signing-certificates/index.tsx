///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ChangeEvent, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    AdminSigningEnrollment,
    getSigningEnrollmentInfo,
    listSigningEnrollments,
    looksLikePemCertificate,
    rejectSigningEnrollment,
    signingEnrollmentCsrUrl,
    SigningEnrollmentInfo,
    uploadSigningEnrollmentCertificate,
} from "@rapidmx/react-shared/crypto/signingProviderApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import { notify } from "../../shared/notifications/store.js";

const INPUT_CLASS = "text-sm border border-border rounded-sm py-1.5 px-2 bg-surface";
const TEXTAREA_CLASS = `${INPUT_CLASS} font-mono text-xs`;

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof ApiRequestError ? err.message : fallback;
}

function statusBadgeClass(status: AdminSigningEnrollment["status"]): string {
    if (status === "failed") return "bg-danger-bg text-danger";
    if (status === "pending") return "bg-surface-alt text-text-muted";
    return "bg-success text-white";
}

function providerLabel(provider: AdminSigningEnrollment["provider"]): string {
    return provider === "rfc8823" ? "Automatic (RFC 8823)" : "Manual";
}

export default function SigningCertificatesPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="signingCertificates">
            <div className="flex flex-col gap-6">
                <div>
                    <h1 className="text-xl font-bold uppercase tracking-wide mb-1">Signing Certificates</h1>
                    <p className="text-sm text-text-muted">
                        Every mailbox's pending signing (digital-signature) certificate request. Requests issued automatically by a
                        certificate authority are listed for visibility only; a manual request needs a certificate uploaded here once
                        the certificate authority has issued one.
                    </p>
                </div>
                <BackendSummary />
                <EnrollmentsTable />
            </div>
        </AdminShell>
    );
}

/** How signing certificates are issued in this deployment - fetched once, since it doesn't change while the page is open. */
function BackendSummary() {
    const [info, setInfo] = useState<SigningEnrollmentInfo | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        getSigningEnrollmentInfo()
            .then(setInfo)
            .catch((err) => setError(errorMessage(err, "Could not load the signing certificate backend.")));
    }, []);

    if (error) {
        return <Alert>{error}</Alert>;
    }
    if (!info) {
        return null;
    }
    if (info.backend === "none") {
        return <p className="text-sm text-text-muted">Signing certificates are not enabled in this deployment.</p>;
    }

    return (
        <div className="text-sm border border-border rounded-sm p-3 bg-surface-alt flex flex-col gap-1">
            <span>
                <strong>{info.automatic ? "Automatic issuance" : "Manual issuance"}</strong>
                {info.ca && <> through {info.ca.host}</>}
                {info.typicalDurationMinutes !== undefined && <> &middot; typically {info.typicalDurationMinutes} minutes</>}
            </span>
            {info.health && !info.health.ok && (
                <span className="text-danger">
                    The certificate authority could not be reached{info.health.lastError && <>: {info.health.lastError}</>}.
                </span>
            )}
        </div>
    );
}

function EnrollmentsTable() {
    const [items, setItems] = useState<AdminSigningEnrollment[] | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [uploadTarget, setUploadTarget] = useState<AdminSigningEnrollment | null>(null);
    const [rejectTarget, setRejectTarget] = useState<AdminSigningEnrollment | null>(null);

    async function reload() {
        try {
            setItems(await listSigningEnrollments());
            setLoadError(null);
        } catch (err) {
            setLoadError(errorMessage(err, "Could not load the pending signing certificate requests."));
        }
    }

    useEffect(() => {
        void reload();
    }, []);

    if (loadError) {
        return <Alert>{loadError}</Alert>;
    }
    if (items === null) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (items.length === 0) {
        return <p className="text-sm text-text-muted">No pending signing certificate requests.</p>;
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
                <thead>
                    <tr className="text-left text-xs font-bold uppercase tracking-wide text-text-muted border-b border-border">
                        <th className="py-2 pr-3">Mailbox</th>
                        <th className="py-2 pr-3">Requested</th>
                        <th className="py-2 pr-3">Provider</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {items.map((row) => (
                        <tr key={row.enrollmentId} className="border-b border-border">
                            <td className="py-2 pr-3 break-all">{row.identity}</td>
                            <td className="py-2 pr-3 whitespace-nowrap">{new Date(row.requestedAt).toLocaleString()}</td>
                            <td className="py-2 pr-3 whitespace-nowrap">{providerLabel(row.provider)}</td>
                            <td className="py-2 pr-3">
                                <span className={`text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill ${statusBadgeClass(row.status)}`}>
                                    {row.status}
                                </span>
                                {row.lastError && <div className="text-xs text-danger mt-1 max-w-xs">{row.lastError}</div>}
                            </td>
                            <td className="py-2 pr-3">
                                <div className="flex items-center gap-3 flex-wrap">
                                    {row.provider === "manual" && (
                                        <a
                                            href={signingEnrollmentCsrUrl(row.enrollmentId)}
                                            className="text-primary-dark hover:underline font-medium whitespace-nowrap"
                                        >
                                            Download CSR
                                        </a>
                                    )}
                                    {row.canUpload && (
                                        <Button type="button" variant="secondary" className="!w-auto" onClick={() => setUploadTarget(row)}>
                                            Upload certificate
                                        </Button>
                                    )}
                                    {row.status === "pending" && row.provider === "manual" && (
                                        <Button type="button" variant="secondary" className="!w-auto" onClick={() => setRejectTarget(row)}>
                                            Reject
                                        </Button>
                                    )}
                                    {row.uploadBlockedReason && !row.canUpload && (
                                        <span className="text-xs text-text-muted max-w-xs">{row.uploadBlockedReason}</span>
                                    )}
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            <UploadCertificateModal target={uploadTarget} onClose={() => setUploadTarget(null)} onDone={reload} />
            <RejectModal target={rejectTarget} onClose={() => setRejectTarget(null)} onDone={reload} />
        </div>
    );
}

function UploadCertificateModal({
    target,
    onClose,
    onDone,
}: {
    target: AdminSigningEnrollment | null;
    onClose: () => void;
    onDone: () => Promise<void>;
}) {
    const [certificate, setCertificate] = useState("");
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    function reset() {
        setCertificate("");
        setError(null);
    }

    function dismiss() {
        if (!uploading) {
            reset();
            onClose();
        }
    }

    function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) {
            return;
        }
        file.text()
            .then((text) => setCertificate(text))
            .catch(() => setError("Could not read this file."));
    }

    // Only invoked from the button below, which only renders once `target` is set (the modal's body) - same
    // non-null-assertion pattern as `data-requests`' `handleApprove()`/`handleDeny()`.
    async function handleUpload() {
        setError(null);
        setUploading(true);
        try {
            const result = await uploadSigningEnrollmentCertificate(target!.enrollmentId, certificate);
            notify({
                kind: "success",
                title: "Certificate accepted",
                message: `${result.identity}: ${result.message}`,
            });
            reset();
            onClose();
            await onDone();
        } catch (err) {
            setError(errorMessage(err, "Could not upload this certificate."));
        } finally {
            setUploading(false);
        }
    }

    const sane = looksLikePemCertificate(certificate);

    return (
        <Modal open={target !== null} onClose={dismiss} title="Upload signing certificate">
            <p className="text-sm mb-3">
                Paste, or choose a file for, the certificate (or certificate chain, leaf first) the certificate authority issued for{" "}
                <strong className="break-all">{target?.identity}</strong>.
            </p>
            <label className="flex flex-col gap-1.5 text-sm mb-3">
                <span className="font-semibold">Certificate (PEM)</span>
                <textarea
                    aria-label="Certificate PEM"
                    className={TEXTAREA_CLASS}
                    rows={8}
                    value={certificate}
                    onChange={(e) => setCertificate(e.target.value)}
                    placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                />
            </label>
            <div className="mb-4">
                <input ref={fileInputRef} type="file" accept=".pem,.crt,.cer,.txt" className="hidden" onChange={handleFileChange} />
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => fileInputRef.current?.click()}>
                    Choose file&hellip;
                </Button>
            </div>
            {certificate.trim() !== "" && !sane && (
                <p role="status" className="mb-3 py-2 px-3 rounded-sm text-xs bg-warning/15 text-text">
                    This doesn't look like a PEM certificate (it should start with -----BEGIN CERTIFICATE-----).
                </p>
            )}
            {error && <Alert>{error}</Alert>}
            <div className="flex gap-3 justify-end mt-2">
                <Button type="button" variant="secondary" className="!w-auto" disabled={uploading} onClick={dismiss}>
                    Cancel
                </Button>
                <Button type="button" className="!w-auto" loading={uploading} disabled={uploading || !certificate.trim()} onClick={handleUpload}>
                    Upload
                </Button>
            </div>
        </Modal>
    );
}

function RejectModal({ target, onClose, onDone }: { target: AdminSigningEnrollment | null; onClose: () => void; onDone: () => Promise<void> }) {
    const [reason, setReason] = useState("");
    const [rejecting, setRejecting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    function dismiss() {
        if (!rejecting) {
            setReason("");
            setError(null);
            onClose();
        }
    }

    // Only invoked from the button below, which only renders once `target` is set - see `handleUpload()`'s identical note.
    async function handleReject() {
        setError(null);
        setRejecting(true);
        try {
            await rejectSigningEnrollment(target!.enrollmentId, reason);
            notify({ kind: "info", title: "Request rejected", message: `${target!.identity}'s signing certificate request was rejected.` });
            setReason("");
            onClose();
            await onDone();
        } catch (err) {
            setError(errorMessage(err, "Could not reject this request."));
        } finally {
            setRejecting(false);
        }
    }

    return (
        <Modal open={target !== null} onClose={dismiss} title="Reject signing certificate request">
            <p className="text-sm mb-3">
                The reason below is shown to <strong className="break-all">{target?.identity}</strong>'s owner.
            </p>
            <label className="flex flex-col gap-1.5 text-sm mb-4">
                <span className="font-semibold">Reason</span>
                <input aria-label="Rejection reason" className={INPUT_CLASS} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            {error && <Alert>{error}</Alert>}
            <div className="flex gap-3 justify-end">
                <Button type="button" variant="secondary" className="!w-auto" disabled={rejecting} onClick={dismiss}>
                    Cancel
                </Button>
                <Button
                    type="button"
                    className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                    loading={rejecting}
                    disabled={rejecting || !reason.trim()}
                    onClick={handleReject}
                >
                    Reject
                </Button>
            </div>
        </Modal>
    );
}
