// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { ApiRequestError, createApiClient } from "../../../lib/util/api.js";
import {
    FreeBusyResponse,
    PersonAvailability,
    availabilityDuring,
    availabilityOf,
    getFreeBusy,
    suggestTimes,
    summarizeAvailability,
    withoutOwnBlock,
} from "../../../lib/calendar/freeBusyApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

const HOUR = 3_600_000;
const t = (iso: string) => Date.parse(iso);

describe("getFreeBusy", () => {
    it("POSTs the addresses and the window as ISO instants", async () => {
        const answer: FreeBusyResponse = { start: "2026-06-16T00:00:00.000Z", end: "2026-06-17T00:00:00.000Z", results: [] };
        const fetchMock = mockFetch(() => jsonResponse(200, answer));
        const result = await getFreeBusy(["a@example.com", "b@example.com"], new Date("2026-06-16T00:00:00Z"), "2026-06-17T00:00:00.000Z");
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/free-busy", expect.anything());
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe("POST");
        expect(JSON.parse(init.body as string)).toEqual({
            addresses: ["a@example.com", "b@example.com"],
            start: "2026-06-16T00:00:00.000Z",
            end: "2026-06-17T00:00:00.000Z",
        });
        expect(result).toEqual(answer);
    });

    it("passes on a Date end as an ISO instant too, and rejects with the server's error", async () => {
        const fetchMock = mockFetch(() => jsonResponse(429, { message: "Slow down" }));
        await expect(getFreeBusy(["a@example.com"], "2026-06-16T00:00:00.000Z", new Date("2026-06-17T00:00:00Z"))).rejects.toBeInstanceOf(ApiRequestError);
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).end).toBe("2026-06-17T00:00:00.000Z");
    });
});

function person(address: string, busy: [string, string, boolean?][], status: PersonAvailability["status"] = "available"): PersonAvailability {
    return { address, status, busy: busy.map(([start, end, tentative]) => ({ startMs: t(start), endMs: t(end), tentative: !!tentative })) };
}

describe("availabilityOf", () => {
    it("turns each result's windows into milliseconds, and gives a person who is not available none", () => {
        const people = availabilityOf({
            start: "2026-06-16T00:00:00.000Z",
            end: "2026-06-17T00:00:00.000Z",
            results: [
                { address: "a@example.com", status: "available", busy: [{ start: "2026-06-16T09:00:00.000Z", end: "2026-06-16T10:00:00.000Z", tentative: true }] },
                { address: "b@example.com", status: "restricted", busy: [{ start: "2026-06-16T09:00:00.000Z", end: "2026-06-16T10:00:00.000Z", tentative: false }] },
                { address: "c@example.com", status: "unknown", busy: [] },
            ],
        });
        expect(people).toEqual([
            { address: "a@example.com", status: "available", busy: [{ startMs: t("2026-06-16T09:00:00Z"), endMs: t("2026-06-16T10:00:00Z"), tentative: true }] },
            { address: "b@example.com", status: "restricted", busy: [] },
            { address: "c@example.com", status: "unknown", busy: [] },
        ]);
    });
});

describe("availabilityDuring", () => {
    const a = person("a@example.com", [
        ["2026-06-16T09:00:00Z", "2026-06-16T10:00:00Z"],
        ["2026-06-16T11:00:00Z", "2026-06-16T12:00:00Z", true],
    ]);

    it("is busy where a firm block overlaps, tentative where only a tentative one does, and free where none does", () => {
        expect(availabilityDuring(a, t("2026-06-16T09:30:00Z"), t("2026-06-16T10:30:00Z"))).toBe("busy");
        expect(availabilityDuring(a, t("2026-06-16T11:30:00Z"), t("2026-06-16T12:30:00Z"))).toBe("tentative");
        expect(availabilityDuring(a, t("2026-06-16T09:30:00Z"), t("2026-06-16T11:30:00Z"))).toBe("busy");
        expect(availabilityDuring(a, t("2026-06-16T10:00:00Z"), t("2026-06-16T11:00:00Z"))).toBe("free");
        expect(availabilityDuring(a, t("2026-06-16T13:00:00Z"), t("2026-06-16T14:00:00Z"))).toBe("free");
    });

    it("is unknown - never free - for anyone the server did not tell about", () => {
        expect(availabilityDuring(person("x@example.com", [], "unknown"), 0, HOUR)).toBe("unknown");
        expect(availabilityDuring(person("y@example.com", [], "restricted"), 0, HOUR)).toBe("unknown");
    });
});

describe("summarizeAvailability", () => {
    it("counts the free, the busy, the tentative and the unknown separately", () => {
        const people = [
            person("a@example.com", []),
            person("b@example.com", [["2026-06-16T09:00:00Z", "2026-06-16T10:00:00Z"]]),
            person("c@example.com", [["2026-06-16T09:00:00Z", "2026-06-16T10:00:00Z", true]]),
            person("d@example.com", [], "unknown"),
            person("e@example.com", [], "restricted"),
        ];
        expect(summarizeAvailability(people, t("2026-06-16T09:00:00Z"), t("2026-06-16T09:30:00Z"))).toEqual({ free: 1, conflicts: 2, tentative: 1, unknown: 2 });
    });
});

describe("withoutOwnBlock", () => {
    it("removes only the exact block of the event itself, from the people named", () => {
        const own: [string, string] = ["2026-06-16T09:00:00Z", "2026-06-16T10:00:00Z"];
        const people = [
            person("A@example.com", [own, ["2026-06-16T13:00:00Z", "2026-06-16T14:00:00Z"]]),
            person("b@example.com", [["2026-06-16T08:30:00Z", "2026-06-16T10:00:00Z"]]),
            person("c@example.com", [own]),
        ];
        const result = withoutOwnBlock(people, new Set(["a@example.com", "b@example.com"]), t(own[0]), t(own[1]));
        expect(result[0].busy).toEqual([{ startMs: t("2026-06-16T13:00:00Z"), endMs: t("2026-06-16T14:00:00Z"), tentative: false }]);
        // Merged with something else, so it is not the event's own block: kept.
        expect(result[1].busy).toHaveLength(1);
        // Not named: untouched.
        expect(result[2]).toBe(people[2]);
    });
});

