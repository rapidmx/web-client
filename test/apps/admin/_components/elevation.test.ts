// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    ELEVATION_ATTEMPT_KEY,
    ELEVATION_REQUIRED_CODE,
    ELEVATION_RETRY_WINDOW_MS,
    clearElevationAttempt,
    elevationAttemptedRecently,
    elevationUrl,
    isElevationRequired,
    recordElevationAttempt,
} from "../../../../apps/shared/components/admin/elevation.js";

afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
});

/** Makes every `sessionStorage` access throw, as it does with site data blocked. */
function blockStorage() {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
        vi.spyOn(Storage.prototype, method).mockImplementation(() => {
            throw new DOMException("blocked", "SecurityError");
        });
    }
}

describe("isElevationRequired", () => {
    it("is true only for a 403 with the elevation-required code", () => {
        expect(ELEVATION_REQUIRED_CODE).toBe("api-104");
        expect(isElevationRequired(new ApiRequestError("Requires elevation.", 403, "api-104"))).toBe(true);
    });

    it("is false for api-103 (elevated, but not an administrator), other codes and other statuses", () => {
        expect(isElevationRequired(new ApiRequestError("No.", 403, "api-103"))).toBe(false);
        expect(isElevationRequired(new ApiRequestError("No.", 403))).toBe(false);
        expect(isElevationRequired(new ApiRequestError("No.", 401, "api-104"))).toBe(false);
        expect(isElevationRequired(new ApiRequestError("No.", 500, "api-104"))).toBe(false);
    });

    it("is false for anything that is not an ApiRequestError", () => {
        expect(isElevationRequired(new TypeError("network down"))).toBe(false);
        expect(isElevationRequired({ status: 403, code: "api-104" })).toBe(false);
        expect(isElevationRequired(undefined)).toBe(false);
    });
});

describe("elevationUrl", () => {
    it("points at auth-server's elevate page with the encoded return_to", () => {
        expect(elevationUrl("https://auth.example.com", "https://mail.example.com/admin/domains?x=1&y=2#top")).toBe(
            `https://auth.example.com/auth/elevate?return_to=${encodeURIComponent("https://mail.example.com/admin/domains?x=1&y=2#top")}`,
        );
    });
});

describe("elevation attempt marker", () => {
    it("is not recent before anything is recorded", () => {
        expect(elevationAttemptedRecently()).toBe(false);
    });

    it("stores a timestamp and reports it as recent inside the retry window only", () => {
        recordElevationAttempt(1_000_000);
        expect(sessionStorage.getItem(ELEVATION_ATTEMPT_KEY)).toBe("1000000");

        expect(elevationAttemptedRecently(1_000_000)).toBe(true);
        expect(elevationAttemptedRecently(1_000_000 + ELEVATION_RETRY_WINDOW_MS - 1)).toBe(true);
        expect(elevationAttemptedRecently(1_000_000 + ELEVATION_RETRY_WINDOW_MS)).toBe(false);
    });

    it("records the current time by default", () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(5_000_000);
        recordElevationAttempt();
        expect(sessionStorage.getItem(ELEVATION_ATTEMPT_KEY)).toBe("5000000");
        expect(elevationAttemptedRecently()).toBe(true);
        now.mockReturnValue(5_000_000 + ELEVATION_RETRY_WINDOW_MS);
        expect(elevationAttemptedRecently()).toBe(false);
    });

    it("ignores a record from the future (clock change) and one that isn't a time", () => {
        sessionStorage.setItem(ELEVATION_ATTEMPT_KEY, "2000000");
        expect(elevationAttemptedRecently(1_000_000)).toBe(false);
        sessionStorage.setItem(ELEVATION_ATTEMPT_KEY, "yesterday");
        expect(elevationAttemptedRecently(1_000_000)).toBe(false);
    });

    it("clears the record", () => {
        recordElevationAttempt();
        clearElevationAttempt();
        expect(sessionStorage.getItem(ELEVATION_ATTEMPT_KEY)).toBeNull();
        expect(elevationAttemptedRecently()).toBe(false);
    });

    it("works, without throwing, when storage is unavailable - nothing is ever remembered", () => {
        blockStorage();
        expect(() => recordElevationAttempt()).not.toThrow();
        expect(elevationAttemptedRecently()).toBe(false);
        expect(() => clearElevationAttempt()).not.toThrow();
    });
});
