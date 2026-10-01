///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState } from "react";
import type { IconType } from "react-icons";
import { HiOutlineEllipsisHorizontal } from "react-icons/hi2";
import NavBadge, { navItemLabel } from "./NavBadge.js";

/** A single icon-rail/bottom-tab entry — deliberately generic (not tied to `AppShell`'s own
 * `AppDef`/`AppShellApp`) so both `AppShell` (www) and `AdminShell` (admin) can share this component
 * for their own, differently-shaped nav item sets. */
export interface NavItem {
    id: string;
    href: string;
    label: string;
    icon: IconType;
    /** A count drawn as a chip on the icon (unread mail) and named in the link's accessible name; nothing at zero or when absent. */
    badge?: number;
}

export interface BottomTabBarProps {
    apps: NavItem[];
    active: string;
}

/** The most entries the bar shows at once: any more and the last slot becomes "More", holding the rest. */
export const MAX_TABS = 5;

/**
 * The entries to draw directly on the bar and the ones left for the "More" menu. Up to `MAX_TABS` entries all show. With more, the bar shows the first
 * `MAX_TABS - 1` and "More" holds the rest - except that the active entry is always on the bar (it takes the last slot when it would otherwise be hidden), so the reader
 * can see where they are.
 */
export function splitTabs(apps: NavItem[], active: string): { shown: NavItem[]; more: NavItem[] } {
    if (apps.length <= MAX_TABS) {
        return { shown: apps, more: [] };
    }
    const slots = MAX_TABS - 1;
    const activeItem = apps.find((app) => app.id === active);
    const hidden = !!activeItem && apps.indexOf(activeItem) >= slots;
    const shown = hidden ? [...apps.slice(0, slots - 1), activeItem] : apps.slice(0, slots);
    return { shown, more: apps.filter((app) => !shown.includes(app)) };
}

const TAB_CLASS = "flex-1 min-w-0 overflow-hidden px-1 flex flex-col items-center justify-center gap-0.5 text-[10px] leading-tight text-center font-medium";

/**
 * The mobile counterpart to an icon rail (`AppShell`'s Mail/Calendar/Contacts/Tasks, or `AdminShell`'s
 * Mailboxes/Quarantine/Ingest Queue) — same data, same full-page-nav `<a href>` links (this framework
 * has no client-side router), just relocated to a fixed bottom bar instead of a persistent left rail,
 * which doesn't fit below the `md` breakpoint. Only ever rendered alongside that rail (`md:hidden` here,
 * `hidden md:flex` there) — never both hidden or both visible at once.
 *
 * The entries share the width equally and never run off the screen: with more than `MAX_TABS`, the last slot is a "More" (…) button that opens a menu
 * of the others (see `splitTabs()`). The menu closes on Escape, on a click elsewhere and on choosing an entry.
 */
export default function BottomTabBar({ apps, active }: BottomTabBarProps) {
    const { shown, more } = splitTabs(apps, active);
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        function handlePointer(event: MouseEvent | TouchEvent) {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        }
        function handleKey(event: KeyboardEvent) {
            if (event.key === "Escape") {
                setOpen(false);
                buttonRef.current?.focus();
            }
        }
        document.addEventListener("mousedown", handlePointer);
        document.addEventListener("touchstart", handlePointer);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handlePointer);
            document.removeEventListener("touchstart", handlePointer);
            document.removeEventListener("keydown", handleKey);
        };
    }, [open]);

    // The unread count of an entry that is behind "More" is still worth a dot on it.
    const hiddenBadge = more.some((app) => (app.badge ?? 0) > 0);

    return (
        <nav aria-label="Mobile navigation" className="md:hidden fixed bottom-0 inset-x-0 z-30 h-14 bg-surface border-t border-border flex items-stretch">
            {shown.map(({ id, href, label, icon: Icon, badge }) => (
                <a
                    key={id}
                    href={href}
                    aria-label={badge ? navItemLabel(label, badge) : undefined}
                    aria-current={id === active ? "page" : undefined}
                    className={[TAB_CLASS, id === active ? "text-primary-dark" : "text-text-muted"].join(" ")}
                >
                    <span className="relative inline-flex">
                        <Icon size={20} aria-hidden="true" />
                        <NavBadge count={badge} />
                    </span>
                    {label}
                </a>
            ))}
            {more.length > 0 && (
                <div ref={rootRef} className="flex-1 min-w-0 flex items-stretch relative">
                    <button
                        ref={buttonRef}
                        type="button"
                        aria-label={hiddenBadge ? "More, with unread items" : "More"}
                        aria-haspopup="menu"
                        aria-expanded={open}
                        onClick={() => setOpen((value) => !value)}
                        className={[TAB_CLASS, "w-full", open ? "text-primary-dark" : "text-text-muted"].join(" ")}
                    >
                        <span className="relative inline-flex">
                            <HiOutlineEllipsisHorizontal size={20} aria-hidden="true" />
                            {hiddenBadge && <span aria-hidden="true" data-testid="more-dot" className="absolute -top-0.5 -right-1 size-2 rounded-full bg-danger" />}
                        </span>
                        <span>More</span>
                    </button>
                    {open && (
                        <ul role="menu" aria-label="More" className="absolute bottom-full right-1 mb-2 min-w-48 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-surface py-1 shadow-modal">
                            {more.map(({ id, href, label, icon: Icon, badge }) => (
                                <li key={id} role="none">
                                    <a
                                        role="menuitem"
                                        href={href}
                                        aria-label={badge ? navItemLabel(label, badge) : undefined}
                                        onClick={() => setOpen(false)}
                                        className="flex items-center gap-3 px-4 py-3 text-sm text-text hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-primary"
                                    >
                                        <span className="relative inline-flex">
                                            <Icon size={20} aria-hidden="true" />
                                            <NavBadge count={badge} />
                                        </span>
                                        {label}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </nav>
    );
}
