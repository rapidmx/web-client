///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, ReactNode, useEffect, useState } from "react";
import { parseISO } from "date-fns";
import {
    HiOutlineBars3BottomLeft,
    HiOutlineBell,
    HiOutlineClock,
    HiOutlineFlag,
    HiOutlineFolder,
    HiOutlineListBullet,
    HiOutlineSun,
    HiOutlineXMark,
} from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { TaskList, TaskPriority, createTask, listTaskLists } from "@rapidmx/react-shared/tasks/tasksApi.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { findWellKnownFolderUid } from "../../mail/findWellKnownFolderUid.js";
import { notify } from "../../notifications/store.js";
import { EventFormController } from "./eventForm.js";
import { INPUT_CLASS, IconRow, SELECT_CLASS } from "./EventFormParts.js";
import QuickFaceFrame from "./QuickFaceFrame.js";

/**
 * What the Task tab holds besides the title (which is the Event tab's): kept by `QuickCreateFaces`, so it survives a trip to another tab.
 * `dueDate` and `reminder` are on the device's clock, as the Tasks app's own form reads them.
 */
export interface TaskDraft {
    /** `yyyy-MM-dd`, or `""` for a task with no due date. */
    dueDate: string;
    /** A date-only due date (local midnight, what the Tasks app writes) rather than a time on it. */
    allDay: boolean;
    /** `HH:mm`, used when `allDay` is off. */
    dueTime: string;
    /** The `TaskList` chosen; `""` is the default "Tasks" list. */
    listUid: string;
    body: string;
    priority: TaskPriority;
    /** `yyyy-MM-ddTHH:mm`, or `""` for no reminder. */
    reminder: string;
    myDay: boolean;
}

/** A new task's starting values: due on the day of the slot or day that was clicked, all day, with the slot's time ready if a time is wanted. */
export function initialTaskDraft(start: string, allDayClick: boolean): TaskDraft {
    return {
        dueDate: start.slice(0, 10),
        allDay: true,
        dueTime: allDayClick ? "09:00" : start.slice(11, 16),
        listUid: "",
        body: "",
        priority: "normal",
        reminder: "",
        myDay: false,
    };
}

export interface TaskQuickFormProps {
    c: EventFormController;
    draft: TaskDraft;
    onDraftChange: (patch: Partial<TaskDraft>) => void;
    tabs: ReactNode;
    /** The card: notes, priority, a reminder and My Day as well. */
    expanded: boolean;
    onExpand: () => void;
}

/**
 * The Task tab of the New event popover (and, with More options, its card): creates a task in the chosen mailbox's Tasks folder with
 * `POST /api/mail/tasks`. Title, due date (all day, or a time on it), which mailbox and - when the mailbox has any - which task list; the
 * card adds notes, priority, a reminder and My Day - every field a `Task` has that a person can fill in (an assignee is chosen in the Tasks app).
 * The calendar does not show tasks, so a save closes the popover with a "Task added" notification instead of reloading anything.
 */
