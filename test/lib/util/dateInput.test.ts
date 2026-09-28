// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { toDatetimeLocal } from "../../../lib/util/dateInput.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("toDatetimeLocal", () => {
    it("formats a UTC instant as a timezone-suffix-less local datetime string", () => {
        vi.stubGlobal(
            "Date",
            class extends Date {
                getTimezoneOffset() {
                    return 0;
                }
            },
        );
        expect(toDatetimeLocal("2026-06-15T19:30:00.000Z")).toBe("2026-06-15T19:30");
    });

    it("shifts by the browser's own timezone offset", () => {
        vi.stubGlobal(
            "Date",
            class extends Date {
                getTimezoneOffset() {
                    return 300; // UTC-5
                }
            },
        );
        expect(toDatetimeLocal("2026-06-15T19:30:00.000Z")).toBe("2026-06-15T14:30");
    });
});
