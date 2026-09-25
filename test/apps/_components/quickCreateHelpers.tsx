///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Shared by the quick-create tab tests (Event | Task | Appointment schedule): rendering a new event's popover and the mocked task and
// booking APIs its tabs call.
import React from "react";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { TaskList } from "@rapidmx/react-shared/tasks/tasksApi.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import EventModal from "../../../apps/shared/components/calendar/EventModal.js";

export const BOOKING_HREF = "/settings/booking-types";

export const ownMailbox = {
    uid: "jane@example.com",
    ownerUserUid: "u1",
    displayName: "Jane Doe",
    primarySmtpAddress: "jane@example.com",
    timezone: "America/New_York",
} as Mailbox;
export const sharedMailbox = { uid: "mb-shared", displayName: "Support", primarySmtpAddress: "support@example.com" } as Mailbox;

export const mailboxOptions = [
    { mailbox: ownMailbox, calendars: [{ uid: "f1", name: "Work" }] },
    {
        mailbox: sharedMailbox,
        calendars: [
            { uid: "f-s1", name: "Support Calendar" },
            { uid: "f-s2", name: "On-call" },
        ],
    },
];

/** A new event's popover (a slot at 09:00 UTC on 2026-06-10), with the handlers it reports to. */
export function renderNew(props: Partial<React.ComponentProps<typeof EventModal>> = {}) {
    const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onDeleted: vi.fn() };
    render(
        <EventModal
            open
            mailboxUid="jane@example.com"
            folderUid="f1"
            calendars={[{ uid: "f1", name: "Work" }]}
            organizerAddress="jane@example.com"
            occurrence={null}
            initialStart={new Date("2026-06-10T09:00:00.000Z")}
            initialEnd={new Date("2026-06-10T10:00:00.000Z")}
            {...handlers}
            {...props}
        />,
    );
    return handlers;
}

/** The value of a query parameter in a request URL. */
export function param(url: string, name: string): string | null {
    return new URL(url, "http://localhost").searchParams.get(name);
}

export interface TaskApiOptions {
    /** The task lists of each mailbox, by uid. */
    lists?: Record<string, TaskList[]>;
    /** Answers `GET /mail/task-lists` with an error instead. */
    listsFail?: boolean;
    /** The mailboxes that have no Tasks folder. */
    noTasksFolder?: string[];
    /** Answers `POST /mail/tasks`. */
    create?: () => Response | Promise<Response>;
}

/** Mocks what the Task tab calls: the mailbox's task lists and folders, and the create. Returns the fetch mock. */
export function mockTaskApi({ lists = {}, listsFail = false, noTasksFolder = [], create }: TaskApiOptions = {}) {
    return mockFetch((url, init) => {
        if (url.startsWith("/api/mail/task-lists")) {
            return listsFail ? jsonResponse(500, { message: "no lists" }) : jsonResponse(200, lists[param(url, "mailboxUid")!] ?? []);
        }
        if (url.startsWith("/api/mail/folders")) {
            const mailboxUid = param(url, "mailboxUid")!;
            return jsonResponse(200, noTasksFolder.includes(mailboxUid) ? [{ uid: "f1", type: "calendar" }] : [{ uid: `tasks-${mailboxUid}`, type: "tasks" }]);
        }
        if (url === "/api/mail/tasks" && init?.method === "POST") {
            return create ? create() : jsonResponse(200, { uid: "t1", title: "created" });
        }
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

/** The JSON body of the first call to `fetchMock` that used `method` on `url`. */
export function sentBody(fetchMock: ReturnType<typeof vi.fn>, url: string, method = "POST") {
    const call = fetchMock.mock.calls.find(([calledUrl, init]) => calledUrl === url && (init as RequestInit | undefined)?.method === method);
    return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined;
}
