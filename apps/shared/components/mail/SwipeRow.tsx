///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { HTMLAttributes, ReactNode, useEffect, useRef, useState } from "react";
import { HiOutlineArchiveBox, HiOutlineFolder } from "react-icons/hi2";
import { useSwipe } from "../../gestures/useSwipe.js";

export interface SwipeRowProps extends HTMLAttributes<HTMLElement> {
    /** The element the row is: a list item, or the row's own `div` inside one. */
    as?: "li" | "div";
    /** Swipes are only followed while this is `true`: the phone layout, and not while rows are being selected. */
    enabled: boolean;
    /** Right to left. Resolves whether it went through; `false` brings the row back, anything else leaves it gone (its list removes it). */
    onArchive: () => Promise<boolean>;
    /** Left to right. The row comes back at once, and this asks where to (a prompt for the folder). */
    onMove: () => void;
    children: ReactNode;
}

/** How long the row takes to leave, or come back - `motion-reduce` skips it. */
const SLIDE = "transform 150ms ease-out";

/**
 * A row of a list of mail that slides with a finger: right to left it takes the row away to Archive (a green panel with the
 * archive icon follows the row in), left to right it comes back and asks for a folder to move it to (a blue panel with a
 * folder). The panels are children of the row placed just outside its edges, so they travel with it and fill the gap it leaves
 * without the row's own markup, or the list's, changing; the list has to clip them (`overflow-x-clip`).
 *
 * Only a swipe that starts out horizontal counts (see `useSwipe()`), so scrolling the list is untouched, and it is an addition
 * to, never the only way of, archiving and moving: the selection bar and the reading pane do the same.
 */
export default function SwipeRow({ as: Tag = "div", enabled, onArchive, onMove, children, className, style, ...rest }: SwipeRowProps) {
    const [offset, setOffset] = useState(0);
    const [width, setWidth] = useState(0);
    /** The row is on its way out (or waiting for the server to confirm it), so a finger can't drag it. */
    const [leaving, setLeaving] = useState(false);
    const [dragging, setDragging] = useState(false);
    const element = useRef<HTMLElement | null>(null);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const swipe = useSwipe({
        enabled: enabled && !leaving,
        onDrag: (next) => {
            setDragging(next !== 0);
            setOffset(next);
        },
        onSwipe: (direction) => {
            if (direction === "right") {
                onMove();
                return;
            }
            const rowWidth = element.current?.clientWidth ?? 0;
            setWidth(rowWidth);
            setLeaving(true);
            setOffset(-rowWidth);
            void onArchive().then((archived) => {
                // Unmounted on success, once the list has dropped the row; a refusal brings it back.
                if (!archived && mounted.current) {
                    setLeaving(false);
                    setOffset(0);
                }
            });
        },
    });

    if (!enabled) {
        return (
            <Tag className={className} style={style} {...rest}>
                {children}
            </Tag>
        );
    }
    const active = offset !== 0;
    return (
        <Tag
            {...rest}
            {...swipe.handlers}
            ref={(node: HTMLElement | null) => {
                element.current = node;
            }}
            className={className}
            style={{
                ...style,
                ...swipe.style,
                transform: active ? `translateX(${offset}px)` : undefined,
                transition: dragging ? "none" : SLIDE,
            }}
            data-swiping={active ? "true" : undefined}
        >
            {children}
            {(active || leaving) && (
                <>
                    <span
                        aria-hidden="true"
                        data-swipe-panel="move"
                        className="absolute inset-y-0 right-full w-full bg-primary text-white flex items-center justify-end pr-6"
                    >
                        <HiOutlineFolder size={24} />
                    </span>
                    <span
                        aria-hidden="true"
                        data-swipe-panel="archive"
                        style={width ? { width } : undefined}
                        className="absolute inset-y-0 left-full w-full bg-success text-white flex items-center justify-start pl-6"
                    >
                        <HiOutlineArchiveBox size={24} />
                    </span>
                </>
            )}
        </Tag>
    );
}
