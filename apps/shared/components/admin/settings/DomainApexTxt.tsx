///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useEffect, useRef, useState } from "react";
import { DnsProviderType, listDnsProviders } from "../../../../../lib/admin/dnsProvidersApi.js";
import { ApexTxtView, Domain, getApexTxt, updateApexTxt } from "../../../../../lib/admin/domainsApi.js";
import Button from "../../../../../lib/components/buttons/Button.js";
import FormField from "../../../../../lib/components/forms/FormField.js";
import Modal from "../../../../../lib/components/overlays/Modal.js";
import Alert from "../ActionAlert.js";
import { actionErrorMessage } from "../elevation.js";

const INPUT_CLASS =
    "w-full text-sm font-mono py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** The values in a "values to keep" box: one per line, trimmed, blank lines dropped, each once. */
function parseKeep(text: string): string[] {
    return [...new Set(text.split("\n").map((line) => line.trim()).filter(Boolean))];
}

/** What the values to keep start as: while managed the saved list; otherwise the suggestion from the live lookup plus the values kept before an opt-out,
 * which are restored as plain records only after a few minutes and so are not at the root yet. */
function startingKeep(view: ApexTxtView): string[] {
    return view.managed ? view.keep : [...new Set([...view.suggestedKeep, ...view.keep])];
}

/** TXT values, each in full (they can be long). */
function Values({ label, values }: { label: string; values: string[] }) {
    return (
        <ul aria-label={label} className="flex flex-col gap-1 mb-3">
            {values.map((value) => (
                <li key={value}>
                    <code className="text-xs break-all">{value}</code>
                </li>
            ))}
        </ul>
    );
}

function Card({ children }: { children: ReactNode }) {
    return (
        <div className="bg-surface border border-border rounded-md p-6">
            <h2 className="text-sm font-bold uppercase tracking-wide mb-3">Root TXT records</h2>
            {children}
        </div>
    );
}

export interface DomainApexTxtProps {
    domain: Domain;
    /** Called after a change was saved, so the page can load the domain and its checklist again. */
    onChanged: () => void;
}

/**
 * Whether RapidMX owns the domain's root TXT records to publish its SPF record there. A provider that owns a record set owns every value in it, so
 * nothing is published there unless the administrator opts in with the values to keep; while it is managed, values added at the DNS host are removed, so
 * this is the only place to edit them (spec 9.4). Shown for a domain a DNS provider publishes.
 */
