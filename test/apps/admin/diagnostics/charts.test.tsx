// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HiOutlineCheckCircle } from "react-icons/hi2";
import Badge from "../../../../apps/shared/components/admin/diagnostics/Badge.js";
import KubernetesNotice from "../../../../apps/shared/components/admin/diagnostics/KubernetesNotice.js";
import MetricTile from "../../../../apps/shared/components/admin/diagnostics/MetricTile.js";
import Sparkline, { sparklinePoints } from "../../../../apps/shared/components/admin/diagnostics/Sparkline.js";
import UsageMeter, {
    CRITICAL_USAGE_PERCENT,
    HIGH_USAGE_PERCENT,
    usageSeverity,
} from "../../../../apps/shared/components/admin/diagnostics/UsageMeter.js";

const plain = (value: number) => `${value}!`;

describe("sparklinePoints", () => {
    it("puts the newest sample at the right edge and leaves room for a full history on the left", () => {
        const [first, second] = sparklinePoints([10, 20], 100);
        expect(second[0]).toBe(240);
        expect(first[0]).toBeCloseTo(240 - 240 / 59, 5);
    });

    it("scales from zero to max, and clamps what is outside", () => {
        const points = sparklinePoints([0, 50, 100, 250, -5], 100);
        expect(points.map(([, y]) => y)).toEqual([46, 24, 2, 2, 46]);
    });

    it("scales to the highest value when there is no usable max, and copes with all zeroes and no values", () => {
        expect(sparklinePoints([5, 10]).map(([, y]) => y)).toEqual([24, 2]);
        expect(sparklinePoints([5, 10], 0).map(([, y]) => y)).toEqual([24, 2]);
        expect(sparklinePoints([0, 0]).map(([, y]) => y)).toEqual([46, 46]);
        expect(sparklinePoints([])).toEqual([]);
    });
});

describe("Sparkline", () => {
    it("draws a line and a wash, and says the latest, lowest and highest in its text alternative", () => {
        const { container } = render(<Sparkline values={[3, 9, 6]} label="CPU" max={10} format={plain} />);
        expect(screen.getByRole("img", { name: "CPU: latest 6!, lowest 3!, highest 9! over the last 3 samples" })).toBeInTheDocument();
        expect(container.querySelectorAll("path")).toHaveLength(2);
        const [wash, line] = Array.from(container.querySelectorAll("path"));
        expect(wash.getAttribute("d")).toMatch(/Z$/);
        expect(line.getAttribute("stroke-width")).toBe("2");
        expect(line.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+ L/);
    });

    it("draws only the baseline until there are two samples", () => {
        const { container, rerender } = render(<Sparkline values={[]} label="Memory" format={plain} />);
        expect(screen.getByRole("img", { name: "Memory: collecting samples" })).toBeInTheDocument();
        expect(container.querySelectorAll("path")).toHaveLength(0);
        rerender(<Sparkline values={[4]} label="Memory" format={plain} />);
        expect(screen.getByRole("img", { name: "Memory: collecting samples" })).toBeInTheDocument();
        expect(container.querySelectorAll("path")).toHaveLength(0);
    });
});

describe("usageSeverity", () => {
    it("calls a value high above 80 and critical above 90, and neither at the boundary", () => {
        expect([HIGH_USAGE_PERCENT, CRITICAL_USAGE_PERCENT]).toEqual([80, 90]);
        expect(usageSeverity(50)).toBe("normal");
        expect(usageSeverity(80)).toBe("normal");
        expect(usageSeverity(80.1)).toBe("high");
        expect(usageSeverity(90)).toBe("high");
        expect(usageSeverity(90.1)).toBe("critical");
    });
});

