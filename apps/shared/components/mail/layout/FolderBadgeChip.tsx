///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { FolderBadge, badgeLabel } from "../../../mail/folderCounts.js";

/** A folder's badge: an accent pill with the unread count, or - for the folders that show how many they hold - plain muted text. */
export default function FolderBadgeChip({ badge }: { badge: FolderBadge }) {
    return (
        <span
            className={[
                "text-xs rounded-pill py-0.5 px-1.5",
                badge.kind === "unread" ? "font-bold bg-primary/15 text-primary-dark" : "font-medium text-text-muted",
            ].join(" ")}
        >
            <span aria-hidden="true">{badge.value}</span>
            <span className="sr-only"> {badgeLabel(badge)}</span>
        </span>
    );
}
