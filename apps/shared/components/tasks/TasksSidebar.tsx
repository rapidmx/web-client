///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { HiOutlineBars3 } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { Task, TaskList, createTaskList, listTaskLists } from "@rapidmx/react-shared/tasksApi.js";
import Drawer from "@rapidmx/react-shared/Drawer.js";

export type TasksView =
    | { type: "myDay" }
    | { type: "important" }
    | { type: "planned" }
    | { type: "assignedToMe" }
    | { type: "flagged" }
    | { type: "all" }
    | { type: "list"; uid: string; name: string };

export function tasksViewKey(view: TasksView): string {
    return view.type === "list" ? `list:${view.uid}` : view.type;
}

export interface TasksSidebarProps {
    mailboxUid?: string;
    /** The caller's own (incomplete) tasks — used to compute every smart-filter's count. Deliberately not
     * fetched again here; the parent already has this loaded for the main list. */
    tasks: Task[];
    userUid?: string;
    active: TasksView;
    onSelect: (view: TasksView) => void;
    /** Bumped by the parent to force a contact-list-style re-fetch of task lists (mirrors
     * `ContactsSidebar`'s identical prop) — not currently used by any caller, kept for parity/future use. */
    refreshToken?: number;
}

function NavItem({ label, count, active, onClick }: { label: string; count?: number; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? "true" : undefined}
            className={[
                "w-full flex items-center justify-between gap-2 text-sm text-left px-2.5 py-1.5 rounded-sm",
                active ? "bg-primary/10 text-primary-dark font-semibold" : "text-text hover:bg-surface-alt",
            ].join(" ")}
        >
            <span className="truncate">{label}</span>
            {count !== undefined && <span className="text-xs text-text-muted shrink-0">{count}</span>}
        </button>
    );
}

/**
 * Tasks' Outlook To-Do-style left sidebar. "My Day"/"Assigned to me" are real persisted fields
 * (`Task.myDay`/`assignedTo`, from Phase 0); "Important"/"Planned" are pure smart-filters derived from
 * already-loaded fields (`priority === "high"`/`dueDate != null`) with no backend concept of their own;
 * "Flagged email" is a `Message` smart-filter (see `flaggedMessages.ts`), not a `Task` one at all — the
 * page renders it as a distinct list, not the task table. "Tasks" is the flat, unfiltered default. Custom
 * lists are real `TaskList` records, fetched here (same pattern as `ContactsSidebar`'s contact lists).
 */
