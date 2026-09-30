// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ContactAvatar from "../../../../lib/components/avatar/ContactAvatar.js";
import { GRAVATAR_PREFERENCE_KEY } from "../../../../lib/contacts/gravatar.js";

afterEach(() => localStorage.clear());

const GRAVATAR = /^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?s=64&d=404$/;

describe("ContactAvatar pictures", () => {
    it("shows the contact's own picture in preference to a Gravatar", () => {
        const { container } = render(<ContactAvatar displayName="Jane Doe" size={32} photoUrl="/api/mail/contacts/c1/photo?v=1" email="jane@example.com" />);
        const img = container.querySelector("img")!;
        expect(img.getAttribute("src")).toBe("/api/mail/contacts/c1/photo?v=1");
        expect(img).toHaveAttribute("aria-hidden", "true");
        expect(img.style.width).toBe("32px");
    });

    it("asks Gravatar for the address, at twice the size, and shows initials until it answers or when it has nothing", async () => {
        const { container } = render(<ContactAvatar displayName="Jane Doe" size={32} email="jane@example.com" />);
        expect(screen.getByText("JD")).toBeInTheDocument();
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toMatch(GRAVATAR));

        fireEvent.error(container.querySelector("img")!);
        await waitFor(() => expect(container.querySelector("img")).toBeNull());
        expect(screen.getByText("JD")).toBeInTheDocument();
    });

    it("falls from the contact's picture to the Gravatar when the picture fails", async () => {
        const { container } = render(<ContactAvatar displayName="Jane Doe" size={32} photoUrl="/p" email="jane@example.com" />);
        fireEvent.error(container.querySelector("img")!);
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toMatch(GRAVATAR));
    });

    it("does not ask Gravatar when the reader turned that off, or there is no address", () => {
        localStorage.setItem(GRAVATAR_PREFERENCE_KEY, "off");
        const off = render(<ContactAvatar displayName="Jane Doe" email="jane@example.com" />);
        expect(off.container.querySelector("img")).toBeNull();
        const none = render(<ContactAvatar displayName="Jane Doe" />);
        expect(none.container.querySelector("img")).toBeNull();
    });

    it("drops a Gravatar that arrives after the address is gone", async () => {
        const { container, rerender } = render(<ContactAvatar displayName="Jane Doe" size={32} email="a@example.com" />);
        rerender(<ContactAvatar displayName="Jane Doe" size={32} />);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(container.querySelector("img")).toBeNull();
    });
});
