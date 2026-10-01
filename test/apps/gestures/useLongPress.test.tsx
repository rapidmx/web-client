// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS, UseLongPressOptions, useLongPress } from "../../../apps/shared/gestures/useLongPress.js";

function Target({ onClick, ...options }: UseLongPressOptions & { onClick?: () => void }) {
    const press = useLongPress(options);
    return (
        <div data-testid="target" style={press.style} {...press.handlers}>
            <button type="button" onClick={onClick}>
                Open
            </button>
        </div>
    );
}

const touch = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("useLongPress", () => {
    it("fires once when a finger stays down for the delay, with a buzz where the device has one", () => {
        const vibrate = vi.fn();
        vi.stubGlobal("navigator", { ...navigator, vibrate });
        const onLongPress = vi.fn();
        render(<Target onLongPress={onLongPress} />);
        const target = screen.getByTestId("target");

        fireEvent.touchStart(target, touch(100, 100));
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS - 1));
        expect(onLongPress).not.toHaveBeenCalled();
        act(() => void vi.advanceTimersByTime(1));
        expect(onLongPress).toHaveBeenCalledOnce();
        expect(vibrate).toHaveBeenCalledWith(10);

        act(() => void vi.advanceTimersByTime(5000));
        expect(onLongPress).toHaveBeenCalledOnce();
    });

    it("is silent on a device with no vibration, and takes a delay of its own", () => {
        const onLongPress = vi.fn();
        render(<Target onLongPress={onLongPress} delay={100} />);

        fireEvent.touchStart(screen.getByTestId("target"), touch(100, 100));
        act(() => void vi.advanceTimersByTime(100));

        expect(onLongPress).toHaveBeenCalledOnce();
    });

    it("gives up when the finger lifts early, goes further than the tolerance, or a second one lands", () => {
        const onLongPress = vi.fn();
        render(<Target onLongPress={onLongPress} />);
        const target = screen.getByTestId("target");

        fireEvent.touchStart(target, touch(100, 100));
        fireEvent.touchEnd(target);
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));

        fireEvent.touchStart(target, touch(100, 100));
        fireEvent.touchMove(target, touch(100, 120));
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));

        fireEvent.touchStart(target, touch(100, 100));
        fireEvent.touchMove(target, { touches: [{ clientX: 100, clientY: 100 }, { clientX: 150, clientY: 100 }] });
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));

        // A move after the timer is gone has nothing to cancel.
        fireEvent.touchMove(target, touch(300, 300));
        expect(onLongPress).not.toHaveBeenCalled();
    });

    it("rides out the tremor of a finger that is held still", () => {
        const onLongPress = vi.fn();
        render(<Target onLongPress={onLongPress} />);
        const target = screen.getByTestId("target");

        fireEvent.touchStart(target, touch(100, 100));
        fireEvent.touchMove(target, touch(103, 104));
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

        expect(onLongPress).toHaveBeenCalledOnce();
    });

    it("does not start with a second finger already down, or while disabled", () => {
        const onLongPress = vi.fn();
        const { rerender } = render(<Target onLongPress={onLongPress} />);
        const target = screen.getByTestId("target");

        fireEvent.touchStart(target, { touches: [{ clientX: 1, clientY: 1 }, { clientX: 9, clientY: 9 }] });
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));
        rerender(<Target onLongPress={onLongPress} enabled={false} />);
        fireEvent.touchStart(screen.getByTestId("target"), touch(100, 100));
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));

        expect(onLongPress).not.toHaveBeenCalled();
    });

    it("gives up when the browser takes the touch over, or the page scrolls", () => {
        const onLongPress = vi.fn();
        render(<Target onLongPress={onLongPress} />);
        const target = screen.getByTestId("target");

        fireEvent.touchStart(target, touch(100, 100));
        fireEvent.touchCancel(target);
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));

        fireEvent.touchStart(target, touch(100, 100));
        fireEvent.scroll(target);
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));

        // The scroll listener went with the press: a later one does nothing.
        fireEvent.scroll(target);
        expect(onLongPress).not.toHaveBeenCalled();
    });

    it("swallows the click that ends a long press, once, and the touchend's own click", () => {
        const onClick = vi.fn();
        render(<Target onLongPress={vi.fn()} onClick={onClick} />);
        const target = screen.getByTestId("target");
        const open = screen.getByRole("button", { name: "Open" });

        fireEvent.touchStart(open, touch(100, 100));
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
        // The browser is told not to make a click at all...
        expect(fireEvent.touchEnd(open)).toBe(false);
        // ...and one that comes anyway is held back from the button under the finger.
        fireEvent.click(open);
        expect(onClick).not.toHaveBeenCalled();

        // The next tap is an ordinary one.
        fireEvent.touchStart(target, touch(100, 100));
        fireEvent.touchEnd(target);
        fireEvent.click(open);
        expect(onClick).toHaveBeenCalledOnce();
    });

    it("leaves the touchend and the click of a short press alone", () => {
        const onClick = vi.fn();
        render(<Target onLongPress={vi.fn()} onClick={onClick} />);
        const open = screen.getByRole("button", { name: "Open" });

        fireEvent.touchStart(open, touch(100, 100));
        expect(fireEvent.touchEnd(open)).toBe(true);
        fireEvent.click(open);

        expect(onClick).toHaveBeenCalledOnce();
    });

    it("stops swallowing after the window for the click has passed, so a press with no click does not eat a later one", () => {
        const onClick = vi.fn();
        render(<Target onLongPress={vi.fn()} onClick={onClick} />);
        const open = screen.getByRole("button", { name: "Open" });

        fireEvent.touchStart(open, touch(100, 100));
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
        fireEvent.touchEnd(open);
        // A second lift of the same press only restarts the window.
        fireEvent.touchEnd(open);
        act(() => void vi.advanceTimersByTime(1000));
        fireEvent.click(open);

        expect(onClick).toHaveBeenCalledOnce();
    });

    it("still swallows the click once the row has turned the press off in answer to it", () => {
        const onClick = vi.fn();
        const { rerender } = render(<Target onLongPress={vi.fn()} onClick={onClick} />);
        const open = screen.getByRole("button", { name: "Open" });

        fireEvent.touchStart(open, touch(100, 100));
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
        rerender(<Target onLongPress={vi.fn()} onClick={onClick} enabled={false} />);
        fireEvent.touchEnd(open);
        fireEvent.click(open);

        expect(onClick).not.toHaveBeenCalled();
    });

    it("forgets a press that was cancelled after it fired, so the next click goes through", () => {
        const onClick = vi.fn();
        render(<Target onLongPress={vi.fn()} onClick={onClick} />);
        const open = screen.getByRole("button", { name: "Open" });

        fireEvent.touchStart(open, touch(100, 100));
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
        fireEvent.touchCancel(open);
        fireEvent.click(open);

        expect(onClick).toHaveBeenCalledOnce();
    });

    it("keeps the context menu away while a press is held and once it has fired, and only then", () => {
        render(<Target onLongPress={vi.fn()} />);
        const target = screen.getByTestId("target");

        expect(fireEvent.contextMenu(target)).toBe(true);
        fireEvent.touchStart(target, touch(100, 100));
        expect(fireEvent.contextMenu(target)).toBe(false);
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
        expect(fireEvent.contextMenu(target)).toBe(false);
        fireEvent.touchCancel(target);
        expect(fireEvent.contextMenu(target)).toBe(true);
    });

    it("stops text selection on the row only while a press can start", () => {
        const { rerender } = render(<Target onLongPress={vi.fn()} />);
        expect(screen.getByTestId("target").style.userSelect).toBe("none");

        rerender(<Target onLongPress={vi.fn()} enabled={false} />);
        expect(screen.getByTestId("target").style.userSelect).toBe("");
    });

    it("calls the latest handler, and never fires into a row that has gone", () => {
        const first = vi.fn();
        const second = vi.fn();
        const { rerender, unmount } = render(<Target onLongPress={first} />);
        fireEvent.touchStart(screen.getByTestId("target"), touch(100, 100));
        rerender(<Target onLongPress={second} />);
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledOnce();

        // Gone while a press is held, and while the click that ends one is awaited.
        fireEvent.touchStart(screen.getByTestId("target"), touch(100, 100));
        unmount();
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS * 2));
        expect(second).toHaveBeenCalledOnce();
        fireEvent.scroll(document.body);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("clears the window for the click when the row goes", () => {
        const { unmount } = render(<Target onLongPress={vi.fn()} />);
        const target = screen.getByTestId("target");
        fireEvent.touchStart(target, touch(100, 100));
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
        fireEvent.touchEnd(target);
        expect(vi.getTimerCount()).toBe(1);

        unmount();

        expect(vi.getTimerCount()).toBe(0);
    });

    it("starts afresh when another finger goes down while the window for a click is open", () => {
        const onLongPress = vi.fn();
        render(<Target onLongPress={onLongPress} />);
        const target = screen.getByTestId("target");
        fireEvent.touchStart(target, touch(100, 100));
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));
        fireEvent.touchEnd(target);

        fireEvent.touchStart(target, touch(100, 100));
        act(() => void vi.advanceTimersByTime(LONG_PRESS_MS));

        expect(onLongPress).toHaveBeenCalledTimes(2);
    });
});
