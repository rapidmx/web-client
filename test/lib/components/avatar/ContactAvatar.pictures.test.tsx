// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContactAvatar from "../../../../lib/components/avatar/ContactAvatar.js";
import { GRAVATAR_PREFERENCE_KEY, markGravatarMissing, setGravatarEnabled } from "../../../../lib/contacts/gravatar.js";

afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
});

// The test setup stubs an IntersectionObserver that never fires; without one an avatar looks up at once.
const enableGravatar = () => {
    localStorage.setItem(GRAVATAR_PREFERENCE_KEY, "on");
    vi.stubGlobal("IntersectionObserver", undefined);
};

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
        enableGravatar();
        const { container } = render(<ContactAvatar displayName="Jane Doe" size={32} email="jane@example.com" />);
        expect(screen.getByText("JD")).toBeInTheDocument();
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toMatch(GRAVATAR));

        fireEvent.error(container.querySelector("img")!);
        await waitFor(() => expect(container.querySelector("img")).toBeNull());
        expect(screen.getByText("JD")).toBeInTheDocument();
    });

    it("falls from the contact's picture to the Gravatar when the picture fails", async () => {
        enableGravatar();
        const { container } = render(<ContactAvatar displayName="Jane Doe" size={32} photoUrl="/p" email="fallback@example.com" />);
        fireEvent.error(container.querySelector("img")!);
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toMatch(GRAVATAR));
    });

    it("does not ask Gravatar unless the reader turned that on, or there is no address", async () => {
        const unset = render(<ContactAvatar displayName="Jane Doe" email="jane@example.com" />);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(unset.container.querySelector("img")).toBeNull();
        localStorage.setItem(GRAVATAR_PREFERENCE_KEY, "off");
        const off = render(<ContactAvatar displayName="Jane Doe" email="jane@example.com" />);
        expect(off.container.querySelector("img")).toBeNull();
        enableGravatar();
        const none = render(<ContactAvatar displayName="Jane Doe" />);
        expect(none.container.querySelector("img")).toBeNull();
    });

    it("drops a Gravatar that arrives after the address is gone", async () => {
        enableGravatar();
        const { container, rerender } = render(<ContactAvatar displayName="Jane Doe" size={32} email="a@example.com" />);
        rerender(<ContactAvatar displayName="Jane Doe" size={32} />);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(container.querySelector("img")).toBeNull();
    });

    it("follows the preference as it changes, without a reload", async () => {
        vi.stubGlobal("IntersectionObserver", undefined);
        const { container } = render(<ContactAvatar displayName="Jane Doe" size={32} email="live@example.com" />);
        expect(container.querySelector("img")).toBeNull();
        act(() => setGravatarEnabled(true));
        await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toMatch(GRAVATAR));
        act(() => setGravatarEnabled(false));
        await waitFor(() => expect(container.querySelector("img")).toBeNull());
    });

    it("does not ask Gravatar while the contact's own picture shows", async () => {
        enableGravatar();
        const { container } = render(<ContactAvatar displayName="Jane Doe" size={32} photoUrl="/own" email="own@example.com" />);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(container.querySelector("img")?.getAttribute("src")).toBe("/own");
    });

    it("remembers for the page's lifetime that Gravatar had no picture, across avatars", async () => {
        enableGravatar();
        const first = render(<ContactAvatar displayName="Jane Doe" size={32} email="nobody@example.com" />);
        await waitFor(() => expect(first.container.querySelector("img")).not.toBeNull());
        fireEvent.error(first.container.querySelector("img")!);
        await waitFor(() => expect(first.container.querySelector("img")).toBeNull());
        const second = render(<ContactAvatar displayName="Jane Doe" size={32} email="nobody@example.com" />);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(second.container.querySelector("img")).toBeNull();
    });

    it("tries a picture again when its URL changes back after a failure", () => {
        const { container, rerender } = render(<ContactAvatar displayName="Jane Doe" photoUrl="/p1" />);
        fireEvent.error(container.querySelector("img")!);
        expect(container.querySelector("img")).toBeNull();
        rerender(<ContactAvatar displayName="Jane Doe" photoUrl="/p2" />);
        rerender(<ContactAvatar displayName="Jane Doe" photoUrl="/p1" />);
        expect(container.querySelector("img")?.getAttribute("src")).toBe("/p1");
    });

    describe("with IntersectionObserver", () => {
        type Callback = (entries: { isIntersecting: boolean }[]) => void;
        function stubObserver() {
            const observers: { callback: Callback; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
            vi.stubGlobal(
                "IntersectionObserver",
                class {
                    observe = vi.fn();
                    disconnect = vi.fn();
                    constructor(public callback: Callback) {
                        observers.push(this);
                    }
                },
            );
            return observers;
        }

        it("looks Gravatar up only once the avatar scrolls into view", async () => {
            enableGravatar();
            const observers = stubObserver();
            const { container } = render(<ContactAvatar displayName="Jane Doe" size={32} email="scroll@example.com" />);
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(container.querySelector("img")).toBeNull();
            expect(observers).toHaveLength(1);
            expect(observers[0].observe).toHaveBeenCalledWith(container.querySelector("span"));

            act(() => observers[0].callback([{ isIntersecting: false }]));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(container.querySelector("img")).toBeNull();

            act(() => observers[0].callback([{ isIntersecting: true }]));
            await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toMatch(GRAVATAR));
            expect(observers[0].disconnect).toHaveBeenCalled();
        });

        it("does not watch an avatar that has nothing to look up", () => {
            const observers = stubObserver();
            render(<ContactAvatar displayName="Jane Doe" email="off@example.com" />);
            expect(observers).toHaveLength(0);
        });
    });

    it("shows initials for an address whose Gravatar is already known to be missing", async () => {
        enableGravatar();
        const probe = render(<ContactAvatar displayName="Jane Doe" size={32} email="known@example.com" />);
        const url = await waitFor(() => {
            const src = probe.container.querySelector("img")?.getAttribute("src");
            expect(src).toBeTruthy();
            return src!;
        });
        probe.unmount();
        markGravatarMissing(url);
        const again = render(<ContactAvatar displayName="Jane Doe" size={32} email="known@example.com" />);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(again.container.querySelector("img")).toBeNull();
    });
});
