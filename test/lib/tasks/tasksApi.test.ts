// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import {
    createTask,
    createTaskList,
    deleteTask,
    deleteTaskList,
    listTaskLists,
    listTasks,
    setTaskCompleted,
    setTaskMyDay,
    updateTask,
    updateTaskList,
} from "../../../lib/tasks/tasksApi.js";
import { createApiClient } from "../../../lib/util/api.js";

const task = {
    uid: "t1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    folderUid: "f1",
    title: "Buy milk",
    completed: false,
    priority: "normal" as const,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("listTasks", () => {
    it("fetches scoped by folderUid, sorted by due date, with default pagination", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, [task]));
        const result = await listTasks("f1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/tasks?limit=25&page=0&folderUid=f1&sort=" + encodeURIComponent(JSON.stringify({ dueDate: "ASC" })),
            expect.anything(),
        );
        expect(result).toEqual([task]);
    });

    it("forwards a custom page/limit", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, []));
        await listTasks("f1", { page: 1, limit: 5 });
        expect(fetchMock.mock.calls[0][0]).toContain("limit=5&page=1");
    });
});

describe("createTask", () => {
    it("posts the input with completed/priority defaults", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, task));
        await createTask({ mailboxUid: "mb1", folderUid: "f1", title: "Buy milk" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/tasks",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({
                    completed: false,
                    priority: "normal",
                    mailboxUid: "mb1",
                    folderUid: "f1",
                    title: "Buy milk",
                }),
            }),
        );
    });

    it("forwards an explicit priority instead of defaulting it", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, task));
        await createTask({ mailboxUid: "mb1", folderUid: "f1", title: "Buy milk", priority: "high" });
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.priority).toBe("high");
    });
});

describe("updateTask", () => {
    it("PUTs the encoded uid with the input", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...task, title: "Buy oat milk" }));
        const result = await updateTask({ uid: "t/1", version: 0, title: "Buy oat milk" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/tasks/t%2F1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "t/1", version: 0, title: "Buy oat milk" }),
            }),
        );
        expect(result.title).toBe("Buy oat milk");
    });
});

describe("setTaskCompleted", () => {
    it("PUTs just the uid/version/completed fields", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...task, completed: true }));
        const result = await setTaskCompleted(task, true);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/tasks/t1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "t1", version: 0, completed: true }),
            }),
        );
        expect(result.completed).toBe(true);
    });
});

describe("deleteTask", () => {
    it("DELETEs the encoded uid with the version query param", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteTask("t/1", 2);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/tasks/t%2F1?version=2",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});

describe("setTaskMyDay", () => {
    it("PUTs just the uid/version/myDay fields", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { ...task, myDay: true }));
        const result = await setTaskMyDay(task, true);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/tasks/t1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "t1", version: 0, myDay: true }),
            }),
        );
        expect(result.myDay).toBe(true);
    });
});

describe("listTaskLists", () => {
    it("fetches scoped by mailboxUid, sorted by name", async () => {
        const list = { uid: "tl1", version: 0, dateCreated: "", dateModified: "", mailboxUid: "mb1", name: "Home" };
        const fetchMock = mockFetch(() => jsonResponse(200, [list]));
        const result = await listTaskLists("mb1");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/task-lists?limit=25&page=0&mailboxUid=mb1&sort=" + encodeURIComponent(JSON.stringify({ name: "ASC" })),
            expect.anything(),
        );
        expect(result).toEqual([list]);
    });
});

describe("createTaskList", () => {
    it("posts mailboxUid/name", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "tl1" }));
        await createTaskList({ mailboxUid: "mb1", name: "Home" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/task-lists",
            expect.objectContaining({ method: "POST", body: JSON.stringify({ mailboxUid: "mb1", name: "Home" }) }),
        );
    });
});

describe("updateTaskList", () => {
    it("PUTs the encoded uid with the input", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "tl1", name: "Renamed" }));
        const result = await updateTaskList({ uid: "tl/1", version: 0, name: "Renamed" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/task-lists/tl%2F1",
            expect.objectContaining({
                method: "PUT",
                body: JSON.stringify({ uid: "tl/1", version: 0, name: "Renamed" }),
            }),
        );
        expect(result.name).toBe("Renamed");
    });
});

describe("deleteTaskList", () => {
    it("DELETEs the encoded uid with the version query param", async () => {
        const fetchMock = mockFetch(() => emptyResponse(200));
        await deleteTaskList("tl/1", 2);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/mail/task-lists/tl%2F1?version=2",
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, task));

        await listTasks("f1", {}, client);
        await createTask({ mailboxUid: "mb1", folderUid: "f1", title: "Buy milk" }, client);
        await updateTask({ uid: "t1", version: 0, title: "Buy oat milk" }, client);
        await setTaskCompleted(task, true, client);
        await setTaskMyDay(task, true, client);
        await deleteTask("t1", 2, client);
        await listTaskLists("mb1", {}, client);
        await createTaskList({ mailboxUid: "mb1", name: "Home" }, client);
        await updateTaskList({ uid: "tl1", version: 0, name: "Renamed" }, client);
        await deleteTaskList("tl1", 2, client);

        expect(fetchMock).toHaveBeenCalledTimes(10);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, [task]));
        await listTasks("f1");
        expect(fetchMock.mock.calls[0][0]).toBe(
            "/api/mail/tasks?limit=25&page=0&folderUid=f1&sort=" + encodeURIComponent(JSON.stringify({ dueDate: "ASC" })),
        );
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});
