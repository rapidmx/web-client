// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import HostCard, { formatLoad } from "../../../../apps/shared/components/admin/diagnostics/HostCard.js";
import NamespaceCard from "../../../../apps/shared/components/admin/diagnostics/NamespaceCard.js";
import ProcessCard from "../../../../apps/shared/components/admin/diagnostics/ProcessCard.js";
import PvcTable from "../../../../apps/shared/components/admin/diagnostics/PvcTable.js";
import SystemPanel from "../../../../apps/shared/components/admin/diagnostics/SystemPanel.js";
import type { DiagnosticsMetrics } from "../../../../apps/shared/components/admin/diagnostics/diagnosticsApi.js";
import type { MetricsPolling } from "../../../../apps/shared/components/admin/diagnostics/useMetricsPolling.js";
import { metricsSample } from "./fixtures.js";

const sample = metricsSample();
const region = (name: string) => within(screen.getByRole("region", { name }));

describe("formatLoad", () => {
    it("writes the three averages, or a dash", () => {
        expect(formatLoad([1.234, 0.5, 0])).toBe("1.23, 0.50, 0.00");
        expect(formatLoad(undefined)).toBe("—");
        expect(formatLoad([])).toBe("—");
    });
});

describe("HostCard", () => {
    it("says it is the node the server runs on, as its own container sees it", () => {
        render(<HostCard host={sample.host} history={[sample]} />);
        expect(region("Node running this server").getByText(/only the node the server runs on/)).toBeInTheDocument();
    });

    it("shows the CPU, memory and load in numbers, with meters", () => {
        render(<HostCard host={sample.host} history={[sample, sample]} />);
        const card = region("Node running this server");
        // The value, and the percentage beside the meter.
        expect(card.getAllByText("35.0%")).toHaveLength(2);
        expect(card.getByText("Whole host, all cores")).toBeInTheDocument();
        expect(card.getByText("4 cores")).toBeInTheDocument();
        expect(card.getByRole("meter", { name: "CPU usage" })).toHaveAttribute("aria-valuenow", "35");
        expect(card.getByText("4.0 GiB")).toBeInTheDocument();
        expect(card.getByText("of 8.0 GiB")).toBeInTheDocument();
        expect(card.getByRole("meter", { name: "Memory usage" })).toHaveAttribute("aria-valuenow", "50");
        expect(card.getByText("1.25, 1.00, 0.50")).toBeInTheDocument();
        expect(card.getByRole("img", { name: /^CPU: latest 35.0%/ })).toBeInTheDocument();
        expect(card.getByRole("img", { name: /^Memory: latest 50.0%/ })).toBeInTheDocument();
    });

    it("lists the disks with usage bars, a High warning in words, and the note for a shared node disk", () => {
        render(<HostCard host={sample.host} history={[sample]} />);
        const card = region("Node running this server");
        expect(card.getByText("/data")).toBeInTheDocument();
        expect(card.getByText("volume server-data")).toBeInTheDocument();
        expect(card.getByText("40.0 GiB of 100 GiB, 60.0 GiB free")).toBeInTheDocument();
        expect(card.getByRole("meter", { name: "Disk usage of /data" })).toHaveAttribute("aria-valuetext", expect.stringContaining("high"));
        expect(card.getByText("High")).toBeInTheDocument();
        expect(card.getAllByText(/Shares the node/)).toHaveLength(1);
        expect(card.getByRole("meter", { name: "Disk usage of /" })).toHaveAttribute("aria-valuenow", "40");
    });

    it("says when a disk has no figures, and when there are no disks", () => {
        const host = { ...sample.host, disks: [{ path: "/x", usedBytes: 1, capacityBytes: 0, availableBytes: 0 }] };
        const { rerender } = render(<HostCard host={host} history={[]} />);
        expect(screen.getByText("No usage figures.")).toBeInTheDocument();
        rerender(<HostCard host={{ ...sample.host, disks: [] }} history={[]} />);
        expect(screen.getByText("No disks were reported.")).toBeInTheDocument();
    });

    it("says so when the server reports nothing about the node, and copes with a sparse report", () => {
        const { rerender } = render(<HostCard host={undefined} history={[]} />);
        expect(screen.getByText(/did not report the node/)).toBeInTheDocument();
        rerender(<HostCard host={{} as DiagnosticsMetrics["host"]} history={[{ ...sample, host: undefined } as unknown as DiagnosticsMetrics]} />);
        const card = region("Node running this server");
        expect(card.queryByRole("meter")).not.toBeInTheDocument();
        expect(card.getByText("No disks were reported.")).toBeInTheDocument();
        expect(card.getAllByText("—").length).toBeGreaterThanOrEqual(4);
    });
});

