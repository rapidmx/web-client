///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    DataExportFormat,
    createExportRequest,
    exportRequestDownloadUrl,
    listExportRequests,
} from "@rapidmx/react-shared/mail/dataExportApi.js";
import {
    MailboxImportFormat,
    listImportRequests,
    uploadMailboxImport,
} from "@rapidmx/react-shared/mail/mailboxImportApi.js";
import {
    DataSubjectErasureRequest,
    approveErasureRequest,
    denyErasureRequest,
    listErasureRequests,
} from "@rapidmx/react-shared/mail/erasureRequestApi.js";
import { Folder, listFolders } from "@rapidmx/react-shared/mail/mailApi.js";
import AdminShell, { AdminShellProps } from "../../shared/components/admin/layout/AdminShell.js";
import { LoadMoreButton, usePagedList } from "../../shared/components/admin/usePagedList.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const INPUT_CLASS = "text-sm border border-border rounded-sm py-1.5 px-2 bg-surface";
const NON_MAIL_FOLDER_TYPES = new Set(["calendar", "contacts", "tasks", "notes"]);

function importFormatFromFilename(filename: string): MailboxImportFormat {
    return filename.toLowerCase().endsWith(".pst") ? "pst" : "mbox";
}

function statusBadgeClass(status: string): string {
    if (status === "failed" || status === "denied") return "bg-danger-bg text-danger";
    if (status === "pending" || status === "processing") return "bg-surface-alt text-text-muted";
    return "bg-success text-white";
}

export default function DataRequestsPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="dataRequests">
            <div className="flex flex-col gap-8">
                <div>
                    <h1 className="text-xl font-bold uppercase tracking-wide mb-1">Data Requests</h1>
                    <p className="text-sm text-text-muted">
                        Every GDPR export, mailbox-import, and account-erasure request across every mailbox, newest first.
                    </p>
                </div>
                <ExportRequestsSection />
                <ImportRequestsSection />
                <ErasureRequestsSection />
            </div>
        </AdminShell>
    );
}

