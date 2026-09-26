///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineCheckCircle, HiOutlineExclamationTriangle, HiOutlineMinusCircle, HiOutlineQuestionMarkCircle } from "react-icons/hi2";
import type { DiagnosticsComponent, DiagnosticsContainer, DiagnosticsPod } from "./diagnosticsApi.js";
import Badge from "./Badge.js";
import KubernetesNotice from "./KubernetesNotice.js";
import { formatDateTime, NO_VALUE, shortDigest } from "./format.js";

const STATUS: Record<DiagnosticsComponent["status"], { label: string; tone: "success" | "warning" | "neutral"; icon: typeof HiOutlineCheckCircle }> = {
    running: { label: "Running", tone: "success", icon: HiOutlineCheckCircle },
    "not-ready": { label: "Not ready", tone: "warning", icon: HiOutlineExclamationTriangle },
    missing: { label: "Not found", tone: "neutral", icon: HiOutlineMinusCircle },
    unknown: { label: "Unknown", tone: "neutral", icon: HiOutlineQuestionMarkCircle },
};

/** The container to describe a component by: the one running the image tag the server calls its version, else the first. */
export function mainContainer(component: DiagnosticsComponent): DiagnosticsContainer | undefined {
    const containers = component.pods.flatMap((pod) => pod.containers);
    return containers.find((container) => container.tag !== undefined && container.tag === component.version) ?? containers[0];
}

/** `image` with its tag, unless the server already wrote the tag into the image. */
export function imageReference(container: DiagnosticsContainer): string {
    return container.tag && !container.image.endsWith(`:${container.tag}`) ? `${container.image}:${container.tag}` : container.image;
}

const HEADINGS = ["Component", "Status", "Version", "Image", "Digest", "Restarts", "Node"];

export interface ComponentsTableProps {
    components: DiagnosticsComponent[];
    kubernetes: { available: boolean; reason?: string };
}

/** The other containers of the install (mail transport, databases, the spam and virus filters, the TURN relay) and how they are doing. */
export default function ComponentsTable({ components, kubernetes }: ComponentsTableProps) {
    return (
        <section aria-labelledby="diagnostics-components-heading" className="rounded-md border border-border bg-surface p-4">
            <h2 id="diagnostics-components-heading" className="text-base font-bold uppercase tracking-wide mb-3">
                Other containers
            </h2>
            {!kubernetes.available ? (
                <KubernetesNotice reason={kubernetes.reason} />
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {HEADINGS.map((heading) => (
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
                            {components.map((component) => (
                                <ComponentRow key={component.component} component={component} />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

function ComponentRow({ component }: { component: DiagnosticsComponent }) {
    const status = STATUS[component.status] ?? STATUS.unknown;
    const main = mainContainer(component);
    const restarts = component.pods.reduce((total, pod) => total + pod.restarts, 0);
    const nodes = [...new Set(component.pods.map((pod) => pod.node).filter(Boolean))];
    return (
        <tr className="align-top">
            <td className="py-2 px-2.5 border-b border-border">
                <div className="font-medium">{component.component}</div>
                {component.pods.length > 0 && (
                    <details className="text-xs text-text-muted">
                        <summary className="cursor-pointer">
                            {component.pods.length} {component.pods.length === 1 ? "pod" : "pods"}
                        </summary>
                        <ul className="mt-1 space-y-2">
                            {component.pods.map((pod) => (
                                <PodDetail key={pod.name} pod={pod} />
                            ))}
                        </ul>
                    </details>
                )}
            </td>
            <td className="py-2 px-2.5 border-b border-border">
                <Badge tone={status.tone} icon={status.icon}>
                    {status.label}
                </Badge>
            </td>
            <td className="py-2 px-2.5 border-b border-border font-mono">{component.version ?? NO_VALUE}</td>
            <td className="py-2 px-2.5 border-b border-border font-mono break-all">{main?.image ?? NO_VALUE}</td>
            <td className="py-2 px-2.5 border-b border-border font-mono" title={main?.digest}>
                {shortDigest(main?.digest)}
            </td>
            <td className="py-2 px-2.5 border-b border-border tabular-nums">{component.pods.length > 0 ? restarts : NO_VALUE}</td>
            <td className="py-2 px-2.5 border-b border-border">{nodes.length > 0 ? nodes.join(", ") : NO_VALUE}</td>
        </tr>
    );
}

function PodDetail({ pod }: { pod: DiagnosticsPod }) {
    return (
        <li className="rounded-sm border border-border p-2">
            <div className="font-mono text-text break-all">{pod.name}</div>
            <div>
                {pod.phase} &middot; {pod.ready ? "ready" : "not ready"} &middot; {pod.restarts} {pod.restarts === 1 ? "restart" : "restarts"}
                {pod.node ? ` · on ${pod.node}` : ""}
                {pod.startedAt ? ` · started ${formatDateTime(pod.startedAt)}` : ""}
            </div>
            <ul className="mt-1">
                {pod.containers.map((container) => (
                    <li key={container.name} className="font-mono break-all">
                        {container.name}: {imageReference(container)}
                        {container.digest ? ` @${shortDigest(container.digest)}` : ""} &middot; {container.ready ? "ready" : "not ready"} &middot;{" "}
                        {container.restartCount} {container.restartCount === 1 ? "restart" : "restarts"}
                    </li>
                ))}
            </ul>
        </li>
    );
}