describe("UsageMeter", () => {
    it("writes the amounts and the percentage, with no severity word when it is normal", () => {
        render(<UsageMeter label="Disk" percent={42.5} detail="4 GiB of 10 GiB" />);
        expect(screen.getByText("4 GiB of 10 GiB")).toBeInTheDocument();
        expect(screen.getByText("42.5%")).toBeInTheDocument();
        expect(screen.queryByText("High")).not.toBeInTheDocument();
        expect(screen.queryByText("Critical")).not.toBeInTheDocument();
        const meter = screen.getByRole("meter", { name: "Disk" });
        expect(meter).toHaveAttribute("aria-valuenow", "43");
        expect(meter).toHaveAttribute("aria-valuetext", "4 GiB of 10 GiB, 42.5%");
    });

    it("says High above 80% and colours the fill as a warning", () => {
        const { container } = render(<UsageMeter label="Disk" percent={85} detail="a" />);
        expect(screen.getByText("High")).toBeInTheDocument();
        expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "a, 85.0%, high");
        expect(container.querySelector(".bg-warning")).not.toBeNull();
    });

    it("says Critical above 90% and colours the fill as danger", () => {
        const { container } = render(<UsageMeter label="Disk" percent={95} detail="a" />);
        expect(screen.getByText("Critical")).toBeInTheDocument();
        expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "a, 95.0%, critical");
        expect(container.querySelector(".bg-danger")).not.toBeNull();
    });

    it("clamps the bar but writes the value as it is", () => {
        const { container } = render(<UsageMeter label="Disk" percent={130} detail="a" />);
        expect(screen.getByText("130.0%")).toBeInTheDocument();
        expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
        expect((container.querySelector(".bg-danger") as HTMLElement).style.width).toBe("100%");
        const negative = render(<UsageMeter label="Other" percent={-4} detail="b" />);
        expect((negative.container.querySelector(".bg-primary") as HTMLElement).style.width).toBe("0%");
    });

    it("does not flag a value when told not to", () => {
        const { container } = render(<UsageMeter label="Disk" percent={97} detail="a" flag={false} />);
        expect(screen.queryByText("Critical")).not.toBeInTheDocument();
        expect(container.querySelector(".bg-danger")).toBeNull();
        expect(screen.getByText("97.0%")).toBeInTheDocument();
    });
});

describe("MetricTile", () => {
    it("shows just a label and a value", () => {
        render(<MetricTile label="Load" value="1.00" />);
        expect(screen.getByText("Load")).toBeInTheDocument();
        expect(screen.getByText("1.00")).toBeInTheDocument();
        expect(screen.queryByRole("meter")).not.toBeInTheDocument();
        expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("adds the detail, a meter for a share of a capacity and a sparkline of the history", () => {
        render(
            <MetricTile
                label="Memory"
                value="4 GiB"
                detail="of 8 GiB"
                usage={{ percent: 50, detail: "4 GiB of 8 GiB" }}
                history={{ values: [1, 2], format: plain }}
            >
                <p>extra</p>
            </MetricTile>
        );
        expect(screen.getByText("of 8 GiB")).toBeInTheDocument();
        expect(screen.getByRole("meter", { name: "Memory usage" })).toBeInTheDocument();
        expect(screen.getByRole("img", { name: /^Memory: latest 2!/ })).toBeInTheDocument();
        expect(screen.getByText("extra")).toBeInTheDocument();
    });
});

describe("Badge and KubernetesNotice", () => {
    it("writes its words, with an icon when given one", () => {
        const { container, rerender } = render(<Badge>plain</Badge>);
        expect(screen.getByText("plain")).toBeInTheDocument();
        expect(container.querySelector("svg")).toBeNull();
        rerender(
            <Badge tone="success" icon={HiOutlineCheckCircle}>
                Running
            </Badge>
        );
        expect(container.querySelector("svg")).not.toBeNull();
        expect(container.querySelector(".bg-success\\/15")).not.toBeNull();
    });

    it("says Kubernetes is not available as a plain note, with the reason when there is one", () => {
        const { rerender } = render(<KubernetesNotice reason="Not running in a cluster." />);
        expect(screen.getByRole("status")).toHaveTextContent("Kubernetes information is not available on this server.");
        expect(screen.getByText("Not running in a cluster.")).toBeInTheDocument();
        expect(screen.getByText(/Docker Compose/)).toBeInTheDocument();
        rerender(<KubernetesNotice />);
        expect(screen.queryByText("Not running in a cluster.")).not.toBeInTheDocument();
    });
});
