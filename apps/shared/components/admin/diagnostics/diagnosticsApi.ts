///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { apiFetch } from "../../../../../lib/util/api.js";

/**
 * The client of the server's `/admin/diagnostics/*` endpoints (`versions`, `runtime`, `metrics`). All three are GET,
 * trusted-administrator only and `@RequiresElevation()`: an elevated token is required (403 `api-104`, see
 * `../elevation.ts`), and any other 403 means the caller is not an administrator. The server may leave any optional
 * field out, so a caller reads them defensively.
 *
 * The server reads Kubernetes with namespace-scoped permissions only: it can list the install's own pods, but not the
 * cluster's nodes or the kubelet's statistics. That is why a node here is only what the pods say of it, and why the
 * machine figures are those of the node running the server, read from inside its own container.
 */

/** The components of a RapidMX install that run beside the server itself, in the order the server lists them. */
export type DiagnosticsComponentName =
    | "postfix"
    | "postfix-bridge"
    | "mongodb"
    | "postgresql"
    | "redis"
    | "coturn"
    | "rspamd"
    | "clamav";

export interface DiagnosticsContainer {
    name: string;
    image: string;
    tag?: string;
    digest?: string;
    ready: boolean;
    restartCount: number;
}

export interface DiagnosticsPod {
    name: string;
    phase: string;
    ready: boolean;
    restarts: number;
    node?: string;
    startedAt?: string;
    containers: DiagnosticsContainer[];
}

export interface DiagnosticsComponent {
    component: DiagnosticsComponentName;
    /** `missing`: Kubernetes is reachable but no pod for it exists. `unknown`: Kubernetes is unavailable. */
    status: "running" | "not-ready" | "missing" | "unknown";
    /** The image tag of the component's main container. */
    version?: string;
    pods: DiagnosticsPod[];
}

export interface DiagnosticsVersions {
    server: {
        nodeVersion: string;
        v8Version: string;
        packageName: string;
        packageVersion: string;
        platform: string;
        arch: string;
        hostname: string;
        pid: number;
        startedAt: string;
        uptimeSeconds: number;
        nodeEnv: string;
    };
    /** Sorted by name. */
    packages: { name: string; version: string; direct: boolean }[];
    /** Always all eight, in the order of `DiagnosticsComponentName`. */
    components: DiagnosticsComponent[];
    kubernetes: { available: boolean; reason?: string };
}

/** A node that runs some of this install's pods, derived from the pods: nothing else about the node is readable. */
export interface DiagnosticsNode {
    name: string;
    internalIP?: string;
    /** How many of the install's pods run on it. */
    podCount: number;
}

export type KubernetesDistribution = "k3s" | "rke2" | "eks" | "gke" | "aks" | "kubernetes";

export interface DiagnosticsRuntime {
    available: boolean;
    reason?: string;
    namespace?: string;
    version?: {
        gitVersion: string;
        major: string;
        minor: string;
        platform: string;
        goVersion?: string;
        buildDate?: string;
        distribution: KubernetesDistribution;
    };
    nodes: DiagnosticsNode[];
}

/** One filesystem of the node that runs the server, as the server's own container sees it. */
export interface DiagnosticsDiskMetrics {
    path: string;
    /** The volume claim mounted there, when it is one. */
    pvc?: string;
    usedBytes: number;
    capacityBytes: number;
    availableBytes: number;
    /** The figures are the whole node filesystem's, not a volume of its own (a hostPath-style volume, such as k3s local-path). */
    sharesNodeDisk?: boolean;
}

/**
 * The node the server pod runs on, as seen from inside the server's own container (on a single-node k3s that is the whole
 * machine). In a cluster of several nodes it is only that one node.
 */
export interface DiagnosticsHostMetrics {
    /** The whole host, 0 to 100 across all cores. */
    cpuPercent: number;
    cpuCount: number;
    memoryTotalBytes: number;
    memoryUsedBytes: number;
    loadAverage: [number, number, number];
    /**
     * Memory the hypervisor holds in the machine's memory balloon. It counts in `memoryUsedBytes` (a guest sees ballooned memory
     * as used) though no process holds it. Absent where no balloon has ever taken any.
     */
    balloon?: { heldBytes: number; inflatedTotalBytes: number };
    /** How stalled the node is waiting for memory, disk and CPU (Linux pressure stall information). Absent without kernel support. */
    pressure?: { memory?: DiagnosticsPressure; io?: DiagnosticsPressure; cpu?: DiagnosticsPressure };
    disks: DiagnosticsDiskMetrics[];
}

/** The share (0 to 100) of the last 10, 60 and 300 seconds that tasks were stalled. `some`: at least one waited. `full`: every one did. */
export interface DiagnosticsPressure {
    some: { avg10: number; avg60: number; avg300: number };
    full?: { avg10: number; avg60: number; avg300: number };
}

/** From the metrics API (metrics-server): absent when it is not installed. */
export interface DiagnosticsPodMetrics {
    name: string;
    component?: DiagnosticsComponentName | "server";
    cpuUsedCores?: number;
    memoryUsedBytes?: number;
}

/**
 * `usedBytes` (what the volume holds) exists only for a volume the server pod mounts (`mountedByServer`), and `measuredBy`
 * says how it was found: from the volume's own filesystem, or - when the volume is a directory of the node's disk
 * (`sharesNodeDisk`, such as k3s's local-path), where the filesystem is the whole disk - by measuring the directory.
 * `capacityBytes` is the volume's allocation, which a volume that shares the node's disk does not enforce; `availableBytes` is
 * what is left of the filesystem it is on.
 */
export interface DiagnosticsPvcMetrics {
    name: string;
    phase: string;
    storageClass?: string;
    requestedBytes?: number;
    capacityBytes?: number;
    usedBytes?: number;
    availableBytes?: number;
    measuredBy?: "filesystem" | "directory";
    /** The directory could not be measured completely, so `usedBytes` is a lower bound. */
    usedPartial?: boolean;
    mountedByServer: boolean;
    sharesNodeDisk?: boolean;
}

export interface DiagnosticsMetrics {
    collectedAt: string;
    process: {
        cpuPercent: number;
        rssBytes: number;
        heapUsedBytes: number;
        heapTotalBytes: number;
        loadAverage: [number, number, number];
        systemMemoryTotalBytes: number;
        systemMemoryFreeBytes: number;
        cpuCount: number;
    };
    host: DiagnosticsHostMetrics;
    kubernetes: {
        available: boolean;
        reason?: string;
        namespace?: {
            name: string;
            /** Whether the pod figures could be read: they need metrics-server. */
            podMetricsAvailable: boolean;
            podMetricsReason?: string;
            cpuUsedCores?: number;
            memoryUsedBytes?: number;
            pods: DiagnosticsPodMetrics[];
        };
        pvcs: DiagnosticsPvcMetrics[];
        errors: string[];
    };
}

/** What is installed and running: the server process, its packages, and the other containers of the install. */
export function getDiagnosticsVersions(): Promise<DiagnosticsVersions> {
    return apiFetch<DiagnosticsVersions>("/admin/diagnostics/versions");
}

/** The Kubernetes version, and the nodes the install's pods run on. */
export function getDiagnosticsRuntime(): Promise<DiagnosticsRuntime> {
    return apiFetch<DiagnosticsRuntime>("/admin/diagnostics/runtime");
}

/** One sample of live resource use. Polled by the System tab. */
export function getDiagnosticsMetrics(): Promise<DiagnosticsMetrics> {
    return apiFetch<DiagnosticsMetrics>("/admin/diagnostics/metrics");
}
