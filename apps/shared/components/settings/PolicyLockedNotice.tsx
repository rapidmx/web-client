///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";

export interface PolicyLockedNoticeProps {
    /** Why the setting next to this notice can't be changed - e.g. that an administrator turned it off for the server. */
    children: React.ReactNode;
}

/**
 * Explains why a settings control is disabled by a policy the user can't change themselves (an administrator's server-wide
 * setting, say), shown right under that control. A disabled control with no reason reads as a defect; this says who decided
 * and that the user isn't the one who can undo it.
 */
export default function PolicyLockedNotice({ children }: PolicyLockedNoticeProps) {
    return (
        <p role="note" className="mt-1.5 text-xs text-text-muted border-l-2 border-border pl-2">
            {children}
        </p>
    );
}
