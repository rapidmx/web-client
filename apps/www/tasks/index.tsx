///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { endOfWeek, isAfter, isBefore, isToday, startOfDay } from "date-fns";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import {
    Task,
    TaskPriority,
    createTask,
    deleteTask,
    listTasks,
    setTaskCompleted,
    setTaskMyDay,
    updateTask,
} from "@rapidmx/react-shared/tasksApi.js";
import { listFlaggedMessages } from "@rapidmx/react-shared/flaggedMessages.js";
import { Message } from "@rapidmx/react-shared/mailApi.js";
import TasksShell, { TasksShellProps, useTasksShell } from "../../shared/components/tasks/layout/TasksShell.js";
import TasksSidebar, { TasksView } from "../../shared/components/tasks/TasksSidebar.js";
import TasksToolbar, { TasksViewMode } from "../../shared/components/tasks/TasksToolbar.js";
import Alert from "../../shared/components/feedback/Alert.js";
import Button from "../../shared/components/buttons/Button.js";

const INPUT_CLASS =
    "text-sm py-1.5 px-2 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export default function TasksPage(props: TasksShellProps) {
    return (
        <TasksShell {...props}>
            <TasksContent />
        </TasksShell>
    );
}

type Bucket = "Overdue" | "Today" | "This Week" | "Later" | "No due date";
const BUCKET_ORDER: Bucket[] = ["Overdue", "Today", "This Week", "Later", "No due date"];

/** Buckets a task by its due date relative to `now`, matching the Outlook/To-Do convention this list mirrors. */
function bucketFor(task: Task, now: Date): Bucket {
    if (!task.dueDate) {
        return "No due date";
    }
    const due = new Date(task.dueDate);
    if (isBefore(due, startOfDay(now))) {
        return "Overdue";
    }
    if (isToday(due)) {
        return "Today";
    }
    if (!isAfter(due, endOfWeek(now, { weekStartsOn: 1 }))) {
        return "This Week";
    }
    return "Later";
}

const PRIORITY_LABEL: Record<TaskPriority, string> = { low: "Low", normal: "Normal", high: "High" };
const PRIORITY_CLASS: Record<TaskPriority, string> = {
    low: "text-text-muted",
    normal: "text-text-muted",
    high: "text-danger",
};

