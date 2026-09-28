///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import { OverlayDepthContext, useOverlayDialog } from "./overlayStack.js";

export interface ModalProps {
    open: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
}

/**
 * A small, dependency-free modal dialog rendered via a portal to `document.body`. Controlled by the
 * caller (`open` state lives in the parent, not here) so multiple call sites can share the same simple
 * contract without each needing its own open/close plumbing.
 *
 * Focus moves into the dialog on open, Tab/Shift+Tab stay trapped inside it, and focus returns to the
 * previously focused element on close. When overlays are stacked (Modal/Drawer), only the topmost one
 * handles Escape and the focus trap - see `overlayStack.ts`.
 */
export default function Modal({ open, onClose, title, children }: ModalProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const childDepth = useOverlayDialog(open, dialogRef, onClose);

    if (!open) {
        return null;
    }

    return createPortal(
        <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center p-5 z-[1000]"
            onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
            <div
                className="w-full max-w-[440px] max-h-[calc(100vh-2.5rem)] overflow-y-auto bg-surface border border-border rounded-md shadow-modal p-7 focus:outline-none"
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
