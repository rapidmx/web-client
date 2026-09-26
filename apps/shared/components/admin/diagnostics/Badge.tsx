///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";
import type { IconType } from "react-icons";

export type BadgeTone = "success" | "warning" | "danger" | "info" | "neutral";

/** The tint behind a badge and the colour of its icon. The words stay in the normal text colour, and every tone
 * that means something (good, warning, bad) is also worded, so a badge never relies on its colour alone. */
const TONES: Record<BadgeTone, { background: string; icon: string }> = {
    success: { background: "bg-success/15", icon: "text-success" },
    warning: { background: "bg-warning/25", icon: "text-warning" },
    danger: { background: "bg-danger/15", icon: "text-danger" },
    info: { background: "bg-primary/15", icon: "text-primary" },
    neutral: { background: "bg-surface-alt", icon: "text-text-muted" },
};

export interface BadgeProps {
    tone?: BadgeTone;
    icon?: IconType;
    children: ReactNode;
}

/** A small pill: an optional icon, then a word or two. */
export default function Badge({ tone = "neutral", icon: Icon, children }: BadgeProps) {
    const classes = TONES[tone];
    return (
        <span
            className={`inline-flex items-center gap-1 rounded-pill border border-border px-2 py-0.5 text-xs font-medium text-text whitespace-nowrap ${classes.background}`}
        >
            {Icon && <Icon size={14} aria-hidden="true" className={classes.icon} />}
            {children}
        </span>
    );
}
