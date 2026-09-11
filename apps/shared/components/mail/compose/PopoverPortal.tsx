///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren, RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface PopoverPortalProps {
    /** The button (or other element) this popover is anchored to — used both to position it and to
     * exclude it from the outside-click-closes check (it already has its own toggle handler; without
     * this exclusion, a click on the trigger while open would close-then-immediately-reopen, since
     * `pointerdown` fires — and closes it — before the trigger's own `click` handler re-opens it). */
    anchorRef: RefObject<HTMLElement | null>;
    onClose: () => void;
    width: number;
    height: number;
    "aria-label": string;
}

/**
 * Renders its children into `document.body` (via a portal), `position: fixed` at a spot computed from
 * `anchorRef`'s own rect — used by `EmojiPicker`/`GifPicker` so the popup escapes every ancestor's
 * `overflow-hidden` (the Compose window's own outer frame, and `RichTextEditor`'s bordered wrapper
 * both clip anything positioned merely `absolute` inside them, however high its `z-index` — clipping
 * isn't a stacking-order problem `z-index` can override). Prefers opening *below* the anchor (there's
 * more room in the editor area below the toolbar than above it, where the To/Cc/Subject rows are —
 * confirmed directly: an earlier `absolute`+`overflow-hidden` version of this rendered the popup
 * behind those rows), flipping to *above* only if there isn't enough room below.
 */
export default function PopoverPortal({ anchorRef, onClose, width, height, children, ...rest }: PropsWithChildren<PopoverPortalProps>) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [style, setStyle] = useState<React.CSSProperties | null>(null);

    useEffect(() => {
        const rect = anchorRef.current?.getBoundingClientRect();
        if (!rect) {
            return;
        }
        const gap = 6;
        const margin = 8;
        const spaceBelow = window.innerHeight - rect.bottom;
        const top = spaceBelow >= height + gap ? rect.bottom + gap : Math.max(margin, rect.top - height - gap);
        const left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin);
        setStyle({ position: "fixed", top, left, width, height });
    }, [anchorRef, height, width]);

    useEffect(() => {
        function handlePointerDown(e: PointerEvent) {
            const target = e.target as Node;
            if (containerRef.current?.contains(target) || anchorRef.current?.contains(target)) {
                return;
            }
            onClose();
        }
        document.addEventListener("pointerdown", handlePointerDown);
        return () => document.removeEventListener("pointerdown", handlePointerDown);
    }, [anchorRef, onClose]);

    if (!style) {
        return null;
    }

    return createPortal(
        <div ref={containerRef} role="dialog" style={style} className="z-50 flex flex-col bg-surface border border-border rounded-md shadow-modal overflow-hidden" {...rest}>
            {children}
        </div>,
        document.body,
    );
}