export default function DomainApexTxt({ domain, onChanged }: DomainApexTxtProps) {
    const [view, setView] = useState<ApexTxtView | null>(null);
    // Whether the view is what the server said when the page last asked: not while the opt-in dialog is waiting for the values at the root now.
    const [fresh, setFresh] = useState(false);
    // The type of the domain's provider, which decides what it can keep; null while unknown (then the server decides).
    const [providerType, setProviderType] = useState<DnsProviderType | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [keepText, setKeepText] = useState("");
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [stopped, setStopped] = useState(false);
    // Which confirmation is open: opting in (with what it will do), or stopping.
    const [confirming, setConfirming] = useState<"in" | "out" | null>(null);

    // An Azure provider keeps one value per name, so the set holds the SPF record alone; rfc2136 can't keep an SPF value at all (the server's `providerKeepsTxt`).
    const keepsNothing = providerType === "azure";
    const cantManage = providerType === "rfc2136";
    // The newest request, so an answer to an older one is dropped, and whether the keep list holds edits the server hasn't seen (a reload leaves them).
    const latest = useRef(0);
    const dirty = useRef(false);

    function load(resetKeep = true) {
        const request = ++latest.current;
        setLoadError(null);
        return getApexTxt(domain.uid)
            .then((loaded) => {
                if (request !== latest.current) {
                    return;
                }
                setView(loaded);
                setFresh(true);
                if (resetKeep && !dirty.current) {
                    setKeepText(startingKeep(loaded).join("\n"));
                }
                // The opt-in must not go on without knowing what is at the root.
                if (loaded.lookupFailed) {
                    setConfirming((open) => (open === "in" ? null : open));
                }
            })
            .catch((err) => {
                if (request !== latest.current) {
                    return;
                }
                setView(null);
                setConfirming(null);
                setLoadError(actionErrorMessage(err, "Could not load the root TXT records."));
            });
    }

    // Again when the domain was saved (its version moved), which is how a change made here arrives.
    useEffect(() => {
        void load();
    }, [domain.uid, domain.dnsProviderUid, domain.version]);

    useEffect(() => {
        let current = true;
        listDnsProviders()
            .then((providers) => current && setProviderType(providers.find((provider) => provider.uid === domain.dnsProviderUid)?.type ?? null))
            .catch(() => current && setProviderType(null));
        return () => {
            current = false;
        };
    }, [domain.dnsProviderUid]);

    async function save(managed: boolean) {
        setSaving(true);
        setError(null);
        setSaved(false);
        setStopped(false);
        try {
            const keep = keepsNothing ? [] : parseKeep(keepText);
            await updateApexTxt(domain.uid, managed ? { managed, keep } : { managed });
            dirty.current = false;
            if (managed) {
                // An edit while managed leaves the domain as it was, so the view takes the new list itself; an opt-in arrives with the reloaded domain.
                setView((current) => (current!.managed ? { ...current!, keep } : current));
                setSaved(true);
            } else {
                setStopped(true);
            }
            setConfirming(null);
            onChanged();
        } catch (err) {
            setError(actionErrorMessage(err, "Could not change the root TXT records."));
        } finally {
            setSaving(false);
        }
    }

    // The values removed are listed from what is at the root when the dialog opens, not when the page loaded; the keep list stays as it is.
    function confirm(kind: "in" | "out") {
        setError(null);
        setConfirming(kind);
        if (kind === "in") {
            setFresh(false);
            void load(false);
        }
    }

    if (loadError) {
        return (
            <Card>
                <Alert>{loadError}</Alert>
            </Card>
        );
    }
    if (!view) {
        return (
            <Card>
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            </Card>
        );
    }

    const keep = keepsNothing ? [] : parseKeep(keepText);
    const removed = view.current.filter((value) => !keep.includes(value));
    // What a stop restores, and what an earlier stop restored: the SPF value RapidMX published and the values it kept.
    const published = [...(view.spf ? [view.spf] : []), ...view.keep];
    const keepField = keepsNothing ? (
        <p className="text-sm text-text-muted mb-3">
            An Azure DNS provider keeps one value per name, so the root TXT records would hold the SPF record alone and RapidMX would remove every other value.
        </p>
    ) : (
        <FormField label="Values to keep" htmlFor="apexTxtKeep">
            <textarea
                id="apexTxtKeep"
                className={INPUT_CLASS}
                rows={Math.max(3, keep.length + 1)}
                value={keepText}
                onChange={(e) => {
                    dirty.current = true;
                    setKeepText(e.target.value);
                    setSaved(false);
                }}
            />
            <p className="text-xs text-text-muted mt-1">One value per line, exactly as it is in the DNS (a site-verification record, for example).</p>
        </FormField>
    );

    return (
        <Card>
            {error && confirming === null && <Alert>{error}</Alert>}
            {stopped && !view.managed && (
                <p className="text-sm mb-3">
                    RapidMX no longer manages the root TXT records. The SPF record and the kept values are being restored as plain records; they are missing for a
                    few minutes meanwhile.
                </p>
            )}
            {view.managed ? (
                <>
                    <p className="text-sm font-semibold mb-3">Values added at your DNS host are removed within a minute; add them here.</p>
                    <p className="text-sm text-text-muted mb-1">RapidMX publishes this SPF record at the root, and the values to keep below:</p>
                    <Values label="Published SPF record" values={[view.spf!]} />
                    {keepField}
                    <div className="flex items-center gap-3">
                        <Button
                            type="button"
                            className="!w-auto"
                            loading={saving}
                            disabled={saving || keep.join("\n") === view.keep.join("\n")}
                            onClick={() => save(true)}
                        >
                            Save values to keep
                        </Button>
                        <Button type="button" variant="secondary" className="!w-auto" disabled={saving} onClick={() => confirm("out")}>
                            Stop managing
                        </Button>
                        {saved && <span className="text-sm text-text-muted">Saved.</span>}
                    </div>
                </>
            ) : cantManage ? (
                <>
                    <p className="text-sm text-text-muted mb-3">
                        An rfc2136 DNS provider can't keep the SPF value among the root TXT records, so RapidMX can't manage them. Add the SPF record and the other
                        root TXT records at your DNS host.
                    </p>
                    {view.current.length > 0 && <Values label="Current root TXT records" values={view.current} />}
                </>
            ) : view.lookupFailed ? (
                <>
                    <p className="text-sm text-text-muted mb-3">
                        The root TXT records couldn't be looked up, and taking them over without knowing what is there would delete it. Try again in a moment.
                    </p>
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => void load()}>
                        Try again
                    </Button>
                </>
            ) : (
                <>
                    <p className="text-sm text-text-muted mb-3">
                        SPF is a TXT record at the root of the domain, shared with the verification records of other services. RapidMX publishes nothing there
                        unless you opt in, and then it owns every value in the set: it publishes SPF and the values you keep, and removes the rest.
                    </p>
                    {view.current.length > 0 ? (
                        <>
                            <p className="text-sm font-semibold mb-1">At the root now</p>
                            <Values label="Current root TXT records" values={view.current} />
                        </>
                    ) : (
                        <p className="text-sm text-text-muted mb-3">There are no TXT records at the root now.</p>
                    )}
                    {published.length > 0 && (
                        <>
                            <p className="text-sm font-semibold mb-1">Restored when RapidMX stopped managing them</p>
                            <Values label="Restored root TXT records" values={published} />
                        </>
                    )}
                    {keepField}
                    <Button type="button" className="!w-auto" onClick={() => confirm("in")}>
                        Manage the root TXT records
                    </Button>
                </>
            )}

            <Modal open={confirming === "in"} onClose={() => setConfirming(null)} title="Manage the root TXT records">
                <p className="text-sm mb-3">
                    RapidMX will publish an SPF record at the root of <strong>{domain.name}</strong> (yours if it already allows this domain's mail servers,
                    otherwise <code className="text-xs">v=spf1 mx ~all</code>), and these values:
                </p>
                {keep.length > 0 ? <Values label="Values RapidMX will keep" values={keep} /> : <p className="text-sm text-text-muted mb-3">(none)</p>}
                <p className="text-sm mb-1">At the root now and not on that list, so removed (an SPF record is replaced by the one above):</p>
                {removed.length > 0 ? (
                    <Values label="Values removed" values={removed} />
                ) : (
                    <p className="text-sm text-text-muted mb-3">Nothing else is there to remove.</p>
                )}
                {!fresh && !error && <p className="text-sm text-text-muted mb-3">Checking what is at the root now&hellip;</p>}
                <p className="text-sm mb-3">Anything you add at your DNS host later is removed within a minute; add it here instead.</p>
                {error && <Alert>{error}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={saving} onClick={() => setConfirming(null)}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto" loading={saving} disabled={saving || !fresh} onClick={() => save(true)}>
                        Manage them
                    </Button>
                </div>
            </Modal>

            <Modal open={confirming === "out"} onClose={() => setConfirming(null)} title="Stop managing the root TXT records">
                <p className="text-sm mb-3">
                    RapidMX lets go of the set and restores these values as plain records you edit at your DNS host. The root TXT records are missing for a few
                    minutes while this happens.
                </p>
                <Values label="Values restored" values={published} />
                {error && <Alert>{error}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={saving} onClick={() => setConfirming(null)}>
                        Cancel
                    </Button>
                    <Button type="button" className="!w-auto" loading={saving} disabled={saving} onClick={() => save(false)}>
                        Stop managing
                    </Button>
                </div>
            </Modal>
        </Card>
    );
}
