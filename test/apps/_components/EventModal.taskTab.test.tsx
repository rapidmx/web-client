// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../testUtils.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";
import { mailboxOptions, mockTaskApi, param, renderNew, sentBody } from "./quickCreateHelpers.js";

// The Task tab of a new event's popover: a task created in the mailbox's Tasks folder through `POST /api/mail/tasks`.

afterEach(() => {
    vi.unstubAllGlobals();
});

async function openTaskTab(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("tab", { name: "Task" }));
}

describe("the quick form", () => {
    it("asks for the title, when it is due (all day, on the clicked day) and nothing else when the mailbox has one task list", async () => {
        mockTaskApi();
        const user = userEvent.setup();
        renderNew();
        await openTaskTab(user);

        expect(screen.getByLabelText("Title")).toHaveAttribute("placeholder", "Add title");
        expect(screen.getByLabelText("Due date")).toHaveValue("2026-06-10");
        expect(screen.getByRole("checkbox", { name: "All day" })).toBeChecked();
        expect(screen.queryByLabelText("Due time")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Task list")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Mailbox")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Notes")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "More options" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    it("creates the task in the mailbox's Tasks folder, due all day on the day, and says so", async () => {
        const fetchMock = mockTaskApi();
        const user = userEvent.setup();
        const { onClose, onSaved } = renderNew();
        await user.type(screen.getByLabelText("Title"), "  Buy milk ");
        await openTaskTab(user);

        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(sentBody(fetchMock, "/api/mail/tasks")).toEqual({
            completed: false,
            priority: "normal",
            mailboxUid: "jane@example.com",
            folderUid: "tasks-jane@example.com",
            title: "Buy milk",
            dueDate: "2026-06-10T00:00:00.000Z",
        });
        // The calendar shows no tasks, so there is nothing for it to reload.
        expect(onSaved).not.toHaveBeenCalled();
        expect(getNotificationsSnapshot().visible).toEqual([
            expect.objectContaining({ kind: "success", title: "Task added", message: "“Buy milk” was added to Tasks." }),
        ]);
    });

    it("takes a time on the due day: the clicked slot's, ready when All day is turned off", async () => {
        const fetchMock = mockTaskApi();
        const user = userEvent.setup();
        const { onClose } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Call Bob");
        await openTaskTab(user);

        await user.click(screen.getByRole("checkbox", { name: "All day" }));
        expect(screen.getByLabelText("Due time")).toHaveValue("09:00");
        fireEvent.change(screen.getByLabelText("Due time"), { target: { value: "14:30" } });
        fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-06-12" } });
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(sentBody(fetchMock, "/api/mail/tasks").dueDate).toBe("2026-06-12T14:30:00.000Z");
    });

    it("offers 9:00 as the time when the click was on a day of the month view", async () => {
        mockTaskApi();
        const user = userEvent.setup();
        renderNew({ initialAllDay: true, initialStart: new Date(2026, 5, 20), initialEnd: new Date(2026, 5, 20) });
        await openTaskTab(user);

        expect(screen.getByLabelText("Due date")).toHaveValue("2026-06-20");
        await user.click(screen.getByRole("checkbox", { name: "All day" }));
        expect(screen.getByLabelText("Due time")).toHaveValue("09:00");
    });

    it("creates a task with no due date when the date is cleared, and stops asking for a time", async () => {
        const fetchMock = mockTaskApi();
        const user = userEvent.setup();
        const { onClose } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Someday");
        await openTaskTab(user);
        await user.click(screen.getByRole("checkbox", { name: "All day" }));

        fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "" } });
        expect(screen.queryByLabelText("Due time")).not.toBeInTheDocument();
        expect(screen.queryByRole("checkbox", { name: "All day" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(sentBody(fetchMock, "/api/mail/tasks")).not.toHaveProperty("dueDate");
    });

    it("needs a title, and a time when the due date is not all day", async () => {
        const fetchMock = mockTaskApi();
        const user = userEvent.setup();
        renderNew();
        await openTaskTab(user);

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("A title is required.")).toBeInTheDocument();

        await user.type(screen.getByLabelText("Title"), "Call");
        await user.click(screen.getByRole("checkbox", { name: "All day" }));
        fireEvent.change(screen.getByLabelText("Due time"), { target: { value: "" } });
        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Pick a time, or choose All day.")).toBeInTheDocument();
        expect(screen.queryByText("A title is required.")).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toEqual([]);
    });
});

