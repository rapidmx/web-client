///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The shared dialog behavior behind `Modal.tsx` and `Drawer.tsx`: a module-level stack of every open
 * overlay, so that when overlays nest (a Modal opened from inside a Drawer, a confirm Modal on top of an
 * edit Modal) only the *topmost* one reacts to Escape and traps Tab — pressing Escape once closes one
 * layer, not every layer at once.
 *
 * One `keydown` listener on `document` is installed while the stack is non-empty and dispatches to the
 * top entry only. A per-overlay listener that checked "am I on top?" wouldn't be enough: the top
 * overlay's `onClose` only *schedules* a React state update, so a lower overlay's listener running later
 * in the same dispatch would still see itself as not-on-top only by luck of ordering.
 */
import { RefObject, createContext, useContext, useEffect, useRef } from "react";

interface OverlayEntry {
    dialogRef: RefObject<HTMLElement | null>;
    onEscape: () => void;
    /** How many overlays enclose this one in the React tree (portals don't change React nesting). */
    depth: number;
    /** Which commit (see `push()`) pushed this entry - assigned by `push()`. */
    commit?: number;
}

/**
 * The nesting depth of the overlay rendering a subtree. Overlays wrap their children in a provider with
 * the value `useOverlayDialog()` returns, so an overlay rendered inside another's children knows it
 * belongs above it regardless of effect ordering - see `push()`.
 */
export const OverlayDepthContext = createContext(0);

const stack: OverlayEntry[] = [];

/** Everything natively tabbable - disabled controls, `tabindex="-1"`, and hidden inputs excluded. */
const TABBABLE_SELECTOR = [
    "a[href]",
    "area[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "iframe",
    "audio[controls]",
    "video[controls]",
    "[contenteditable]:not([contenteditable='false'])",
    "[tabindex]",
].join(",");

function tabbableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
        (el) => el.tabIndex >= 0 && !el.hasAttribute("inert") && !el.closest("[hidden]"),
    );
}

function handleKeyDown(e: KeyboardEvent) {
    const top = stack[stack.length - 1];
    const dialog = top.dialogRef.current;
    if (e.key === "Escape") {
        top.onEscape();
        return;
    }
    if (e.key !== "Tab" || !dialog) {
        return;
    }
    const tabbable = tabbableElements(dialog);
    const active = document.activeElement;
    if (tabbable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
    }
    const first = tabbable[0];
    const last = tabbable[tabbable.length - 1];
    const outside = !dialog.contains(active);
    if (e.shiftKey) {
        if (outside || active === first || active === dialog) {
            e.preventDefault();
            last.focus();
        }
    } else if (outside || active === last) {
        e.preventDefault();
        first.focus();
    }
}

/** Identifies the synchronous burst of effects (one React commit) an entry was pushed in: bumped in a
 * microtask after the first push of a burst, so every push from the same commit shares one value. */
let currentCommit = 0;
let commitBumpScheduled = false;

function push(entry: OverlayEntry) {
    if (stack.length === 0) {
        document.addEventListener("keydown", handleKeyDown);
    }
    if (!commitBumpScheduled) {
        commitBumpScheduled = true;
        queueMicrotask(() => {
            commitBumpScheduled = false;
            currentCommit++;
        });
    }
    entry.commit = currentCommit;
    // Normally just an append (the most recently opened overlay is on top). But React runs a child's
    // effects before its parent's, so when a nested overlay mounts already-open in the same commit as the
    // overlay containing it, the child is pushed first and would end up *under* its own container - so an
    // entry goes below deeper entries pushed *in the same commit* (its not-yet-stacked children). A deeper
    // entry from an earlier commit stays below it: an overlay opened later is on top regardless of depth
    // (e.g. a top-level confirm opened while a nested Drawer > Modal is already showing).
    let index = stack.length;
    while (index > 0 && stack[index - 1].depth > entry.depth && stack[index - 1].commit === entry.commit) {
        index--;
    }
    stack.splice(index, 0, entry);
}

function remove(entry: OverlayEntry) {
    stack.splice(stack.indexOf(entry), 1);
    if (stack.length === 0) {
        document.removeEventListener("keydown", handleKeyDown);
    }
}

/**
 * Wires one open overlay into the stack: on open, remembers the previously focused element and moves
 * focus into `dialogRef`'s element; while open *and topmost*, Escape calls `onClose` and Tab/Shift+Tab
 * cycle focus within the dialog; on close/unmount, leaves the stack and restores focus to whatever had it
 * before opening (when that's still an `HTMLElement`).
 *
 * `onClose` is read through a ref: callers routinely pass it as a fresh inline function every render, and
 * depending on it directly would re-run the effect - re-stealing focus into the dialog - on every parent
 * re-render (e.g. every keystroke in a field inside the dialog).
 *
 * Returns the depth to provide to the overlay's children via `OverlayDepthContext`.
 */
export function useOverlayDialog(open: boolean, dialogRef: RefObject<HTMLElement | null>, onClose: () => void): number {
    const depth = useContext(OverlayDepthContext);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        if (!open) return;

        // Remember what had focus before the overlay opened so it can be restored on close (e.g. the
        // "+ Add" button that triggered it), then move focus into the dialog itself.
        const trigger = document.activeElement;
        const entry: OverlayEntry = { dialogRef, onEscape: () => onCloseRef.current(), depth };
        push(entry);
        // An overlay that mounted open underneath an already-open nested one (see `push()`) must not
        // steal focus from the overlay above it.
        if (stack[stack.length - 1] === entry) {
            dialogRef.current?.focus();
        }

        return () => {
            remove(entry);
            if (trigger instanceof HTMLElement) {
                trigger.focus();
            }
        };
    }, [open]);

    return depth + 1;
}
