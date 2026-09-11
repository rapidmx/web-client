///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { IconType } from "react-icons";
import { HiOutlineCheckCircle, HiOutlineListBullet, HiOutlineSun, HiOutlineTableCells, HiOutlineTrash } from "react-icons/hi2";

export type TasksViewMode = "list" | "grid";

export interface TasksToolbarProps {
    viewMode: TasksViewMode;
    onViewModeChange: (mode: TasksViewMode) => void;
    selectedCount: number;
    onComplete: () => void;
    onDelete: () => void;
    onAddToMyDay: () => void;
}

function ToolbarButton({
    label,
    icon: Icon,
    active,
    disabled,
    onClick,
}: {
    label: string;
    icon: IconType;
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className={[
                "flex flex-col items-center gap-1 text-xs px-2.5 py-1.5 rounded-sm disabled:opacity-40 disabled:cursor-not-allowed",
                active ? "bg-primary/10 text-primary-dark" : "text-text-muted hover:not-disabled:bg-surface-alt hover:not-disabled:text-text",
            ].join(" ")}
        >
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
        </button>
    );
}

/** Tasks' toolbar: a Grid/List view-mode toggle (local, not persisted) plus bulk actions for whatever
 * rows are checked (Complete, Add to My Day, Delete) — deliberately presentational, matching
 * `ContactsToolbar`'s convention, since the page owns the actual task data/selection. */
export default function TasksToolbar({ viewMode, onViewModeChange, selectedCount, onComplete, onDelete, onAddToMyDay }: TasksToolbarProps) {
    const hasSelection = selectedCount > 0;

    return (
        <div role="toolbar" aria-label="Tasks actions" className="border-b border-border bg-surface-alt flex items-center gap-0.5 px-2 py-1">
            <ToolbarButton label="List" icon={HiOutlineListBullet} active={viewMode === "list"} onClick={() => onViewModeChange("list")} />
            <ToolbarButton label="Grid" icon={HiOutlineTableCells} active={viewMode === "grid"} onClick={() => onViewModeChange("grid")} />
            <div className="w-px self-stretch my-1 bg-border" aria-hidden="true" />
            <ToolbarButton label="Complete" icon={HiOutlineCheckCircle} disabled={!hasSelection} onClick={onComplete} />
            <ToolbarButton label="Add to My Day" icon={HiOutlineSun} disabled={!hasSelection} onClick={onAddToMyDay} />
            <ToolbarButton label="Delete" icon={HiOutlineTrash} disabled={!hasSelection} onClick={onDelete} />
        </div>
    );
}