describe("task lists and mailboxes", () => {
    const lists = { "jane@example.com": [{ uid: "l1", name: "Groceries" }, { uid: "l2", name: "Work" }], "mb-shared": [{ uid: "l3", name: "Support" }] } as never;

    it("offers the mailbox's task lists, the default one first, and files the task in the one chosen", async () => {
        const fetchMock = mockTaskApi({ lists });
        const user = userEvent.setup();
        const { onClose } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Milk");
        await openTaskTab(user);

        const select = await screen.findByLabelText("Task list");
        expect(select).toHaveValue("");
        expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(["Tasks", "Groceries", "Work"]);
        await user.selectOptions(select, "l2");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(sentBody(fetchMock, "/api/mail/tasks").taskListUid).toBe("l2");
    });

    it("keeps the default list when none was chosen", async () => {
        const fetchMock = mockTaskApi({ lists });
        const user = userEvent.setup();
        const { onClose } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Milk");
        await openTaskTab(user);
        await screen.findByLabelText("Task list");

        await user.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(sentBody(fetchMock, "/api/mail/tasks")).not.toHaveProperty("taskListUid");
    });

    it("shows no choice of list when the lists cannot be read", async () => {
        const fetchMock = mockTaskApi({ listsFail: true });
        const user = userEvent.setup();
        renderNew();
        await openTaskTab(user);

        await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => (url as string).startsWith("/api/mail/task-lists"))).toBe(true));
        await waitFor(() => expect(screen.queryByLabelText("Task list")).not.toBeInTheDocument());
    });

    it("creates the task in the chosen mailbox, with that mailbox's lists, and forgets a list of the one it left", async () => {
        const fetchMock = mockTaskApi({ lists });
        const user = userEvent.setup();
        const { onClose } = renderNew({ mailboxOptions });
        await user.type(screen.getByLabelText("Title"), "Ticket");
        await openTaskTab(user);

        await user.selectOptions(await screen.findByLabelText("Task list"), "l1");
        expect(screen.getByRole("option", { name: "Support (shared)" })).toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText("Mailbox"), "mb-shared");
        // The shared mailbox's own lists replace the old ones, and the old choice is not one of them.
        await waitFor(() => expect(screen.getByRole("option", { name: "Support" })).toBeInTheDocument());
        expect(screen.getByLabelText("Task list")).toHaveValue("");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(sentBody(fetchMock, "/api/mail/tasks")).toEqual(
            expect.objectContaining({ mailboxUid: "mb-shared", folderUid: "tasks-mb-shared" }),
        );
        expect(sentBody(fetchMock, "/api/mail/tasks")).not.toHaveProperty("taskListUid");
        expect(fetchMock.mock.calls.filter(([url]) => (url as string).startsWith("/api/mail/task-lists")).map(([url]) => param(url as string, "mailboxUid"))).toEqual([
            "jane@example.com",
            "mb-shared",
        ]);
    });

    it("ignores the lists of a mailbox that was left before they arrived", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const fetchMock = mockTaskApi({ lists });
        const inner = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (url, init) => {
            if (url.startsWith("/api/mail/task-lists") && param(url, "mailboxUid") === "jane@example.com") {
                await held;
            }
            return inner(url, init);
        });
        const user = userEvent.setup();
        renderNew({ mailboxOptions });
        await openTaskTab(user);

        await user.selectOptions(screen.getByLabelText("Mailbox"), "mb-shared");
        expect(await screen.findByRole("option", { name: "Support" })).toBeInTheDocument();
        release();
        // Jane's lists arrive late and do not replace the shared mailbox's.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.queryByRole("option", { name: "Groceries" })).not.toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Support" })).toBeInTheDocument();
    });
});

