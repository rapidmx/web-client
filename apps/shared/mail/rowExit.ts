///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** How long a row that leaves the list (moved, deleted, archived) takes to collapse. The list drops it from its data after this long. */
export const ROW_EXIT_MS = 200;

/**
 * Whether a row that leaves should collapse rather than vanish: the browser can animate an element (`Element.animate()` - every current one
 * can) and the reader has not asked for less motion (`prefers-reduced-motion`). Otherwise the row is removed at once.
 */
export function canAnimateRowExit(): boolean {
    // Only called from event handlers, i.e. in a browser.
    if (typeof Element.prototype.animate !== "function") {
        return false;
    }
    return !(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/**
 * Collapses a row that is leaving: its height and opacity run to zero over `ROW_EXIT_MS`, so the rows below slide up into the gap, and it
 * stays collapsed (`fill: forwards`) until the list drops it. The row is marked so a second call for the same element does nothing.
 */
export function collapseRow(row: HTMLElement): void {
    if (row.dataset.collapsing) {
        return;
    }
    row.dataset.collapsing = "true";
    const height = row.getBoundingClientRect().height;
    row.style.overflow = "hidden";
    row.animate(
        [
            { height: `${height}px`, opacity: 1 },
            { height: "0px", opacity: 0, borderBottomWidth: "0px" },
        ],
        { duration: ROW_EXIT_MS, easing: "ease-out", fill: "forwards" },
    );
}
