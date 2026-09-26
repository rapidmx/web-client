///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import type { DiagnosticsRuntime } from "./diagnosticsApi.js";
import type { DiagnosticsResource } from "./useDiagnosticsResource.js";
import Badge from "./Badge.js";
import KubernetesNotice from "./KubernetesNotice.js";
import { formatDateTime, NO_VALUE } from "./format.js";

/** What a distribution's id is called on screen. */
const DISTRIBUTIONS: Record<string, string> = {
    k3s: "k3s",
    rke2: "RKE2",
    eks: "Amazon EKS",
    gke: "Google GKE",
    aks: "Azure AKS",
    kubernetes: "Kubernetes",
};

const NODE_HEADINGS = ["Node", "Internal IP", "Pods of this install"];

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
    return (
        <div>
            <dt className="text-xs uppercase tracking-wide text-text-muted">{term}</dt>
            <dd className="break-words">{children}</dd>
        </div>
    );
}

function RuntimeDetails({ runtime }: { runtime: DiagnosticsRuntime }) {
    const version = runtime.version;
    const nodes = runtime.nodes ?? [];
    return (
        <>
            <section aria-labelledby="diagnostics-kubernetes-heading" className="rounded-md border border-border bg-surface p-4">
                <h2 id="diagnostics-kubernetes-heading" className="text-base font-bold uppercase tracking-wide mb-3">
                    Kubernetes
                </h2>
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                    <Fact term="Version">
                        <span className="font-mono">{version?.gitVersion ?? NO_VALUE}</span>
                    </Fact>
                    <Fact term="Distribution">
                        {version ? <Badge tone="info">{DISTRIBUTIONS[version.distribution] ?? version.distribution}</Badge> : NO_VALUE}
                    </Fact>
                    <Fact term="Platform">{version?.platform ?? NO_VALUE}</Fact>
                    <Fact term="Namespace">
                        <span className="font-mono">{runtime.namespace ?? NO_VALUE}</span>
                    </Fact>
                    <Fact term="Go version">{version?.goVersion ?? NO_VALUE}</Fact>
                    <Fact term="Built">{formatDateTime(version?.buildDate)}</Fact>
                </dl>
            </section>
            <section aria-labelledby="diagnostics-nodes-heading" className="rounded-md border border-border bg-surface p-4">
                <h2 id="diagnostics-nodes-heading" className="text-base font-bold uppercase tracking-wide mb-1">
                    Nodes
                </h2>
                <p className="mb-3 text-xs text-text-muted">
                    The nodes that run this install&rsquo;s pods. The server can only see its own namespace, so nothing about the nodes
                    themselves is listed here.
                </p>
                {nodes.length === 0 ? (
                    <p className="text-sm text-text-muted">No node is running any of this install&rsquo;s pods.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                            <thead>
                                <tr>
                                    {NODE_HEADINGS.map((heading) => (
                                        <th
                                            key={heading}
                                            className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                        >
                                            {heading}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {nodes.map((node) => (
                                    <tr key={node.name}>
                                        <td className="py-2 px-2.5 border-b border-border font-mono break-all">{node.name}</td>
                                        <td className="py-2 px-2.5 border-b border-border font-mono">{node.internalIP ?? NO_VALUE}</td>
                                        <td className="py-2 px-2.5 border-b border-border tabular-nums">{node.podCount}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </section>
        </>
    );
}

/** The Runtime tab: the Kubernetes version and the nodes the install's pods run on. */
export default function RuntimePanel({ runtime }: { runtime: DiagnosticsResource<DiagnosticsRuntime> }) {
    const { data, error, loading } = runtime;
    return (
        <div className="space-y-6">
            {error && <Alert>{error}</Alert>}
            {!data && loading && <p className="text-sm text-text-muted">Loading&hellip;</p>}
            {data && (data.available ? <RuntimeDetails runtime={data} /> : <KubernetesNotice reason={data.reason} />)}
        </div>
    );
}
