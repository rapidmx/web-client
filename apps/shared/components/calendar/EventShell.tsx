///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { createContext, ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { OverlayDepthContext, useOverlayDialog } from "@rapidmx/react-shared/components/overlays/overlayStack.js";

/**
 * Where a new event's quick-create popover hangs: the rectangle (viewport coordinates) of what was clicked - a time slot, a day cell, the
 * "New event" button. `placement` says on which side it opens: beside the rectangle (`"side"`, the default: to its right, or to its left
 * when there is no room) or under it (`"below"`).
 */
export interface EventAnchor {
    left: number;
    top: number;
    right: number;
    bottom: number;
    placement?: "side" | "below";
}

/** The anchor for a clicked element (see `EventAnchor`). */
export function anchorOf(element: Element, placement: EventAnchor["placement"] = "side"): EventAnchor {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return { left, top, right, bottom, placement };
}

/** How the shell is drawn: a popover next to `anchor`, a bottom sheet (a phone's quick create), or a centered card with a backdrop. */
export type EventShellVariant = "popover" | "sheet" | "card";

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;

/**
 * Where a `width` x `height` popover goes for `anchor`, kept wholly inside the viewport (its margin on every side). With no anchor - the
 * keyboard shortcut - it is centered, near the top.
 */
export function placePopover(
    anchor: EventAnchor | undefined,
    size: { width: number; height: number },
    viewport: { width: number; height: number },
): { left: number; top: number } {
    let left: number;
    let top: number;
    if (!anchor) {
        left = (viewport.width - size.width) / 2;
        top = viewport.height * 0.1;
    } else if (anchor.placement === "below") {
        left = anchor.left;
        top = anchor.bottom + ANCHOR_GAP;
    } else {
        left = anchor.right + ANCHOR_GAP;
        if (left + size.width > viewport.width - VIEWPORT_MARGIN) {
            left = anchor.left - ANCHOR_GAP - size.width;
        }
        top = anchor.top;
    }
    return {
        left: Math.max(VIEWPORT_MARGIN, Math.min(left, viewport.width - size.width - VIEWPORT_MARGIN)),
        top: Math.max(VIEWPORT_MARGIN, Math.min(top, viewport.height - size.height - VIEWPORT_MARGIN)),
    };
}

/** What a form inside a popover uses to make its grip drag the popover. */
export interface EventShellContextValue {
    dragHandleProps: { onPointerDown: (event: React.PointerEvent) => void } | undefined;
}
export const EventShellContext = createContext<EventShellContextValue>({ dragHandleProps: undefined });

export interface EventShellProps {
    variant: EventShellVariant;
    /** The dialog's accessible name. */
    label: string;
    /** Escape, the backdrop (unless `onBackdropPress` says otherwise) and the close buttons' shared way out. */
    onClose: () => void;
    /** What a press on the backdrop does, where it must not just close: a half-typed quick event is not thrown away by a stray click. */
    onBackdropPress?: () => void;
    anchor?: EventAnchor;
    /** Names the face being shown (details, quick create, full form): when it changes, focus moves to the new face's `data-autofocus` element,
     * or to the dialog itself when it has none. */
    focusKey: string;
    /** The widest the popover or card gets, in px. */
    width: number;
    children: ReactNode;
}

/**
 * The frame every face of the event dialog shares (the read-only details, the quick-create popover, the full form), so that switching from
 * one to another keeps the focus handling and - the point of drawing them all through one element tree - keeps a form's state when the quick
 * popover grows into the full card. The tree is deliberately the same for every variant (backdrop, dialog, children): only classes and
 * styles change, so React never remounts what is inside.
 *
 * Escape and the Tab focus trap come from the shared overlay stack (`useOverlayDialog`), as for `Modal`. A popover is placed beside its
 * anchor (`placePopover()`), re-placed when its own height changes, and can be dragged by a grip that takes `EventShellContext`'s handle.
 */
