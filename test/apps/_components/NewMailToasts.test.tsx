// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewMailToasts from "../../../apps/shared/components/mail/NewMailToasts.js";
import { TOAST_DURATION_MS } from "../../../apps/shared/mail/useNewMailNotifications.js";

function notice(uid: string, overrides: Record<string, unknown> = {}) {
    return {
        uid,
        mailboxUid: "mb1",
        folderUid: "inbox",
        senderName: "Jane Doe",
        senderAddress: "jane@example.com",
        subject: `Subject ${uid}`,
        preview: `Preview ${uid}`,
        href: `/messages/${uid}`,
        ...overrides,
    } as any;
}

function setHidden(hidden: boolean) {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
}

function renderToasts(toasts: any[], props: Record<string, unknown> = {}) {
    const onDismiss = vi.fn();
    const onEnableDesktop = vi.fn();
    const onDeclineDesktop = vi.fn();
    const view = render(
        <NewMailToasts
            toasts={toasts}
            onDismiss={onDismiss}
            offerDesktop={false}
            onEnableDesktop={onEnableDesktop}
            onDeclineDesktop={onDeclineDesktop}
            {...props}
        />,
    );
    return { ...view, onDismiss, onEnableDesktop, onDeclineDesktop };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    // @ts-expect-error - restore jsdom's own getter
    delete document.visibilityState;
});

