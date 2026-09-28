// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import { CalendarOccurrence, expandOccurrences } from "../../../lib/calendar/recurrence.js";
import {
    deleteEventOccurrence,
    deleteEventSeries,
    detachOccurrence,
    moveOccurrence,
    resizeOccurrenceEnd,
    saveEventSeries,
} from "../../../lib/calendar/calendarMutations.js";
import type { ApiClient } from "../../../lib/util/api.js";

/** A minimal `ApiClient` whose own `fetch()` is a plain mock, distinct from the global `fetch()` the
 * default (no-client) path uses - lets a test assert an explicit client's calls never touch the global one. */
function fakeApiClient(impl: (path: string, init?: RequestInit) => unknown = () => undefined): ApiClient & { fetch: ReturnType<typeof vi.fn> } {
    const fetch = vi.fn((path: string, init?: RequestInit) => Promise.resolve().then(() => impl(path, init)));
    return { fetch, setUnauthorizedObserver: vi.fn() } as unknown as ApiClient & { fetch: typeof fetch };
}

function occurrence(overrides: Partial<CalendarOccurrence> = {}): CalendarOccurrence {
    return {
        uid: "e1",
        version: 2,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        title: "Standup",
        startDate: "2026-06-03T15:00:00.000Z",
        endDate: "2026-06-03T15:30:00.000Z",
        allDay: false,
        timezone: "UTC",
        organizer: { address: "jane@example.com", type: "to" },
        attendees: [],
        status: "confirmed",
        busyStatus: "busy",
        icalUid: "abc",
        sequence: 0,
        recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO", "WE"], exceptions: [] },
        recurrenceId: "2026-06-03T15:00:00.000Z",
        occurrenceKey: "e1::2026-06-03T15:00:00.000Z",
        isRecurringOccurrence: true,
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("saveEventSeries", () => {
    it("PUTs the edited fields onto the master event", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, occurrence({ title: "Renamed" })));
        const result = await saveEventSeries(occurrence(), { title: "Renamed" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/e1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ uid: "e1", version: 2, title: "Renamed" }) }),
        );
        expect(result.title).toBe("Renamed");
    });

    // Round-4 review: moving a series left its exceptions (and detached occurrences' recurrenceIds) at the
    // old occurrence starts - a deleted occurrence reappeared and the override pairing broke.
    describe("when the series start moves", () => {
        const master = occurrence({
            startDate: "2026-06-01T13:00:00.000Z", // Mon 09:00 EDT
            endDate: "2026-06-01T13:30:00.000Z",
            timezone: "America/New_York",
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: ["2026-06-08T13:00:00.000Z", "2026-11-02T14:00:00.000Z"] },
            recurrenceId: undefined,
        });
        const detached = occurrence({ uid: "d1", version: 4, recurrenceRule: undefined, recurrenceId: "2026-11-09T14:00:00.000Z", startDate: "2026-11-10T20:00:00.000Z" });

        function routes(overrides: { listFails?: boolean; detachedPutFails?: boolean; events?: unknown[] } = {}) {
            return mockFetch((url, init) => {
                if (url === "/api/mail/calendar-events/e1" && !init?.method) return jsonResponse(200, master);
                if (url.startsWith("/api/mail/calendar-events?")) {
                    return overrides.listFails
                        ? jsonResponse(500, { message: "boom" })
                        : jsonResponse(200, overrides.events ?? [master, detached, occurrence({ uid: "other", icalUid: "zzz", recurrenceId: "2026-06-08T13:00:00.000Z" })]);
                }
                if (url === "/api/mail/calendar-events/e1" && init?.method === "PUT") return jsonResponse(200, { ...master, ...JSON.parse(init.body as string) });
                if (url === "/api/mail/calendar-events/d1" && init?.method === "PUT") {
                    return overrides.detachedPutFails ? jsonResponse(409, { message: "conflict" }) : jsonResponse(200, detached);
                }
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });
        }

        const putBody = (fetchMock: ReturnType<typeof mockFetch>, uid: string) =>
            JSON.parse(fetchMock.mock.calls.find(([url, init]) => url === `/api/mail/calendar-events/${uid}` && init?.method === "PUT")![1]!.body as string);

        it("shifts exceptions and detached occurrences' recurrenceIds by the same wall-clock delta, across DST", async () => {
            const fetchMock = routes();
            // 09:00 -> 10:30 local: +1h30 wall clock, which is 14:30Z in summer but 15:30Z in winter.
            const result = await saveEventSeries(occurrence(), { startDate: "2026-06-01T14:30:00.000Z", endDate: "2026-06-01T15:00:00.000Z" });

            expect(putBody(fetchMock, "e1")).toMatchObject({
                uid: "e1",
                version: 2,
                startDate: "2026-06-01T14:30:00.000Z",
                recurrenceRule: { freq: "weekly", exceptions: ["2026-06-08T14:30:00.000Z", "2026-11-02T15:30:00.000Z"] },
            });
            expect(putBody(fetchMock, "d1")).toEqual({ uid: "d1", version: 4, recurrenceId: "2026-11-09T15:30:00.000Z" });
            expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(2);
            expect(result).not.toHaveProperty("detachedOccurrenceSyncFailed");
        });

        it("shifts in UTC for an all-day series converted to timed, and prefers the edited rule's own exceptions", async () => {
            const allDayMaster = { ...master, allDay: true, startDate: "2026-06-01T00:00:00.000Z", endDate: "2026-06-02T00:00:00.000Z" };
            const fetchMock = mockFetch((url, init) => {
                if (url === "/api/mail/calendar-events/e1" && !init?.method) return jsonResponse(200, allDayMaster);
                if (url.startsWith("/api/mail/calendar-events?")) return jsonResponse(200, []);
                return jsonResponse(200, allDayMaster);
            });
            await saveEventSeries(occurrence(), {
                allDay: false,
                startDate: "2026-06-01T13:00:00.000Z", // 09:00 EDT on the same date
                recurrenceRule: { freq: "weekly", interval: 1, exceptions: ["2026-12-07T00:00:00.000Z"] },
            });
            expect(putBody(fetchMock, "e1").recurrenceRule.exceptions).toEqual(["2026-12-07T14:00:00.000Z"]); // 09:00 EST
        });

        // Round-5 review: an exception for an occurrence pushed forward by a DST gap was shifted by its pushed
        // instant, not the rule's wall-clock time, so the deleted occurrence reappeared after the move.
        it("shifts a DST-gap exception by the rule's wall-clock time, so it still matches the moved rule's occurrence", async () => {
            const gapMaster = {
                ...master,
                startDate: "2026-03-01T07:30:00.000Z", // Sun 02:30 EST
                endDate: "2026-03-01T08:00:00.000Z",
                // 2026-03-08 02:30 doesn't exist in New York; the generated occurrence is 03:30 EDT (07:30Z).
                // 2026-03-15T10:00Z is a hand-made exception no occurrence has (06:00 EDT) - shifted by its own wall time.
                recurrenceRule: { freq: "weekly" as const, interval: 1, byDay: ["SU" as const], exceptions: ["2026-03-08T07:30:00.000Z", "2026-03-15T10:00:00.000Z"] },
            };
            const fetchMock = mockFetch((url, init) => {
                if (url === "/api/mail/calendar-events/e1" && !init?.method) return jsonResponse(200, gapMaster);
                if (url.startsWith("/api/mail/calendar-events?")) return jsonResponse(200, []);
                return jsonResponse(200, { ...gapMaster, ...JSON.parse(init.body as string) });
            });
            const saved = await saveEventSeries(occurrence(), { startDate: "2026-03-01T08:30:00.000Z", endDate: "2026-03-01T09:00:00.000Z" }); // 03:30 EST

            const exceptions: string[] = putBody(fetchMock, "e1").recurrenceRule.exceptions;
            expect(exceptions).toEqual(["2026-03-08T07:30:00.000Z", "2026-03-15T11:00:00.000Z"]);
            // The moved series really does generate (and so now suppresses) the 2026-03-08 occurrence at that instant.
            const generated = expandOccurrences({ ...saved, recurrenceRule: { ...saved.recurrenceRule!, exceptions: [] } }, new Date("2026-03-07T00:00:00Z"), new Date("2026-03-09T00:00:00Z"));
            expect(generated.map((o) => o.startDate)).toEqual(["2026-03-08T07:30:00.000Z"]);
            expect(expandOccurrences(saved, new Date("2026-03-07T00:00:00Z"), new Date("2026-03-09T00:00:00Z"))).toEqual([]);
        });

        it("reports detachedOccurrenceSyncFailed (without throwing) when a detached occurrence can't be updated or listed", async () => {
            routes({ detachedPutFails: true });
            const failedPut = await saveEventSeries(occurrence(), { startDate: "2026-06-01T14:00:00.000Z" });
            expect(failedPut).toMatchObject({ uid: "e1", detachedOccurrenceSyncFailed: true });
            vi.unstubAllGlobals();

            routes({ listFails: true });
            expect((await saveEventSeries(occurrence(), { startDate: "2026-06-01T14:00:00.000Z" })).detachedOccurrenceSyncFailed).toBe(true);
        });

        it("makes one plain PUT when the start doesn't actually move, and sends no rule for a non-recurring master", async () => {
            const fetchMock = routes();
            await saveEventSeries(occurrence(), { startDate: master.startDate, title: "Renamed" });
            expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${url}`)).toEqual([
                "GET /api/mail/calendar-events/e1",
                "PUT /api/mail/calendar-events/e1",
            ]);
            vi.unstubAllGlobals();

            const plain = { ...master, recurrenceRule: undefined };
            const plainFetch = mockFetch((url, init) => {
                if (url.startsWith("/api/mail/calendar-events?")) return jsonResponse(200, []);
                return jsonResponse(200, init?.method ? { ...plain, ...JSON.parse(init.body as string) } : plain);
            });
            await saveEventSeries(occurrence(), { startDate: "2026-06-01T14:00:00.000Z" });
            expect(putBody(plainFetch, "e1")).not.toHaveProperty("recurrenceRule");
        });

        // Round-3 (2nd-round) review: the doc comment above promises a shift on a timezone/allDay change too,
        // but the entry gate only checked `fields.startDate !== undefined` - a timezone- or allDay-only edit (no
        // startDate) silently skipped the shift entirely, sending a bare PUT with no recurrenceRule at all. Not
        // reachable through today's only real caller (web-client's EventModal.tsx always supplies startDate
        // alongside a genuine allDay/timezone change), but this is an exported function of a shared package.
        it("also enters the shift path when only the timezone changes, with no startDate", async () => {
            const tzMaster = {
                ...master,
                recurrenceRule: { freq: "weekly" as const, interval: 1, byDay: ["MO" as const], exceptions: ["2026-06-08T13:00:00.000Z"] },
            };
            const fetchMock = mockFetch((url, init) => {
                if (url === "/api/mail/calendar-events/e1" && !init?.method) return jsonResponse(200, tzMaster);
                if (url.startsWith("/api/mail/calendar-events?")) return jsonResponse(200, []);
                if (url === "/api/mail/calendar-events/e1" && init?.method === "PUT") return jsonResponse(200, { ...tzMaster, ...JSON.parse(init.body as string) });
                throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
            });

            await saveEventSeries(occurrence(), { timezone: "America/Chicago" });

            const methods = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${url}`);
            // Proves the full shift path ran (master fetched, detached occurrences listed) instead of the old
            // silent single-PUT skip.
            expect(methods[0]).toBe("GET /api/mail/calendar-events/e1");
            expect(methods.some((m) => m.startsWith("GET /api/mail/calendar-events?"))).toBe(true);
            expect(methods.filter((m) => m.startsWith("PUT"))).toHaveLength(1);

            const body = putBody(fetchMock, "e1");
            expect(body.timezone).toBe("America/Chicago");
            // New York and Chicago are both in DST in June, exactly one hour apart, so the wall-clock
            // reinterpretation delta this reinterpretation produces (-1h) exactly cancels out for a plain
            // weekly exception with no DST edge - the shifted instant equals the original. What matters is
            // that `recurrenceRule` is present at all here, where the unfixed code sent none.
            expect(body.recurrenceRule.exceptions).toEqual(["2026-06-08T13:00:00.000Z"]);
        });
    });
});

