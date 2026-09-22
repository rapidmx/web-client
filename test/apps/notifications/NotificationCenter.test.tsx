///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NotificationCenter from "../../../apps/shared/notifications/NotificationCenter.js";
import NotificationHistoryDialog from "../../../apps/shared/notifications/NotificationHistoryDialog.js";
import { useNotifications, useUnseenErrorCount } from "../../../apps/shared/notifications/useNotifications.js";
import { DEFAULT_TIMEOUT_MS, dismiss, getNotificationsSnapshot, notify } from "../../../apps/shared/notifications/store.js";

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
    vi.useRealTimers();
});

function raise(input: Parameters<typeof notify>[0]) {
    let id = "";
    act(() => {
        id = notify(input);
    });
    return id;
}

describe("NotificationCenter", () => {
    it("always renders both live regions - errors in an assertive one, everything else in a polite one - so content added later is announced, with roles only on the pop-ups", () => {
        render(<NotificationCenter />);
        const errors = screen.getByTestId("notification-errors");
        const others = screen.getByTestId("notification-others");
        expect(errors).toHaveAttribute("aria-live", "assertive");
        expect(others).toHaveAttribute("aria-live", "polite");
        // Nothing to say: the page has no alert or status of its own from here.
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        raise({ kind: "error", title: "Boom" });
        raise({ kind: "info", title: "FYI" });
        raise({ kind: "warning", title: "Careful" });
        expect(within(errors).getByRole("alert")).toHaveTextContent("Boom");
        const statuses = within(others).getAllByRole("status");
        expect(statuses).toHaveLength(2);
        expect(statuses[0]).toHaveTextContent("FYI");
        expect(statuses[1]).toHaveTextContent("Careful");
    });

    it("is anchored right under the header row (a zero-height sticky line), above compose sheets, and never covers the account menu", () => {
        render(<NotificationCenter />);
        const anchor = screen.getByTestId("notification-anchor");
        expect(anchor.className).toContain("sticky");
        expect(anchor.className).toContain("h-0");
        expect(anchor.className).toContain("z-[60]");
        // It sticks just below the frame's header (whatever its height), never less than 2.5rem from the top.
        expect(anchor.className).toContain("top-[max(var(--rr-header-h,0px),2.5rem)]");
        expect(screen.getByTestId("notification-stack").className).toContain("top-1");
        expect(screen.getByTestId("notification-stack").className).toContain("var(--rr-header-h,0px)");
    });

    it("shows each kind's title, message, subtitle, preview and hint, with a count for a repeated one", () => {
        render(<NotificationCenter />);
        raise({ kind: "success", title: "Saved", message: "The contact was saved.", subtitle: "sub", preview: "prev", hint: "a hint", dedupeKey: "k" });
        raise({ kind: "success", title: "Saved", dedupeKey: "k" });
        const item = screen.getByTestId("notification");
        expect(item).toHaveAttribute("data-kind", "success");
        expect(within(item).getByText("Saved")).toBeInTheDocument();
        expect(within(item).getByText(/×2/)).toBeInTheDocument();
        expect(within(item).getByText("(2 times)")).toBeInTheDocument();
    });

    it("renders a new-mail pop-up as a link to the message, dismissing it on click", () => {
        render(<NotificationCenter />);
        raise({ kind: "mail", title: "Jane", subtitle: "<jane@example.com>", message: "Lunch", preview: "Are you free?", href: "/messages/m1" });
        const link = screen.getByRole("link");
        expect(link).toHaveAttribute("href", "/messages/m1");
        expect(link).toHaveTextContent("New message");
        expect(link).toHaveTextContent("Jane");
        expect(link).toHaveTextContent("Lunch");
        expect(link).toHaveTextContent("Are you free?");
        fireEvent.click(link);
        expect(screen.queryByTestId("notification")).not.toBeInTheDocument();
    });

    it("has a dismiss button, and Escape inside a pop-up dismisses it", () => {
        render(<NotificationCenter />);
        raise({ kind: "info", title: "One" });
        raise({ kind: "info", title: "Two" });
        fireEvent.click(screen.getByRole("button", { name: "Dismiss notification: One" }));
        expect(screen.queryByText("One")).not.toBeInTheDocument();
        const two = screen.getByTestId("notification");
        const key = fireEvent.keyDown(two, { key: "Escape" });
        expect(key).toBe(false);
        expect(screen.queryByTestId("notification")).not.toBeInTheDocument();
        raise({ kind: "info", title: "Three" });
        expect(fireEvent.keyDown(screen.getByTestId("notification"), { key: "a" })).toBe(true);
        expect(screen.getByTestId("notification")).toBeInTheDocument();
    });

    it("shows technical details collapsed, monospace and copyable", async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
        render(<NotificationCenter />);
        raise({ kind: "error", title: "Failed", details: ["status: 502", "recipient 1: a@b.c"] });
        expect(screen.getByText("Technical details").closest("details")).not.toHaveAttribute("open");
        expect(screen.getByRole("list", { name: "Technical details" })).toHaveClass("font-mono");
        fireEvent.click(screen.getByRole("button", { name: "Copy technical details" }));
        await act(async () => {
            await Promise.resolve();
        });
        expect(writeText).toHaveBeenCalledWith("status: 502\nrecipient 1: a@b.c");
    });

    it("runs an action's callback and resolves (dismisses) the pop-up, unless it keeps it open; a link action is an anchor", () => {
        render(<NotificationCenter />);
        const onClick = vi.fn();
        const onKeep = vi.fn();
        raise({
            kind: "error",
            title: "Not sent",
            actions: [{ label: "Retry", onClick }, { label: "Peek", onClick: onKeep, keepOpen: true }, { label: "Open", href: "/somewhere" }, { label: "Nothing" }],
        });
        fireEvent.click(screen.getByRole("button", { name: "Peek" }));
        expect(onKeep).toHaveBeenCalled();
        expect(screen.getByTestId("notification")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/somewhere");
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(onClick).toHaveBeenCalled();
        expect(screen.queryByTestId("notification")).not.toBeInTheDocument();
        raise({ kind: "error", title: "Again", actions: [{ label: "Go", href: "/x" }, { label: "Nothing" }] });
        fireEvent.click(screen.getByRole("button", { name: "Nothing" }));
        expect(screen.queryByTestId("notification")).not.toBeInTheDocument();
        raise({ kind: "error", title: "Link", actions: [{ label: "Go", href: "/x" }] });
        fireEvent.click(screen.getByRole("link", { name: "Go" }));
        expect(screen.queryByTestId("notification")).not.toBeInTheDocument();
    });

    it("pauses a pop-up's clock while it is hovered or holds the focus, not when focus moves between its own controls", () => {
        render(<NotificationCenter />);
        raise({ kind: "info", title: "Hold", actions: [{ label: "A" }, { label: "B" }], sticky: false, timeoutMs: 1000 });
        const item = screen.getByTestId("notification");
        fireEvent.mouseEnter(item);
        act(() => {
            vi.advanceTimersByTime(5000);
        });
        expect(screen.getByTestId("notification")).toBeInTheDocument();
        fireEvent.mouseLeave(item);
        fireEvent.focus(screen.getByRole("button", { name: "A" }));
        act(() => {
            vi.advanceTimersByTime(5000);
        });
        expect(screen.getByTestId("notification")).toBeInTheDocument();
        // Focus moving to another control of the same pop-up is not leaving it.
        fireEvent.blur(screen.getByRole("button", { name: "A" }), { relatedTarget: screen.getByRole("button", { name: "B" }) });
        act(() => {
            vi.advanceTimersByTime(5000);
        });
        expect(screen.getByTestId("notification")).toBeInTheDocument();
        fireEvent.blur(screen.getByRole("button", { name: "B" }), { relatedTarget: null });
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(screen.queryByTestId("notification")).not.toBeInTheDocument();
    });

    it("stops the clocks while the tab is hidden and resumes when it is back", () => {
        const state = vi.spyOn(document, "visibilityState", "get");
        state.mockReturnValue("visible");
        const { unmount } = render(<NotificationCenter />);
        raise({ kind: "info", title: "Wait for me", timeoutMs: 1000 });
        state.mockReturnValue("hidden");
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
            vi.advanceTimersByTime(10_000);
        });
        expect(screen.getByTestId("notification")).toBeInTheDocument();
        state.mockReturnValue("visible");
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
            vi.advanceTimersByTime(1000);
        });
        expect(screen.queryByTestId("notification")).not.toBeInTheDocument();
        unmount();
        state.mockRestore();
    });

    it("says how many more are waiting for room", () => {
        render(<NotificationCenter />);
        for (const name of ["A", "B", "C", "D", "E"]) {
            raise({ id: name, kind: "error", title: name });
        }
        expect(screen.getAllByTestId("notification")).toHaveLength(3);
        expect(screen.getByText("2 more waiting")).toBeInTheDocument();
        act(() => dismiss("A"));
        expect(screen.getByText("1 more waiting")).toBeInTheDocument();
    });

    it("catches an unhandled error and an unhandled rejection as one 'Something went wrong' pop-up with details", () => {
        render(<NotificationCenter />);
        act(() => {
            window.dispatchEvent(new ErrorEvent("error", { error: new Error("kaboom"), message: "kaboom", filename: "app.js", lineno: 3, colno: 4 }));
            window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
        });
        expect(screen.getAllByText("Something went wrong")).toHaveLength(1);
        expect(screen.getByText(/×2/)).toBeInTheDocument();
        const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
        rejection.reason = new Error("late");
        act(() => {
            window.dispatchEvent(rejection);
        });
        expect(screen.getByText(/×3/)).toBeInTheDocument();
    });
});