describe("ProcessCard", () => {
    it("shows the process CPU, memory, heap, load and the memory the container sees", () => {
        render(<ProcessCard process={sample.process} history={[sample, sample]} />);
        const card = region("This server process");
        expect(card.getByText("12.5%")).toBeInTheDocument();
        expect(card.getByText("4 cores available")).toBeInTheDocument();
        expect(card.getByText("300 MiB")).toBeInTheDocument();
        expect(card.getByText("of 150 MiB allocated")).toBeInTheDocument();
        expect(card.getByText("0.50, 0.75, 1.00")).toBeInTheDocument();
        expect(card.getByText("6.0 GiB")).toBeInTheDocument();
        expect(card.getByText("of 8.0 GiB")).toBeInTheDocument();
        expect(card.getByRole("meter", { name: "Memory visible to the container usage" })).toHaveAttribute("aria-valuenow", "75");
        expect(card.getByRole("img", { name: /^Process CPU: latest 12.5%/ })).toBeInTheDocument();
        expect(card.getByRole("img", { name: /^Process memory \(RSS\): latest 300 MiB/ })).toBeInTheDocument();
    });

    it("does not call a full heap a warning: it is normally nearly full", () => {
        render(
            <ProcessCard
                process={{ ...sample.process, heapUsedBytes: 98 * 1024 ** 2, heapTotalBytes: 100 * 1024 ** 2 }}
                history={[]}
            />
        );
        expect(screen.getByRole("meter", { name: "Heap usage" })).toBeInTheDocument();
        expect(screen.queryByText("Critical")).not.toBeInTheDocument();
    });

    it("says so when the server reports nothing, and copes with a sparse report", () => {
        const { rerender } = render(<ProcessCard process={undefined} history={[]} />);
        expect(screen.getByText(/did not report its own figures/)).toBeInTheDocument();
        rerender(<ProcessCard process={{} as DiagnosticsMetrics["process"]} history={[{ ...sample, process: undefined } as unknown as DiagnosticsMetrics]} />);
        expect(screen.queryByRole("meter")).not.toBeInTheDocument();
        expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
    });
});

