///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect } from "react";

/** A count this hook put in front of the title, so it can be taken off again: `(3) `. */
const TITLE_PREFIX = /^\(\d+\) /;

/** `title` with `count` unread in front - `(3) Acme: Mail` - or as it is when there are none. */
export function titleWithUnread(title: string, count: number): string {
    const base = title.replace(TITLE_PREFIX, "");
    return count > 0 ? `(${count > 99 ? "99+" : count}) ${base}` : base;
}

export interface UseUnreadTitleOptions {
    /** Does nothing while false - for the one of two owners that isn't. Default true. */
    enabled?: boolean;
    /** Changes whenever something else has rewritten the title (the app frame sets it on every page change), so the count is put in front of
     * the new one. */
    resetKey?: unknown;
}

/**
 * Keeps the browser tab's title in step with the unread count, as Outlook on the web does - `(3) Acme: Mail` - so mail that
 * arrives while the tab is in the background can be seen from the tab strip. The count is put in front of whatever the title is
 * (the page sets its own, from the branding) and taken off again when it drops to zero or the component goes away.
 *
 * Order matters when the same component also sets the title: declare this hook after the effect that does, so that on a change of `resetKey`
 * the count is taken off the old title, the new title is written, and the count goes back in front of it.
 */
export function useUnreadTitle(count: number, { enabled = true, resetKey }: UseUnreadTitleOptions = {}): void {
    useEffect(() => {
        if (!enabled) {
            return;
        }
        document.title = titleWithUnread(document.title, count);
        return () => {
            document.title = titleWithUnread(document.title, 0);
        };
    }, [count, enabled, resetKey]);
}
