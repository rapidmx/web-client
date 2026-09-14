///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    DataExportFormat,
    DataExportRequest,
    createExportRequest,
    exportRequestDownloadUrl,
    listExportRequests,
} from "@rapidmx/react-shared/mail/dataExportApi.js";
import {
    MailboxImportFormat,
    MailboxImportRequest,
    listImportRequests,
    uploadMailboxImport,
} from "@rapidmx/react-shared/mail/mailboxImportApi.js";
import {
    DataSubjectErasureRequest,
    createErasureRequest,
    listErasureRequests,
} from "@rapidmx/react-shared/mail/erasureRequestApi.js";
import { Folder, listFolders } from "@rapidmx/react-shared/mail/mailApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const NON_MAIL_FOLDER_TYPES = new Set(["calendar", "contacts", "tasks", "notes"]);

function importFormatFromFilename(filename: string): MailboxImportFormat {
    return filename.toLowerCase().endsWith(".pst") ? "pst" : "mbox";
}

function statusBadgeClass(status: string): string {
    if (status === "failed" || status === "denied") return "bg-danger-bg text-danger";
    if (status === "pending" || status === "processing") return "bg-surface-alt text-text-muted";
    return "bg-success text-white";
}

export type SettingsPrivacyPageProps = Omit<SettingsShellProps, "active">;

export default function SettingsPrivacyPage(props: SettingsPrivacyPageProps) {
    return (
        <SettingsShell {...props} active="privacy">
            <PrivacyContent userUid={props.userUid} />
        </SettingsShell>
    );
}

function PrivacyContent({ userUid }: { userUid?: string }) {
    const { mailboxUid, mailboxes } = useSettingsShell();
    // Data export and account erasure always act on the *caller's own* mailbox server-side (neither
    // request carries a mailbox), whatever the switcher shows - so both are only offered while the
    // switcher is on that mailbox, and name it explicitly. Import targets the selected mailbox's own
    // folders, so it stays available for any selected mailbox.
    const selected = mailboxes.find((mb) => mb.uid === mailboxUid)!;
    const ownMailbox = mailboxes.find((mb) => mb.ownerUserUid !== undefined && mb.ownerUserUid === userUid);
    const selectedIsOwn = selected.uid === ownMailbox?.uid;

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-xl flex flex-col gap-8">
                <div>
                    <h1 className="text-lg font-bold tracking-tight mb-1">Privacy &amp; Data</h1>
                    <p className="text-sm text-text-muted">Export or manage the data associated with this mailbox.</p>
                </div>

                {selectedIsOwn ? (
                    <ExportSection mailboxUid={mailboxUid} mailboxLabel={`${selected.displayName} (${selected.primarySmtpAddress})`} />
                ) : (
                    <OwnMailboxOnlyNotice ownMailboxLabel={ownMailbox && `${ownMailbox.displayName} (${ownMailbox.primarySmtpAddress})`} />
                )}
                <ImportSection mailboxUid={mailboxUid} />
                {selectedIsOwn && <ErasureSection mailboxLabel={`${selected.displayName} (${selected.primarySmtpAddress})`} />}
            </div>
        </div>
    );
}

function OwnMailboxOnlyNotice({ ownMailboxLabel }: { ownMailboxLabel?: string }) {
    return (
        <div>
            <h2 className="text-sm font-semibold mb-2">Export or delete my data</h2>
            <p className="text-xs text-text-muted">
                Exporting your data and deleting your account only apply to your own mailbox, not one shared with
                you.{" "}
                {ownMailboxLabel
                    ? `Switch to ${ownMailboxLabel} to manage them.`
                    : "You don't have a mailbox of your own to manage here."}
            </p>
        </div>
    );
}

