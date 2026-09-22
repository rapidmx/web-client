///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { OutboxFolderStatus, outboxLabel } from "../../mail/outbox/outboxState.js";

export interface OutboxBadgeProps {
    /** How many messages the Outbox holds: the folder's own count, which already includes what this tab has just sent. */
    total: number;
    /** What they are doing, when known (`useOutboxStatus()`). */
    status?: OutboxFolderStatus;
    /** How many of this mailbox's messages this tab is still handing to the server. */
    pendingHere: number;
}

/**
 * The Outbox's count, next to its name: a small pill. While anything is on its way it says so - an animated dot and an accent colour (the dot's
 * animation is CSS, off under `prefers-reduced-motion`); when a message failed and is waiting for the user it is red; otherwise it is the plain
 * count every "how many are in here" folder shows. Screen readers get the same as text ("2 messages sending"), in a polite live region so a
 * change - a message going out, a failure - is announced.
 */
export default function OutboxBadge({ total, status, pendingHere }: OutboxBadgeProps) {
    const failed = status?.failed ?? 0;
    const inFlight = (status ? status.sending + status.retrying : 0) + pendingHere;
    const state = failed > 0 ? "failed" : inFlight > 0 ? "sending" : "idle";
    const label = outboxLabel(total, status, pendingHere);
    return (
        <span
            data-testid="outbox-badge"
            data-state={state}
            title={label}
            aria-live="polite"
            className={[
                "inline-flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-xs",
                state === "failed" ? "bg-danger font-bold text-white" : state === "sending" ? "bg-primary/15 font-bold text-primary-dark" : "font-medium text-text-muted",
            ].join(" ")}
        >
            {state === "sending" && <span aria-hidden="true" className="rr-sending-dot h-1.5 w-1.5 rounded-full bg-primary" />}
            <span aria-hidden="true">{total}</span>
            <span className="sr-only"> {label}</span>
        </span>
    );
}
