// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HostCard from "../../../../apps/shared/components/admin/diagnostics/HostCard.js";
import PressureTiles, { pressureLevel } from "../../../../apps/shared/components/admin/diagnostics/PressureTiles.js";
import { metricsSample } from "./fixtures.js";

const GiB = 1024 ** 3;
const sample = metricsSample();
const stall = (avg10: number, avg60 = avg10 / 2, avg300 = avg10 / 4) => ({ avg10, avg60, avg300 });

function host(overrides: Partial<typeof sample.host> = {}) {
    return { ...sample.host, memoryTotalBytes: 30 * GiB, ...overrides };
}

describe("pressureLevel", () => {
    it("says low, elevated and high in words", () => {
        expect(pressureLevel(0)).toBe("Low");
        expect(pressureLevel(9.9)).toBe("Low");
        expect(pressureLevel(10)).toBe("Elevated");
        expect(pressureLevel(29.9)).toBe("Elevated");
        expect(pressureLevel(30)).toBe("High");
        expect(pressureLevel(100)).toBe("High");
    });
});

describe("PressureTiles", () => {
    it("shows nothing where the kernel gives neither pressure nor a balloon", () => {
        const { container } = render(<PressureTiles host={host()} history={[]} />);
        expect(container).toBeEmptyDOMElement();
        const empty = render(<PressureTiles host={host({ pressure: {} })} history={[]} />);
        expect(empty.container).toBeEmptyDOMElement();
    });

    it("shows each pressure the kernel reports, in numbers and words, and skips the rest", () => {
        render(
            <PressureTiles
                host={host({ pressure: { memory: { some: stall(64.35, 73.93, 33.85), full: stall(45.64, 55.43, 25.77) }, cpu: { some: stall(2) } } })}
                history={[]}
            />
        );
        expect(screen.getByText("Pressure")).toBeInTheDocument();
        expect(screen.getByText("Memory pressure")).toBeInTheDocument();
        expect(screen.getByText("64.3%")).toBeInTheDocument();
        expect(screen.getByText("High: tasks waiting for memory, last 10 seconds")).toBeInTheDocument();
        expect(screen.getByText(/Last minute 73\.9%, last 5 minutes 33\.9% · every task waiting: 45\.6%/)).toBeInTheDocument();
        expect(screen.getByText("CPU pressure")).toBeInTheDocument();
        expect(screen.getByText("Low: tasks waiting for a CPU, last 10 seconds")).toBeInTheDocument();
        // The CPU line has no "full" figure to add.
        expect(screen.getByText(/Last minute 1\.0%, last 5 minutes 0\.5%$/)).toBeInTheDocument();
        expect(screen.queryByText("I/O pressure")).not.toBeInTheDocument();
        expect(screen.queryByText("Held by the hypervisor")).not.toBeInTheDocument();
    });

    it("draws each pressure's history", () => {
        const history = [10, 20, 25].map((value) => ({ ...sample, host: { ...sample.host, pressure: { io: { some: stall(value) } } } }));
        render(<PressureTiles host={history[2].host} history={history} />);
        expect(screen.getByText("I/O pressure")).toBeInTheDocument();
        expect(screen.getByText("Elevated: tasks waiting for the disk, last 10 seconds")).toBeInTheDocument();
        expect(screen.getByRole("img", { name: /^I\/O pressure: latest 25\.0%, lowest 10\.0%, highest 25\.0%/ })).toBeInTheDocument();
    });

    it("shows what the hypervisor's balloon holds against the node's memory, and how much it has taken since boot", () => {
        const ballooned = { balloon: { heldBytes: 8 * GiB, inflatedTotalBytes: 600 * GiB } };
        const history = [{ ...sample, host: host(ballooned) }];
        render(<PressureTiles host={history[0].host} history={history} />);
        expect(screen.getByText("Held by the hypervisor")).toBeInTheDocument();
        const tile = within(screen.getByText("Held by the hypervisor").parentElement as HTMLElement);
        expect(tile.getByText("8.0 GiB")).toBeInTheDocument();
        expect(tile.getByText("of 30.0 GiB")).toBeInTheDocument();
        expect(tile.getByRole("meter", { name: "Held by the hypervisor usage" })).toHaveAttribute("aria-valuenow", "27");
        expect(tile.getByText(/It counts as used above though no process holds it\./)).toBeInTheDocument();
        expect(tile.getByText(/600 GiB taken since the node booted/)).toBeInTheDocument();
        // Ballooned memory is not a fullness to raise an alarm about, so it has no High or Critical word.
        expect(screen.queryByText("High")).not.toBeInTheDocument();
        expect(screen.getByRole("img", { name: /^Held by the hypervisor: collecting samples/ })).toBeInTheDocument();
    });

    it("shows the balloon without a meter when the node reports no memory to compare it with", () => {
        render(<PressureTiles host={host({ memoryTotalBytes: 0, balloon: { heldBytes: GiB, inflatedTotalBytes: GiB } })} history={[]} />);
        expect(screen.getByText("Held by the hypervisor")).toBeInTheDocument();
        expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    });
});

describe("HostCard with pressure", () => {
    it("shows the pressure between the node's figures and its disks", () => {
        render(<HostCard host={host({ pressure: { memory: { some: stall(5) } } })} history={[]} />);
        const card = within(screen.getByRole("region", { name: "Node running this server" }));
        expect(card.getByText("Memory pressure")).toBeInTheDocument();
        expect(card.getByText("Disks")).toBeInTheDocument();
    });

    it("is unchanged where there is no pressure or balloon", () => {
        render(<HostCard host={host()} history={[]} />);
        expect(screen.queryByText("Pressure")).not.toBeInTheDocument();
    });
});
