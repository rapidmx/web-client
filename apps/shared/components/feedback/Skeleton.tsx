///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";

export interface SkeletonProps {
    /** Tailwind width class, e.g. `"w-32"` or `"w-full"`. Defaults to full width. */
    width?: string;
    /** Tailwind height class, e.g. `"h-4"`. Defaults to a text-line height. */
    height?: string;
    /** Extra classes — e.g. `"rounded-full"` for an avatar placeholder instead of the default bar shape. */
    className?: string;
}

/** A single pulsing placeholder bar — the shared building block every skeleton layout in this app
 * composes from, so a loading list/sidebar/page reads as "this shape is about to have real content"
 * rather than either a blank pane or a spinner (this app's convention going forward for anything that
 * takes a network round trip to render — see the shells' own `Skeleton`-based "checking" state). */
export default function Skeleton({ width = "w-full", height = "h-4", className = "" }: SkeletonProps) {
    return <div aria-hidden="true" className={["animate-pulse rounded-sm bg-border", width, height, className].join(" ")} />;
}

/** A vertical stack of `count` skeleton rows, each an icon-sized block plus a text-line bar — the
 * shape shared by every list-style loading state in this app (folder trees, message/contact/task
 * lists, sidebar nav items). */
export function SkeletonList({ count = 5, className = "" }: { count?: number; className?: string }) {
    return (
        <div aria-hidden="true" className={["flex flex-col gap-2", className].join(" ")}>
            {Array.from({ length: count }, (_, i) => (
                <div key={i} className="flex items-center gap-2.5 py-1">
                    <Skeleton width="w-6" height="h-6" className="rounded-full shrink-0" />
                    <Skeleton width={i % 2 === 0 ? "w-3/4" : "w-1/2"} />
                </div>
            ))}
        </div>
    );
}
