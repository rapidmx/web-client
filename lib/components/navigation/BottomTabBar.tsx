///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef } from "react";
import type { IconType } from "react-icons";

/** A single icon-rail/bottom-tab entry — deliberately generic (not tied to `AppShell`'s own
 * `AppDef`/`AppShellApp`) so both `AppShell` (www) and `AdminShell` (admin) can share this component
 * for their own, differently-shaped nav item sets. */
export interface NavItem {
    id: string;
    href: string;
    label: string;
    icon: IconType;
}

export interface BottomTabBarProps {
    apps: NavItem[];
    active: string;
}

/**
 * The mobile counterpart to an icon rail (`AppShell`'s Mail/Calendar/Contacts/Tasks, or `AdminShell`'s
 * Mailboxes/Quarantine/Ingest Queue) — same data, same full-page-nav `<a href>` links (this framework
 * has no client-side router), just relocated to a fixed bottom bar instead of a persistent left rail,
 * which doesn't fit below the `md` breakpoint. Only ever rendered alongside that rail (`md:hidden` here,
 * `hidden md:flex` there) — never both hidden or both visible at once.
 *
 * A few items share the width equally; a long list (the admin console has ten or so) doesn't fit at a readable size, so each
 * item keeps a minimum width, its label wraps onto a second line rather than running into its neighbour's, and the bar scrolls
 * sideways - opening with the active item in view.
 */
export default function BottomTabBar({ apps, active }: BottomTabBarProps) {
    const activeRef = useRef<HTMLAnchorElement | null>(null);
    useEffect(() => {
        const item = activeRef.current;
        const bar = item?.parentElement;
        if (item && bar && bar.scrollWidth > bar.clientWidth) {
            // Set directly rather than `scrollIntoView()`, which would scroll the page as well.
            bar.scrollLeft = item.offsetLeft - (bar.clientWidth - item.offsetWidth) / 2;
        }
    }, [active]);
    return (
        <nav
            aria-label="Mobile navigation"
            className="md:hidden fixed bottom-0 inset-x-0 z-30 h-14 bg-surface border-t border-border flex items-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
            {apps.map(({ id, href, label, icon: Icon }) => (
                <a
                    key={id}
                    href={href}
                    ref={id === active ? activeRef : undefined}
                    aria-current={id === active ? "page" : undefined}
                    className={[
                        "flex-1 shrink-0 min-w-[4.75rem] px-1 flex flex-col items-center justify-center gap-0.5 text-[10px] leading-tight text-center font-medium",
                        id === active ? "text-primary-dark" : "text-text-muted",
                    ].join(" ")}
                >
                    <Icon size={20} aria-hidden="true" />
                    {label}
                </a>
            ))}
        </nav>
    );
}
