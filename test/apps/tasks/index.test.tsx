// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { addDays, endOfWeek, subDays } from "date-fns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import TasksPage from "../../../apps/www/tasks/index.js";

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

// Dates computed relative to the real "now" (rather than a pinned fake clock — fake timers reliably
// deadlock combined with userEvent's own internal delays in this setup) via the same date-fns
// primitives the component itself uses, so each fixture lands in its intended bucket regardless of
// which real calendar day the suite happens to run on.
const NOW = new Date();
const OVERDUE_DATE = subDays(NOW, 5).toISOString();
const TODAY_DATE = NOW.toISOString();
const THIS_WEEK_DATE = endOfWeek(NOW, { weekStartsOn: 1 }).toISOString();
const LATER_DATE = addDays(endOfWeek(NOW, { weekStartsOn: 1 }), 3).toISOString();

function task(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        uid: "t1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        folderUid: "f-tasks",
        title: "Task",
        completed: false,
        priority: "normal" as const,
        ...overrides,
    };
}

const overdueTask = task({ uid: "t-overdue", title: "Overdue task", dueDate: OVERDUE_DATE, priority: "high" });
const todayTask = task({ uid: "t-today", title: "Today task", dueDate: TODAY_DATE });
const thisWeekTask = task({ uid: "t-week", title: "This week task", dueDate: THIS_WEEK_DATE, priority: "low" });
const laterTask = task({ uid: "t-later", title: "Later task", dueDate: LATER_DATE });
const noDueDateTask = task({ uid: "t-none", title: "No due date task" });
const completedTask = task({ uid: "t-done", title: "Done task", completed: true });

function mockShellAndTasks(
    tasks: unknown[],
    extra?: (url: string, init?: RequestInit) => Response | undefined,
    folders: unknown[] = [tasksFolder],
) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
        // TasksSidebar fetches this on mount for "Lists" — empty by default here.
        if (url.startsWith("/api/mail/task-lists")) return jsonResponse(200, []);
        if (url.startsWith("/api/mail/tasks") && (init?.method ?? "GET") === "GET") return jsonResponse(200, tasks);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// A fixed Monday, used only by the two bucket-precision tests below via local fake timers (never
// combined with userEvent — see the note above on why fake timers + userEvent deadlock here). Real
// "now" can legitimately fall on the last day of the Mon-start week (Sunday), where "This Week" (a
// day later than today, but still within the week) has no valid date at all — not a bug, just not a
// testable-with-real-dates case, hence pinning to a day that always has a valid "This Week" date.
const BUCKET_TEST_NOW = new Date("2026-06-15T12:00:00.000Z"); // a Monday