describe("NamespaceCard", () => {
    const namespace = sample.kubernetes.namespace!;

    it("shows the totals and the pods, biggest memory first, a pod with no figures last", () => {
        render(<NamespaceCard namespace={namespace} history={[sample, sample]} />);
        const card = region("Namespace rapidmx");
        expect(card.getByText("1.5 cores")).toBeInTheDocument();
        expect(card.getByText("2.0 GiB")).toBeInTheDocument();
        expect(card.getByRole("img", { name: /^Namespace CPU: latest 1.5 cores/ })).toBeInTheDocument();
        const rows = card.getAllByRole("row").slice(1);
        expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual(["server-abc", "redis-0", "mystery-0"]);
        const server = within(rows[0]);
        expect(server.getByText("server")).toBeInTheDocument();
        expect(server.getByText("0.4 cores")).toBeInTheDocument();
        expect(server.getByText("400 MiB")).toBeInTheDocument();
        expect(within(rows[2]).getAllByText("—")).toHaveLength(3);
    });

    it("puts pods with no figure last wherever they come", () => {
        const pods = [{ name: "a" }, { name: "b", memoryUsedBytes: 5 }, { name: "c" }, { name: "d", memoryUsedBytes: 9 }, { name: "e" }];
        render(<NamespaceCard namespace={{ ...namespace, pods }} history={[]} />);
        const names = screen.getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].textContent);
        expect(names).toEqual(["d", "b", "a", "c", "e"]);
    });

    it("gives the hint that metrics-server is needed when the pod figures are not available, without an error", () => {
        render(<NamespaceCard namespace={{ ...namespace, podMetricsAvailable: false, podMetricsReason: "metrics.k8s.io is not served." }} history={[]} />);
        const card = region("Namespace rapidmx");
        expect(card.getByRole("status")).toHaveTextContent("Per-pod CPU and memory are not available.");
        expect(card.getByText(/metrics-server/)).toHaveTextContent("metrics.k8s.io is not served.");
        expect(card.queryByRole("table")).not.toBeInTheDocument();
    });

    it("gives the hint without a reason", () => {
        render(<NamespaceCard namespace={{ ...namespace, podMetricsAvailable: false, podMetricsReason: undefined }} history={[]} />);
        expect(screen.getByText(/metrics-server/).textContent).not.toMatch(/metrics.k8s.io/);
    });

    it("says when no pod figures were reported, and when there is no namespace at all", () => {
        const { rerender } = render(<NamespaceCard namespace={{ ...namespace, pods: undefined as never }} history={[]} />);
        expect(screen.getByText("No pod figures were reported.")).toBeInTheDocument();
        rerender(<NamespaceCard namespace={undefined} history={[]} />);
        expect(screen.getByRole("heading", { name: "Namespace" })).toBeInTheDocument();
        expect(screen.getByText(/did not report the namespace/)).toBeInTheDocument();
        rerender(<NamespaceCard namespace={{ ...namespace, name: "" }} history={[]} />);
        expect(screen.getByRole("heading", { name: "Namespace" })).toBeInTheDocument();
    });

    it("reads the history of a sample without a namespace as nothing", () => {
        const bare = { ...sample, kubernetes: { ...sample.kubernetes, namespace: undefined } };
        render(<NamespaceCard namespace={namespace} history={[bare, bare]} />);
        expect(screen.getByRole("img", { name: "Namespace CPU: collecting samples" })).toBeInTheDocument();
    });

    it("reads the history of a sample without a kubernetes section as nothing", () => {
        render(<NamespaceCard namespace={namespace} history={[{ ...sample, kubernetes: undefined } as unknown as DiagnosticsMetrics]} />);
        expect(screen.getByRole("img", { name: "Namespace memory: collecting samples" })).toBeInTheDocument();
    });
});

describe("PvcTable", () => {
    const [mounted, unmounted] = sample.kubernetes.pvcs;

    it("shows a usage bar for a volume the server mounts, and says why there is none for another", () => {
        render(<PvcTable pvcs={[{ ...mounted, usedBytes: 50 * 1024 ** 3 }, unmounted]} />);
        const rows = screen.getAllByRole("row").slice(1);
        const first = within(rows[0]);
        expect(first.getByText("server-data")).toBeInTheDocument();
        expect(first.getByText("local-path")).toBeInTheDocument();
        expect(first.getByText("100 GiB")).toBeInTheDocument();
        expect(first.getByText("50.0 GiB of 100 GiB")).toBeInTheDocument();
        expect(first.getByRole("meter", { name: "Usage of volume server-data" })).toHaveAttribute("aria-valuenow", "50");
        const second = within(rows[1]);
        expect(second.getByText("mongodb-data")).toBeInTheDocument();
        expect(second.getByText("10.0 GiB")).toBeInTheDocument();
        expect(second.getByText("Usage not available: not mounted in the server pod.")).toBeInTheDocument();
        expect(second.queryByRole("meter")).not.toBeInTheDocument();
    });

    it("says High above 80% and Critical above 90%, in words", () => {
        render(<PvcTable pvcs={[mounted, { ...mounted, name: "full", usedBytes: 95 * 1024 ** 3 }]} />);
        expect(screen.getByText("High")).toBeInTheDocument();
        expect(screen.getByText("Critical")).toBeInTheDocument();
    });

    it("does not flag a volume that shares the node's disk, and says so", () => {
        render(<PvcTable pvcs={[{ ...mounted, usedBytes: 97 * 1024 ** 3, sharesNodeDisk: true }]} />);
        expect(screen.queryByText("Critical")).not.toBeInTheDocument();
        expect(screen.queryByText("High")).not.toBeInTheDocument();
        expect(screen.getByText("97.0 GiB of 100 GiB")).toBeInTheDocument();
        expect(screen.getByText(/Shares the node.s disk; the volume.s size is not enforced/)).toBeInTheDocument();
    });

    it("says when a mounted volume has no figures, and writes a dash for a missing class and size", () => {
        render(<PvcTable pvcs={[{ name: "odd", phase: "Pending", mountedByServer: true }]} />);
        expect(screen.getByText("The server has no usage figures for this volume.")).toBeInTheDocument();
        expect(within(screen.getAllByRole("row")[1]).getAllByText("—")).toHaveLength(2);
    });

    it("says when there are no claims", () => {
        render(<PvcTable pvcs={[]} />);
        expect(screen.getByText("This install has no persistent volume claims.")).toBeInTheDocument();
    });
});

