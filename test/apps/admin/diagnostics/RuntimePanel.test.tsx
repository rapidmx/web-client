// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RuntimePanel from "../../../../apps/shared/components/admin/diagnostics/RuntimePanel.js";
import type { DiagnosticsRuntime } from "../../../../apps/shared/components/admin/diagnostics/diagnosticsApi.js";
import { runtimeFixture } from "./fixtures.js";

const resource = (data: DiagnosticsRuntime | undefined, extra: { error?: string; loading?: boolean } = {}) => ({
    data,
    error: extra.error,
    loading: extra.loading ?? false,
});

describe("RuntimePanel", () => {
    it("shows the Kubernetes version, distribution, platform and namespace", () => {
        render(<RuntimePanel runtime={resource(runtimeFixture())} />);
        const card = within(screen.getByRole("region", { name: "Kubernetes" }));
        expect(card.getByText("v1.33.1+k3s1")).toBeInTheDocument();
        expect(card.getByText("k3s")).toBeInTheDocument();
        expect(card.getByText("linux/amd64")).toBeInTheDocument();
        expect(card.getByText("rapidmx")).toBeInTheDocument();
        expect(card.getByText("go1.24.2")).toBeInTheDocument();
        expect(card.getByText(new Date("2026-05-01T00:00:00Z").toLocaleString())).toBeInTheDocument();
    });

    it("names other distributions, and a distribution it does not know by its id", () => {
        const withDistribution = (distribution: string) =>
            runtimeFixture({ version: { ...runtimeFixture().version!, distribution: distribution as "k3s" } });
        const { rerender } = render(<RuntimePanel runtime={resource(withDistribution("eks"))} />);
        expect(screen.getByText("Amazon EKS")).toBeInTheDocument();
        rerender(<RuntimePanel runtime={resource(withDistribution("talos"))} />);
        expect(screen.getByText("talos")).toBeInTheDocument();
    });

    it("lists the nodes that run the install's pods, and says it cannot see more", () => {
        render(<RuntimePanel runtime={resource(runtimeFixture())} />);
        const nodes = within(screen.getByRole("region", { name: "Nodes" }));
        expect(nodes.getByText(/only see its own namespace/)).toBeInTheDocument();
        expect(nodes.getAllByRole("row")).toHaveLength(3);
        const first = within(nodes.getByText("node-1").closest("tr")!);
        expect(first.getByText("10.0.0.1")).toBeInTheDocument();
        expect(first.getByText("5")).toBeInTheDocument();
        const second = within(nodes.getByText("node-2").closest("tr")!);
        expect(second.getByText("—")).toBeInTheDocument();
    });

    it("copes with a server that leaves out the version and the nodes", () => {
        render(<RuntimePanel runtime={resource({ available: true } as DiagnosticsRuntime)} />);
        expect(within(screen.getByRole("region", { name: "Kubernetes" })).getAllByText("—")).toHaveLength(6);
        expect(screen.getByText(/No node is running any/)).toBeInTheDocument();
    });

    it("says Kubernetes is not available as a note, with the reason", () => {
        render(<RuntimePanel runtime={resource({ available: false, reason: "Running under Docker Compose.", nodes: [] })} />);
        expect(screen.getByRole("status")).toHaveTextContent("Kubernetes information is not available on this server.");
        expect(screen.getByText("Running under Docker Compose.")).toBeInTheDocument();
        expect(screen.queryByRole("region", { name: "Nodes" })).not.toBeInTheDocument();
    });

    it("says it is loading, and shows an error", () => {
        const { rerender } = render(<RuntimePanel runtime={resource(undefined, { loading: true })} />);
        expect(screen.getByText(/Loading/)).toBeInTheDocument();
        rerender(<RuntimePanel runtime={resource(undefined, { error: "Could not read the runtime." })} />);
        expect(screen.getByText("Could not read the runtime.")).toBeInTheDocument();
        expect(screen.queryByText(/Loading/)).not.toBeInTheDocument();
    });
});
