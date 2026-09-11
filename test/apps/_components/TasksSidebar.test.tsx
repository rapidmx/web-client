// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import TasksSidebar, { tasksViewKey, TasksView } from "../../../apps/shared/components/tasks/TasksSidebar.js";
import type { Task } from "@rapidmx/react-shared/tasksApi.js";

function task(overrides: Partial<Task> = {}): Task {
    return {
        uid: "t1",
        version: 0,
        dateCreated: "",
        dateModified: "",
        mailboxUid: "mb1",
        folderUid: "f1",
        title: "Buy milk",
        completed: false,
        priority: "normal",
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("tasksViewKey", () => {
    it("returns a distinct key per view type, including the list uid for list views.", () => {
        expect(tasksViewKey({ type: "myDay" })).toBe("myDay");
        expect(tasksViewKey({ type: "important" })).toBe("important");
        expect(tasksViewKey({ type: "planned" })).toBe("planned");
        expect(tasksViewKey({ type: "assignedToMe" })).toBe("assignedToMe");
        expect(tasksViewKey({ type: "flagged" })).toBe("flagged");
        expect(tasksViewKey({ type: "all" })).toBe("all");
        expect(tasksViewKey({ type: "list", uid: "l1", name: "Home" })).toBe("list:l1");
    });
});

describe("TasksSidebar", () => {
    it("shows counts for My Day, Important, Planned, Assigned to me, and Tasks.", async () => {
        mockFetch(() => jsonResponse(200, []));
        const tasks = [
            task({ uid: "t1", myDay: true }),
            task({ uid: "t2", priority: "high" }),
            task({ uid: "t3", dueDate: "2026-01-01T00:00:00.000Z" }),
            task({ uid: "t4", assignedTo: "u1" }),
        ];
        render(<TasksSidebar mailboxUid="mb1" tasks={tasks} userUid="u1" active={{ type: "all" }} onSelect={vi.fn()} />);

        expect(screen.getByText("My Day").closest("button")).toHaveTextContent("1");
        expect(screen.getByText("Important").closest("button")).toHaveTextContent("1");
        expect(screen.getByText("Planned").closest("button")).toHaveTextContent("1");
        expect(screen.getByText("Assigned to me").closest("button")).toHaveTextContent("1");
        expect(screen.getByText("Tasks").closest("button")).toHaveTextContent("4");
        expect(await screen.findByText("Flagged email")).toBeInTheDocument();
    });

    it("marks the active view with aria-current, and calls onSelect for every smart-filter.", async () => {
        mockFetch(() => jsonResponse(200, []));
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<TasksSidebar tasks={[]} active={{ type: "myDay" }} onSelect={onSelect} />);

        expect(screen.getByText("My Day").closest("button")).toHaveAttribute("aria-current", "true");
        expect(screen.getByText("Important").closest("button")).not.toHaveAttribute("aria-current");

        await user.click(screen.getByText("My Day"));
        expect(onSelect).toHaveBeenCalledWith({ type: "myDay" });
        await user.click(screen.getByText("Important"));
        expect(onSelect).toHaveBeenCalledWith({ type: "important" });
        await user.click(screen.getByText("Planned"));
        expect(onSelect).toHaveBeenCalledWith({ type: "planned" });
        await user.click(screen.getByText("Assigned to me"));
        expect(onSelect).toHaveBeenCalledWith({ type: "assignedToMe" });
        await user.click(screen.getByText("Flagged email"));
        expect(onSelect).toHaveBeenCalledWith({ type: "flagged" });
        await user.click(screen.getByText("Tasks"));
        expect(onSelect).toHaveBeenCalledWith({ type: "all" });
    });

    it("does nothing (no fetch, empty lists) when there is no mailboxUid yet.", () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        render(<TasksSidebar tasks={[]} active={{ type: "all" }} onSelect={vi.fn()} />);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.queryByText(/Home/)).not.toBeInTheDocument();
    });

    it("fetches and renders the mailbox's task lists, with a per-list task count.", async () => {
        mockFetch(() => jsonResponse(200, [{ uid: "l1", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Home" }]));
        const tasks = [task({ uid: "t1", taskListUid: "l1" }), task({ uid: "t2", taskListUid: "l1" }), task({ uid: "t3" })];
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<TasksSidebar mailboxUid="mb1" tasks={tasks} active={{ type: "all" }} onSelect={onSelect} />);

        const listButton = await screen.findByText("Home");
        expect(listButton.closest("button")).toHaveTextContent("2");

        await user.click(listButton);
        expect(onSelect).toHaveBeenCalledWith({ type: "list", uid: "l1", name: "Home" });
    });

    it("marks a selected list as active by uid.", async () => {
        mockFetch(() => jsonResponse(200, [{ uid: "l1", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Home" }]));
        render(<TasksSidebar mailboxUid="mb1" tasks={[]} active={{ type: "list", uid: "l1", name: "Home" }} onSelect={vi.fn()} />);
        expect((await screen.findByText("Home")).closest("button")).toHaveAttribute("aria-current", "true");
    });

    it("shows the ApiRequestError message when loading task lists fails.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockFetch(() => {
            throw new ApiRequestError("nope", 500);
        });
        render(<TasksSidebar mailboxUid="mb1" tasks={[]} active={{ type: "all" }} onSelect={vi.fn()} />);
        expect(await screen.findByText("nope")).toBeInTheDocument();
    });

    it("shows a generic error message when loading task lists fails with a non-API error.", async () => {
        mockFetch(() => {
            throw new Error("boom");
        });
        render(<TasksSidebar mailboxUid="mb1" tasks={[]} active={{ type: "all" }} onSelect={vi.fn()} />);
        expect(await screen.findByText("Could not load task lists.")).toBeInTheDocument();
    });

    it("re-fetches task lists when refreshToken changes.", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        const { rerender } = render(
            <TasksSidebar mailboxUid="mb1" tasks={[]} active={{ type: "all" }} onSelect={vi.fn()} refreshToken={1} />,
        );
        await screen.findByText("Lists");

        rerender(<TasksSidebar mailboxUid="mb1" tasks={[]} active={{ type: "all" }} onSelect={vi.fn()} refreshToken={2} />);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        await screen.findByText("Lists");
    });

    it("opens the mobile drawer via the menu button, and selecting a view closes it again.", async () => {
        mockFetch(() => jsonResponse(200, []));
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<TasksSidebar mailboxUid="mb1" tasks={[]} active={{ type: "all" }} onSelect={onSelect} />);

        expect(screen.queryByRole("dialog", { name: "Tasks" })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Open tasks menu" }));
        const drawer = screen.getByRole("dialog", { name: "Tasks" });
        await user.click(within(drawer).getByText("My Day"));

        expect(onSelect).toHaveBeenCalledWith({ type: "myDay" });
        expect(screen.queryByRole("dialog", { name: "Tasks" })).not.toBeInTheDocument();
    });

    it("closes the mobile drawer via its own Close button", async () => {
        mockFetch(() => jsonResponse(200, []));
        const user = userEvent.setup();
        render(<TasksSidebar mailboxUid="mb1" tasks={[]} active={{ type: "all" }} onSelect={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Open tasks menu" }));
        const drawer = screen.getByRole("dialog", { name: "Tasks" });
        await user.click(within(drawer).getByRole("button", { name: "Close" }));

        expect(screen.queryByRole("dialog", { name: "Tasks" })).not.toBeInTheDocument();
    });

    it("opens a new-list form, creates the list, and appends it to the sidebar sorted by name.", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (init?.method === "POST") {
                return jsonResponse(200, { uid: "l2", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Aardvarks" });
            }
            return jsonResponse(200, [{ uid: "l1", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Home" }]);
        });
        const user = userEvent.setup();
        render(<TasksSidebar mailboxUid="mb1" tasks={[]} active={{ type: "all" }} onSelect={vi.fn()} />);

        await screen.findByText("Home");
        await user.click(screen.getByLabelText("New list"));
        await user.type(screen.getByLabelText("New list name"), "Aardvarks");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/task-lists",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ mailboxUid: "mb1", name: "Aardvarks" }) }),
        );
        const names = (await screen.findAllByRole("button")).map((b) => b.textContent).filter((t) => t?.includes("Aardvarks") || t?.includes("Home"));
        expect(names[0]).toContain("Aardvarks");
    });

    it("does not submit the new-list form when the mailbox or name is missing.", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        const user = userEvent.setup();
        render(<TasksSidebar mailboxUid="mb1" tasks={[]} active={{ type: "all" }} onSelect={vi.fn()} />);

        await user.click(screen.getByLabelText("New list"));
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(fetchMock).not.toHaveBeenCalledWith("/api/mail/task-lists", expect.objectContaining({ method: "POST" }));
    });

    it("shows a generic error message when creating a new list fails with a non-API error.", async () => {
        const fetchMock = mockFetch((url, init) => {
            if (init?.method === "POST") throw new Error("nope");
            return jsonResponse(200, []);
        });
        const user = userEvent.setup();
        render(<TasksSidebar mailboxUid="mb1" tasks={[]} active={{ type: "all" }} onSelect={vi.fn()} />);

        await user.click(screen.getByLabelText("New list"));
        await user.type(screen.getByLabelText("New list name"), "Oops");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("Could not create this list.")).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalled();
    });

    it("shows the ApiRequestError message when creating a new list fails with an API error.", async () => {
        const { ApiRequestError } = await import("@rapidmx/react-shared/api.js");
        mockFetch((url, init) => {
            if (init?.method === "POST") throw new ApiRequestError("list name already taken", 409);
            return jsonResponse(200, []);
        });
        const user = userEvent.setup();
        render(<TasksSidebar mailboxUid="mb1" tasks={[]} active={{ type: "all" }} onSelect={vi.fn()} />);

        await user.click(screen.getByLabelText("New list"));
        await user.type(screen.getByLabelText("New list name"), "Oops");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(await screen.findByText("list name already taken")).toBeInTheDocument();
    });
});