describe("useNotifications and the history dialog", () => {
    function Probe() {
        const notifications = useNotifications();
        return (
            <div>
                <span data-testid="visible">{notifications.visible.length}</span>
                <span data-testid="unseen">{notifications.unseenErrors}</span>
                <button type="button" onClick={() => notifications.notify({ kind: "error", title: "From hook", details: ["x"] })}>
                    raise
                </button>
                <button type="button" onClick={() => notifications.dismissAll()}>
                    clear
                </button>
            </div>
        );
    }

    it("has a narrow hook for just the count of unseen errors", () => {
        function Count() {
            return <span data-testid="count">{useUnseenErrorCount()}</span>;
        }
        render(<Count />);
        expect(screen.getByTestId("count")).toHaveTextContent("0");
        raise({ kind: "error", title: "One" });
        raise({ kind: "info", title: "Not an error" });
        expect(screen.getByTestId("count")).toHaveTextContent("1");
    });

    it("gives a component the stack and the history, and the functions to change them", () => {
        render(<Probe />);
        expect(screen.getByTestId("visible")).toHaveTextContent("0");
        fireEvent.click(screen.getByRole("button", { name: "raise" }));
        expect(screen.getByTestId("visible")).toHaveTextContent("1");
        expect(screen.getByTestId("unseen")).toHaveTextContent("1");
        fireEvent.click(screen.getByRole("button", { name: "clear" }));
        expect(screen.getByTestId("visible")).toHaveTextContent("0");
    });

    it("lists the recent notifications newest first, marks them seen on open, keeps the just-seen errors highlighted, and clears", () => {
        raise({ kind: "error", title: "Earlier failure", message: "Why", details: ["line one"], dedupeKey: "k" });
        raise({ kind: "error", title: "Earlier failure", message: "Why", details: ["line one"], dedupeKey: "k" });
        raise({ kind: "success", title: "Message sent" });
        dismiss("notification-1");
        const { rerender } = render(<NotificationHistoryDialog open={false} onClose={() => undefined} />);
        expect(getNotificationsSnapshot().unseenErrors).toBe(1);
        rerender(<NotificationHistoryDialog open onClose={() => undefined} />);
        expect(getNotificationsSnapshot().unseenErrors).toBe(0);
        const list = screen.getByRole("list", { name: "Recent notifications" });
        const items = within(list).getAllByRole("listitem").filter((li) => li.querySelector("time"));
        expect(items[0]).toHaveTextContent("Message sent");
        expect(items[1]).toHaveTextContent("Earlier failure");
        expect(items[1]).toHaveTextContent("×2");
        expect(items[1].className).toContain("bg-danger-bg");
        expect(items[0].className).not.toContain("bg-danger-bg");
        expect(within(items[1]).getByText("line one")).toBeInTheDocument();
        expect(within(items[1]).getByRole("button", { name: "Copy technical details" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Clear list" }));
        expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
    });

    it("closes through its own close button", () => {
        const onClose = vi.fn();
        render(<NotificationHistoryDialog open onClose={onClose} />);
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalled();
        expect(DEFAULT_TIMEOUT_MS.info).toBeGreaterThan(0);
    });
});
