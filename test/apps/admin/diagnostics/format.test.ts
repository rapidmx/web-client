// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    describeError,
    ELEVATION_MESSAGE,
    formatBytes,
    formatCores,
    formatDateTime,
    formatPercent,
    formatUptime,
    isPermissionError,
    NO_VALUE,
    NOT_AUTHORISED_MESSAGE,
    percentOf,
    shortDigest,
} from "../../../../apps/shared/components/admin/diagnostics/format.js";

describe("formatBytes", () => {
    it("writes binary units with one decimal, none from 100 up", () => {
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(512)).toBe("512 B");
        expect(formatBytes(1536)).toBe("1.5 KiB");
        expect(formatBytes(200 * 1024 * 1024)).toBe("200 MiB");
        expect(formatBytes(3.25 * 1024 ** 3)).toBe("3.3 GiB");
        expect(formatBytes(-2048)).toBe("-2.0 KiB");
    });

    it("stops at PiB", () => {
        expect(formatBytes(1e18)).toBe("888 PiB");
    });

    it("writes a dash for a missing or non-finite number", () => {
        expect(formatBytes(undefined)).toBe(NO_VALUE);
        expect(formatBytes(Number.NaN)).toBe(NO_VALUE);
        expect(formatBytes("12" as unknown as number)).toBe(NO_VALUE);
    });
});

describe("formatCores", () => {
    it("writes cores, singular for one, two decimals at most", () => {
        expect(formatCores(0)).toBe("0 cores");
        expect(formatCores(0.25)).toBe("0.25 cores");
        expect(formatCores(1)).toBe("1 core");
        expect(formatCores(0.999)).toBe("1 core");
        expect(formatCores(1.5)).toBe("1.5 cores");
        expect(formatCores(12.4)).toBe("12 cores");
        expect(formatCores(undefined)).toBe(NO_VALUE);
    });
});

describe("formatPercent and percentOf", () => {
    it("writes one decimal", () => {
        expect(formatPercent(42.34)).toBe("42.3%");
        expect(formatPercent(undefined)).toBe(NO_VALUE);
    });

    it("divides, and refuses a missing figure or a capacity that is not positive", () => {
        expect(percentOf(1, 4)).toBe(25);
        expect(percentOf(undefined, 4)).toBeUndefined();
        expect(percentOf(1, undefined)).toBeUndefined();
        expect(percentOf(1, 0)).toBeUndefined();
    });
});

describe("formatUptime", () => {
    it("writes the two largest units that are not zero", () => {
        expect(formatUptime(0)).toBe("0s");
        expect(formatUptime(5.9)).toBe("5s");
        expect(formatUptime(65)).toBe("1m 5s");
        expect(formatUptime(3700)).toBe("1h 1m");
        expect(formatUptime(3 * 86400 + 4 * 3600 + 30)).toBe("3d 4h");
        expect(formatUptime(86400)).toBe("1d 0h");
    });

    it("writes a dash for a missing or negative number", () => {
        expect(formatUptime(undefined)).toBe(NO_VALUE);
        expect(formatUptime(-1)).toBe(NO_VALUE);
    });
});

describe("formatDateTime and shortDigest", () => {
    it("writes a date for the viewer, a missing one as a dash and an unreadable one as it came", () => {
        expect(formatDateTime("2026-09-26T10:00:00.000Z")).toBe(new Date("2026-09-26T10:00:00.000Z").toLocaleString());
        expect(formatDateTime(undefined)).toBe(NO_VALUE);
        expect(formatDateTime("yesterday")).toBe("yesterday");
    });

    it("cuts a digest to twelve characters without its algorithm", () => {
        expect(shortDigest("sha256:0123456789abcdef0123")).toBe("0123456789ab");
        expect(shortDigest("0123456789abcdef")).toBe("0123456789ab");
        expect(shortDigest(undefined)).toBe(NO_VALUE);
    });
});

describe("describeError and isPermissionError", () => {
    it("says elevation is needed for api-104", () => {
        expect(describeError(new ApiRequestError("Requires elevation.", 403, "api-104"), "x")).toBe(ELEVATION_MESSAGE);
    });

    it("says the caller is not authorised for any other 403 and for 401", () => {
        expect(describeError(new ApiRequestError("no", 403, "api-103"), "x")).toBe(NOT_AUTHORISED_MESSAGE);
        expect(describeError(new ApiRequestError("no", 401), "x")).toBe(NOT_AUTHORISED_MESSAGE);
        expect(isPermissionError(new ApiRequestError("no", 403))).toBe(true);
        expect(isPermissionError(new ApiRequestError("no", 401))).toBe(true);
    });

    it("uses the server's message for another API error, else the fallback", () => {
        expect(describeError(new ApiRequestError("Kubernetes is down.", 502), "x")).toBe("Kubernetes is down.");
        expect(describeError(new ApiRequestError("", 500), "fallback")).toBe("fallback");
        expect(describeError(new Error("boom"), "fallback")).toBe("fallback");
        expect(isPermissionError(new ApiRequestError("no", 500))).toBe(false);
        expect(isPermissionError(new Error("boom"))).toBe(false);
    });
});
