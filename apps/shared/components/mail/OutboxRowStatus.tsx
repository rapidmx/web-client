///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { outboxItemStatus } from "../../mail/outbox/outboxState.js";

/**
 * The state line an Outbox list row carries under its subject: "Sending...", "Retrying (attempt 2, at 10:15)", "Not sent: <reason>" or
 * "Scheduled for ...". Read from the message's own `scheduledSend*` fields (see `outboxItemStatus()`), so it follows the list as the server's
 * events refresh it. A failed one is the one that needs the user: red, and its reason is spelled out.
 */
export default function OutboxRowStatus({ message }: { message: Message }) {
    const status = outboxItemStatus(message);
    const at = status.at === undefined ? "" : new Date(status.at).toLocaleString();
    const text =
        status.state === "failed"
            ? `Not sent: ${status.error}`
            : status.state === "retrying"
              ? `Retrying (attempt ${status.attempts + 1}${at ? `, ${at}` : ""})`
              : status.state === "scheduled"
                ? `Scheduled for ${at}`
                : "Sending…";
    return (
        <div data-testid="outbox-row-status" data-state={status.state} className={["flex items-center gap-1.5 text-xs", status.state === "failed" ? "font-semibold text-danger" : "text-text-muted"].join(" ")}>
            {status.state === "sending" && <span aria-hidden="true" className="rr-sending-dot h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
            <span className="truncate">{text}</span>
        </div>
    );
}
