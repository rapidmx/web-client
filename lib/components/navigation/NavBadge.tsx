///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";

/** The most a nav badge spells out; a larger count reads "99+". */
export const NAV_BADGE_MAX = 99;

/** A nav item's accessible name: its label, plus its unread count when it has one ("Mail, 3 unread"). */
export function navItemLabel(label: string, badge?: number): string {
    return badge ? `${label}, ${badge} unread` : label;
}

/**
 * The small round count chip on the corner of a nav icon (the Mail rail icon's unread mail). Drawn only for a count above zero; it is
 * hidden from assistive technology because the link it sits on carries the count in its own name (`navItemLabel()`). Position it by
 * placing it inside a `relative` wrapper around the icon.
 */
export default function NavBadge({ count }: { count?: number }) {
    if (!count) {
        return null;
    }
    return (
        <span
            aria-hidden="true"
            data-testid="nav-badge"
            className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-pill bg-danger text-white text-[10px] font-bold leading-4 text-center"
        >
            {count > NAV_BADGE_MAX ? `${NAV_BADGE_MAX}+` : count}
        </span>
    );
}
