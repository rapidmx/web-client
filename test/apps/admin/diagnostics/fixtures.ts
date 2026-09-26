///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import type {
    DiagnosticsComponent,
    DiagnosticsComponentName,
    DiagnosticsMetrics,
    DiagnosticsRuntime,
    DiagnosticsVersions,
} from "../../../../apps/shared/components/admin/diagnostics/diagnosticsApi.js";

const COMPONENTS: DiagnosticsComponentName[] = ["postfix", "postfix-bridge", "mongodb", "postgresql", "redis", "coturn", "rspamd", "clamav"];

/** A component with one pod that is running, on `node`, at image tag `tag`. */
export function runningComponent(component: DiagnosticsComponentName, tag: string, node = "node-1"): DiagnosticsComponent {
    return {
        component,
        status: "running",
        version: tag,
        pods: [
            {
                name: `${component}-0`,
                phase: "Running",
                ready: true,
                restarts: 2,
                node,
                startedAt: "2026-09-20T08:00:00.000Z",
                containers: [
                    { name: "sidecar", image: "example/sidecar", tag: "0.1", ready: true, restartCount: 0 },
                    {
                        name: component,
                        image: `docker.io/library/${component}`,
                        tag,
                        digest: "sha256:0123456789abcdef0123456789abcdef",
                        ready: true,
                        restartCount: 2,
                    },
                ],
            },
        ],
    };
}

export function versionsFixture(overrides: Partial<DiagnosticsVersions> = {}): DiagnosticsVersions {
    return {
        server: {
            nodeVersion: "v24.1.0",
            v8Version: "13.6.233",
            packageName: "@rapidmx/server",
            packageVersion: "1.0.0-beta.18",
            platform: "linux",
            arch: "x64",
            hostname: "rapidmx-server-abc",
            pid: 17,
            startedAt: "2026-09-25T10:00:00.000Z",
            uptimeSeconds: 90_000,
            nodeEnv: "production",
        },
        packages: [
            { name: "@rapidmx/restapi", version: "0.23.0", direct: true },
            { name: "left-pad", version: "1.3.0", direct: false },
            { name: "zod", version: "4.0.0", direct: true },
        ],
        components: COMPONENTS.map((name, index) => {
            if (name === "coturn") {
                return { component: name, status: "missing" as const, pods: [] };
            }
            if (name === "clamav") {
                return { ...runningComponent(name, "1.4"), status: "not-ready" as const };
            }
            return runningComponent(name, `${index + 1}.0`, index % 2 === 0 ? "node-1" : "node-2");
        }),
        kubernetes: { available: true },
        ...overrides,
    };
}

export function runtimeFixture(overrides: Partial<DiagnosticsRuntime> = {}): DiagnosticsRuntime {
    return {
        available: true,
        namespace: "rapidmx",
        version: {
            gitVersion: "v1.33.1+k3s1",
            major: "1",
            minor: "33",
            platform: "linux/amd64",
            goVersion: "go1.24.2",
            buildDate: "2026-05-01T00:00:00Z",
            distribution: "k3s",
        },
        nodes: [
            { name: "node-1", internalIP: "10.0.0.1", podCount: 5 },
            { name: "node-2", podCount: 3 },
        ],
        ...overrides,
    };
}

export function metricsSample(overrides: Partial<DiagnosticsMetrics> = {}): DiagnosticsMetrics {
    return {
        collectedAt: "2026-09-26T10:00:00.000Z",
        process: {
            cpuPercent: 12.5,
            rssBytes: 300 * 1024 * 1024,
            heapUsedBytes: 100 * 1024 * 1024,
            heapTotalBytes: 150 * 1024 * 1024,
            loadAverage: [0.5, 0.75, 1],
            systemMemoryTotalBytes: 8 * 1024 ** 3,
            systemMemoryFreeBytes: 2 * 1024 ** 3,
            cpuCount: 4,
        },
        host: {
            cpuPercent: 35,
            cpuCount: 4,
            memoryTotalBytes: 8 * 1024 ** 3,
            memoryUsedBytes: 4 * 1024 ** 3,
            loadAverage: [1.25, 1, 0.5],
            disks: [
                { path: "/", usedBytes: 40 * 1024 ** 3, capacityBytes: 100 * 1024 ** 3, availableBytes: 60 * 1024 ** 3 },
                {
                    path: "/data",
                    pvc: "server-data",
                    usedBytes: 85 * 1024 ** 3,
                    capacityBytes: 100 * 1024 ** 3,
                    availableBytes: 15 * 1024 ** 3,
                    sharesNodeDisk: true,
                },
            ],
        },
        kubernetes: {
            available: true,
            namespace: {
                name: "rapidmx",
                podMetricsAvailable: true,
                cpuUsedCores: 1.5,
                memoryUsedBytes: 2 * 1024 ** 3,
                pods: [
                    { name: "redis-0", component: "redis", cpuUsedCores: 0.05, memoryUsedBytes: 50 * 1024 ** 2 },
                    { name: "server-abc", component: "server", cpuUsedCores: 0.4, memoryUsedBytes: 400 * 1024 ** 2 },
                    { name: "mystery-0" },
                ],
            },
            pvcs: [
                {
                    name: "server-data",
                    phase: "Bound",
                    storageClass: "local-path",
                    requestedBytes: 100 * 1024 ** 3,
                    capacityBytes: 100 * 1024 ** 3,
                    usedBytes: 85 * 1024 ** 3,
                    availableBytes: 15 * 1024 ** 3,
                    mountedByServer: true,
                },
                { name: "mongodb-data", phase: "Bound", requestedBytes: 10 * 1024 ** 3, mountedByServer: false },
            ],
            errors: [],
        },
        ...overrides,
    };
}
