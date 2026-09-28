///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Typed wrappers over `@rapidmx/restapi`'s `/mail/tasks` REST surface — see `mailApi.ts`'s own header
 * comment for the shared ACL/authorization model every wrapper file here follows. */

import { ApiClient, withClient } from "../util/api.js";
import { ListParams, buildQuery } from "../util/apiQuery.js";

export type TaskPriority = "low" | "normal" | "high";

export interface Task {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    folderUid: string;
    title: string;
    body?: string;
    dueDate?: string;
    completed: boolean;
    priority: TaskPriority;
    reminderDate?: string;
    /** The `TaskList` this task is a member of, if any — undefined means the default flat "Tasks" list. */
    taskListUid?: string;
    /** Whether the caller has manually added this task to their curated "My Day" working set. Absent is
     * equivalent to `false` — not derived from `dueDate`, since an undated (or future-dated) task can
     * still be added to today's list. */
    myDay?: boolean;
    /** The uid of the user this task is assigned to, if any. */
    assignedTo?: string;
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */

/** Lists a folder's tasks, soonest due date first (tasks with no due date sort last). */
export function listTasks(folderUid: string, params: ListParams = {}, client?: ApiClient): Promise<Task[]> {
    return withClient(client, `/mail/tasks?${buildQuery(params, { folderUid, sort: JSON.stringify({ dueDate: "ASC" }) })}`);
}

export interface CreateTaskInput {
    mailboxUid: string;
    folderUid: string;
    title: string;
    body?: string;
    dueDate?: string;
    priority?: TaskPriority;
    reminderDate?: string;
    taskListUid?: string;
    myDay?: boolean;
    assignedTo?: string;
}

export function createTask(input: CreateTaskInput, client?: ApiClient): Promise<Task> {
    return withClient(client, "/mail/tasks", {
        method: "POST",
        body: JSON.stringify({ completed: false, priority: "normal", ...input }),
    });
}

export interface UpdateTaskInput {
    uid: string;
    version: number;
    title?: string;
    body?: string;
    dueDate?: string;
    completed?: boolean;
    priority?: TaskPriority;
    reminderDate?: string;
    taskListUid?: string;
    myDay?: boolean;
    assignedTo?: string;
}

export function updateTask(input: UpdateTaskInput, client?: ApiClient): Promise<Task> {
    return withClient(client, `/mail/tasks/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

/** Toggles a task's `completed` flag in place — same pattern as `mailApi.ts`'s `setMessageRead`. */
export function setTaskCompleted(task: Task, completed: boolean, client?: ApiClient): Promise<Task> {
    return updateTask({ uid: task.uid, version: task.version, completed }, client);
}

/** Adds/removes a task from the caller's curated "My Day" working set — same thin-wrapper pattern as
 * `setTaskCompleted`. */
export function setTaskMyDay(task: Task, myDay: boolean, client?: ApiClient): Promise<Task> {
    return updateTask({ uid: task.uid, version: task.version, myDay }, client);
}

export function deleteTask(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/tasks/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}

export interface TaskList {
    uid: string;
    version: number;
    dateCreated: string;
    dateModified: string;
    mailboxUid: string;
    name: string;
}

/** Lists a mailbox's task lists (Outlook To-Do-style custom lists), alphabetically by name. */
export function listTaskLists(mailboxUid: string, params: ListParams = {}, client?: ApiClient): Promise<TaskList[]> {
    return withClient(client, `/mail/task-lists?${buildQuery(params, { mailboxUid, sort: JSON.stringify({ name: "ASC" }) })}`);
}

export function createTaskList(input: { mailboxUid: string; name: string }, client?: ApiClient): Promise<TaskList> {
    return withClient(client, "/mail/task-lists", { method: "POST", body: JSON.stringify(input) });
}

export function updateTaskList(input: { uid: string; version: number; name: string }, client?: ApiClient): Promise<TaskList> {
    return withClient(client, `/mail/task-lists/${encodeURIComponent(input.uid)}`, {
        method: "PUT",
        body: JSON.stringify(input),
    });
}

export function deleteTaskList(uid: string, version: number, client?: ApiClient): Promise<void> {
    return withClient(client, `/mail/task-lists/${encodeURIComponent(uid)}?version=${version}`, { method: "DELETE" });
}