function ExportRequestsSection() {
    // The create form below isn't gated behind `loading`, so a fast create-then-reload can resolve before the
    // initial mount fetch does - `usePagedList()` only ever applies the most recently started load.
    const list = usePagedList(listExportRequests, "Could not load export requests.");
    const [mailboxUid, setMailboxUid] = useState("");
    const [format, setFormat] = useState<DataExportFormat>("json");
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    useEffect(() => {
        void list.reload();
    }, []);

    async function handleCreate(e: FormEvent) {
        e.preventDefault();
        setCreateError(null);
        setCreating(true);
        try {
            await createExportRequest({ format, mailboxUid: mailboxUid.trim() });
            setMailboxUid("");
            await list.reload();
        } catch (err) {
            setCreateError(err instanceof ApiRequestError ? err.message : "Could not start this export.");
        } finally {
            setCreating(false);
        }
    }

    return (
        <section>
            <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted mb-3">Export requests</h2>

            <form onSubmit={handleCreate} className="flex items-end gap-3 mb-4 flex-wrap">
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Mailbox UID</span>
                    <input
                        aria-label="Export mailbox UID"
                        className={INPUT_CLASS}
                        value={mailboxUid}
                        onChange={(e) => setMailboxUid(e.target.value)}
                    />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Format</span>
                    <select
                        aria-label="Export format"
                        className={INPUT_CLASS}
                        value={format}
                        onChange={(e) => setFormat(e.target.value as DataExportFormat)}
                    >
                        <option value="json">JSON</option>
                        <option value="mbox">Mbox</option>
                    </select>
                </label>
                <Button type="submit" variant="secondary" className="!w-auto" loading={creating} disabled={creating || !mailboxUid.trim()}>
                    Create export
                </Button>
            </form>

            {createError && <Alert>{createError}</Alert>}
            {list.loadError && <Alert>{list.loadError}</Alert>}

            {list.loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : list.items.length === 0 ? (
                <p className="text-sm text-text-muted">No export requests.</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {list.items.map((request) => (
                        <li
                            key={request.uid}
                            className="flex items-center justify-between gap-3 text-sm py-1.5 px-3 bg-surface-alt rounded-sm"
                        >
                            <span>
                                {request.mailboxUid} &middot; {request.format.toUpperCase()} &middot;{" "}
                                {new Date(request.dateCreated).toLocaleString()}
                                {request.status === "failed" && request.errorMessage && (
                                    <span className="text-danger"> — {request.errorMessage}</span>
                                )}
                            </span>
                            <span className="flex items-center gap-3">
                                <span
                                    className={`text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill ${statusBadgeClass(request.status)}`}
                                >
                                    {request.status}
                                </span>
                                {request.status === "ready" && (
                                    <a href={exportRequestDownloadUrl(request.uid)} className="text-primary-dark hover:underline font-medium">
                                        Download
                                    </a>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            <LoadMoreButton list={list} label="Load more export requests" />
        </section>
    );
}

function ImportRequestsSection() {
    // Same stale-response guard as ExportRequestsSection - the Upload button is enabled independently of this
    // section's own `loading`.
    const list = usePagedList(listImportRequests, "Could not load import requests.");
    const [mailboxUid, setMailboxUid] = useState("");
    const [folders, setFolders] = useState<Folder[]>([]);
    const [targetFolderUid, setTargetFolderUid] = useState("");
    const [folderError, setFolderError] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        void list.reload();
    }, []);

    function handleLoadFolders() {
        const uid = mailboxUid.trim();
        setTargetFolderUid("");
        setFolders([]);
        setFolderError(null);
        if (!uid) {
            return;
        }
        listFolders(uid)
            .then((all) => {
                const mailFolders = all.filter((f) => !NON_MAIL_FOLDER_TYPES.has(f.type));
                setFolders(mailFolders);
                setTargetFolderUid(mailFolders[0]?.uid ?? "");
            })
            .catch((err) => setFolderError(err instanceof ApiRequestError ? err.message : "Could not load this mailbox's folders."));
    }

    function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file || !targetFolderUid || !mailboxUid.trim()) {
            return;
        }
        setUploadError(null);
        setUploading(true);
        uploadMailboxImport(file, { format: importFormatFromFilename(file.name), targetFolderUid, mailboxUid: mailboxUid.trim() })
            .then(() => list.reload())
            .catch((err) => setUploadError(err instanceof ApiRequestError ? err.message : "Could not upload this file."))
            .finally(() => setUploading(false));
    }

    return (
        <section>
            <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted mb-3">Import requests</h2>

            <div className="flex items-end gap-3 mb-2 flex-wrap">
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Mailbox UID</span>
                    <input
                        aria-label="Import mailbox UID"
                        className={INPUT_CLASS}
                        value={mailboxUid}
                        onChange={(e) => setMailboxUid(e.target.value)}
                        onBlur={handleLoadFolders}
                    />
                </label>
                {folders.length > 0 && (
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">Destination folder</span>
                        <select
                            aria-label="Import destination folder"
                            className={INPUT_CLASS}
                            value={targetFolderUid}
                            onChange={(e) => setTargetFolderUid(e.target.value)}
                        >
                            {folders.map((folder) => (
                                <option key={folder.uid} value={folder.uid}>
                                    {folder.name}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                <Button
                    type="button"
                    variant="secondary"
                    className="!w-auto"
                    loading={uploading}
                    disabled={uploading || !targetFolderUid}
                    onClick={() => fileInputRef.current?.click()}
                >
                    Upload Mbox or PST file
                </Button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".mbox,.pst"
                    aria-label="Upload mail archive"
                    className="hidden"
                    onChange={handleFileChange}
                />
            </div>

            {folderError && <Alert>{folderError}</Alert>}
            {uploadError && <Alert>{uploadError}</Alert>}
            {list.loadError && <Alert>{list.loadError}</Alert>}

            {list.loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : list.items.length === 0 ? (
                <p className="text-sm text-text-muted">No import requests.</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {list.items.map((request) => (
                        <li
                            key={request.uid}
                            className="flex items-center justify-between gap-3 text-sm py-1.5 px-3 bg-surface-alt rounded-sm"
                        >
                            <span>
                                {request.mailboxUid} &middot; {request.format.toUpperCase()} &middot;{" "}
                                {new Date(request.dateCreated).toLocaleString()}
                                {request.status === "completed" && (
                                    <span className="text-text-muted">
                                        {" "}
                                        — {request.importedCount ?? 0} imported
                                        {request.failedCount ? `, ${request.failedCount} failed` : ""}
                                    </span>
                                )}
                                {request.status === "failed" && request.errorMessage && (
                                    <span className="text-danger"> — {request.errorMessage}</span>
                                )}
                            </span>
                            <span
                                className={`text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill ${statusBadgeClass(request.status)}`}
                            >
                                {request.status}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            <LoadMoreButton list={list} label="Load more import requests" />
        </section>
    );
}

function ErasureRequestsSection() {
    const list = usePagedList(listErasureRequests, "Could not load erasure requests.");
    const [approveTarget, setApproveTarget] = useState<DataSubjectErasureRequest | null>(null);
    const [approving, setApproving] = useState(false);
    const [approveError, setApproveError] = useState<string | null>(null);
    const [denyTarget, setDenyTarget] = useState<DataSubjectErasureRequest | null>(null);
    const [denyReason, setDenyReason] = useState("");
    const [denying, setDenying] = useState(false);
    const [denyError, setDenyError] = useState<string | null>(null);

    useEffect(() => {
        void list.reload();
    }, []);

    function closeApproveModal() {
        setApproveTarget(null);
        setApproveError(null);
    }

    async function handleApprove() {
        setApproveError(null);
        setApproving(true);
        try {
            // Only invoked from the approve modal below, which only renders once approveTarget is set.
            await approveErasureRequest(approveTarget!.uid);
            closeApproveModal();
            await list.reload();
        } catch (err) {
            setApproveError(err instanceof ApiRequestError ? err.message : "Could not approve this request.");
        } finally {
            setApproving(false);
        }
    }

    function closeDenyModal() {
        setDenyTarget(null);
        setDenyReason("");
        setDenyError(null);
    }

    async function handleDeny() {
        setDenyError(null);
        setDenying(true);
        try {
            // Only invoked from the deny modal below, which only renders once denyTarget is set.
            await denyErasureRequest(denyTarget!.uid, denyReason);
            closeDenyModal();
            await list.reload();
        } catch (err) {
            setDenyError(err instanceof ApiRequestError ? err.message : "Could not deny this request.");
        } finally {
            setDenying(false);
        }
    }

    return (
        <section>
            <h2 className="text-sm font-bold uppercase tracking-wide text-text-muted mb-3">Erasure requests</h2>
            <p className="text-xs text-text-muted mb-3">
                Self-service only — a mailbox owner requests their own account's erasure; there is no
                admin-initiated path here, only review.
            </p>

            {list.loadError && <Alert>{list.loadError}</Alert>}

            {list.loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : list.items.length === 0 ? (
                <p className="text-sm text-text-muted">No erasure requests.</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {list.items.map((request) => (
                        <li key={request.uid} className="border border-border rounded-sm p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-sm">
                                    {request.mailboxUid} &middot; {new Date(request.dateCreated).toLocaleString()}
                                    {request.status === "denied" && request.reason && (
                                        <span className="text-danger"> — {request.reason}</span>
                                    )}
                                    {request.status === "completed" && request.purgedCount !== undefined && (
                                        <span className="text-text-muted"> — {request.purgedCount} records purged</span>
                                    )}
                                </span>
                                <span
                                    className={`text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill ${statusBadgeClass(request.status)}`}
                                >
                                    {request.status}
                                </span>
                            </div>
                            {request.status === "pending" && (
                                <div className="flex gap-3 mt-2">
                                    <Button type="button" className="!w-auto" onClick={() => setApproveTarget(request)}>
                                        Approve
                                    </Button>
                                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setDenyTarget(request)}>
                                        Deny
                                    </Button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            <LoadMoreButton list={list} label="Load more erasure requests" />

            <Modal open={approveTarget !== null} onClose={closeApproveModal} title="Approve erasure request">
                <p className="text-sm mb-3">
                    Approving permanently erases the mailbox <strong className="break-all">{approveTarget?.mailboxUid}</strong>{" "}
                    and everything in it - mail, contacts, calendars, tasks, and notes.
                </p>
                <p className="text-sm font-semibold text-danger mb-4">This is irreversible and cannot be undone.</p>
                {approveError && <Alert>{approveError}</Alert>}
                <div className="flex gap-3 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={approving} onClick={closeApproveModal}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                        loading={approving}
                        disabled={approving}
                        onClick={handleApprove}
                    >
                        Erase mailbox
                    </Button>
                </div>
            </Modal>

            <Modal open={denyTarget !== null} onClose={closeDenyModal} title="Deny erasure request">
                <label className="flex flex-col gap-1.5 text-sm mb-4">
                    <span className="font-semibold">Reason</span>
                    <input
                        aria-label="Denial reason"
                        className={INPUT_CLASS}
                        value={denyReason}
                        onChange={(e) => setDenyReason(e.target.value)}
                    />
                </label>
                {denyError && <Alert>{denyError}</Alert>}
                <div className="flex gap-3 justify-end">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={denying} onClick={closeDenyModal}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                        loading={denying}
                        disabled={denying || !denyReason.trim()}
                        onClick={handleDeny}
                    >
                        Deny
                    </Button>
                </div>
            </Modal>
        </section>
    );
}