function ExportSection({ mailboxUid, mailboxLabel }: { mailboxUid?: string; mailboxLabel: string }) {
    const [requests, setRequests] = useState<DataExportRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [format, setFormat] = useState<DataExportFormat>("json");
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    // The create form below isn't gated behind `loading`, so a fast create-then-reload can resolve before
    // the initial mount fetch does; without this guard the mount fetch's now-stale response would land
    // last and silently revert the list. Only the most-recently-issued load's response is ever applied.
    const loadSeq = useRef(0);
    function loadRequests() {
        const seq = ++loadSeq.current;
        return listExportRequests()
            .then((data) => {
                if (seq === loadSeq.current) {
                    setRequests(data);
                }
            })
            .catch((err) => {
                if (seq === loadSeq.current) {
                    setLoadError(err instanceof ApiRequestError ? err.message : "Could not load your export requests.");
                }
            });
    }

    useEffect(() => {
        void loadRequests().finally(() => setLoading(false));
    }, [mailboxUid]);

    async function handleCreate(e: FormEvent) {
        e.preventDefault();
        setCreateError(null);
        setCreating(true);
        try {
            await createExportRequest({ format });
            await loadRequests();
        } catch (err) {
            setCreateError(err instanceof ApiRequestError ? err.message : "Could not start this export.");
        } finally {
            setCreating(false);
        }
    }

    return (
        <div>
            <h2 className="text-sm font-semibold mb-2">Export my data</h2>
            <p className="text-xs text-text-muted mb-3">
                Requests a copy of <strong>{mailboxLabel}</strong>&rsquo;s messages, contacts, calendar, tasks, and notes. This runs
                in the background and can take a few minutes — check back here for a download link once it&rsquo;s
                ready.
            </p>

            <form onSubmit={handleCreate} className="flex items-end gap-3 mb-5">
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Format</span>
                    <select
                        aria-label="Export format"
                        className="text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                        value={format}
                        onChange={(e) => setFormat(e.target.value as DataExportFormat)}
                    >
                        <option value="json">JSON</option>
                        <option value="mbox">Mbox</option>
                    </select>
                </label>
                <Button type="submit" variant="secondary" className="!w-auto" loading={creating} disabled={creating}>
                    Request export
                </Button>
            </form>

            {createError && <Alert>{createError}</Alert>}
            {loadError && <Alert>{loadError}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : requests.length === 0 ? (
                <p className="text-sm text-text-muted">No export requests yet.</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {requests.map((request) => (
                        <li
                            key={request.uid}
                            className="flex items-center justify-between gap-3 text-sm py-1.5 px-3 bg-surface-alt rounded-sm"
                        >
                            <span>
                                {request.format.toUpperCase()} &middot; {new Date(request.dateCreated).toLocaleString()}
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
                                    <a
                                        href={exportRequestDownloadUrl(request.uid)}
                                        className="text-primary-dark hover:underline font-medium"
                                    >
                                        Download
                                    </a>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function ImportSection({ mailboxUid }: { mailboxUid?: string }) {
    const [folders, setFolders] = useState<Folder[]>([]);
    const [targetFolderUid, setTargetFolderUid] = useState("");
    const [foldersError, setFoldersError] = useState<string | null>(null);
    const [requests, setRequests] = useState<MailboxImportRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Same stale-response guard as ExportSection's loadRequests() - the Upload button is enabled
    // independently of this section's own `loading`, so a fast upload-then-reload can resolve before the
    // initial mount fetch does.
    const loadSeq = useRef(0);
    function loadRequests() {
        const seq = ++loadSeq.current;
        return listImportRequests()
            .then((data) => {
                if (seq === loadSeq.current) {
                    setRequests(data);
                }
            })
            .catch((err) => {
                if (seq === loadSeq.current) {
                    setLoadError(err instanceof ApiRequestError ? err.message : "Could not load your import requests.");
                }
            });
    }

    useEffect(() => {
        // Only reachable once mailboxUid is resolved - SettingsShell never renders this page's children
        // until then, the same invariant every other settings page in this codebase already relies on.
        void Promise.all([
            listFolders(mailboxUid!)
                .then((all) => {
                    const mailFolders = all.filter((f) => !NON_MAIL_FOLDER_TYPES.has(f.type));
                    setFolders(mailFolders);
                    setTargetFolderUid(mailFolders[0]?.uid ?? "");
                })
                .catch((err) =>
                    setFoldersError(err instanceof ApiRequestError ? err.message : "Could not load this mailbox's folders."),
                ),
            loadRequests(),
        ]).finally(() => setLoading(false));
    }, [mailboxUid]);

    function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file || !targetFolderUid) {
            return;
        }
        setUploadError(null);
        setUploading(true);
        uploadMailboxImport(file, { format: importFormatFromFilename(file.name), targetFolderUid })
            .then(() => loadRequests())
            .catch((err) => setUploadError(err instanceof ApiRequestError ? err.message : "Could not upload this file."))
            .finally(() => setUploading(false));
    }

    return (
        <div>
            <h2 className="text-sm font-semibold mb-2">Import mail</h2>
            <p className="text-xs text-text-muted mb-3">
                Uploads an Mbox or PST archive and imports every message it contains into the folder you
                choose below. This runs in the background — check back here for its progress.
            </p>

            {folders.length > 0 && (
                <label className="flex flex-col gap-1.5 text-sm mb-3 max-w-xs">
                    <span className="font-semibold">Destination folder</span>
                    <select
                        aria-label="Destination folder"
                        className="text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
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
                className="!w-auto mb-3"
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

            {foldersError && <Alert>{foldersError}</Alert>}
            {uploadError && <Alert>{uploadError}</Alert>}
            {loadError && <Alert>{loadError}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : requests.length === 0 ? (
                <p className="text-sm text-text-muted">No import requests yet.</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {requests.map((request) => (
                        <li
                            key={request.uid}
                            className="flex items-center justify-between gap-3 text-sm py-1.5 px-3 bg-surface-alt rounded-sm"
                        >
                            <span>
                                {request.format.toUpperCase()} &middot; {new Date(request.dateCreated).toLocaleString()}
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
        </div>
    );
}

function ErasureSection({ mailboxLabel }: { mailboxLabel: string }) {
    const [requests, setRequests] = useState<DataSubjectErasureRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    function loadRequests() {
        return listErasureRequests()
            .then(setRequests)
            .catch((err) => setLoadError(err instanceof ApiRequestError ? err.message : "Could not load your erasure requests."));
    }

    useEffect(() => {
        void loadRequests().finally(() => setLoading(false));
    }, []);

    const hasPending = requests.some((request) => request.status === "pending");

    function closeConfirm() {
        setConfirming(false);
    }

    async function handleConfirm() {
        setCreateError(null);
        setCreating(true);
        try {
            await createErasureRequest();
            setConfirming(false);
            await loadRequests();
        } catch (err) {
            setCreateError(err instanceof ApiRequestError ? err.message : "Could not submit this request.");
        } finally {
            setCreating(false);
        }
    }

    return (
        <div>
            <h2 className="text-sm font-semibold mb-2">Delete my account</h2>
            <p className="text-xs text-text-muted mb-3">
                Permanently and irreversibly deletes <strong>{mailboxLabel}</strong> and everything in it, once a compliance
                administrator reviews and approves the request. There is no way to cancel a request or undo
                the deletion once it runs.
            </p>

            {loadError && <Alert>{loadError}</Alert>}

            {loading ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : (
                <>
                    {requests.length > 0 && (
                        <ul className="flex flex-col gap-2 mb-3">
                            {requests.map((request) => (
                                <li
                                    key={request.uid}
                                    className="flex items-center justify-between gap-3 text-sm py-1.5 px-3 bg-surface-alt rounded-sm"
                                >
                                    <span>
                                        {new Date(request.dateCreated).toLocaleString()}
                                        {request.status === "denied" && request.reason && (
                                            <span className="text-danger"> — {request.reason}</span>
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
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto !border-danger !text-danger hover:!border-danger hover:!text-danger"
                        disabled={hasPending}
                        onClick={() => setConfirming(true)}
                    >
                        Request account erasure
                    </Button>
                </>
            )}

            <Modal open={confirming} onClose={closeConfirm} title="Delete my account">
                <p className="text-sm mb-5">
                    This permanently deletes {mailboxLabel} and everything in it — messages, contacts,
                    calendar, tasks, and notes — once approved. This cannot be undone and cannot be
                    cancelled once submitted.
                </p>
                {createError && <Alert>{createError}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={creating} onClick={closeConfirm}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                        loading={creating}
                        disabled={creating}
                        onClick={handleConfirm}
                    >
                        Request erasure
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