export default function EventShell({ variant, label, onClose, onBackdropPress, anchor, focusKey, width, children }: EventShellProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const depth = useOverlayDialog(true, dialogRef, onClose);
    // How far the grip has dragged the popover from where it was placed.
    const [offset, setOffset] = useState({ x: 0, y: 0 });
    const offsetRef = useRef(offset);
    offsetRef.current = offset;
    const dragStart = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);

    const place = useCallback(() => {
        const dialog = dialogRef.current;
        // A resize reported after the dialog has gone (the popover closes as soon as its event is saved) has nothing left to place.
        if (!dialog) {
            return;
        }
        if (variant !== "popover") {
            dialog.style.left = "";
            dialog.style.top = "";
            return;
        }
        const size = { width: dialog.offsetWidth, height: dialog.offsetHeight };
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const base = placePopover(anchor, size, viewport);
        const left = Math.max(VIEWPORT_MARGIN, Math.min(base.left + offsetRef.current.x, viewport.width - size.width - VIEWPORT_MARGIN));
        const top = Math.max(VIEWPORT_MARGIN, Math.min(base.top + offsetRef.current.y, viewport.height - size.height - VIEWPORT_MARGIN));
        dialog.style.left = `${Math.round(left)}px`;
        dialog.style.top = `${Math.round(top)}px`;
    }, [anchor, variant]);

    useLayoutEffect(() => {
        place();
    }, [place, offset]);

    // Declared after `useOverlayDialog()`'s own effect, which focuses the dialog itself: the face's first field wins over that.
    useEffect(() => {
        (dialogRef.current!.querySelector<HTMLElement>("[data-autofocus]") ?? dialogRef.current!).focus();
    }, [focusKey]);

    // The popover grows and shrinks with its rows (the time controls expanding, a guest added): keep it inside the window.
    useEffect(() => {
        if (variant !== "popover" || typeof ResizeObserver === "undefined") {
            return;
        }
        const observer = new ResizeObserver(() => place());
        observer.observe(dialogRef.current!);
        return () => observer.disconnect();
    }, [place, variant]);

    useEffect(() => {
        function handleMove(event: PointerEvent) {
            const start = dragStart.current;
            if (start) {
                setOffset({ x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y });
            }
        }
        function handleUp() {
            dragStart.current = null;
        }
        window.addEventListener("pointermove", handleMove);
        window.addEventListener("pointerup", handleUp);
        return () => {
            window.removeEventListener("pointermove", handleMove);
            window.removeEventListener("pointerup", handleUp);
        };
    }, []);

    const context: EventShellContextValue = {
        dragHandleProps:
            variant === "popover"
                ? {
                      onPointerDown: (event) => {
                          dragStart.current = { x: event.clientX, y: event.clientY, from: offsetRef.current };
                      },
                  }
                : undefined,
    };

    const backdropClass =
        variant === "card"
            ? "fixed inset-0 bg-black/50 flex items-center justify-center p-3 md:p-5 z-[1000]"
            : variant === "sheet"
              ? "fixed inset-0 bg-black/50 flex items-end z-[1000]"
              : "fixed inset-0 z-[1000]";
    const dialogClass =
        variant === "card"
            ? "w-full max-h-[calc(100vh-1.5rem)] md:max-h-[calc(100vh-2.5rem)] overflow-y-auto bg-surface border border-border rounded-xl shadow-modal focus:outline-none"
            : variant === "sheet"
              ? "w-full max-h-[90vh] overflow-y-auto bg-surface border-t border-border rounded-t-2xl shadow-modal focus:outline-none pb-[env(safe-area-inset-bottom)]"
              : "fixed max-h-[calc(100vh-1rem)] overflow-y-auto bg-surface border border-border rounded-xl shadow-modal focus:outline-none";
    const dialogStyle: React.CSSProperties =
        variant === "popover" ? { width, maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)` } : variant === "card" ? { maxWidth: width } : {};

    return createPortal(
        <div
            className={backdropClass}
            data-event-shell={variant}
            onMouseDown={(event) => event.target === event.currentTarget && (onBackdropPress ?? onClose)()}
        >
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={dialogClass} style={dialogStyle}>
                <OverlayDepthContext.Provider value={depth}>
                    <EventShellContext.Provider value={context}>{children}</EventShellContext.Provider>
                </OverlayDepthContext.Provider>
            </div>
        </div>,
        document.body,
    );
}