describe("detachOccurrence", () => {
    it("adds an exception to the master and creates a standalone event with the edited fields", async () => {
        const created = occurrence({ uid: "e2", title: "Renamed", recurrenceRule: undefined, occurrenceKey: "e2", isRecurringOccurrence: false });
        const fetchMock = mockFetch((url, init) => {
            if (url === "/api/mail/calendar-events/e1" && init?.method === "PUT") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...occurrence(), recurrenceRule: body.recurrenceRule });
            }
            if (url === "/api/mail/calendar-events" && init?.method === "POST") {
                return jsonResponse(200, created);
            }
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });

        const result = await detachOccurrence(occurrence(), { title: "Renamed" });

        // The master's exceptions list grew by exactly the detached occurrence's original start.
        const putCall = fetchMock.mock.calls.find((c) => c[0] === "/api/mail/calendar-events/e1")!;
        const putBody = JSON.parse((putCall[1] as RequestInit).body as string);
        expect(putBody.recurrenceRule.exceptions).toEqual(["2026-06-03T15:00:00.000Z"]);

        // The new standalone event carries the master's own fields plus the edit, not a recurrence rule.
        const postCall = fetchMock.mock.calls.find((c) => c[0] === "/api/mail/calendar-events" && (c[1] as RequestInit).method === "POST")!;
        const postBody = JSON.parse((postCall[1] as RequestInit).body as string);
        expect(postBody).toEqual(
            expect.objectContaining({
                mailboxUid: "mb1",
                folderUid: "f1",
                title: "Renamed",
                startDate: "2026-06-03T15:00:00.000Z",
                organizer: { address: "jane@example.com", type: "to" },
            }),
        );
        expect(postBody.recurrenceRule).toBeUndefined();
        expect(result.uid).toBe("e2");
    });

    it("carries the series' description, visibility and guest permissions onto the detached event, and none it does not have", async () => {
        const fetchMock = mockFetch((url, init) =>
            init?.method === "POST" ? jsonResponse(200, occurrence({ uid: "e2" })) : jsonResponse(200, occurrence()),
        );
        await detachOccurrence(
            occurrence({
                description: "Agenda",
                descriptionHtml: "<p>Agenda</p>",
                visibility: "private",
                guestsCanModify: true,
                guestsCanInviteOthers: false,
                guestsCanSeeGuestList: false,
            }),
            { title: "Renamed" },
        );
        const post = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(post).toEqual(
            expect.objectContaining({
                description: "Agenda",
                descriptionHtml: "<p>Agenda</p>",
                visibility: "private",
                guestsCanModify: true,
                guestsCanInviteOthers: false,
                guestsCanSeeGuestList: false,
            }),
        );

        fetchMock.mockClear();
        await detachOccurrence(occurrence({ description: null, descriptionHtml: null, visibility: null, guestsCanModify: null }), { title: "Renamed" });
        const bare = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        for (const key of ["description", "descriptionHtml", "visibility", "guestsCanModify"]) {
            expect(bare).not.toHaveProperty(key);
        }
    });

    it("creates the detached event before excluding the occurrence from the master", async () => {
        const fetchMock = mockFetch((url, init) =>
            init?.method === "POST" ? jsonResponse(200, occurrence({ uid: "e2" })) : jsonResponse(200, occurrence()),
        );
        await detachOccurrence(occurrence(), { title: "Renamed" });
        expect(fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit).method} ${c[0]}`)).toEqual([
            "POST /api/mail/calendar-events",
            "PUT /api/mail/calendar-events/e1",
        ]);
    });

    it("keeps the master's icalUid and autoReply fields, sets recurrenceId, and never copies a recurrenceRule", async () => {
        const fetchMock = mockFetch((url, init) =>
            init?.method === "POST" ? jsonResponse(200, occurrence({ uid: "e2" })) : jsonResponse(200, occurrence()),
        );
        const master = occurrence({ icalUid: "series-ical", autoReplyEnabled: true, autoReplyMessage: "Away" });

        // The event modal passes its full field set, including the series' own recurrence rule.
        await detachOccurrence(master, { title: "Renamed", recurrenceRule: master.recurrenceRule });

        const postCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit).method === "POST")!;
        const postBody = JSON.parse((postCall[1] as RequestInit).body as string);
        expect(postBody).toMatchObject({
            icalUid: "series-ical",
            recurrenceId: "2026-06-03T15:00:00.000Z",
            autoReplyEnabled: true,
            autoReplyMessage: "Away",
            title: "Renamed",
        });
        expect("recurrenceRule" in postBody).toBe(false);
    });

    it("deletes the created detached event and rethrows when adding the exception fails", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (init?.method === "POST") return jsonResponse(200, occurrence({ uid: "e2", version: 0 }));
            if (init?.method === "PUT") return jsonResponse(409, { message: "version conflict" });
            return emptyResponse(200);
        });

        await expect(detachOccurrence(occurrence(), { title: "Renamed" })).rejects.toThrow();

        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e2?version=0", expect.objectContaining({ method: "DELETE" }));
    });

    it("still rethrows the original error when the rollback delete also fails", async () => {
        mockFetch((url, init) => {
            if (init?.method === "POST") return jsonResponse(200, occurrence({ uid: "e2", version: 0 }));
            if (init?.method === "PUT") return jsonResponse(409, { message: "version conflict" });
            return jsonResponse(500, { message: "rollback failed" });
        });

        await expect(detachOccurrence(occurrence(), { title: "Renamed" })).rejects.toThrow("version conflict");
    });

    it("does not touch the master when creating the detached event fails", async () => {
        const fetchMock = mockFetch(() => jsonResponse(500, { message: "create failed" }));
        await expect(detachOccurrence(occurrence(), { title: "Renamed" })).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
    });
});

describe("deleteEventSeries", () => {
    it("DELETEs the master event outright", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteEventSeries(occurrence());
        expect(fetchMock).toHaveBeenCalledWith("/api/mail/calendar-events/e1?version=2", expect.objectContaining({ method: "DELETE" }));
    });
});

describe("deleteEventOccurrence", () => {
    it("adds an exception to the master, leaving the rest of the series intact", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, occurrence()));
        await deleteEventOccurrence(occurrence());
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/e1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({
                    uid: "e1",
                    version: 2,
                    recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO", "WE"], exceptions: ["2026-06-03T15:00:00.000Z"] },
                }),
            }),
        );
    });
});

describe("moveOccurrence", () => {
    it("shifts a non-recurring event's start/end by deltaMs, preserving duration, via a plain PUT", async () => {
        const nonRecurring = occurrence({ recurrenceRule: undefined, isRecurringOccurrence: false, occurrenceKey: "e1" });
        const fetchMock = mockFetch(() => jsonResponse(200, nonRecurring));
        const oneDayMs = 24 * 60 * 60 * 1000;

        await moveOccurrence(nonRecurring, oneDayMs);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/e1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({
                    uid: "e1",
                    version: 2,
                    startDate: "2026-06-04T15:00:00.000Z",
                    endDate: "2026-06-04T15:30:00.000Z",
                }),
            }),
        );
    });

    it("detaches a recurring occurrence into its own standalone event when moved", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (url === "/api/mail/calendar-events/e1" && init?.method === "PUT") return jsonResponse(200, occurrence());
            if (url === "/api/mail/calendar-events" && init?.method === "POST") return jsonResponse(200, occurrence({ uid: "e2" }));
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const oneHourMs = 60 * 60 * 1000;

        const result = await moveOccurrence(occurrence(), oneHourMs);

        const postCall = fetchMock.mock.calls.find((c) => c[0] === "/api/mail/calendar-events" && (c[1] as RequestInit).method === "POST")!;
        const postBody = JSON.parse((postCall[1] as RequestInit).body as string);
        expect(postBody.startDate).toBe("2026-06-03T16:00:00.000Z");
        expect(postBody.endDate).toBe("2026-06-03T16:30:00.000Z");
        expect(result.uid).toBe("e2");
    });
});

describe("resizeOccurrenceEnd", () => {
    it("resizes a non-recurring event's end time, keeping start fixed, via a plain PUT", async () => {
        const nonRecurring = occurrence({ recurrenceRule: undefined, isRecurringOccurrence: false, occurrenceKey: "e1" });
        const fetchMock = mockFetch(() => jsonResponse(200, nonRecurring));

        await resizeOccurrenceEnd(nonRecurring, new Date("2026-06-03T16:00:00.000Z"));

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/e1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "e1", version: 2, endDate: "2026-06-03T16:00:00.000Z" }),
            }),
        );
    });

    it("clamps to a 15-minute minimum duration rather than inverting start/end", async () => {
        const nonRecurring = occurrence({ recurrenceRule: undefined, isRecurringOccurrence: false, occurrenceKey: "e1" });
        const fetchMock = mockFetch(() => jsonResponse(200, nonRecurring));

        // Attempting to resize to *before* the start (15:00) must clamp to start + 15 minutes.
        await resizeOccurrenceEnd(nonRecurring, new Date("2026-06-03T14:00:00.000Z"));

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/calendar-events/e1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "e1", version: 2, endDate: "2026-06-03T15:15:00.000Z" }),
            }),
        );
    });

    it("detaches a recurring occurrence into its own standalone event when resized", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (url === "/api/mail/calendar-events/e1" && init?.method === "PUT") return jsonResponse(200, occurrence());
            if (url === "/api/mail/calendar-events" && init?.method === "POST") return jsonResponse(200, occurrence({ uid: "e2" }));
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });

        const result = await resizeOccurrenceEnd(occurrence(), new Date("2026-06-03T16:00:00.000Z"));

        const postCall = fetchMock.mock.calls.find((c) => c[0] === "/api/mail/calendar-events" && (c[1] as RequestInit).method === "POST")!;
        const postBody = JSON.parse((postCall[1] as RequestInit).body as string);
        expect(postBody.endDate).toBe("2026-06-03T16:00:00.000Z");
        expect(postBody.startDate).toBe("2026-06-03T15:00:00.000Z"); // start unchanged
        expect(result.uid).toBe("e2");
    });
});

describe("every mutation, given an explicit ApiClient", () => {
    it("saveEventSeries threads it through both the plain-PUT path and the fetch-master/list/re-point path", async () => {
        const fetchMock = mockFetch(() => {
            throw new Error("the global apiFetch() must not be used when an explicit client is provided");
        });
        const client = fakeApiClient(() => occurrence({ title: "Renamed" }));

        const result = await saveEventSeries(occurrence(), { title: "Renamed" }, client);

        expect(client.fetch).toHaveBeenCalledWith(
            "/mail/calendar-events/e1",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ uid: "e1", version: 2, title: "Renamed" }) }),
        );
        expect(result.title).toBe("Renamed");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("saveEventSeries's series-move path (master GET, detached LIST, every re-point PUT) all go through it too", async () => {
        const master = occurrence({
            startDate: "2026-06-01T13:00:00.000Z",
            endDate: "2026-06-01T13:30:00.000Z",
            timezone: "America/New_York",
            recurrenceRule: { freq: "weekly", interval: 1, byDay: ["MO"], exceptions: [] },
            recurrenceId: undefined,
        });
        const detached = occurrence({ uid: "d1", version: 4, recurrenceRule: undefined, recurrenceId: "2026-11-09T14:00:00.000Z", startDate: "2026-11-10T20:00:00.000Z" });
        const fetchMock = mockFetch(() => {
            throw new Error("the global apiFetch() must not be used when an explicit client is provided");
        });
        const client = fakeApiClient((path, init) => {
            const method = init?.method ?? "GET";
            if (path === "/mail/calendar-events/e1" && method === "GET") return master;
            if (path.startsWith("/mail/calendar-events?")) return [master, detached];
            if (path === "/mail/calendar-events/e1" && method === "PUT") return { ...master, ...JSON.parse(init!.body as string) };
            if (path === "/mail/calendar-events/d1" && method === "PUT") return detached;
            throw new Error(`unexpected ${method} ${path}`);
        });

        await saveEventSeries(occurrence(), { startDate: "2026-06-01T14:30:00.000Z", endDate: "2026-06-01T15:00:00.000Z" }, client);

        expect(client.fetch).toHaveBeenCalledWith("/mail/calendar-events/e1", undefined);
        expect(client.fetch).toHaveBeenCalledWith(expect.stringContaining("/mail/calendar-events?"), undefined);
        expect(client.fetch).toHaveBeenCalledWith("/mail/calendar-events/d1", expect.objectContaining({ method: "PUT" }));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("detachOccurrence threads it through the create, the master's exception PUT, and a rollback delete", async () => {
        const fetchMock = mockFetch(() => {
            throw new Error("the global apiFetch() must not be used when an explicit client is provided");
        });
        const client = fakeApiClient((path, init) => {
            const method = init?.method ?? "GET";
            if (path === "/mail/calendar-events" && method === "POST") return occurrence({ uid: "e2", version: 0 });
            if (path === "/mail/calendar-events/e1" && method === "PUT") return jsonRejects();
            if (path === "/mail/calendar-events/e2?version=0" && method === "DELETE") return undefined;
            throw new Error(`unexpected ${method} ${path}`);
        });

        function jsonRejects(): never {
            throw new Error("version conflict");
        }

        await expect(detachOccurrence(occurrence(), { title: "Renamed" }, client)).rejects.toThrow("version conflict");

        expect(client.fetch).toHaveBeenCalledWith("/mail/calendar-events", expect.objectContaining({ method: "POST" }));
        expect(client.fetch).toHaveBeenCalledWith("/mail/calendar-events/e2?version=0", expect.objectContaining({ method: "DELETE" }));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("deleteEventSeries, deleteEventOccurrence, moveOccurrence and resizeOccurrenceEnd all use it instead of the global fetch", async () => {
        const fetchMock = mockFetch(() => {
            throw new Error("the global apiFetch() must not be used when an explicit client is provided");
        });
        const nonRecurring = occurrence({ recurrenceRule: undefined, isRecurringOccurrence: false, occurrenceKey: "e1" });
        const client = fakeApiClient(() => nonRecurring);

        await deleteEventSeries(occurrence(), client);
        expect(client.fetch).toHaveBeenCalledWith("/mail/calendar-events/e1?version=2", expect.objectContaining({ method: "DELETE" }));

        await deleteEventOccurrence(occurrence(), client);
        expect(client.fetch).toHaveBeenCalledWith("/mail/calendar-events/e1", expect.objectContaining({ method: "PUT" }));

        await moveOccurrence(nonRecurring, 60_000, client);
        expect(client.fetch).toHaveBeenCalledWith("/mail/calendar-events/e1", expect.objectContaining({ method: "PUT" }));
        await resizeOccurrenceEnd(nonRecurring, new Date("2026-06-03T16:00:00.000Z"), client);
        // deleteEventOccurrence's PUT, moveOccurrence's PUT and resizeOccurrenceEnd's PUT all landed on the same path.
        expect(client.fetch.mock.calls.filter(([path, init]: [string, RequestInit?]) => path === "/mail/calendar-events/e1" && init?.method === "PUT").length).toBe(3);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
