///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEADER_HEIGHT_VAR, useHeaderHeightRef } from "../../../apps/shared/notifications/headerOffset.js";

let height = 64;
let observers: Array<{ callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];

function Probe() {
    const ref = useHeaderHeightRef();
    const [shown, setShown] = useState(true);
    return (
        <>
            {shown && <header ref={ref}>bar</header>}
            <button onClick={() => setShown((value) => !value)}>toggle</button>
        </>
    );
}

const value = () => document.documentElement.style.getPropertyValue(HEADER_HEIGHT_VAR);

describe("useHeaderHeightRef", () => {
    beforeEach(() => {
        height = 64;
        observers = [];
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ height, width: 0, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0, toJSON: () => ({}) }));
        document.documentElement.style.removeProperty(HEADER_HEIGHT_VAR);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    function stubObserver() {
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe = vi.fn();
                disconnect = vi.fn();
                constructor(callback: () => void) {
                    observers.push({ callback, observe: this.observe, disconnect: this.disconnect });
                }
            },
        );
    }

    it("publishes the header's height, keeps it current as it resizes and when the window does, and lets go when the header goes", () => {
        stubObserver();
        const { getByText } = render(<Probe />);
        expect(value()).toBe("64px");
        expect(observers).toHaveLength(1);
        expect(observers[0].observe).toHaveBeenCalledTimes(1);

        height = 96;
        act(() => observers[0].callback());
        expect(value()).toBe("96px");

        height = 40;
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });
        expect(value()).toBe("40px");

        act(() => getByText("toggle").click());
        expect(value()).toBe("0px");
        expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
        height = 200;
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });
        expect(value()).toBe("0px");

        act(() => getByText("toggle").click());
        expect(value()).toBe("200px");
    });

    it("works without a ResizeObserver, and a header that never appears is 0", () => {
        vi.stubGlobal("ResizeObserver", undefined);
        const first = render(<Probe />);
        expect(value()).toBe("64px");
        first.unmount();
        // Unmounting takes the header away: the variable does not keep a stale height.
        expect(value()).toBe("0px");
    });
});