describe("SystemPanel", () => {
    function polling(overrides: Partial<MetricsPolling> = {}): MetricsPolling {
        return { history: [sample], error: undefined, loading: false, paused: false, setPaused: vi.fn(), ...overrides };
    }

    it("shows the node, the process, the namespace and the volumes", () => {
        render(<SystemPanel polling={polling()} />);
        for (const name of ["Node running this server", "This server process", "Namespace rapidmx", "Persistent volumes"]) {
            expect(screen.getByRole("region", { name })).toBeInTheDocument();
        }
        expect(screen.getByText(/Updates every 5 seconds/)).toBeInTheDocument();
        expect(screen.getByText(new RegExp(`Last sample ${new Date(sample.collectedAt).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))).toBeInTheDocument();
    });

    it("pauses and resumes", async () => {
        const user = userEvent.setup();
        const setPaused = vi.fn();
        const { rerender } = render(<SystemPanel polling={polling({ setPaused })} />);
        expect(screen.getByRole("button", { name: "Pause" })).toHaveAttribute("aria-pressed", "false");
        await user.click(screen.getByRole("button", { name: "Pause" }));
        expect(setPaused).toHaveBeenLastCalledWith(true);

        rerender(<SystemPanel polling={polling({ setPaused, paused: true })} />);
        expect(screen.getByText(/Updates are paused/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute("aria-pressed", "true");
        await user.click(screen.getByRole("button", { name: "Resume" }));
        expect(setPaused).toHaveBeenLastCalledWith(false);
    });

    it("says it is loading before the first sample", () => {
        render(<SystemPanel polling={polling({ history: [], loading: true })} />);
        expect(screen.getByText(/Loading/)).toBeInTheDocument();
        expect(screen.queryByRole("region")).not.toBeInTheDocument();
    });

    it("shows a failure and still shows what it has", () => {
        render(<SystemPanel polling={polling({ error: "Could not read the server's metrics." })} />);
        expect(screen.getByText("Could not read the server's metrics.")).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "This server process" })).toBeInTheDocument();
    });

    it("still shows the node and the process when Kubernetes is not available, with the hint", () => {
        const unavailable = metricsSample({ kubernetes: { available: false, reason: "Running under Docker Compose.", pvcs: [], errors: [] } });
        render(<SystemPanel polling={polling({ history: [unavailable] })} />);
        expect(screen.getByRole("region", { name: "Node running this server" })).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "This server process" })).toBeInTheDocument();
        expect(screen.getByText("Running under Docker Compose.")).toBeInTheDocument();
        expect(screen.queryByRole("region", { name: "Persistent volumes" })).not.toBeInTheDocument();
    });

    it("treats a sample with no kubernetes section as Kubernetes not available", () => {
        render(<SystemPanel polling={polling({ history: [{ ...sample, kubernetes: undefined } as unknown as DiagnosticsMetrics] })} />);
        expect(screen.getByText("Kubernetes information is not available on this server.")).toBeInTheDocument();
    });

    it("shows the errors the server collected, inline, without dropping the rest", () => {
        const withErrors = metricsSample({
            kubernetes: { ...sample.kubernetes, errors: ["Could not list PVCs.", "metrics-server timed out"] },
        });
        render(<SystemPanel polling={polling({ history: [withErrors] })} />);
        expect(screen.getByText("Could not list PVCs.")).toBeInTheDocument();
        expect(screen.getByText("metrics-server timed out")).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Persistent volumes" })).toBeInTheDocument();
    });

    it("copes with a Kubernetes section that has no errors or volumes lists", () => {
        const sparse = { ...sample, kubernetes: { available: true } } as unknown as DiagnosticsMetrics;
        render(<SystemPanel polling={polling({ history: [sparse] })} />);
        expect(screen.getByText("This install has no persistent volume claims.")).toBeInTheDocument();
    });
});
