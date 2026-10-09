// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushEvent } from "../../../lib/mail/pushClient.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import TasksPageBase from "../../../apps/www/tasks/index.js";
import { withTestRouter } from "../routerTestUtils.js";

// The tasks page and what the push connection tells it about a task created, changed or deleted elsewhere: fetched again by its uid.

// Rendered inside a router, as the app's shell does (see routerTestUtils.tsx).
const TasksPage = withTestRouter(TasksPageBase);

// The shared push connection: the page adds a listener, and the tests are the server.
const listeners = new Set<(event: PushEvent) => void>();
// The channels each group asked for, as `PushClient.setChannels()` keeps them.
const channelGroups = new Map<string, readonly string[]>();
vi.mock("../../../lib/mail/pushClient.js", () => ({
    getPushClient: () => ({
        onEvent: (listener: (event: PushEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setChannels: (channels: readonly string[], group: string) => {
            if (channels.length > 0) {
                channelGroups.set(group, channels);
            } else {
                channelGroups.delete(group);
            }
        },
        start: () => undefined,
    }),
}));
function push(event: PushEvent) {
    act(() => {
        for (const listener of [...listeners]) {
            listener(event);
        }
    });
}

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
const tasksFolder = {
    uid: "f-tasks",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Tasks",
    type: "tasks" as const,
    unreadCount: 0,
    totalCount: 0,
};

function task(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        uid: "t1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        folderUid: "f-tasks",
        title: "Water the plants",
        completed: false,
        priority: "normal" as const,
        ...overrides,
    };
}

let tasks: unknown[];
let single: (uid: string) => Response;

function mockTasks() {
    return mockFetch((url, init) => {
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [tasksFolder]);
        // TasksSidebar fetches this on mount for "Lists".
        if (url.startsWith("/api/mail/task-lists")) return jsonResponse(200, []);
        if (url.startsWith("/api/mail/tasks?")) return jsonResponse(200, tasks);
        const one = /^\/api\/mail\/tasks\/([^/?]+)$/.exec(url);
        if (one && (init?.method ?? "GET") === "GET") return single(decodeURIComponent(one[1]));
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

/** Whether the page has asked for the task `uid` by itself. */
function fetchedTask(fetchMock: ReturnType<typeof mockTasks>, uid: string): boolean {
    return fetchMock.mock.calls.some(([url]) => url === `/api/mail/tasks/${uid}`);
}

/** Lets a settled fetch's answer reach the page. */
async function flush() {
    await act(async () => {
        await Promise.resolve();
    });
}

beforeEach(() => {
    listeners.clear();
    channelGroups.clear();
    tasks = [task()];
    single = () => jsonResponse(404, { message: "not found" });
    window.history.pushState(null, "", "/tasks");
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState(null, "", "/");
});

describe("TasksPage live updates", () => {
    it("subscribes to its tasks folder while it is open, under its own channel group, and lets it go when the page goes", async () => {
        mockTasks();
        const { unmount } = render(<TasksPage userUid="u1" />);
        await screen.findByText("Water the plants");
        await waitFor(() => expect(channelGroups.get("tasks")).toEqual(["f-tasks"]));

        unmount();
        expect(channelGroups.has("tasks")).toBe(false);
    });

    it("shows a task another device created, alongside the ones already listed", async () => {
        mockTasks();
        render(<TasksPage userUid="u1" />);
        await screen.findByText("Water the plants");

        single = (uid) => jsonResponse(200, task({ uid, title: "Call the plumber" }));
        push({ type: "TaskMongo", action: "create", data: { uid: "t2" } });

        expect(await screen.findByText("Call the plumber")).toBeInTheDocument();
        expect(screen.getByText("Water the plants")).toBeInTheDocument();
    });

    it("replaces a task the page already holds with what the fetch says, and leaves the others as they are", async () => {
        tasks = [task(), task({ uid: "t2", title: "Old title" })];
        mockTasks();
        render(<TasksPage userUid="u1" />);
        await screen.findByText("Old title");

        single = (uid) => jsonResponse(200, task({ uid, title: "New title" }));
        push({ type: "TaskSQL", action: "update", data: { uid: "t2", title: "Pushed title" } });

        expect(await screen.findByText("New title")).toBeInTheDocument();
        expect(screen.queryByText("Old title")).not.toBeInTheDocument();
        // The pushed payload is never shown as the task.
        expect(screen.queryByText("Pushed title")).not.toBeInTheDocument();
        expect(screen.getByText("Water the plants")).toBeInTheDocument();
    });

    it("drops a deleted task without fetching it", async () => {
        tasks = [task(), task({ uid: "t2", title: "Doomed" })];
        const fetchMock = mockTasks();
        render(<TasksPage userUid="u1" />);
        await screen.findByText("Doomed");

        push({ type: "TaskMongo", action: "delete", data: { uid: "t2" } });

        await waitFor(() => expect(screen.queryByText("Doomed")).not.toBeInTheDocument());
        expect(screen.getByText("Water the plants")).toBeInTheDocument();
        expect(fetchedTask(fetchMock, "t2")).toBe(false);
    });

    it("drops a task that was moved to another folder, and does not add one that is in another folder", async () => {
        tasks = [task(), task({ uid: "t2", title: "Moving out" })];
        const fetchMock = mockTasks();
        render(<TasksPage userUid="u1" />);
        await screen.findByText("Moving out");

        single = (uid) => jsonResponse(200, task({ uid, title: uid === "t2" ? "Moving out" : "Elsewhere", folderUid: "f-other" }));
        push({ type: "TaskMongo", action: "update", data: { uid: "t2" } });
        await waitFor(() => expect(screen.queryByText("Moving out")).not.toBeInTheDocument());
        expect(screen.getByText("Water the plants")).toBeInTheDocument();

        push({ type: "TaskMongo", action: "create", data: { uid: "t3" } });
        await waitFor(() => expect(fetchedTask(fetchMock, "t3")).toBe(true));
        await flush();
        expect(screen.queryByText("Elsewhere")).not.toBeInTheDocument();
    });

    it("drops a task that is gone, and leaves the list alone when the fetch fails for any other reason", async () => {
        tasks = [task(), task({ uid: "t2", title: "Doomed" })];
        const fetchMock = mockTasks();
        render(<TasksPage userUid="u1" />);
        await screen.findByText("Doomed");

        single = () => jsonResponse(500, { message: "boom" });
        push({ type: "TaskMongo", action: "update", data: { uid: "t2" } });
        await waitFor(() => expect(fetchedTask(fetchMock, "t2")).toBe(true));
        await flush();
        expect(screen.getByText("Doomed")).toBeInTheDocument();

        single = () => jsonResponse(404, { message: "gone" });
        push({ type: "TaskSQL", action: "update", data: { uid: "t2" } });
        await waitFor(() => expect(screen.queryByText("Doomed")).not.toBeInTheDocument());
        expect(screen.getByText("Water the plants")).toBeInTheDocument();
    });

    it("does nothing for a push that is not about a task, and stops listening when the page goes", async () => {
        const fetchMock = mockTasks();
        const { unmount } = render(<TasksPage userUid="u1" />);
        await screen.findByText("Water the plants");
        // The page's own, and whatever the app frame around it listens for.
        expect(listeners.size).toBeGreaterThanOrEqual(1);

        // A task list is its own model, as is a message; a reminder is not a change, and a push with no uid names nothing.
        push({ type: "TaskListMongo", action: "delete", data: { uid: "t1" } });
        push({ type: "TaskListSQL", action: "update", data: { uid: "t1" } });
        push({ type: "MessageMongo", action: "delete", data: { uid: "t1" } });
        push({ type: "TaskMongo", action: "reminder", data: { uid: "t1" } });
        push({ type: "TaskMongo", action: "delete", data: { uid: 5 } });
        await flush();

        expect(screen.getByText("Water the plants")).toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([url]) => /^\/api\/mail\/tasks\//.test(url))).toBe(false);

        unmount();
        expect(listeners.size).toBe(0);
    });
});
