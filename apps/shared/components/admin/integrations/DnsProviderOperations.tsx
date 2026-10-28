///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { DnsOperation, DnsOperationState, DnsOperationType, listDnsProviderOperations, testDnsProvider } from "../../../../../lib/admin/dnsProvidersApi.js";
import Button from "../../../../../lib/components/buttons/Button.js";
import Alert from "../ActionAlert.js";
import { actionErrorMessage } from "../elevation.js";
import { formatTime } from "./dnsProviderParts.js";

const TYPE_LABELS: Record<DnsOperationType, string> = {
    test: "Connection test",
    takeover: "Take over",
    restore: "Restore",
};

const STATE_LABELS: Record<DnsOperationState, string> = {
    queued: "Queued",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
};

/**
 * "Test connection" and the config's latest operations (connection tests, takeovers, restores of a domain's root TXT records), which the DNS controller
 * runs and reports on. A test is only queued here: its result arrives with the controller's next report, so the list can be refreshed.
 */
export default function DnsProviderOperations({ uid }: { uid: string }) {
    const [operations, setOperations] = useState<DnsOperation[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [testing, setTesting] = useState(false);
    const [testError, setTestError] = useState<string | null>(null);
    const [queued, setQueued] = useState(false);

    function load() {
        listDnsProviderOperations(uid)
            .then((loadedOperations) => {
                setOperations(loadedOperations);
                setLoaded(true);
                setError(null);
            })
            .catch((err) => setError(actionErrorMessage(err, "Could not load the operations.")));
    }

    useEffect(load, [uid]);

    async function handleTest() {
        setTesting(true);
        setTestError(null);
        try {
            const operation = await testDnsProvider(uid);
            setOperations((current) => [operation, ...current]);
            setQueued(true);
        } catch (err) {
            setTestError(actionErrorMessage(err, "Could not queue the connection test."));
        } finally {
            setTesting(false);
        }
    }

    return (
        <section className="mt-8 max-w-3xl">
            <h3 className="text-base font-bold uppercase tracking-wide mb-1">Connection and operations</h3>
            <p className="text-sm text-text-muted mb-3">
                Test connection has the DNS controller run external-dns once with the saved credentials, to check that they work and reach the zones.
            </p>
            <div className="flex gap-3 mb-3">
                <Button type="button" variant="secondary" className="!w-auto" loading={testing} disabled={testing} onClick={handleTest}>
                    Test connection
                </Button>
                <Button type="button" variant="secondary" className="!w-auto" onClick={load}>
                    Refresh
                </Button>
            </div>
            {testError && <Alert>{testError}</Alert>}
            {queued && (
                <p className="text-sm text-text-muted mb-3">Test queued. The DNS controller runs the test and reports the result here; refresh to see it.</p>
            )}
            {error && <Alert>{error}</Alert>}
            {operations.length > 0 ? (
                <table aria-label="Recent operations" className="w-full text-sm border-collapse">
                    <thead>
                        <tr>
                            {["Operation", "State", "Result", "When"].map((h) => (
                                <th key={h} className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border">
                                    {h}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {operations.map((operation) => (
                            <tr key={operation.uid}>
                                <td className="py-2 px-2.5 border-b border-border">
                                    {TYPE_LABELS[operation.type] + (operation.domainUid ? ` (${operation.domainUid})` : operation.endpointSetId?.startsWith("hosts-") ? " (host names)" : "")}
                                </td>
                                <td className="py-2 px-2.5 border-b border-border">{STATE_LABELS[operation.state]}</td>
                                <td className="py-2 px-2.5 border-b border-border text-text-muted">{operation.message}</td>
                                <td className="py-2 px-2.5 border-b border-border text-text-muted whitespace-nowrap">
                                    {formatTime(operation.finishedAt ?? operation.startedAt ?? operation.dateCreated)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ) : loaded ? (
                <p className="text-sm text-text-muted">No operations yet.</p>
            ) : (
                !error && <p className="text-sm text-text-muted">Loading&hellip;</p>
            )}
        </section>
    );
}
