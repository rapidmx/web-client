///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The modifier keys of a click - what a mouse event, or the native event behind a checkbox's change, carries. */
export interface ClickModifiers {
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
}

/** Whether a click is a multi-select click (Shift, Ctrl, or Cmd on a Mac) rather than the plain click that opens a row. */
export function isSelectionClick(modifiers: ClickModifiers | undefined): boolean {
    return !!modifiers && !!(modifiers.shiftKey || modifiers.ctrlKey || modifiers.metaKey);
}

/** Ctrl (or Cmd on a Mac): toggle just the clicked row. */
export function isToggleClick(modifiers: ClickModifiers | undefined): boolean {
    return !!modifiers && !!(modifiers.ctrlKey || modifiers.metaKey);
}

/**
 * The anchor of a Shift+click range, as Explorer and Outlook have it: the row last clicked (or opened) - `anchor` - while it is still in
 * the list, else the row open in the reading pane (`open`), else nothing (the range is then just the clicked row).
 */
export function resolveAnchor(keys: readonly string[], anchor: string | null, open: string | null): string | null {
    if (anchor !== null && keys.includes(anchor)) {
        return anchor;
    }
    return open !== null && keys.includes(open) ? open : null;
}

/**
 * Every key from `anchor` to `target` inclusive, in the order `keys` has them - the order the list is displayed in, whichever end of the
 * range was clicked first. With no usable anchor the range is `target` alone.
 */
export function rangeBetween(keys: readonly string[], anchor: string | null, target: string): string[] {
    const from = anchor === null ? -1 : keys.indexOf(anchor);
    const to = keys.indexOf(target);
    if (from === -1 || to === -1) {
        return [target];
    }
    return keys.slice(Math.min(from, to), Math.max(from, to) + 1);
}