function TasksContent() {
    const { folderUid, mailboxUid, userUid } = useTasksShell();
    const [tasks, setTasks] = useState<Task[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [title, setTitle] = useState("");
    const [dueDate, setDueDate] = useState("");
    const [priority, setPriority] = useState<TaskPriority>("normal");
    const [createError, setCreateError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [view, setView] = useState<TasksView>({ type: "all" });
    const [viewMode, setViewMode] = useState<TasksViewMode>("list");
    const [checkedUids, setCheckedUids] = useState<Set<string>>(new Set());
    const [flaggedMessages, setFlaggedMessages] = useState<Message[]>([]);
    const [flaggedLoading, setFlaggedLoading] = useState(false);
    const [flaggedError, setFlaggedError] = useState<string | null>(null);

    function reload(): Promise<void> {
        if (!folderUid) {
            setTasks([]);
            setLoading(false);
            return Promise.resolve();
        }
        setLoading(true);
        setError(null);
        return listTasks(folderUid, { limit: 500 })
            .then(setTasks)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load tasks."))
            .finally(() => setLoading(false));
    }

    useEffect(() => {
        void reload();
    }, [folderUid]);

    useEffect(() => {
        if (view.type !== "flagged" || !mailboxUid) {
            return;
        }
        setFlaggedLoading(true);
        setFlaggedError(null);
        listFlaggedMessages(mailboxUid)
            .then(setFlaggedMessages)
            .catch((err) => setFlaggedError(err instanceof ApiRequestError ? err.message : "Could not load flagged email."))
            .finally(() => setFlaggedLoading(false));
    }, [view, mailboxUid]);

    async function handleCreate(e: FormEvent) {
        e.preventDefault();
        setCreateError(null);
        if (!title.trim()) {
            setCreateError("A title is required.");
            return;
        }
        if (!mailboxUid || !folderUid) {
            return;
        }
        setCreating(true);
        try {
            const created = await createTask({
                mailboxUid,
                folderUid,
                title: title.trim(),
                dueDate: dueDate ? new Date(dueDate).toISOString() : undefined,
                priority,
            });
            setTasks((prev) => [...prev, created]);
            setTitle("");
            setDueDate("");
            setPriority("normal");
        } catch (err) {
            setCreateError(err instanceof ApiRequestError ? err.message : "Could not create this task.");
        } finally {
            setCreating(false);
        }
    }

    async function handleToggle(task: Task) {
        setError(null);
        const nextCompleted = !task.completed;
        setTasks((prev) => prev.map((t) => (t.uid === task.uid ? { ...t, completed: nextCompleted } : t)));
        try {
            const updated = await setTaskCompleted(task, nextCompleted);
            setTasks((prev) => prev.map((t) => (t.uid === task.uid ? updated : t)));
        } catch (err) {
            setTasks((prev) => prev.map((t) => (t.uid === task.uid ? task : t)));
            setError(err instanceof ApiRequestError ? err.message : "Could not update this task.");
        }
    }

    async function handleDelete(task: Task) {
        setError(null);
        try {
            await deleteTask(task.uid, task.version);
            setTasks((prev) => prev.filter((t) => t.uid !== task.uid));
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not delete this task.");
        }
    }

    function handleSelectView(next: TasksView) {
        setView(next);
        setCheckedUids(new Set());
    }

    function toggleChecked(uid: string) {
        setCheckedUids((prev) => {
            const next = new Set(prev);
            if (next.has(uid)) {
                next.delete(uid);
            } else {
                next.add(uid);
            }
            return next;
        });
    }

    const viewFiltered = useMemo(() => {
        switch (view.type) {
            case "myDay":
                return tasks.filter((t) => t.myDay);
            case "important":
                return tasks.filter((t) => t.priority === "high");
            case "planned":
                return tasks.filter((t) => t.dueDate != null);
            case "assignedToMe":
                return tasks.filter((t) => t.assignedTo === userUid);
            case "list":
                return tasks.filter((t) => t.taskListUid === view.uid);
            case "flagged":
                return [];
            case "all":
                return tasks;
        }
    }, [tasks, view, userUid]);

    const checkedTasks = viewFiltered.filter((t) => checkedUids.has(t.uid));

    async function handleBulkComplete() {
        let bulkError: string | null = null;
        for (const task of checkedTasks) {
            try {
                await setTaskCompleted(task, true);
            } catch (err) {
                bulkError = err instanceof ApiRequestError ? err.message : "Could not update one or more tasks.";
            }
        }
        setCheckedUids(new Set());
        await reload();
        setError(bulkError);
    }

    async function handleBulkAddToMyDay() {
        let bulkError: string | null = null;
        for (const task of checkedTasks) {
            try {
                await setTaskMyDay(task, true);
            } catch (err) {
                bulkError = err instanceof ApiRequestError ? err.message : "Could not update one or more tasks.";
            }
        }
        setCheckedUids(new Set());
        await reload();
        setError(bulkError);
    }

    async function handleBulkDelete() {
        let bulkError: string | null = null;
        for (const task of checkedTasks) {
            try {
                await deleteTask(task.uid, task.version);
            } catch (err) {
                bulkError = err instanceof ApiRequestError ? err.message : "Could not delete one or more tasks.";
            }
        }
        setCheckedUids(new Set());
        await reload();
        setError(bulkError);
    }

    const grouped = useMemo(() => {
        const now = new Date();
        const map = new Map<Bucket, Task[]>(BUCKET_ORDER.map((b) => [b, []]));
        for (const task of viewFiltered) {
            if (task.completed) {
                continue;
            }
            map.get(bucketFor(task, now))!.push(task);
        }
        return map;
    }, [viewFiltered]);

    const completedTasks = viewFiltered.filter((t) => t.completed);

    return (
        <div className="flex-1 flex min-h-0">
            <TasksSidebar mailboxUid={mailboxUid} tasks={tasks} userUid={userUid} active={view} onSelect={handleSelectView} />
            <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
                <TasksToolbar
                    viewMode={viewMode}
                    onViewModeChange={setViewMode}
                    selectedCount={checkedTasks.length}
                    onComplete={handleBulkComplete}
                    onDelete={handleBulkDelete}
                    onAddToMyDay={handleBulkAddToMyDay}
                />
                <div role="region" aria-label="Tasks list" className="max-w-2xl mx-auto w-full flex flex-col gap-6 p-6">
                    <h1 className="text-xl font-bold uppercase tracking-wide">Tasks</h1>

                    {error && <Alert>{error}</Alert>}

                    {view.type === "flagged" ? (
                        <FlaggedEmailList loading={flaggedLoading} error={flaggedError} messages={flaggedMessages} />
                    ) : (
                        <>
                            <form onSubmit={handleCreate} className="flex items-center gap-2 bg-surface border border-border rounded-md p-2">
                                <input
                                    type="text"
                                    aria-label="Add a task"
                                    className={`${INPUT_CLASS} flex-1`}
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    placeholder="Add a task"
                                />
                                <input
                                    type="date"
                                    aria-label="Due date"
                                    className={INPUT_CLASS}
                                    value={dueDate}
                                    onChange={(e) => setDueDate(e.target.value)}
                                />
                                <select
                                    aria-label="Priority"
                                    className={INPUT_CLASS}
                                    value={priority}
                                    onChange={(e) => setPriority(e.target.value as TaskPriority)}
                                >
                                    <option value="low">Low</option>
                                    <option value="normal">Normal</option>
                                    <option value="high">High</option>
                                </select>
                                <Button type="submit" loading={creating} disabled={creating} className="!w-auto shrink-0">
                                    Add
                                </Button>
                            </form>
                            {createError && <Alert>{createError}</Alert>}

                            {loading ? (
                                <p className="text-sm text-text-muted">Loading&hellip;</p>
                            ) : viewFiltered.length === 0 ? (
                                <p className="text-sm text-text-muted">No tasks yet.</p>
                            ) : viewMode === "grid" ? (
                                <TaskTable
                                    tasks={viewFiltered}
                                    checkedUids={checkedUids}
                                    onToggleChecked={toggleChecked}
                                    onToggle={handleToggle}
                                    onDelete={handleDelete}
                                />
                            ) : (
                                <>
                                    {BUCKET_ORDER.map((bucket) => {
                                        const items = grouped.get(bucket)!;
                                        if (items.length === 0) {
                                            return null;
                                        }
                                        return (
                                            <TaskGroup
                                                key={bucket}
                                                label={bucket}
                                                tasks={items}
                                                checkedUids={checkedUids}
                                                onToggleChecked={toggleChecked}
                                                onToggle={handleToggle}
                                                onDelete={handleDelete}
                                            />
                                        );
                                    })}
                                    {completedTasks.length > 0 && (
                                        <TaskGroup
                                            label="Completed"
                                            tasks={completedTasks}
                                            checkedUids={checkedUids}
                                            onToggleChecked={toggleChecked}
                                            onToggle={handleToggle}
                                            onDelete={handleDelete}
                                        />
                                    )}
                                </>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function FlaggedEmailList({ loading, error, messages }: { loading: boolean; error: string | null; messages: Message[] }) {
    if (error) {
        return <Alert>{error}</Alert>;
    }
    if (loading) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (messages.length === 0) {
        return <p className="text-sm text-text-muted">No flagged email.</p>;
    }
    return (
        <ul className="bg-surface border border-border rounded-md divide-y divide-border">
            {messages.map((m) => (
                <li key={m.uid} className="flex items-center gap-3 py-2.5 px-3 text-sm">
                    <span className="flex-1 truncate">{m.subject || "(no subject)"}</span>
                    <span className="text-xs text-text-muted shrink-0">{m.from.address}</span>
                    <span className="text-xs text-text-muted shrink-0">{new Date(m.receivedDate).toLocaleDateString()}</span>
                </li>
            ))}
        </ul>
    );
}

/** A circular completion-toggle control matching Outlook's visual language (not a native checkbox), while
 * staying a real accessible toggle. */
function CompletionToggle({ task, onToggle }: { task: Task; onToggle: (task: Task) => void }) {
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={task.completed}
            aria-label={`Mark "${task.title}" as ${task.completed ? "not complete" : "complete"}`}
            onClick={() => onToggle(task)}
            className={[
                "w-4 h-4 rounded-full border shrink-0 flex items-center justify-center text-[10px]",
                task.completed ? "bg-primary border-primary text-white" : "border-border text-transparent",
            ].join(" ")}
        >
            &#10003;
        </button>
    );
}

interface TaskGroupProps {
    label: string;
    tasks: Task[];
    checkedUids: Set<string>;
    onToggleChecked: (uid: string) => void;
    onToggle: (task: Task) => void;
    onDelete: (task: Task) => void;
}

function TaskGroup({ label, tasks, checkedUids, onToggleChecked, onToggle, onDelete }: TaskGroupProps) {
    return (
        <div>
            <h2 className="text-xs font-bold uppercase tracking-wide text-text-muted mb-2">{label}</h2>
            <ul className="bg-surface border border-border rounded-md divide-y divide-border">
                {tasks.map((task) => (
                    <li key={task.uid} className="flex items-center gap-3 py-2.5 px-3">
                        <input
                            type="checkbox"
                            aria-label={`Select ${task.title}`}
                            checked={checkedUids.has(task.uid)}
                            onChange={() => onToggleChecked(task.uid)}
                        />
                        <CompletionToggle task={task} onToggle={onToggle} />
                        <span className={["flex-1 text-sm", task.completed ? "line-through text-text-muted" : ""].join(" ")}>
                            {task.title}
                        </span>
                        {task.priority !== "normal" && (
                            <span className={["text-xs font-medium", PRIORITY_CLASS[task.priority]].join(" ")}>
                                {PRIORITY_LABEL[task.priority]}
                            </span>
                        )}
                        {task.dueDate && (
                            <span className="text-xs text-text-muted shrink-0">{new Date(task.dueDate).toLocaleDateString()}</span>
                        )}
                        <button
                            type="button"
                            onClick={() => onDelete(task)}
                            aria-label={`Delete "${task.title}"`}
                            className="text-text-muted hover:text-danger text-sm px-1"
                        >
                            &times;
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

interface TaskTableProps {
    tasks: Task[];
    checkedUids: Set<string>;
    onToggleChecked: (uid: string) => void;
    onToggle: (task: Task) => void;
    onDelete: (task: Task) => void;
}

function TaskTable({ tasks, checkedUids, onToggleChecked, onToggle, onDelete }: TaskTableProps) {
    const allChecked = tasks.length > 0 && tasks.every((t) => checkedUids.has(t.uid));

    function toggleAll() {
        if (allChecked) {
            // Every task is already checked when this branch runs (that's what `allChecked` means) — no
            // per-task guard needed, unlike the `else` branch below where only *some* tasks may be checked.
            for (const t of tasks) {
                onToggleChecked(t.uid);
            }
        } else {
            for (const t of tasks) {
                if (!checkedUids.has(t.uid)) {
                    onToggleChecked(t.uid);
                }
            }
        }
    }

    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm bg-surface border border-border rounded-md">
                <thead>
                    <tr className="border-b border-border text-left">
                        <th className="w-8 px-3 py-2">
                            <input type="checkbox" aria-label="Select all tasks" checked={allChecked} onChange={toggleAll} />
                        </th>
                        <th className="w-8 px-3 py-2" />
                        <th className="px-3 py-2 text-xs font-bold uppercase tracking-wide text-text-muted">Title</th>
                        <th className="px-3 py-2 text-xs font-bold uppercase tracking-wide text-text-muted">Due Date</th>
                        <th className="px-3 py-2 text-xs font-bold uppercase tracking-wide text-text-muted">Importance</th>
                        <th className="w-8 px-3 py-2" />
                    </tr>
                </thead>
                <tbody>
                    {tasks.map((task) => (
                        <tr key={task.uid} className="border-b border-border last:border-0">
                            <td className="px-3 py-2">
                                <input
                                    type="checkbox"
                                    aria-label={`Select ${task.title}`}
                                    checked={checkedUids.has(task.uid)}
                                    onChange={() => onToggleChecked(task.uid)}
                                />
                            </td>
                            <td className="px-3 py-2">
                                <CompletionToggle task={task} onToggle={onToggle} />
                            </td>
                            <td className={["px-3 py-2", task.completed ? "line-through text-text-muted" : ""].join(" ")}>{task.title}</td>
                            <td className="px-3 py-2 text-text-muted">{task.dueDate ? new Date(task.dueDate).toLocaleDateString() : ""}</td>
                            <td className={["px-3 py-2", PRIORITY_CLASS[task.priority]].join(" ")}>{PRIORITY_LABEL[task.priority]}</td>
                            <td className="px-3 py-2">
                                <button
                                    type="button"
                                    onClick={() => onDelete(task)}
                                    aria-label={`Delete "${task.title}"`}
                                    className="text-text-muted hover:text-danger text-sm px-1"
                                >
                                    &times;
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
