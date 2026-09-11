// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ContactAvatar from "../../../apps/shared/components/contacts/ContactAvatar.js";

describe("ContactAvatar", () => {
    it("renders the first and last initials for a multi-word name, uppercased.", () => {
        render(<ContactAvatar displayName="jane doe" />);
        expect(screen.getByText("JD")).toBeInTheDocument();
    });

    it("renders a single initial for a one-word name.", () => {
        render(<ContactAvatar displayName="Cher" />);
        expect(screen.getByText("C")).toBeInTheDocument();
    });

    it("renders a fallback '?' for a blank name.", () => {
        render(<ContactAvatar displayName="   " />);
        expect(screen.getByText("?")).toBeInTheDocument();
    });

    it("is deterministic — the same name always gets the same color.", () => {
        const { container: a } = render(<ContactAvatar displayName="Jane Doe" />);
        const { container: b } = render(<ContactAvatar displayName="Jane Doe" />);
        const colorA = (a.querySelector("span") as HTMLElement).style.backgroundColor;
        const colorB = (b.querySelector("span") as HTMLElement).style.backgroundColor;
        expect(colorA).toBe(colorB);
        expect(colorA).not.toBe("");
    });

    it("scales font size with a custom size prop.", () => {
        render(<ContactAvatar displayName="Jane Doe" size={64} />);
        const span = screen.getByText("JD");
        expect(span.style.width).toBe("64px");
        expect(span.style.fontSize).toBe("25.6px");
    });
});
