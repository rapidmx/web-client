// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { clearViewedOriginal, isViewedOriginal, useViewOriginal } from "../../../apps/shared/components/mail/reading/viewOriginal.js";

afterEach(() => clearViewedOriginal());

describe("useViewOriginal", () => {
    it("follows the theme until the reader flips it", () => {
        const { result } = renderHook(() => useViewOriginal("m1"));
        expect(result.current[0]).toBe(false);
        expect(isViewedOriginal("m1")).toBe(false);
    });

    it("remembers the choice per message for the session: another render, another mount, another message", () => {
        const first = renderHook(() => useViewOriginal("m1"));
        act(() => first.result.current[1](true));
        expect(first.result.current[0]).toBe(true);
        expect(isViewedOriginal("m1")).toBe(true);
        first.unmount();
        expect(renderHook(() => useViewOriginal("m1")).result.current[0]).toBe(true);
        expect(renderHook(() => useViewOriginal("m2")).result.current[0]).toBe(false);
    });

    it("forgets it when the reader flips back", () => {
        const { result } = renderHook(() => useViewOriginal("m1"));
        act(() => result.current[1](true));
        act(() => result.current[1](false));
        expect(result.current[0]).toBe(false);
        expect(isViewedOriginal("m1")).toBe(false);
    });
});
