///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";
import { HiChevronDown } from "react-icons/hi2";
import FolderBadgeChip from "./FolderBadgeChip.js";

export interface SidebarSectionProps {
    /** Unique per rendering of the sidebar (it is on screen twice on a phone: beside the list and in the drawer): names the folder list the heading controls. */
    domId: string;
    /** The heading's text. */
    label: ReactNode;
    /** Whether the heading is a toggle at all. Not for a lone mailbox, whose section has nothing to be hidden for. */
    collapsible: boolean;
    expanded: boolean;
    onToggle: () => void;
    /** The unread mail in the section's folders that carry an unread count (see `unreadBadgeTotal()`), shown on the heading while it is collapsed (and only when there is some) so new mail in a hidden section is still noticed. */
    unread?: number;
    /** Shown between the heading and the folders, collapsed or not: a failure to load the section's folders is not something to hide. */
    notice?: ReactNode;
    /** The section's folder rows. */
    children: ReactNode;
}

/**
 * One section of Mail's sidebar ("All mailboxes", or one mailbox): a heading over a list of folders. When `collapsible` the heading is a
 * disclosure button (`aria-expanded`, `aria-controls` the list, a chevron that turns) and the list is `hidden` while it is collapsed -
 * kept in the document, so the button's `aria-controls` always names something and nothing is fetched or rebuilt on opening it.
 */
export default function SidebarSection({ domId, label, collapsible, expanded, onToggle, unread = 0, notice, children }: SidebarSectionProps) {
    const shown = !collapsible || expanded;
    return (
        <div>
            {collapsible ? (
                <h2 className="mb-1">
                    <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={domId}
                        onClick={onToggle}
                        className={[
                            "flex w-full items-center gap-1 rounded-sm px-2.5 py-0.5 text-left text-xs font-bold uppercase tracking-wide text-text-muted",
                            "focus-visible:outline-2 focus-visible:outline-primary",
                            "hover:bg-surface-alt hover:text-text",
                        ].join(" ")}
                    >
                        <HiChevronDown
                            size={14}
                            aria-hidden="true"
                            className={["shrink-0 transition-transform", expanded ? "" : "-rotate-90"].join(" ")}
                        />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {!expanded && unread > 0 && <FolderBadgeChip badge={{ kind: "unread", value: unread }} />}
                    </button>
                </h2>
            ) : (
                <div className="text-xs font-bold uppercase tracking-wide text-text-muted mb-1 px-2.5 truncate">{label}</div>
            )}
            {notice}
            <div id={domId} hidden={!shown} className={shown ? "flex flex-col gap-0.5" : "hidden"}>
                {children}
            </div>
        </div>
    );
}
