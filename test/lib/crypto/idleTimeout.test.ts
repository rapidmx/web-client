// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_IDLE_TIMEOUT_MINUTES, getIdleTimeoutMinutes, setIdleTimeoutMinutes } from "../../../lib/crypto/idleTimeout.js";

afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
});

describe("getIdleTimeoutMinutes / setIdleTimeoutMinutes", () => {
    it("defaults to DEFAULT_IDLE_TIMEOUT_MINUTES when nothing has been configured", () => {
        expect(getIdleTimeoutMinutes()).toBe(DEFAULT_IDLE_TIMEOUT_MINUTES);
    });

    it("round-trips a set value", () => {
        setIdleTimeoutMinutes(15);
        expect(getIdleTimeoutMinutes()).toBe(15);
    });

    it("round-trips 0 (disabled), distinct from 'never configured'", () => {
        setIdleTimeoutMinutes(0);
        expect(getIdleTimeoutMinutes()).toBe(0);
    });

    it("falls back to the default for a corrupted (non-numeric) stored value", () => {
        localStorage.setItem("rapidmx:idle-timeout-minutes", "not-a-number");
        expect(getIdleTimeoutMinutes()).toBe(DEFAULT_IDLE_TIMEOUT_MINUTES);
    });

    it("falls back to the default for a negative stored value", () => {
        localStorage.setItem("rapidmx:idle-timeout-minutes", "-5");
        expect(getIdleTimeoutMinutes()).toBe(DEFAULT_IDLE_TIMEOUT_MINUTES);
    });

    it("falls back to the default when localStorage.getItem throws (e.g. storage-blocked context)", () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("storage blocked");
        });
        expect(getIdleTimeoutMinutes()).toBe(DEFAULT_IDLE_TIMEOUT_MINUTES);
    });

    it("swallows a localStorage.setItem failure rather than throwing", () => {
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("storage blocked");
        });
        expect(() => setIdleTimeoutMinutes(30)).not.toThrow();
    });
});
