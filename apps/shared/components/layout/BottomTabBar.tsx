///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
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
 */
export default function BottomTabBar({ apps, active }: BottomTabBarProps) {
    return (
        <nav
            aria-label="Mobile navigation"
            className="md:hidden fixed bottom-0 inset-x-0 z-30 h-14 bg-surface border-t border-border flex items-stretch"
        >
            {apps.map(({ id, href, label, icon: Icon }) => (
                <a
                    key={id}
                    href={href}
                    aria-current={id === active ? "page" : undefined}
                    className={[
                        "flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium",
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