export default function TaskQuickForm({ c, draft, onDraftChange, tabs, expanded, onExpand }: TaskQuickFormProps) {
    const { values } = c;
    const [lists, setLists] = useState<TaskList[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // The chosen mailbox's task lists (a mailbox with none has just the default one, and no choice is shown).
    useEffect(() => {
        let cancelled = false;
        setLists([]);
        void listTaskLists(values.targetMailboxUid)
            .catch((): TaskList[] => [])
            .then((result) => {
                if (!cancelled) {
                    setLists(result);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [values.targetMailboxUid]);

    const mailboxChoices = c.mailboxOptions && c.mailboxOptions.length > 1 ? c.mailboxOptions : undefined;
    // A list of another mailbox that was chosen before the mailbox changed is no longer one.
    const listUid = lists.some((list) => list.uid === draft.listUid) ? draft.listUid : "";

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        setError(null);
        const title = values.title.trim();
        if (!title) {
            setError("A title is required.");
            return;
        }
        if (draft.dueDate && !draft.allDay && !draft.dueTime) {
            setError("Pick a time, or choose All day.");
            return;
        }
        setSaving(true);
        try {
            const mailboxUid = values.targetMailboxUid;
            const folderUid = await findWellKnownFolderUid(mailboxUid, "tasks");
            if (!folderUid) {
                setError("That mailbox has no Tasks folder.");
                return;
            }
            await createTask({
                mailboxUid,
                folderUid,
                title,
                body: draft.body.trim() || undefined,
                // A date-only due date is the local day's midnight, the way the Tasks app writes one.
                dueDate: draft.dueDate ? parseISO(draft.allDay ? draft.dueDate : `${draft.dueDate}T${draft.dueTime}`).toISOString() : undefined,
                priority: draft.priority,
                reminderDate: draft.reminder ? parseISO(draft.reminder).toISOString() : undefined,
                taskListUid: listUid || undefined,
                myDay: draft.myDay || undefined,
            });
            notify({ kind: "success", title: "Task added", message: `“${title}” was added to Tasks.` });
            c.onCancel();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create this task.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <QuickFaceFrame
            c={c}
            tabs={tabs}
            tab="task"
            error={error}
            onSubmit={(event) => void handleSubmit(event)}
            footer={
                <>
                    {!expanded && (
                        <Button type="button" variant="text" className="!w-auto" onClick={onExpand}>
                            More options
                        </Button>
                    )}
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Save
                    </Button>
                </>
            }
        >
            <IconRow icon={<HiOutlineClock size={20} />}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                    <input
                        type="date"
                        aria-label="Due date"
                        className={`${SELECT_CLASS} min-w-0`}
                        value={draft.dueDate}
                        onChange={(e) => onDraftChange({ dueDate: e.target.value })}
                    />
                    {draft.dueDate && !draft.allDay && (
                        <input
                            type="time"
                            aria-label="Due time"
                            className={`${SELECT_CLASS} min-w-0`}
                            value={draft.dueTime}
                            onChange={(e) => onDraftChange({ dueTime: e.target.value })}
                        />
                    )}
                    {draft.dueDate && (
                        <label className="flex items-center gap-2">
                            <input type="checkbox" checked={draft.allDay} onChange={(e) => onDraftChange({ allDay: e.target.checked })} />
                            All day
                        </label>
                    )}
                </div>
            </IconRow>

            {mailboxChoices && (
                <IconRow icon={<HiOutlineFolder size={20} />}>
                    <select
                        aria-label="Mailbox"
                        className={`${SELECT_CLASS} max-w-full`}
                        value={values.targetMailboxUid}
                        onChange={(e) => c.onMailboxChange(e.target.value)}
                    >
                        {mailboxChoices.map(({ mailbox }) => (
                            <option key={mailbox.uid} value={mailbox.uid}>
                                {mailbox.displayName}
                                {mailbox.ownerUserUid ? "" : " (shared)"}
                            </option>
                        ))}
                    </select>
                </IconRow>
            )}

            {lists.length > 0 && (
                <IconRow icon={<HiOutlineListBullet size={20} />}>
                    <select
                        aria-label="Task list"
                        className={`${SELECT_CLASS} max-w-full`}
                        value={listUid}
                        onChange={(e) => onDraftChange({ listUid: e.target.value })}
                    >
                        <option value="">Tasks</option>
                        {lists.map((list) => (
                            <option key={list.uid} value={list.uid}>
                                {list.name}
                            </option>
                        ))}
                    </select>
                </IconRow>
            )}

            {expanded && (
                <>
                    <IconRow icon={<HiOutlineBars3BottomLeft size={20} />}>
                        <textarea
                            aria-label="Notes"
                            rows={3}
                            placeholder="Add notes"
                            className={INPUT_CLASS}
                            value={draft.body}
                            onChange={(e) => onDraftChange({ body: e.target.value })}
                        />
                    </IconRow>
                    <IconRow icon={<HiOutlineFlag size={20} />}>
                        <select
                            aria-label="Priority"
                            className={`${SELECT_CLASS} max-w-full`}
                            value={draft.priority}
                            onChange={(e) => onDraftChange({ priority: e.target.value as TaskPriority })}
                        >
                            <option value="low">Low priority</option>
                            <option value="normal">Normal priority</option>
                            <option value="high">High priority</option>
                        </select>
                    </IconRow>
                    <IconRow icon={<HiOutlineBell size={20} />}>
                        {draft.reminder ? (
                            <div className="flex items-center gap-2 text-sm">
                                <input
                                    type="datetime-local"
                                    aria-label="Reminder"
                                    className={`${SELECT_CLASS} min-w-0`}
                                    value={draft.reminder}
                                    onChange={(e) => onDraftChange({ reminder: e.target.value })}
                                />
                                <button
                                    type="button"
                                    aria-label="Remove reminder"
                                    className="w-7 h-7 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                                    onClick={() => onDraftChange({ reminder: "" })}
                                >
                                    <HiOutlineXMark size={16} aria-hidden="true" />
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                className="text-sm text-text-muted hover:text-text py-1.5"
                                onClick={() => onDraftChange({ reminder: `${draft.dueDate || values.start.slice(0, 10)}T09:00` })}
                            >
                                Add reminder
                            </button>
                        )}
                    </IconRow>
                    <IconRow icon={<HiOutlineSun size={20} />}>
                        <label className="flex items-center gap-2 text-sm py-1.5">
                            <input type="checkbox" checked={draft.myDay} onChange={(e) => onDraftChange({ myDay: e.target.checked })} />
                            Add to My Day
                        </label>
                    </IconRow>
                </>
            )}
        </QuickFaceFrame>
    );
}
