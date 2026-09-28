///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import { OverlayDepthContext, useOverlayDialog } from "./overlayStack.js";

export interface DrawerProps {
    open: boolean;
    onClose: () => void;
    title: string;
    /** Which edge the drawer slides in from. Defaults to "left" (matches every current call site — a
     * secondary sidebar or nav list). */
    side?: "left" | "right";
    /** Fill the whole window instead of a 18rem strip beside a dimmed page - what a phone's navigation drawer wants, where a sliver of the page behind
     * it is only a mis-tap waiting to happen. The panel keeps the safe-area insets clear of a notch and the home indicator. Defaults to `false`. */
    fullScreen?: boolean;
    children: ReactNode;
}

/**
 * An off-canvas panel for mobile, portal-rendered to `document.body` like `Modal.tsx` — same
 * backdrop/focus-trap/Escape-key contract (shared via `overlayStack.ts`), just styled as a slide-in edge panel
 * instead of a centered card. Used to hold a secondary sidebar's content below the `md` breakpoint,
 * where it doesn't fit alongside the primary content.
 */
export default function Drawer({ open, onClose, title, side = "left", fullScreen = false, children }: DrawerProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const childDepth = useOverlayDialog(open, dialogRef, onClose);

    if (!open) {
        return null;
    }

    return createPortal(
        <div
            className="fixed inset-0 bg-black/50 z-[1000]"
            onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
            <div
                className={[
                    fullScreen
                        ? "fixed inset-0 w-full overflow-y-auto bg-surface p-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))] focus:outline-none"
                        : "fixed inset-y-0 w-72 max-w-[85vw] overflow-y-auto bg-surface border-border shadow-modal p-5 focus:outline-none",
                    fullScreen ? "" : side === "left" ? "left-0 border-r" : "right-0 border-l",
                ].join(" ")}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                tabIndex={-1}
                ref={dialogRef}
            >
                <div className="flex items-start justify-between gap-4 mb-5">
                    <div className="text-xl font-bold tracking-tight">{title}</div>
                    <button
                        type="button"
                        className="bg-transparent border-none text-text-muted text-2xl leading-none cursor-pointer p-0 hover:text-text"
                        aria-label="Close"
                        onClick={onClose}
                    >
                        &times;
                    </button>
                </div>
                <div>
                    <OverlayDepthContext.Provider value={childDepth}>{children}</OverlayDepthContext.Provider>
                </div>
            </div>
        </div>,
        document.body,
    );
}
