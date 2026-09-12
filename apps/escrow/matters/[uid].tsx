///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { closeMatter, getMatter, Matter } from "@rapidmx/react-shared/admin/mattersApi.js";
import {
    approveAccessRequest,
    createAccessRequest,
    denyAccessRequest,
    EscrowAccessRequest,
    getAccessRequestMaterial,
    listAccessRequests,
} from "@rapidmx/react-shared/admin/escrowAccessRequestsApi.js";
import {
    createMatterExportRequest,
    listMatterExportRequests,
    matterExportRequestDownloadUrl,
    MatterExportRequest,
} from "@rapidmx/react-shared/admin/matterExportApi.js";
import { searchMatter, SearchResultPage } from "@rapidmx/react-shared/admin/matterSearchApi.js";
import EscrowShell, { EscrowShellProps } from "../../shared/components/escrow/layout/EscrowShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

// `BaseEscrowAccessRequestRoute.find()` always returns every request under every scope the caller holds
// (it unconditionally overwrites any `matterId` filter with its own held-scopes-derived one — see
// `escrowAccessRequestsApi.ts`'s own doc comment) — there is no server-side way to ask for just this one
// matter's requests. This page fetches a generously-sized single page and filters client-side instead of
// paginating a second, matter-scoped list UI on top of an already-scoped one; a holder with more than this
// many *total* in-flight requests across every matter they hold is not the common case this v1 targets.
const REQUESTS_FETCH_LIMIT = 200;

function statusBadgeClass(status: string): string {
    if (status === "denied" || status === "failed") return "bg-danger-bg text-danger";
    if (status === "pending") return "bg-surface-alt text-text-muted";
    return "bg-success text-white";
}

export default function MatterDetailPage(props: Omit<EscrowShellProps, "active"> & { params: { uid: string } }) {
    return (
        <EscrowShell {...props} active="matters">
            <MatterDetailContent uid={props.params.uid} />
        </EscrowShell>
    );
}