describe("when the task cannot be created", () => {
    it("says the mailbox has no Tasks folder, and stays open", async () => {
        mockTaskApi({ noTasksFolder: ["jane@example.com"] });
        const user = userEvent.setup();
        const { onClose } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Milk");
        await openTaskTab(user);

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("That mailbox has no Tasks folder.")).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        expect(getNotificationsSnapshot().visible).toEqual([]);
    });

    it("shows the server's own message", async () => {
        mockTaskApi({ create: () => jsonResponse(403, { message: "You cannot add tasks to this mailbox." }) });
        const user = userEvent.setup();
        const { onClose } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Milk");
        await openTaskTab(user);

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("You cannot add tasks to this mailbox.")).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        // The button is usable again.
        expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });

    it("says so plainly when the request did not get an answer", async () => {
        mockTaskApi({
            create: () => {
                throw new TypeError("network down");
            },
        });
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Milk");
        await openTaskTab(user);

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByText("Could not create this task.")).toBeInTheDocument();
    });
});

describe("the card", () => {
    it("adds notes, priority, a reminder and My Day to the form, without More options, and keeps what was typed", async () => {
        mockTaskApi();
        const user = userEvent.setup();
        renderNew();
        await user.type(screen.getByLabelText("Title"), "Report");
        await openTaskTab(user);
        fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-06-30" } });

        await user.click(screen.getByRole("button", { name: "More options" }));
        expect(screen.getByLabelText("Title")).toHaveValue("Report");
        expect(screen.getByLabelText("Due date")).toHaveValue("2026-06-30");
        expect(screen.queryByRole("button", { name: "More options" })).not.toBeInTheDocument();
        expect(screen.getByLabelText("Notes")).toHaveAttribute("placeholder", "Add notes");
        expect(screen.getByLabelText("Priority")).toHaveValue("normal");
        expect(screen.getByRole("checkbox", { name: "Add to My Day" })).not.toBeChecked();
        expect(screen.getByRole("button", { name: "Add reminder" })).toBeInTheDocument();
        expect(screen.getByLabelText("Title")).toHaveFocus();
    });

    it("creates the task with everything on it", async () => {
        const fetchMock = mockTaskApi();
        const user = userEvent.setup();
        const { onClose } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Report");
        await openTaskTab(user);
        await user.click(screen.getByRole("button", { name: "More options" }));

        await user.type(screen.getByLabelText("Notes"), "  Quarterly numbers ");
        await user.selectOptions(screen.getByLabelText("Priority"), "high");
        await user.click(screen.getByRole("checkbox", { name: "Add to My Day" }));
        await user.click(screen.getByRole("button", { name: "Add reminder" }));
        // The reminder starts at 9:00 on the due day.
        expect(screen.getByLabelText("Reminder")).toHaveValue("2026-06-10T09:00");
        fireEvent.change(screen.getByLabelText("Reminder"), { target: { value: "2026-06-09T17:15" } });
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(sentBody(fetchMock, "/api/mail/tasks")).toEqual({
            completed: false,
            priority: "high",
            mailboxUid: "jane@example.com",
            folderUid: "tasks-jane@example.com",
            title: "Report",
            body: "Quarterly numbers",
            dueDate: "2026-06-10T00:00:00.000Z",
            reminderDate: "2026-06-09T17:15:00.000Z",
            myDay: true,
        });
    });

    it("can take a reminder off again, and starts one on the event's day when the task has no due date", async () => {
        const fetchMock = mockTaskApi();
        const user = userEvent.setup();
        const { onClose } = renderNew();
        await user.type(screen.getByLabelText("Title"), "Report");
        await openTaskTab(user);
        fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "" } });
        await user.click(screen.getByRole("button", { name: "More options" }));

        await user.click(screen.getByRole("button", { name: "Add reminder" }));
        expect(screen.getByLabelText("Reminder")).toHaveValue("2026-06-10T09:00");
        await user.click(screen.getByRole("button", { name: "Remove reminder" }));
        expect(screen.queryByLabelText("Reminder")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(sentBody(fetchMock, "/api/mail/tasks")).not.toHaveProperty("reminderDate");
        expect(sentBody(fetchMock, "/api/mail/tasks")).not.toHaveProperty("myDay");
    });
});