describe("TasksPage", () => {
    it("groups tasks into Overdue/Today/This Week/Later/No due date buckets", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(BUCKET_TEST_NOW);
        const pinnedOverdue = task({ uid: "t-overdue", title: "Overdue task", dueDate: "2026-06-10T00:00:00.000Z", priority: "high" });
        // Noon UTC, matching BUCKET_TEST_NOW's time-of-day — a midnight-UTC timestamp would land on the
        // *previous* local calendar day in any timezone behind UTC, failing date-fns' local-time `isToday`.
        const pinnedToday = task({ uid: "t-today", title: "Today task", dueDate: "2026-06-15T12:00:00.000Z" });
        const pinnedThisWeek = task({ uid: "t-week", title: "This week task", dueDate: "2026-06-18T00:00:00.000Z", priority: "low" });
        const pinnedLater = task({ uid: "t-later", title: "Later task", dueDate: "2026-06-25T00:00:00.000Z" });
        mockShellAndTasks([pinnedLater, pinnedOverdue, pinnedToday, pinnedThisWeek, noDueDateTask]);
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Overdue task");
        const list = within(screen.getByRole("region", { name: "Tasks list" }));
        const headings = list.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
        expect(headings).toEqual(["Overdue", "Today", "This Week", "Later", "No due date"]);
        expect(screen.getByText("Today task")).toBeInTheDocument();
        expect(screen.getByText("This week task")).toBeInTheDocument();
        expect(screen.getByText("Later task")).toBeInTheDocument();
        expect(screen.getByText("No due date task")).toBeInTheDocument();
    });

    it("shows priority badges for low/high but not normal, and a due date when set", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.setSystemTime(BUCKET_TEST_NOW);
        const pinnedOverdue = task({ uid: "t-overdue", title: "Overdue task", dueDate: "2026-06-10T00:00:00.000Z", priority: "high" });
        const pinnedThisWeek = task({ uid: "t-week", title: "This week task", dueDate: "2026-06-18T00:00:00.000Z", priority: "low" });
        mockShellAndTasks([pinnedOverdue, pinnedThisWeek, noDueDateTask]);
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Overdue task");
        // "High"/"Low" also appear as <option> text in the priority <select> above, so scope to each row.
        const overdueRow = screen.getByText("Overdue task").closest("li") as HTMLElement;
        const thisWeekRow = screen.getByText("This week task").closest("li") as HTMLElement;
        expect(within(overdueRow).getByText("High")).toBeInTheDocument();
        expect(within(thisWeekRow).getByText("Low")).toBeInTheDocument();
        // noDueDateTask is "normal" priority and has no due date — neither a badge nor a date renders for it.
        const noDueRow = screen.getByText("No due date task").closest("li") as HTMLElement;
        expect(noDueRow.textContent).not.toMatch(/Normal/);
    });

    it("shows a Completed section only when there are completed tasks", async () => {
        mockShellAndTasks([todayTask]);
        const { rerender } = render(<TasksPage userUid="u1" />);
        await screen.findByText("Today task");
        expect(screen.queryByRole("heading", { name: "Completed" })).not.toBeInTheDocument();

        mockShellAndTasks([todayTask, completedTask]);
        rerender(<TasksPage userUid="u1" key="reload" />);
        expect(await screen.findByRole("heading", { name: "Completed" })).toBeInTheDocument();
        expect(screen.getByText("Done task")).toBeInTheDocument();
    });

    it("shows 'No tasks yet.' when the list is empty", async () => {
        mockShellAndTasks([]);
        render(<TasksPage userUid="u1" />);
        expect(await screen.findByText("No tasks yet.")).toBeInTheDocument();
    });

    it("shows an error message when loading tasks fails", async () => {
        mockShellAndTasks([], (url, init) =>
            url.startsWith("/api/mail/tasks") && (init?.method ?? "GET") === "GET" ? jsonResponse(500, { message: "boom" }) : undefined,
        );
        render(<TasksPage userUid="u1" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading tasks fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [tasksFolder]);
            if (url.startsWith("/api/mail/task-lists")) return jsonResponse(200, []);
            throw new TypeError("network down");
        });
        render(<TasksPage userUid="u1" />);
        expect(await screen.findByText("Could not load tasks.")).toBeInTheDocument();
    });

    it("clears the list (not stuck loading) when the mailbox has no tasks folder yet", async () => {
        mockShellAndTasks([], undefined, []);
        render(<TasksPage userUid="u1" />);
        expect(await screen.findByText("No tasks yet.")).toBeInTheDocument();
    });

    it("creates a task and clears the form", async () => {
        const created = task({ uid: "t-new", title: "Ship the report", dueDate: "2026-06-16T00:00:00.000Z", priority: "high" });
        const fetchMock = mockShellAndTasks([], (url, init) =>
            url === "/api/mail/tasks" && init?.method === "POST" ? jsonResponse(200, created) : undefined,
        );
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("No tasks yet.");
        await user.type(screen.getByLabelText("Add a task"), "Ship the report");
        await user.type(screen.getByLabelText("Due date"), "2026-06-16");
        await user.selectOptions(screen.getByLabelText("Priority"), "high");
        await user.click(screen.getByRole("button", { name: "Add" }));

        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/tasks", expect.objectContaining({ method: "POST" })));
        const body = JSON.parse(
            (fetchMock.mock.calls.find((c) => c[0] === "/api/mail/tasks" && (c[1] as RequestInit).method === "POST")![1] as RequestInit)
                .body as string,
        );
        expect(body).toEqual(
            expect.objectContaining({ mailboxUid: "mb1", folderUid: "f-tasks", title: "Ship the report", priority: "high" }),
        );
        expect(await screen.findByText("Ship the report")).toBeInTheDocument();
        expect(screen.getByLabelText("Add a task")).toHaveValue("");
    });

    it("shows a validation error and does not submit when the title is blank", async () => {
        const fetchMock = mockShellAndTasks([]);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("No tasks yet.");
        const callsBefore = fetchMock.mock.calls.length;
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("A title is required.")).toBeInTheDocument();
        expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    it("does not submit when the tasks folder isn't ready yet (mailboxUid/folderUid missing)", async () => {
        const fetchMock = mockShellAndTasks([], undefined, []);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("No tasks yet.");
        await user.type(screen.getByLabelText("Add a task"), "Add a task");
        const callsBefore = fetchMock.mock.calls.length;
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    it("shows an error message when creating a task fails", async () => {
        mockShellAndTasks([], (url, init) =>
            url === "/api/mail/tasks" && init?.method === "POST" ? jsonResponse(500, { message: "create failed" }) : undefined,
        );
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("No tasks yet.");
        await user.type(screen.getByLabelText("Add a task"), "Add a task");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("create failed")).toBeInTheDocument();
    });

    it("shows a generic error message when creating a task fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [tasksFolder]);
            if (url.startsWith("/api/mail/task-lists")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/tasks") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("No tasks yet.");
        await user.type(screen.getByLabelText("Add a task"), "Add a task");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("Could not create this task.")).toBeInTheDocument();
    });

    it("toggles a task complete and back, updating optimistically, leaving other tasks untouched", async () => {
        const otherTask = task({ uid: "t-other", title: "Other task" });
        const fetchMock = mockShellAndTasks([todayTask, otherTask], (url, init) =>
            url === "/api/mail/tasks/t-today" && init?.method === "PUT" ? jsonResponse(200, { ...todayTask, completed: true }) : undefined,
        );
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        const checkbox = await screen.findByLabelText('Mark "Today task" as complete');
        await user.click(checkbox);

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/tasks/t-today",
                expect.objectContaining({ method: "PUT", body: JSON.stringify({ uid: "t-today", version: 0, completed: true }) }),
            ),
        );
        expect(await screen.findByRole("heading", { name: "Completed" })).toBeInTheDocument();
        // The other task (map's "not this uid" branch, both optimistic-update and confirmed-response passes)
        // must still be present, unaffected, and still shown as not completed.
        expect(screen.getByLabelText('Mark "Other task" as complete')).not.toBeChecked();
    });

    it("reverts the optimistic update and shows an error when toggling fails, leaving other tasks untouched", async () => {
        const otherTask = task({ uid: "t-other", title: "Other task" });
        mockShellAndTasks([todayTask, otherTask], (url, init) =>
            url === "/api/mail/tasks/t-today" && init?.method === "PUT" ? jsonResponse(500, { message: "toggle failed" }) : undefined,
        );
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        const checkbox = await screen.findByLabelText('Mark "Today task" as complete');
        await user.click(checkbox);

        expect(await screen.findByText("toggle failed")).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Completed" })).not.toBeInTheDocument();
        expect(screen.getByLabelText('Mark "Today task" as complete')).not.toBeChecked();
        expect(screen.getByLabelText('Mark "Other task" as complete')).not.toBeChecked();
    });

    it("shows a generic error message when toggling fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [tasksFolder]);
            if (url.startsWith("/api/mail/task-lists")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/tasks") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [todayTask]);
            if (url === "/api/mail/tasks/t-today" && init?.method === "PUT") throw new TypeError("network down");
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        const checkbox = await screen.findByLabelText('Mark "Today task" as complete');
        await user.click(checkbox);

        expect(await screen.findByText("Could not update this task.")).toBeInTheDocument();
    });

    it("deletes a task, removing it from the list", async () => {
        const fetchMock = mockShellAndTasks([todayTask], (url, init) =>
            url === "/api/mail/tasks/t-today?version=0" && init?.method === "DELETE" ? emptyResponse(200) : undefined,
        );
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: 'Delete "Today task"' }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/tasks/t-today?version=0", expect.objectContaining({ method: "DELETE" })),
        );
        expect(await screen.findByText("No tasks yet.")).toBeInTheDocument();
    });

    it("shows an error message when deleting a task fails", async () => {
        mockShellAndTasks([todayTask], (url, init) =>
            url === "/api/mail/tasks/t-today?version=0" && init?.method === "DELETE" ? jsonResponse(500, { message: "delete failed" }) : undefined,
        );
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: 'Delete "Today task"' }));

        expect(await screen.findByText("delete failed")).toBeInTheDocument();
    });

    it("shows a generic error message when deleting a task fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [tasksFolder]);
            if (url.startsWith("/api/mail/task-lists")) return jsonResponse(200, []);
            if (url.startsWith("/api/mail/tasks") && (init?.method ?? "GET") === "GET") return jsonResponse(200, [todayTask]);
            if (url === "/api/mail/tasks/t-today?version=0" && init?.method === "DELETE") throw new TypeError("network down");
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: 'Delete "Today task"' }));

        expect(await screen.findByText("Could not delete this task.")).toBeInTheDocument();
    });
});