export default function TasksSidebar({ mailboxUid, tasks, userUid, active, onSelect, refreshToken }: TasksSidebarProps) {
    const [lists, setLists] = useState<TaskList[]>([]);
    const [listsError, setListsError] = useState<string | null>(null);
    const [addingList, setAddingList] = useState(false);
    const [newListName, setNewListName] = useState("");
    const [drawerOpen, setDrawerOpen] = useState(false);

    useEffect(() => {
        if (!mailboxUid) {
            setLists([]);
            return;
        }
        setListsError(null);
        listTaskLists(mailboxUid, { limit: 200 })
            .then(setLists)
            .catch((err) => setListsError(err instanceof ApiRequestError ? err.message : "Could not load task lists."));
    }, [mailboxUid, refreshToken]);

    const myDayCount = useMemo(() => tasks.filter((t) => t.myDay).length, [tasks]);
    const importantCount = useMemo(() => tasks.filter((t) => t.priority === "high").length, [tasks]);
    const plannedCount = useMemo(() => tasks.filter((t) => t.dueDate != null).length, [tasks]);
    const assignedToMeCount = useMemo(() => tasks.filter((t) => t.assignedTo === userUid).length, [tasks, userUid]);
    const listCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const t of tasks) {
            if (t.taskListUid) {
                counts.set(t.taskListUid, (counts.get(t.taskListUid) ?? 0) + 1);
            }
        }
        return counts;
    }, [tasks]);

    async function handleAddList(e: FormEvent) {
        e.preventDefault();
        if (!mailboxUid || !newListName.trim()) {
            return;
        }
        try {
            const created = await createTaskList({ mailboxUid, name: newListName.trim() });
            setLists((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
            setNewListName("");
            setAddingList(false);
        } catch (err) {
            setListsError(err instanceof ApiRequestError ? err.message : "Could not create this list.");
        }
    }

    function handleSelect(view: TasksView) {
        onSelect(view);
        setDrawerOpen(false);
    }

    // A function, not a plain JSX constant — rendered both in the desktop `<nav>` and the mobile
    // `Drawer` (see `ContactsSidebar` for the identical pattern and the duplicate-id reasoning behind
    // the `idPrefix`).
    const navContent = (idPrefix: string) => (
        <>
            <div className="flex flex-col gap-0.5">
                <NavItem label="My Day" count={myDayCount} active={active.type === "myDay"} onClick={() => handleSelect({ type: "myDay" })} />
                <NavItem
                    label="Important"
                    count={importantCount}
                    active={active.type === "important"}
                    onClick={() => handleSelect({ type: "important" })}
                />
                <NavItem label="Planned" count={plannedCount} active={active.type === "planned"} onClick={() => handleSelect({ type: "planned" })} />
                <NavItem
                    label="Assigned to me"
                    count={assignedToMeCount}
                    active={active.type === "assignedToMe"}
                    onClick={() => handleSelect({ type: "assignedToMe" })}
                />
                <NavItem label="Flagged email" active={active.type === "flagged"} onClick={() => handleSelect({ type: "flagged" })} />
            </div>

            <NavItem label="Tasks" count={tasks.length} active={active.type === "all"} onClick={() => handleSelect({ type: "all" })} />

            <div>
                <div className="flex items-center justify-between px-2.5 mb-1">
                    <h2 className="text-xs font-bold uppercase tracking-wide text-text-muted">Lists</h2>
                    <button
                        type="button"
                        onClick={() => setAddingList(true)}
                        aria-label="New list"
                        className="text-xs font-bold text-primary-dark hover:underline"
                    >
                        +
                    </button>
                </div>
                {listsError && <p className="px-2.5 text-xs text-danger">{listsError}</p>}
                <div className="flex flex-col gap-0.5">
                    {lists.map((list) => (
                        <NavItem
                            key={list.uid}
                            label={list.name}
                            count={listCounts.get(list.uid) ?? 0}
                            active={active.type === "list" && active.uid === list.uid}
                            onClick={() => handleSelect({ type: "list", uid: list.uid, name: list.name })}
                        />
                    ))}
                </div>
                {addingList && (
                    <form onSubmit={handleAddList} className="flex items-center gap-1 px-2.5 mt-1">
                        <input
                            type="text"
                            autoFocus
                            aria-label="New list name"
                            id={`${idPrefix}-new-list-name`}
                            value={newListName}
                            onChange={(e) => setNewListName(e.target.value)}
                            className="flex-1 text-xs py-1 px-1.5 border border-border rounded-sm bg-surface"
                        />
                        <button type="submit" className="text-xs font-semibold text-primary-dark">
                            Add
                        </button>
                    </form>
                )}
            </div>
        </>
    );

    return (
        <>
            <button
                type="button"
                className="md:hidden m-3 w-9 h-9 flex items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text"
                aria-label="Open tasks menu"
                onClick={() => setDrawerOpen(true)}
            >
                <HiOutlineBars3 size={20} aria-hidden="true" />
            </button>
            <nav aria-label="Tasks" className="hidden md:flex w-56 shrink-0 border-r border-border flex-col gap-4 p-3 overflow-y-auto">
                {navContent("desktop")}
            </nav>
            <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Tasks">
                <div className="flex flex-col gap-4">{navContent("mobile")}</div>
            </Drawer>
        </>
    );
}
