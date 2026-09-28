// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Skeleton, { SkeletonList } from "../../../../lib/components/feedback/Skeleton.js";

describe("Skeleton", () => {
    it("defaults to a full-width, text-line-height pulsing bar", () => {
        const { container } = render(<Skeleton />);
        const el = container.firstElementChild as HTMLElement;
        expect(el.className).toContain("w-full");
        expect(el.className).toContain("h-4");
        expect(el.className).toContain("animate-pulse");
        expect(el).toHaveAttribute("aria-hidden", "true");
    });

    it("uses a custom width, height, and extra className when given", () => {
        const { container } = render(<Skeleton width="w-32" height="h-6" className="rounded-full" />);
        const el = container.firstElementChild as HTMLElement;
        expect(el.className).toContain("w-32");
        expect(el.className).toContain("h-6");
        expect(el.className).toContain("rounded-full");
    });
});

describe("SkeletonList", () => {
    it("renders 5 rows by default, each with an icon block and a text bar", () => {
        const { container } = render(<SkeletonList />);
        const rows = container.querySelectorAll(":scope > div > div");
        expect(rows).toHaveLength(5);
    });

    it("renders a custom row count and a custom className on the wrapper", () => {
        const { container } = render(<SkeletonList count={3} className="gap-4" />);
        const wrapper = container.firstElementChild as HTMLElement;
        expect(wrapper.className).toContain("gap-4");
        expect(wrapper.querySelectorAll(":scope > div")).toHaveLength(3);
    });

    it("alternates the text bar's width between rows", () => {
        const { container } = render(<SkeletonList count={2} />);
        const rows = container.querySelectorAll(":scope > div > div");
        const textBar = (row: Element) => row.querySelectorAll("div")[1] as HTMLElement;
        expect(textBar(rows[0]).className).toContain("w-3/4");
        expect(textBar(rows[1]).className).toContain("w-1/2");
    });
});