describe("suggestTimes", () => {
    const window = { startMs: t("2026-06-16T08:00:00Z"), endMs: t("2026-06-16T12:00:00Z") };

    it("finds the first slots of the duration where every known person is free, 30 minutes apart by default, five at most", () => {
        const people = [person("a@example.com", [["2026-06-16T08:00:00Z", "2026-06-16T09:00:00Z"]]), person("b@example.com", [["2026-06-16T09:30:00Z", "2026-06-16T10:00:00Z", true]])];
        const found = suggestTimes(people, { windows: [window], durationMs: HOUR });
        expect(found.map((ms) => new Date(ms).toISOString())).toEqual(["2026-06-16T10:00:00.000Z", "2026-06-16T10:30:00.000Z", "2026-06-16T11:00:00.000Z"]);
        expect(suggestTimes([person("c@example.com", [])], { windows: [window], durationMs: 30 * 60_000 })).toHaveLength(5);
    });

    it("takes a step and a limit, the windows in any order, and skips what starts before notBeforeMs", () => {
        const later = { startMs: t("2026-06-17T08:00:00Z"), endMs: t("2026-06-17T09:00:00Z") };
        const found = suggestTimes([person("a@example.com", [])], {
            windows: [later, window],
            durationMs: HOUR,
            stepMs: HOUR,
            limit: 3,
            notBeforeMs: t("2026-06-16T09:00:00Z"),
        });
        expect(found.map((ms) => new Date(ms).toISOString())).toEqual(["2026-06-16T09:00:00.000Z", "2026-06-16T10:00:00.000Z", "2026-06-16T11:00:00.000Z"]);
        expect(suggestTimes([person("a@example.com", [])], { windows: [later, window], durationMs: HOUR, stepMs: HOUR, limit: 4, notBeforeMs: t("2026-06-16T11:00:00Z") })).toHaveLength(2);
    });

    it("does not let people it cannot see decide, and offers nothing when it can see nobody", () => {
        const people = [person("a@example.com", []), person("b@example.com", [], "restricted")];
        expect(suggestTimes(people, { windows: [window], durationMs: HOUR, limit: 1 })).toEqual([window.startMs]);
        expect(suggestTimes([person("b@example.com", [], "restricted"), person("c@example.com", [], "unknown")], { windows: [window], durationMs: HOUR })).toEqual([]);
        expect(suggestTimes([], { windows: [window], durationMs: HOUR })).toEqual([]);
    });

    it("finds nothing for a duration that is not positive or longer than every window", () => {
        expect(suggestTimes([person("a@example.com", [])], { windows: [window], durationMs: 0 })).toEqual([]);
        expect(suggestTimes([person("a@example.com", [])], { windows: [window], durationMs: 5 * HOUR })).toEqual([]);
        expect(suggestTimes([person("a@example.com", [["2026-06-16T08:00:00Z", "2026-06-16T12:00:00Z"]])], { windows: [window], durationMs: HOUR })).toEqual([]);
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const answer: FreeBusyResponse = { start: "2026-06-16T00:00:00.000Z", end: "2026-06-17T00:00:00.000Z", results: [] };
        const fetchMock = mockFetch(() => jsonResponse(200, answer));

        await getFreeBusy(["a@example.com"], "2026-06-16T00:00:00.000Z", "2026-06-17T00:00:00.000Z", client);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const answer: FreeBusyResponse = { start: "2026-06-16T00:00:00.000Z", end: "2026-06-17T00:00:00.000Z", results: [] };
        const fetchMock = mockFetch(() => jsonResponse(200, answer));

        await getFreeBusy(["a@example.com"], "2026-06-16T00:00:00.000Z", "2026-06-17T00:00:00.000Z");

        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/free-busy", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});

describe("free/busy helpers fail closed", () => {
    it("treats a busy window whose date can't be read as busy for all time, not as free", () => {
        const [a] = availabilityOf({
            start: "2026-06-16T00:00:00.000Z",
            end: "2026-06-17T00:00:00.000Z",
            results: [
                {
                    address: "a@example.com",
                    status: "available",
                    busy: [
                        { start: "not a date", end: "2026-06-16T10:00:00.000Z", tentative: false },
                        { start: "2026-06-16T09:00:00.000Z", end: "", tentative: true },
                    ],
                },
            ],
        });
        expect(availabilityDuring(a, t("2026-06-16T12:00:00Z"), t("2026-06-16T13:00:00Z"))).toBe("busy");
        expect(a.busy[1]).toEqual({ startMs: -Infinity, endMs: Infinity, tentative: true });
    });

    it("never loops forever on a step that does not advance, and takes a minute as the finest step", () => {
        const window = { startMs: t("2026-06-16T08:00:00Z"), endMs: t("2026-06-16T09:00:00Z") };
        const people = [person("a@example.com", [])];
        for (const stepMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(suggestTimes(people, { windows: [window], durationMs: 30 * 60_000, stepMs, limit: 100 }).length).toBeGreaterThan(0);
        }
        expect(suggestTimes(people, { windows: [window], durationMs: 30 * 60_000, stepMs: 1, limit: 100 })).toHaveLength(31);
        expect(suggestTimes(people, { windows: [window], durationMs: 30 * 60_000, stepMs: Number.NaN, limit: 100 })).toHaveLength(2);
    });
});