const inboxFolder = { ...tasksFolder, uid: "f-inbox", name: "Inbox", type: "inbox" as const };
const list = { uid: "l1", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Home" };

function flaggedMessage(uid: string, receivedDate: string) {
    return {
        uid,
        version: 0,
        dateCreated: "",
        dateModified: "",
        folderUid: "f-inbox",
        mailboxUid: "mb1",
        messageId: `${uid}@test`,
        subject: `Subject ${uid}`,
        from: { address: "sender@example.com", type: "to" },
        recipients: [],
        sentDate: receivedDate,
        receivedDate,
        bodyPreview: "",
        flags: { read: true, flagged: true, answered: false, forwarded: false },
        importance: "normal",
        hasAttachments: false,
    };
}

describe("TasksPage — sidebar views, toolbar bulk actions, and grid mode", () => {
    const myDayTask = task({ uid: "t-myday", title: "My Day task", myDay: true });
    const importantTask = task({ uid: "t-imp", title: "Important task", priority: "high" });
    const plannedTask = task({ uid: "t-planned", title: "Planned task", dueDate: TODAY_DATE });
    const assignedTask = task({ uid: "t-assigned", title: "Assigned task", assignedTo: "u1" });
    const listedTask = task({ uid: "t-listed", title: "Listed task", taskListUid: "l1" });

    function mockShellAndTasksWithLists(
        tasks: unknown[],
        lists: unknown[] = [list],
        folders: unknown[] = [tasksFolder],
        extra?: (url: string, init?: RequestInit) => Response | undefined,
    ) {
        return mockFetch((url, init) => {
            const custom = extra?.(url, init);
            if (custom) return custom;
            if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, folders);
            if (url.startsWith("/api/mail/task-lists")) return jsonResponse(200, lists);
            if (url.startsWith("/api/mail/tasks") && (init?.method ?? "GET") === "GET") return jsonResponse(200, tasks);
            throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
        });
    }

    it("My Day view shows only tasks in the caller's My Day set.", async () => {
        mockShellAndTasksWithLists([todayTask, myDayTask]);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByText("My Day"));

        expect(await screen.findByText("My Day task")).toBeInTheDocument();
        expect(screen.queryByText("Today task")).not.toBeInTheDocument();
    });

    it("Important view shows only high-priority tasks.", async () => {
        mockShellAndTasksWithLists([todayTask, importantTask]);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByText("Important"));

        expect(await screen.findByText("Important task")).toBeInTheDocument();
        expect(screen.queryByText("Today task")).not.toBeInTheDocument();
    });

    it("Planned view shows only tasks with a due date.", async () => {
        mockShellAndTasksWithLists([noDueDateTask, plannedTask]);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("No due date task");
        await user.click(screen.getByText("Planned"));

        expect(await screen.findByText("Planned task")).toBeInTheDocument();
        expect(screen.queryByText("No due date task")).not.toBeInTheDocument();
    });

    it("Assigned to me view shows only tasks assigned to the caller.", async () => {
        mockShellAndTasksWithLists([todayTask, assignedTask]);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByText("Assigned to me"));

        expect(await screen.findByText("Assigned task")).toBeInTheDocument();
        expect(screen.queryByText("Today task")).not.toBeInTheDocument();
    });

    it("a custom list view shows only tasks in that list.", async () => {
        mockShellAndTasksWithLists([todayTask, listedTask]);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(await screen.findByText("Home"));

        expect(await screen.findByText("Listed task")).toBeInTheDocument();
        expect(screen.queryByText("Today task")).not.toBeInTheDocument();
    });

    it("Flagged email view fetches and shows flagged messages across mail folders, hiding the task table/add-a-task row.", async () => {
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder, inboxFolder], (url) => {
            if (url.includes("folderUid=f-inbox")) return jsonResponse(200, [flaggedMessage("m1", "2026-01-01T00:00:00.000Z")]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByText("Flagged email"));

        expect(await screen.findByText("Subject m1")).toBeInTheDocument();
        expect(screen.queryByLabelText("Add a task")).not.toBeInTheDocument();
    });

    it("Flagged email view falls back to '(no subject)' for a message with a blank subject.", async () => {
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder, inboxFolder], (url) => {
            if (url.includes("folderUid=f-inbox")) return jsonResponse(200, [{ ...flaggedMessage("m1", "2026-01-01T00:00:00.000Z"), subject: "" }]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByText("Flagged email"));

        expect(await screen.findByText("(no subject)")).toBeInTheDocument();
    });

    it("Flagged email view shows 'No flagged email.' when there are none.", async () => {
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder, inboxFolder], (url) => {
            if (url.includes("folderUid=f-inbox")) return jsonResponse(200, []);
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByText("Flagged email"));

        expect(await screen.findByText("No flagged email.")).toBeInTheDocument();
    });

    it("Flagged email view shows the ApiRequestError message when the fetch fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder, inboxFolder], (url) => {
            if (url.includes("folderUid=f-inbox")) throw new ApiRequestError("nope", 500);
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByText("Flagged email"));

        expect(await screen.findByText("nope")).toBeInTheDocument();
    });

    it("Flagged email view shows a generic error message when the fetch fails with a non-API error.", async () => {
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder, inboxFolder], (url) => {
            if (url.includes("folderUid=f-inbox")) throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByText("Flagged email"));

        expect(await screen.findByText("Could not load flagged email.")).toBeInTheDocument();
    });

    it("Grid view renders a sortable-looking table with Title/Due Date/Importance columns instead of bucketed groups.", async () => {
        mockShellAndTasksWithLists([todayTask]);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(within(screen.getByRole("toolbar")).getByText("Grid"));

        expect(screen.getByText("Title")).toBeInTheDocument();
        expect(screen.getByText("Due Date")).toBeInTheDocument();
        expect(screen.getByText("Importance")).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Today" })).not.toBeInTheDocument();
    });

    it("Grid view shows a completed task's title with strikethrough styling.", async () => {
        mockShellAndTasksWithLists([completedTask]);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Done task");
        await user.click(within(screen.getByRole("toolbar")).getByText("Grid"));

        expect(screen.getByText("Done task")).toHaveClass("line-through");
    });

    it("Grid view: an individual row checkbox can be checked/unchecked, and its delete button removes it.", async () => {
        const fetchMock = mockShellAndTasksWithLists([todayTask], [list], [tasksFolder], (url, init) =>
            url === "/api/mail/tasks/t-today?version=0" && init?.method === "DELETE" ? emptyResponse(200) : undefined,
        );
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(within(screen.getByRole("toolbar")).getByText("Grid"));

        await user.click(screen.getByLabelText("Select Today task"));
        expect(screen.getByLabelText("Select Today task")).toBeChecked();
        await user.click(screen.getByLabelText("Select Today task"));
        expect(screen.getByLabelText("Select Today task")).not.toBeChecked();

        await user.click(screen.getByRole("button", { name: 'Delete "Today task"' }));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith("/api/mail/tasks/t-today?version=0", expect.objectContaining({ method: "DELETE" })),
        );
    });

    it("select-all checkbox checks/unchecks every visible row, enabling toolbar bulk actions.", async () => {
        mockShellAndTasksWithLists([todayTask, noDueDateTask]);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(within(screen.getByRole("toolbar")).getByText("Grid"));

        // Start from a *partial* selection (only one of two rows checked) before checking all, so
        // toggling all exercises the "skip a row that's already checked" branch too, not just the
        // all-unchecked-to-all-checked case.
        await user.click(screen.getByLabelText("Select Today task"));
        await user.click(screen.getByLabelText("Select all tasks"));

        expect(screen.getByLabelText("Select Today task")).toBeChecked();
        expect(screen.getByLabelText("Select No due date task")).toBeChecked();
        expect(within(screen.getByRole("toolbar")).getByText("Delete").closest("button")).not.toBeDisabled();

        await user.click(screen.getByLabelText("Select all tasks"));
        expect(screen.getByLabelText("Select Today task")).not.toBeChecked();
    });

    it("an individual checkbox (in bucketed list mode) can be checked, then unchecked again.", async () => {
        mockShellAndTasksWithLists([todayTask]);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByLabelText("Select Today task"));
        expect(screen.getByLabelText("Select Today task")).toBeChecked();

        await user.click(screen.getByLabelText("Select Today task"));
        expect(screen.getByLabelText("Select Today task")).not.toBeChecked();
    });

    it("toolbar Complete marks every checked task complete.", async () => {
        const fetchMock = mockShellAndTasksWithLists([todayTask, noDueDateTask], [list], [tasksFolder], (url, init) => {
            if (init?.method === "PUT") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...todayTask, ...body });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByLabelText("Select Today task"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Complete"));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/tasks/t-today",
                expect.objectContaining({ method: "PUT", body: expect.stringContaining('"completed":true') }),
            ),
        );
    });

    it("toolbar Complete shows the ApiRequestError message when updating a checked task fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder], (url, init) => {
            if (init?.method === "PUT") throw new ApiRequestError("cannot complete", 403);
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByLabelText("Select Today task"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Complete"));

        expect(await screen.findByText("cannot complete")).toBeInTheDocument();
    });

    it("toolbar Complete shows a generic error message when updating a checked task fails with a non-API error.", async () => {
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder], (url, init) => {
            if (init?.method === "PUT") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByLabelText("Select Today task"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Complete"));

        expect(await screen.findByText("Could not update one or more tasks.")).toBeInTheDocument();
    });

    it("toolbar Add to My Day adds every checked task to My Day.", async () => {
        const fetchMock = mockShellAndTasksWithLists([todayTask], [list], [tasksFolder], (url, init) => {
            if (init?.method === "PUT") {
                const body = JSON.parse(init.body as string);
                return jsonResponse(200, { ...todayTask, ...body });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByLabelText("Select Today task"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Add to My Day"));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/mail/tasks/t-today",
                expect.objectContaining({ method: "PUT", body: expect.stringContaining('"myDay":true') }),
            ),
        );
    });

    it("toolbar Add to My Day shows the ApiRequestError message when updating a checked task fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder], (url, init) => {
            if (init?.method === "PUT") throw new ApiRequestError("cannot add to my day", 403);
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByLabelText("Select Today task"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Add to My Day"));

        expect(await screen.findByText("cannot add to my day")).toBeInTheDocument();
    });

    it("toolbar Add to My Day shows a generic error message when updating a checked task fails with a non-API error.", async () => {
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder], (url, init) => {
            if (init?.method === "PUT") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByLabelText("Select Today task"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Add to My Day"));

        expect(await screen.findByText("Could not update one or more tasks.")).toBeInTheDocument();
    });

    it("toolbar Delete removes every checked task.", async () => {
        const deletedCalls: string[] = [];
        const fetchMock = mockShellAndTasksWithLists([todayTask, noDueDateTask], [list], [tasksFolder], (url, init) => {
            if (init?.method === "DELETE") {
                deletedCalls.push(url);
                return emptyResponse(200);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(within(screen.getByRole("toolbar")).getByText("Grid"));
        await user.click(screen.getByLabelText("Select all tasks"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Delete"));

        await waitFor(() => expect(deletedCalls.length).toBe(2));
        expect(fetchMock).toHaveBeenCalled();
    });

    it("toolbar Delete shows the ApiRequestError message when deleting a checked task fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder], (url, init) => {
            if (init?.method === "DELETE") throw new ApiRequestError("cannot delete", 403);
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByLabelText("Select Today task"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Delete"));

        expect(await screen.findByText("cannot delete")).toBeInTheDocument();
    });

    it("toolbar Delete shows a generic error message when deleting a checked task fails with a non-API error.", async () => {
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder], (url, init) => {
            if (init?.method === "DELETE") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);

        await screen.findByText("Today task");
        await user.click(screen.getByLabelText("Select Today task"));
        await user.click(within(screen.getByRole("toolbar")).getByText("Delete"));

        expect(await screen.findByText("Could not delete one or more tasks.")).toBeInTheDocument();
    });

    it("wraps the task table (Grid view) in a horizontally-scrollable container, so it doesn't break the layout on a narrow screen.", async () => {
        mockShellAndTasksWithLists([todayTask], [list], [tasksFolder]);
        const user = userEvent.setup();
        render(<TasksPage userUid="u1" />);
        await screen.findByText("Today task");

        await user.click(within(screen.getByRole("toolbar")).getByText("Grid"));

        const table = await screen.findByRole("table");
        expect(table.parentElement).toHaveClass("overflow-x-auto");
    });
});
