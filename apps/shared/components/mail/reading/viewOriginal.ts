///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useCallback, useState } from "react";

/** Messages the reader chose to see exactly as authored rather than adapted to the theme, for the life of the tab. */
const original = new Set<string>();

/** Whether the reader asked to see `uid` as authored. */
export function isViewedOriginal(uid: string): boolean {
    return original.has(uid);
}

/** Forgets every choice (the tests). */
export function clearViewedOriginal(): void {
    original.clear();
}

/**
 * The per-message "View original" choice: `false` (follow the theme) until the reader flips it, then remembered for the session so
 * collapsing and expanding a message, or coming back to it, keeps the choice.
 */
export function useViewOriginal(uid: string): [boolean, (value: boolean) => void] {
    const [value, setValue] = useState(() => isViewedOriginal(uid));
    const update = useCallback(
        (next: boolean) => {
            if (next) {
                original.add(uid);
            } else {
                original.delete(uid);
            }
            setValue(next);
        },
        [uid],
    );
    return [value, update];
}