describe("NewMailToasts", () => {
    it("is an always-present polite status region, so an arrival is announced without interrupting", () => {
        renderToasts([]);
        const region = screen.getByRole("status", { name: "New mail" });
        expect(region).toHaveAttribute("aria-live", "polite");
        expect(region).toBeEmptyDOMElement();
        expect(region.className).toContain("pointer-events-none");
    });

    it("shows the sender's name and address, the subject and the preview, as a link to the message", () => {
        renderToasts([notice("m1")]);
        const link = screen.getByRole("link");
        expect(link).toHaveAttribute("href", "/messages/m1");
        expect(link).toHaveTextContent("Jane Doe");
        expect(link).toHaveTextContent("<jane@example.com>");
        expect(link).toHaveTextContent("Subject m1");
        expect(link).toHaveTextContent("Preview m1");
    });

    it("shows a sender without a name by their address alone, and omits an empty preview", () => {
        renderToasts([notice("m1", { senderName: "", preview: "" })]);
        const link = screen.getByRole("link");
        expect(link).toHaveTextContent("jane@example.com");
        expect(link).not.toHaveTextContent("<");
        expect(link).toHaveTextContent("New messagejane@example.comSubject m1");
    });

    it("renders text as text: markup in the sender, subject or preview is never turned into elements", () => {
        renderToasts([notice("m1", { senderName: "<b>Boss</b>", subject: "<img src=x onerror=alert(1)>", preview: "<script>alert(1)</script>" })]);
        const link = screen.getByRole("link");
        expect(link.querySelector("b, img, script")).toBeNull();
        expect(link).toHaveTextContent("<b>Boss</b>");
        expect(link).toHaveTextContent("<img src=x onerror=alert(1)>");
        expect(link).toHaveTextContent("<script>alert(1)</script>");
    });

    it("dismisses on the dismiss button, and when the link is followed", () => {
        const { onDismiss } = renderToasts([notice("m1")]);
        fireEvent.click(screen.getByRole("button", { name: "Dismiss notification: Subject m1" }));
        expect(onDismiss).toHaveBeenCalledWith("m1");
        onDismiss.mockClear();
        fireEvent.click(screen.getByRole("link"));
        expect(onDismiss).toHaveBeenCalledWith("m1");
    });

    it("stacks several, oldest first", () => {
        renderToasts([notice("a"), notice("b"), notice("c")]);
        expect(screen.getAllByTestId("new-mail-toast").map((el) => el.textContent)).toEqual([
            expect.stringContaining("Subject a"),
            expect.stringContaining("Subject b"),
            expect.stringContaining("Subject c"),
        ]);
    });

    it("moves with a CSS animation that only runs for readers who have not asked for reduced motion", () => {
        renderToasts([notice("m1")]);
        // The class carries the animation; app.css applies it inside `@media (prefers-reduced-motion: no-preference)`.
        expect(screen.getByTestId("new-mail-toast").className).toContain("rr-toast-in");
    });

    describe("going away by itself", () => {
        it(`goes after ${TOAST_DURATION_MS / 1000} seconds`, () => {
            const { onDismiss } = renderToasts([notice("m1")]);
            act(() => {
                vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
            });
            expect(onDismiss).not.toHaveBeenCalled();
            act(() => {
                vi.advanceTimersByTime(1);
            });
            expect(onDismiss).toHaveBeenCalledWith("m1");
        });

        it("waits while hovered, and has the rest of its time again afterwards", () => {
            const { onDismiss } = renderToasts([notice("m1")]);
            act(() => {
                vi.advanceTimersByTime(5_000);
            });
            fireEvent.mouseEnter(screen.getByTestId("new-mail-toast"));
            act(() => {
                vi.advanceTimersByTime(60_000);
            });
            expect(onDismiss).not.toHaveBeenCalled();

            fireEvent.mouseLeave(screen.getByTestId("new-mail-toast"));
            act(() => {
                vi.advanceTimersByTime(TOAST_DURATION_MS - 5_000 - 1);
            });
            expect(onDismiss).not.toHaveBeenCalled();
            act(() => {
                vi.advanceTimersByTime(1);
            });
            expect(onDismiss).toHaveBeenCalledWith("m1");
        });

        it("waits while it holds keyboard focus, and only lets go when focus leaves it", () => {
            const { onDismiss } = renderToasts([notice("m1")], { offerDesktop: true });
            fireEvent.focus(screen.getByRole("link"));
            act(() => {
                vi.advanceTimersByTime(60_000);
            });
            expect(onDismiss).not.toHaveBeenCalled();

            // Focus moving to another control inside the same pop-up is not leaving it.
            fireEvent.blur(screen.getByRole("link"), { relatedTarget: screen.getByRole("button", { name: "Not now" }) });
            act(() => {
                vi.advanceTimersByTime(60_000);
            });
            expect(onDismiss).not.toHaveBeenCalled();

            fireEvent.blur(screen.getByRole("button", { name: "Not now" }), { relatedTarget: null });
            act(() => {
                vi.advanceTimersByTime(TOAST_DURATION_MS);
            });
            expect(onDismiss).toHaveBeenCalledWith("m1");
        });

        it("waits while the tab is out of view, so it is still there when the reader comes back", () => {
            const { onDismiss } = renderToasts([notice("m1")]);
            act(() => setHidden(true));
            act(() => {
                vi.advanceTimersByTime(TOAST_DURATION_MS * 5);
            });
            expect(onDismiss).not.toHaveBeenCalled();

            act(() => setHidden(false));
            act(() => {
                vi.advanceTimersByTime(TOAST_DURATION_MS);
            });
            expect(onDismiss).toHaveBeenCalledWith("m1");
        });

        it("clears its clock when it goes away", () => {
            const { onDismiss, unmount } = renderToasts([notice("m1")]);
            unmount();
            act(() => {
                vi.advanceTimersByTime(TOAST_DURATION_MS * 2);
            });
            expect(onDismiss).not.toHaveBeenCalled();
        });
    });

    describe("the offer to turn on desktop notifications", () => {
        it("is inside the first pop-up only, with a button for each answer", () => {
            const { onEnableDesktop, onDeclineDesktop } = renderToasts([notice("a"), notice("b")], { offerDesktop: true });
            expect(screen.getAllByRole("button", { name: "Turn on desktop notifications" })).toHaveLength(1);
            const first = screen.getAllByTestId("new-mail-toast")[0];
            expect(first).toContainElement(screen.getByRole("button", { name: "Turn on desktop notifications" }));

            fireEvent.click(screen.getByRole("button", { name: "Turn on desktop notifications" }));
            expect(onEnableDesktop).toHaveBeenCalledTimes(1);
            fireEvent.click(screen.getByRole("button", { name: "Not now" }));
            expect(onDeclineDesktop).toHaveBeenCalledTimes(1);
        });

        it("is left out when not offered", () => {
            renderToasts([notice("a")]);
            expect(screen.queryByRole("button", { name: "Turn on desktop notifications" })).not.toBeInTheDocument();
        });
    });
});
