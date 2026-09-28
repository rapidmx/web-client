// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, it, expect } from "vitest";
import { CALENDAR_COLOR_PALETTE, DEFAULT_CALENDAR_COLOR, accentColorForMailbox, colorForFolder } from "../../../lib/calendar/calendarColors.js";

describe("accentColorForMailbox", () => {
    it("is deterministic for the same mailbox uid", () => {
        expect(accentColorForMailbox("mb-shared")).toBe(accentColorForMailbox("mb-shared"));
    });

    it("always returns a palette color other than the default", () => {
        for (const uid of ["a", "mb-1", "mb-2", "support", "0f6c8e2a-1b2c-4d5e-9f00-112233445566"]) {
            const color = accentColorForMailbox(uid);
            expect(CALENDAR_COLOR_PALETTE).toContain(color);
            expect(color).not.toBe(DEFAULT_CALENDAR_COLOR);
        }
    });
});

describe("colorForFolder with a fallback", () => {
    it("uses the fallback for an uncolored folder", () => {
        expect(colorForFolder({ color: undefined }, "#7c3aed")).toBe("#7c3aed");
    });

    it("still prefers the folder's own color over the fallback", () => {
        expect(colorForFolder({ color: "#16a34a" }, "#7c3aed")).toBe("#16a34a");
    });
});

describe("colorForFolder", () => {
    it("returns the folder's own color when set", () => {
        expect(colorForFolder({ color: "#16a34a" })).toBe("#16a34a");
    });

    it("falls back to DEFAULT_CALENDAR_COLOR when the folder has no color", () => {
        expect(colorForFolder({ color: undefined })).toBe(DEFAULT_CALENDAR_COLOR);
    });

    it("falls back to DEFAULT_CALENDAR_COLOR when the folder's color is an empty string", () => {
        expect(colorForFolder({ color: "" })).toBe(DEFAULT_CALENDAR_COLOR);
    });

    it("DEFAULT_CALENDAR_COLOR is the palette's first entry", () => {
        expect(DEFAULT_CALENDAR_COLOR).toBe(CALENDAR_COLOR_PALETTE[0]);
    });
});