function MatterDetailContent({ uid }: { uid: string }) {
    const [matter, setMatter] = useState<Matter | null>(null);
    const [requests, setRequests] = useState<EscrowAccessRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [closing, setClosing] = useState(false);
    const [closeError, setCloseError] = useState<string | null>(null);

    const [showNewRequest, setShowNewRequest] = useState(false);
    const [newRequestMailboxUid, setNewRequestMailboxUid] = useState("");
    const [creatingRequest, setCreatingRequest] = useState(false);
    const [newRequestError, setNewRequestError] = useState<string | null>(null);

    // Keyed by request uid — several rows can be independently mid-action at once.
    const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
    const [actingOn, setActingOn] = useState<Record<string, boolean>>({});

    const [materialFor, setMaterialFor] = useState<EscrowAccessRequest | null>(null);
    const [materialText, setMaterialText] = useState("");
    const [materialError, setMaterialError] = useState<string | null>(null);
    const [loadingMaterial, setLoadingMaterial] = useState(false);

    const [exportRequests, setExportRequests] = useState<MatterExportRequest[]>([]);
    const [creatingExport, setCreatingExport] = useState(false);
    const [exportError, setExportError] = useState<string | null>(null);

    const [searchText, setSearchText] = useState("");
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [searchResults, setSearchResults] = useState<Record<string, SearchResultPage> | null>(null);

    // Same "no server-side single-matter filter, fetch a generous page and filter client-side" shape
    // REQUESTS_FETCH_LIMIT's own doc comment already establishes for access requests -
    // listMatterExportRequests() has the identical held-scopes-derived scoping, not a per-matter one.
    function reload() {
        setLoading(true);
        setError(null);
        Promise.all([getMatter(uid), listAccessRequests({ limit: REQUESTS_FETCH_LIMIT }), listMatterExportRequests()])
            .then(([loadedMatter, allRequests, allExportRequests]) => {
                setMatter(loadedMatter);
                setRequests(allRequests.filter((r) => r.matterId === uid));
                setExportRequests(allExportRequests.filter((r) => r.matterId === uid));
            })
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this matter."))
            .finally(() => setLoading(false));
    }

    useEffect(() => {
        reload();
    }, [uid]);

    // Only ever invoked from the "Close matter" button below, which itself only renders once `matter` is
    // resolved (children only render once loaded — see the early returns further down) — the non-null
    // assertion reflects that real invariant, not an unchecked assumption. Matches `DomainDetailContent.
    // handleVerify`'s identical pattern.
    async function handleClose() {
        setClosing(true);
        setCloseError(null);
        try {
            const updated = await closeMatter(matter!.uid);
            setMatter(updated);
        } catch (err) {
            setCloseError(err instanceof ApiRequestError ? err.message : "Could not close this matter.");
        } finally {
            setClosing(false);
        }
    }

    async function handleCreateRequest(e: FormEvent) {
        e.preventDefault();
        setNewRequestError(null);
        if (!newRequestMailboxUid.trim()) {
            setNewRequestError("A mailbox uid is required.");
            return;
        }
        setCreatingRequest(true);
        try {
            await createAccessRequest({ matterId: uid, mailboxUid: newRequestMailboxUid.trim() });
            setShowNewRequest(false);
            setNewRequestMailboxUid("");
            reload();
        } catch (err) {
            setNewRequestError(err instanceof ApiRequestError ? err.message : "Could not create this access request.");
        } finally {
            setCreatingRequest(false);
        }
    }

    async function handleApprove(request: EscrowAccessRequest) {
        setActingOn((prev) => ({ ...prev, [request.uid]: true }));
        setActionErrors((prev) => ({ ...prev, [request.uid]: "" }));
        try {
            const updated = await approveAccessRequest(request.uid);
            setRequests((prev) => prev.map((r) => (r.uid === updated.uid ? updated : r)));
        } catch (err) {
            setActionErrors((prev) => ({
                ...prev,
                [request.uid]: err instanceof ApiRequestError ? err.message : "Could not approve this request.",
            }));
        } finally {
            setActingOn((prev) => ({ ...prev, [request.uid]: false }));
        }
    }

    async function handleDeny(request: EscrowAccessRequest) {
        setActingOn((prev) => ({ ...prev, [request.uid]: true }));
        setActionErrors((prev) => ({ ...prev, [request.uid]: "" }));
        try {
            const updated = await denyAccessRequest(request.uid);
            setRequests((prev) => prev.map((r) => (r.uid === updated.uid ? updated : r)));
        } catch (err) {
            setActionErrors((prev) => ({
                ...prev,
                [request.uid]: err instanceof ApiRequestError ? err.message : "Could not deny this request.",
            }));
        } finally {
            setActingOn((prev) => ({ ...prev, [request.uid]: false }));
        }
    }

    async function handleGetMaterial(request: EscrowAccessRequest) {
        setMaterialFor(request);
        setMaterialText("");
        setMaterialError(null);
        setLoadingMaterial(true);
        try {
            const material = await getAccessRequestMaterial(request.uid);
            setMaterialText(JSON.stringify(material.masterKeyWraps, null, 2));
        } catch (err) {
            setMaterialError(err instanceof ApiRequestError ? err.message : "Could not read this request's material.");
        } finally {
            setLoadingMaterial(false);
        }
    }

    function closeMaterialModal() {
        setMaterialFor(null);
    }

    async function handleCreateExport() {
        setExportError(null);
        setCreatingExport(true);
        try {
            await createMatterExportRequest(uid);
            reload();
        } catch (err) {
            setExportError(err instanceof ApiRequestError ? err.message : "Could not start this export.");
        } finally {
            setCreatingExport(false);
        }
    }

    async function handleSearch(e: FormEvent) {
        e.preventDefault();
        setSearchError(null);
        setSearching(true);
        try {
            const results = await searchMatter(uid, searchText);
            setSearchResults(results);
        } catch (err) {
            setSearchError(err instanceof ApiRequestError ? err.message : "Could not search this matter.");
        } finally {
            setSearching(false);
        }
    }

    if (loading) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error || !matter) {
        return <Alert>{error ?? "Matter not found."}</Alert>;
    }

    return (
        <div className="max-w-4xl flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <a href="/escrow" className="text-sm text-primary-dark hover:underline">
                        &larr; All matters
                    </a>
                    <h1 className="text-xl font-bold tracking-tight mt-1">{matter.name}</h1>
                </div>
                {!matter.closedAt && (
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto shrink-0"
                        loading={closing}
                        disabled={closing}
                        onClick={handleClose}
                    >
                        Close matter
                    </Button>
                )}
            </div>

            {closeError && <Alert>{closeError}</Alert>}

            <div className="bg-surface border border-border rounded-md p-6">
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                    <dt className="text-text-muted">Description</dt>
                    <dd>{matter.description ?? "None"}</dd>
                    <dt className="text-text-muted">Escrow scope</dt>
                    <dd className="font-mono text-xs">{matter.escrowScopeId}</dd>
                    <dt className="text-text-muted">Custodian mailboxes</dt>
                    <dd>{matter.custodianMailboxUids.join(", ")}</dd>
                    <dt className="text-text-muted">Date range</dt>
                    <dd>
                        {new Date(matter.dateRangeStart).toLocaleDateString()} &ndash;{" "}
                        {new Date(matter.dateRangeEnd).toLocaleDateString()}
                    </dd>
                    <dt className="text-text-muted">Status</dt>
                    <dd>{matter.closedAt ? `Closed ${new Date(matter.closedAt).toLocaleString()}` : "Open"}</dd>
                </dl>
            </div>

            <div className="bg-surface border border-border rounded-md p-6">
                <div className="flex items-center justify-between mb-3">
                    <h2 className="text-base font-bold uppercase tracking-wide">Access requests</h2>
                    {!matter.closedAt && (
                        <Button type="button" className="!w-auto" onClick={() => setShowNewRequest(true)}>
                            + New access request
                        </Button>
                    )}
                </div>

                {requests.length === 0 ? (
                    <p className="text-sm text-text-muted">No access requests yet.</p>
                ) : (
                    <ul className="flex flex-col gap-3">
                        {requests.map((request) => (
                            <li key={request.uid} className="border border-border rounded-sm p-4">
                                <div className="flex items-center justify-between gap-3 flex-wrap">
                                    <div>
                                        <div className="text-sm font-semibold">{request.mailboxUid}</div>
                                        <div className="text-xs text-text-muted">
                                            {request.approvals.length} of {request.requiredHoldersAtCreation} approvals
                                            &middot; requested by {request.requestedByUserUid}
                                        </div>
                                    </div>
                                    <span
                                        className={[
                                            "text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill",
                                            request.status === "denied"
                                                ? "bg-danger-bg text-danger"
                                                : request.status === "pending"
                                                  ? "bg-surface-alt text-text-muted"
                                                  : "bg-success text-white",
                                        ].join(" ")}
                                    >
                                        {request.status}
                                    </span>
                                </div>

                                {actionErrors[request.uid] && <Alert>{actionErrors[request.uid]}</Alert>}

                                <div className="flex gap-3 mt-3">
                                    {request.status === "pending" && (
                                        <>
                                            <Button
                                                type="button"
                                                className="!w-auto"
                                                loading={actingOn[request.uid]}
                                                disabled={actingOn[request.uid]}
                                                onClick={() => handleApprove(request)}
                                            >
                                                Approve
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                className="!w-auto"
                                                loading={actingOn[request.uid]}
                                                disabled={actingOn[request.uid]}
                                                onClick={() => handleDeny(request)}
                                            >
                                                Deny
                                            </Button>
                                        </>
                                    )}
                                    {(request.status === "approved" || request.status === "fulfilled") && (
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            className="!w-auto"
                                            onClick={() => handleGetMaterial(request)}
                                        >
                                            Get material
                                        </Button>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="bg-surface border border-border rounded-md p-6">
                <div className="flex items-center justify-between mb-3">
                    <h2 className="text-base font-bold uppercase tracking-wide">Export this matter</h2>
                    <Button type="button" className="!w-auto" loading={creatingExport} disabled={creatingExport} onClick={handleCreateExport}>
                        + New export
                    </Button>
                </div>
                <p className="text-xs text-text-muted mb-3">
                    Exports messages (narrowed to this matter&rsquo;s own date range), plus full contacts,
                    calendar events, tasks, and notes, from every custodian mailbox actually assigned to this
                    matter&rsquo;s escrow scope, as one combined NDJSON file.
                </p>
                {exportError && <Alert>{exportError}</Alert>}
                {exportRequests.length === 0 ? (
                    <p className="text-sm text-text-muted">No export requests yet.</p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {exportRequests.map((request) => (
                            <li
                                key={request.uid}
                                className="flex items-center justify-between gap-3 text-sm py-1.5 px-3 bg-surface-alt rounded-sm"
                            >
                                <span>
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
                                        <a
                                            href={matterExportRequestDownloadUrl(request.uid)}
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

            <div className="bg-surface border border-border rounded-md p-6">
                <h2 className="text-base font-bold uppercase tracking-wide mb-3">Search this matter&rsquo;s custodians</h2>
                <form onSubmit={handleSearch} className="flex gap-3 mb-4">
                    <input
                        aria-label="Search this matter"
                        className={INPUT_CLASS}
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        placeholder="Free text or an operator filter, e.g. from:alice@example.com"
                    />
                    <Button type="submit" className="!w-auto shrink-0" loading={searching} disabled={searching || !searchText.trim()}>
                        Search
                    </Button>
                </form>
                {searchError && <Alert>{searchError}</Alert>}
                {searchResults &&
                    (Object.keys(searchResults).length === 0 ? (
                        <p className="text-sm text-text-muted">No custodian mailboxes could be searched.</p>
                    ) : (
                        <div className="flex flex-col gap-4">
                            {Object.entries(searchResults).map(([mailboxUid, page]) => (
                                <div key={mailboxUid}>
                                    <h3 className="text-sm font-semibold mb-2">{mailboxUid}</h3>
                                    {page.results.length === 0 ? (
                                        <p className="text-xs text-text-muted">No matches.</p>
                                    ) : (
                                        <ul className="flex flex-col gap-1">
                                            {page.results.map((result) => (
                                                <li
                                                    key={`${result.entityType}-${result.entityUid}`}
                                                    className="text-sm py-1 px-2 bg-surface-alt rounded-sm"
                                                >
                                                    {result.entityType} &middot; {result.entityUid}
                                                    {result.snippet && <span className="text-text-muted"> — {result.snippet}</span>}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            ))}
                        </div>
                    ))}
            </div>

            <Modal open={showNewRequest} onClose={() => setShowNewRequest(false)} title="New access request">
                <form onSubmit={handleCreateRequest} className="flex flex-col gap-4">
                    {newRequestError && <Alert>{newRequestError}</Alert>}
                    <FormField label="Mailbox uid" htmlFor="newRequestMailboxUid">
                        <input
                            id="newRequestMailboxUid"
                            type="text"
                            className={INPUT_CLASS}
                            value={newRequestMailboxUid}
                            onChange={(e) => setNewRequestMailboxUid(e.target.value)}
                        />
                    </FormField>
                    <p className="text-xs text-text-muted">
                        Must be one of this matter's own custodian mailboxes, currently assigned to this matter's
                        escrow scope. Your own creation counts as the first approval.
                    </p>
                    <div className="flex gap-3 justify-end">
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto"
                            disabled={creatingRequest}
                            onClick={() => setShowNewRequest(false)}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" className="!w-auto" loading={creatingRequest} disabled={creatingRequest}>
                            Create request
                        </Button>
                    </div>
                </form>
            </Modal>

            <Modal open={materialFor !== null} onClose={closeMaterialModal} title="Escrow key material">
                {/* Deliberately raw JSON, not a decrypt/viewer UI: this console never attempts to decrypt
                    anything, per specs/end-to-end_encryption.md's "this server never holds the scope's
                    private key" - the holder is expected to copy this into their own offline tooling. See
                    this session's own report for this documented scope trim. */}
                {loadingMaterial ? (
                    <p className="text-sm text-text-muted">Loading&hellip;</p>
                ) : materialError ? (
                    <Alert>{materialError}</Alert>
                ) : (
                    <>
                        <p className="text-sm text-text-muted mb-3">
                            Still-encrypted master key wraps for <strong>{materialFor?.mailboxUid}</strong> — this
                            server cannot decrypt these either. Copy the JSON below into your own offline tooling.
                        </p>
                        <pre className="text-xs font-mono bg-surface-alt border border-border rounded-sm p-3 overflow-x-auto whitespace-pre-wrap break-all">
                            {materialText}
                        </pre>
                    </>
                )}
            </Modal>
        </div>
    );
}
