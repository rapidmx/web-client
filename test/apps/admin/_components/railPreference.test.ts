// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { RAIL_EXPANDED_KEY, readRailExpanded, writeRailExpanded } from "../../../../apps/shared/components/admin/layout/railPreference.js";

afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
});

describe("the admin rail's preference", () => {
    it("is collapsed until it is expanded, and remembers each choice", () => {
        expect(readRailExpanded()).toBe(false);
        writeRailExpanded(true);
        expect(localStorage.getItem(RAIL_EXPANDED_KEY)).toBe("true");
        expect(readRailExpanded()).toBe(true);
        writeRailExpanded(false);
        expect(readRailExpanded()).toBe(false);
    });

    it("reads anything but true as collapsed", () => {
        localStorage.setItem(RAIL_EXPANDED_KEY, "yes");
        expect(readRailExpanded()).toBe(false);
    });

    it("copes with a browser store that refuses to be read or written", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        expect(readRailExpanded()).toBe(false);
        expect(() => writeRailExpanded(true)).not.toThrow();
    });
});
