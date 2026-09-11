// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import PopoverPortal from "../../../apps/shared/components/mail/compose/PopoverPortal.js";

function mockRect(el: HTMLElement, rect: Partial<DOMRect>) {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
        top: 0,
        left: 0,
        bottom: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
        ...rect,
    });
}

function Harness({ onClose = vi.fn(), width = 100, height = 100 }: { onClose?: () => void; width?: number; height?: number }) {
    const anchorRef = useRef<HTMLButtonElement>(null);
    return (
        <div>
            <button ref={anchorRef} type="button">
                anchor
            </button>
            <PopoverPortal anchorRef={anchorRef} onClose={onClose} width={width} height={height} aria-label="Test popover">
                <span>popover content</span>
            </PopoverPortal>
        </div>
    );
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("PopoverPortal", () => {
    it("renders into document.body, outside the component tree it's mounted from.", () => {
        const { container } = render(<Harness />);

        const popover = screen.getByRole("dialog", { name: "Test popover" });
        expect(container.contains(popover)).toBe(false);
        expect(document.body.contains(popover)).toBe(true);
    });

});

describe("PopoverPortal positioning", () => {
    function HarnessWithRect({
        rect,
        onClose = vi.fn(),
    }: {
        rect: Partial<DOMRect>;
        onClose?: () => void;
    }) {
        const anchorRef = useRef<HTMLButtonElement>(null);
        React.useLayoutEffect(() => {
            if (anchorRef.current) {
                mockRect(anchorRef.current, rect);
            }
        }, []);
        return (
            <div>
                <button ref={anchorRef} type="button">
                    anchor
                </button>
                <PopoverPortal anchorRef={anchorRef} onClose={onClose} width={200} height={200} aria-label="Test popover">
                    <span>popover content</span>
                </PopoverPortal>
            </div>
        );
    }

    it("opens below the anchor when there's enough room in the viewport.", () => {
        vi.stubGlobal("innerHeight", 1000);
        vi.stubGlobal("innerWidth", 1000);
        render(<HarnessWithRect rect={{ top: 100, bottom: 130, left: 50 }} />);

        const popover = screen.getByRole("dialog", { name: "Test popover" });
        expect(popover.style.top).toBe("136px");
        expect(popover.style.left).toBe("50px");
    });

    it("flips above the anchor when there isn't enough room below in the viewport.", () => {
        vi.stubGlobal("innerHeight", 500);
        vi.stubGlobal("innerWidth", 1000);
        render(<HarnessWithRect rect={{ top: 450, bottom: 480, left: 50 }} />);

        const popover = screen.getByRole("dialog", { name: "Test popover" });
        // top - height - gap = 450 - 200 - 6 = 244
        expect(popover.style.top).toBe("244px");
    });

    it("clamps horizontally so the popover never overflows the right edge of the viewport.", () => {
        vi.stubGlobal("innerHeight", 1000);
        vi.stubGlobal("innerWidth", 300);
        render(<HarnessWithRect rect={{ top: 100, bottom: 130, left: 280 }} />);

        const popover = screen.getByRole("dialog", { name: "Test popover" });
        // innerWidth(300) - width(200) - margin(8) = 92
        expect(popover.style.left).toBe("92px");
    });

    it("calls onClose on an outside pointerdown, but not one on the anchor or the popover itself.", async () => {
        vi.stubGlobal("innerHeight", 1000);
        vi.stubGlobal("innerWidth", 1000);
        const onClose = vi.fn();
        const user = userEvent.setup();
        render(<HarnessWithRect rect={{ top: 100, bottom: 130, left: 50 }} onClose={onClose} />);

        await user.click(screen.getByText("anchor"));
        expect(onClose).not.toHaveBeenCalled();

        await user.click(screen.getByText("popover content"));
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.pointerDown(document.body);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("renders nothing until the anchor's rect has been measured.", () => {
        function NullAnchorHarness() {
            const anchorRef = useRef<HTMLButtonElement>(null);
            return <PopoverPortal anchorRef={anchorRef} onClose={vi.fn()} width={100} height={100} aria-label="Never shown" />;
        }
        render(<NullAnchorHarness />);
        expect(screen.queryByRole("dialog", { name: "Never shown" })).not.toBeInTheDocument();
    });
});
