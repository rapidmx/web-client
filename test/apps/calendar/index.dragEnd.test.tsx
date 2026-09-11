// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
/**
 * Covers `CalendarPage`'s `handleDragEnd` — the glue between a `@dnd-kit` drag-end and
 * `resolveDragAction`/`moveOccurrence`/`resizeOccurrenceEnd` (both already independently unit-tested;
 * see `calendarDragIds.test.ts` and `calendarMutations.test.ts`). A real drag gesture can't be driven
 * from jsdom (see `index.test.tsx`'s note on `PointerSensor`), so this mocks `DndContext` itself to
 * capture the `onDragEnd` callback the page wires up, then invokes it directly with a synthetic
 * minimal `DragEndEvent` (`handleDragEnd` only ever reads `.active.id` and `.over?.id`). `useDraggable`/
 * `useDroppable` are left real (via `importActual`) so `MonthView`/`TimeGridView` still render
 * normally — `@dnd-kit`'s own context has safe no-op defaults outside a real `DndContext`.
 */
import React from "react";
import { MouseSensor, TouchSensor } from "@dnd-kit/core";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { dayDropId, resizeDragId, slotDropId } from "@rapidmx/react-shared/calendarDragIds.js";
import CalendarPage from "../../../apps/www/calendar/index.js";

let capturedOnDragEnd: ((event: { active: { id: string }; over: { id: string } | null }) => Promise<void>) | undefined;
const capturedSensorCalls: { sensor: unknown; options: unknown }[] = [];

vi.mock("@dnd-kit/core", async () => {
    const actual = await vi.importActual<typeof import("@dnd-kit/core")>("@dnd-kit/core");
    return {
        ...actual,
        DndContext: ({ onDragEnd, children }: { onDragEnd: typeof capturedOnDragEnd; children: React.ReactNode }) => {
            capturedOnDragEnd = onDragEnd;
            return <>{children}</>;
        },
        useSensor: (sensor: unknown, options: unknown) => {
            capturedSensorCalls.push({ sensor, options });
            return actual.useSensor(sensor as never, options as never);
        },
    };
});

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};
const calendarFolder = {
    uid: "f-cal",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Calendar",
    type: "calendar" as const,
    unreadCount: 0,
    totalCount: 0,
};
const event = {
    uid: "e1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    folderUid: "f-cal",
    title: "Standup",
    startDate: "2026-06-15T15:00:00.000Z",
    endDate: "2026-06-15T15:30:00.000Z",
    allDay: false,
    timezone: "UTC",
    organizer: { address: "u1@example.com", type: "to" as const },
    attendees: [],
    status: "confirmed" as const,
    busyStatus: "busy" as const,
    icalUid: "abc",
    sequence: 0,
};

function mockShellAndEvents(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [calendarFolder]);
        if (url.startsWith("/api/mail/calendar-events") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [event]);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

beforeEach(() => {
    window.history.pushState(null, "", "/calendar?date=2026-06-15&view=month");
});

afterEach(() => {
    vi.unstubAllGlobals();
    capturedOnDragEnd = undefined;
    capturedSensorCalls.length = 0;
    window.history.pushState(null, "", "/");
});

describe("CalendarPage handleDragEnd", () => {
    it("configures MouseSensor/TouchSensor with activation constraints, not a bare PointerSensor", async () => {
        mockShellAndEvents();
        render(<CalendarPage userUid="u1" />);
        await screen.findByText(/Standup/);

        // `useSensor` is re-invoked on every render (React re-renders `CalendarContent` several times as
        // its data loads), so this checks that every capture matches one of the two expected
        // sensor/options pairs, rather than asserting an exact call count.
        expect(capturedSensorCalls.length).toBeGreaterThan(0);
        for (const call of capturedSensorCalls) {
            if (call.sensor === MouseSensor) {
                expect(call.options).toEqual({ activationConstraint: { distance: 8 } });
            } else if (call.sensor === TouchSensor) {
                expect(call.options).toEqual({ activationConstraint: { delay: 250, tolerance: 8 } });
            } else {
                throw new Error(`unexpected sensor class: ${String(call.sensor)}`);
            }
        }
        expect(capturedSensorCalls.some((c) => c.sensor === MouseSensor)).toBe(true);
        expect(capturedSensorCalls.some((c) => c.sensor === TouchSensor)).toBe(true);
    });

    it("moves an occurrence to the dropped-on day and reloads", async () => {
        const fetchMock = mockShellAndEvents((url, init) =>
            url === "/api/mail/calendar-events/e1" && init?.method === "PUT" ? jsonResponse(200, { ...event, startDate: "2026-06-16T15:00:00.000Z", endDate: "2026-06-16T15:30:00.000Z" }) : undefined,
        );
        render(<CalendarPage userUid="u1" />);
        await screen.findByText(/Standup/);

        await act(async () => {
            await capturedOnDragEnd!({ active: { id: "e1" }, over: { id: dayDropId(new Date("2026-06-16T00:00:00.000Z")) } });
        });

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/calendar-events/e1",
                expect.objectContaining({ method: "PUT" }),
            ),
        );
    });

    it("resizes an occurrence's end to the dropped-on slot and reloads", async () => {
        const fetchMock = mockShellAndEvents((url, init) =>
            url === "/api/mail/calendar-events/e1" && init?.method === "PUT" ? jsonResponse(200, { ...event, endDate: "2026-06-15T16:00:00.000Z" }) : undefined,
        );
        render(<CalendarPage userUid="u1" />);
        await screen.findByText(/Standup/);

        await act(async () => {
            await capturedOnDragEnd!({
                active: { id: resizeDragId({ ...event, occurrenceKey: "e1", isRecurringOccurrence: false }) },
                over: { id: slotDropId(new Date("2026-06-15T16:00:00.000Z")) },
            });
        });

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/calendar-events/e1",
                expect.objectContaining({ method: "PUT", body: expect.stringContaining("2026-06-15T16:00:00.000Z") }),
            ),
        );
    });

    it("does nothing when the drop doesn't resolve to an action (dropped outside any target)", async () => {
        const fetchMock = mockShellAndEvents();
        render(<CalendarPage userUid="u1" />);
        await screen.findByText(/Standup/);
        const callsBefore = fetchMock.mock.calls.length;

        await act(async () => {
            await capturedOnDragEnd!({ active: { id: "e1" }, over: null });
        });

        expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    it("shows an API error message when the mutation fails", async () => {
        mockShellAndEvents((url, init) =>
            url === "/api/mail/calendar-events/e1" && init?.method === "PUT" ? jsonResponse(500, { message: "move failed" }) : undefined,
        );
        render(<CalendarPage userUid="u1" />);
        await screen.findByText(/Standup/);

        await act(async () => {
            await capturedOnDragEnd!({ active: { id: "e1" }, over: { id: dayDropId(new Date("2026-06-16T00:00:00.000Z")) } });
        });

        expect(await screen.findByText("move failed")).toBeInTheDocument();
    });

    it("shows a generic error message when the mutation fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [calendarFolder]);
            if (url.startsWith("/api/mail/calendar-events") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [event]);
            if (url === "/api/mail/calendar-events/e1" && init?.method === "PUT") throw new TypeError("network down");
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        render(<CalendarPage userUid="u1" />);
        await screen.findByText(/Standup/);

        await act(async () => {
            await capturedOnDragEnd!({ active: { id: "e1" }, over: { id: dayDropId(new Date("2026-06-16T00:00:00.000Z")) } });
        });

        expect(await screen.findByText("Could not update this event.")).toBeInTheDocument();
    });
});
