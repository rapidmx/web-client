// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { isSelectionClick, isToggleClick, rangeBetween, resolveAnchor } from "../../../apps/shared/mail/rangeSelection.js";

const KEYS = ["a", "b", "c", "d", "e"];

describe("isSelectionClick / isToggleClick", () => {
    it("treats Shift, Ctrl and Cmd as selection clicks and a bare click as none", () => {
        expect(isSelectionClick(undefined)).toBe(false);
        expect(isSelectionClick({})).toBe(false);
        expect(isSelectionClick({ shiftKey: true })).toBe(true);
        expect(isSelectionClick({ ctrlKey: true })).toBe(true);
        expect(isSelectionClick({ metaKey: true })).toBe(true);
    });

    it("toggles a single row for Ctrl and Cmd, not for Shift", () => {
        expect(isToggleClick(undefined)).toBe(false);
        expect(isToggleClick({ shiftKey: true })).toBe(false);
        expect(isToggleClick({ ctrlKey: true })).toBe(true);
        expect(isToggleClick({ metaKey: true, shiftKey: true })).toBe(true);
    });
});

describe("resolveAnchor", () => {
    it("prefers the last clicked row while it is listed", () => {
        expect(resolveAnchor(KEYS, "b", "d")).toBe("b");
    });

    it("falls back to the open row when the anchor is unset or gone from the list", () => {
        expect(resolveAnchor(KEYS, null, "d")).toBe("d");
        expect(resolveAnchor(KEYS, "zzz", "d")).toBe("d");
    });

    it("has no anchor when neither is listed", () => {
        expect(resolveAnchor(KEYS, null, null)).toBeNull();
        expect(resolveAnchor(KEYS, "zzz", "yyy")).toBeNull();
    });
});

describe("rangeBetween", () => {
    it("spans anchor to target inclusive, in display order, whichever was clicked first", () => {
        expect(rangeBetween(KEYS, "b", "d")).toEqual(["b", "c", "d"]);
        expect(rangeBetween(KEYS, "d", "b")).toEqual(["b", "c", "d"]);
        expect(rangeBetween(KEYS, "c", "c")).toEqual(["c"]);
    });

    it("is the target alone without a usable anchor or target", () => {
        expect(rangeBetween(KEYS, null, "c")).toEqual(["c"]);
        expect(rangeBetween(KEYS, "zzz", "c")).toEqual(["c"]);
        expect(rangeBetween(KEYS, "a", "zzz")).toEqual(["zzz"]);
    });
});
