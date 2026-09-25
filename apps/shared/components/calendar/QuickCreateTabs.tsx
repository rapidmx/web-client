///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { KeyboardEvent } from "react";

/** What the New event popover can create. */
export type QuickTab = "event" | "task" | "appointment";

const TAB_LABELS: Record<QuickTab, string> = { event: "Event", task: "Task", appointment: "Appointment schedule" };

/** The DOM ids that tie each tab to its panel (`aria-controls` / `aria-labelledby`). */
export function quickTabId(tab: QuickTab): string {
    return `quick-create-tab-${tab}`;
}
export function quickPanelId(tab: QuickTab): string {
    return `quick-create-panel-${tab}`;
}

/** The attributes of the element holding the selected tab's content. */
export function quickPanelProps(tab: QuickTab) {
    return { role: "tabpanel" as const, id: quickPanelId(tab), "aria-labelledby": quickTabId(tab) };
}

export interface QuickCreateTabsProps {
    tab: QuickTab;
    onChange: (tab: QuickTab) => void;
    /** Whether the booking plugin is running: without it there is no Appointment schedule tab. */
    showAppointment: boolean;
}

/**
 * The segmented control across the top of the New event popover: Event, Task and (when the booking plugin is running) Appointment schedule.
 * A WAI-ARIA tab list with automatic activation: only the selected tab is in the Tab order, and the arrow keys (wrapping), Home and End
 * move to and select another.
 */
export default function QuickCreateTabs({ tab, onChange, showAppointment }: QuickCreateTabsProps) {
    const tabs: QuickTab[] = showAppointment ? ["event", "task", "appointment"] : ["event", "task"];

    function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        const index = tabs.indexOf(tab);
        let next: QuickTab;
        if (event.key === "ArrowRight") {
            next = tabs[(index + 1) % tabs.length];
        } else if (event.key === "ArrowLeft") {
            next = tabs[(index + tabs.length - 1) % tabs.length];
        } else if (event.key === "Home") {
            next = tabs[0];
        } else if (event.key === "End") {
            next = tabs[tabs.length - 1];
        } else {
            return;
        }
        event.preventDefault();
        onChange(next);
    }

    return (
        <div role="tablist" aria-label="What to create" className="mx-5 mb-3 flex gap-1 rounded-lg bg-surface-alt p-1">
            {tabs.map((id) => (
                <button
                    key={id}
                    type="button"
                    role="tab"
                    id={quickTabId(id)}
                    aria-selected={id === tab}
                    aria-controls={quickPanelId(id)}
                    tabIndex={id === tab ? 0 : -1}
                    onClick={() => onChange(id)}
                    onKeyDown={handleKeyDown}
                    className={[
                        "flex-1 min-w-0 rounded-md px-2 py-1.5 text-sm font-medium truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                        id === tab ? "bg-surface text-text shadow-sm" : "text-text-muted hover:text-text",
                    ].join(" ")}
                >
                    {TAB_LABELS[id]}
                </button>
            ))}
        </div>
    );
}
