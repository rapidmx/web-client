///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it } from "vitest";
import { dueDateInstant, parseDueDate } from "../../../apps/shared/components/tasks/dueDate.js";

const originalTz = process.env.TZ;
afterEach(() => {
    process.env.TZ = originalTz;
});

describe("task due dates", () => {
    it("stores a date-only due date as UTC midnight", () => {
        expect(dueDateInstant("2026-06-17")).toBe("2026-06-17T00:00:00.000Z");
    });

    it("reads a date-only due date as the same calendar day in any zone", () => {
        for (const zone of ["Australia/Sydney", "America/Los_Angeles", "UTC"]) {
            process.env.TZ = zone;
            const due = parseDueDate(dueDateInstant("2026-06-17"));
            expect([due.getFullYear(), due.getMonth(), due.getDate(), due.getHours()]).toEqual([2026, 5, 17, 0]);
        }
    });

    it("reads any other instant as itself, an older version's local-midnight value included", () => {
        process.env.TZ = "Australia/Sydney";
        expect(parseDueDate("2026-06-16T14:00:00.000Z").toISOString()).toBe("2026-06-16T14:00:00.000Z");
        expect(parseDueDate("2026-06-12T14:30:00.000Z").toISOString()).toBe("2026-06-12T14:30:00.000Z");
    });
});
