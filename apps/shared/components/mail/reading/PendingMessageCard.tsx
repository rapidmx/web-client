///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import type { OutgoingReply } from "../../../mail/outbox/outgoingReplies.js";
import MailAddress, { RecipientLine } from "../MailAddress.js";
import MessageBody from "./MessageBody.js";
import { BODY_FONT_STYLE, CardShell, SenderAvatar } from "./MessageCard.js";

/**
 * A reply or forward that has just been sent, drawn where its message will be once the server has filed it: the sender, who it went to, its body as
 * it was composed, and one line saying where it is - "Sending...", "Sent", or, when it did not go, "Not sent: <why>" with the same ways out the
 * pop-up offers (Retry, Open draft ...). It reads like the message's own card, so the real message replaces it without the thread rearranging.
 *
 * The body goes through the reading pane's own sanitizing frame (`MessageBody`), exactly as a received message's does.
 */
export default function PendingMessageCard({
    reply,
    headerRef,
}: {
    reply: OutgoingReply;
    /** Registered so the pane can put the focus here when the message first appears. Focusable, but not in the tab order. */
    headerRef: (node: HTMLHeadingElement | null) => void;
}) {
    const failed = reply.state === "failed";
    return (
        <CardShell>
            <div className="flex items-center gap-3 px-4 py-3">
                <SenderAvatar from={reply.sender} />
                <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
                        <h2 ref={headerRef} tabIndex={-1} style={BODY_FONT_STYLE} className="flex-1 min-w-[13rem] font-semibold outline-none focus-visible:outline-2 focus-visible:outline-primary">
                            <MailAddress recipient={reply.sender} />
                        </h2>
                        <div
                            // Its own element for each: an alert is announced when it appears, which a status that changed its role would not be.
                            key={failed ? "failed" : "progress"}
                            role={failed ? "alert" : "status"}
                            data-testid="pending-message-status"
                            data-state={reply.state}
                            className={["flex items-center gap-1.5 text-xs shrink-0", failed ? "font-semibold text-danger" : "text-text-muted"].join(" ")}
                        >
                            {reply.state === "sending" && <span aria-hidden="true" className="rr-sending-dot h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                            <span>{failed ? `Not sent: ${reply.failure}` : reply.state === "sending" ? "Sending…" : "Sent"}</span>
                        </div>
                    </div>
                    <RecipientLine label="To" recipients={reply.to} />
                    <RecipientLine label="Cc" recipients={reply.cc} />
                    <RecipientLine label="Bcc" recipients={reply.bcc} />
                </div>
            </div>
            {failed && (
                <div className="flex flex-wrap gap-2 px-4 pb-3">
                    {reply.actions.map((action) => (
                        <Button key={action.label} type="button" variant="secondary" className="!w-auto" onClick={action.onClick}>
                            {action.label}
                        </Button>
                    ))}
                </div>
            )}
            <div className="px-4 pb-4">
                <MessageBody messageUid={reply.uid} messageVersion={0} title={`Message: ${reply.subject}`} content={{ kind: "html", html: reply.html }} />
            </div>
        </CardShell>
    );
}
