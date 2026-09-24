///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useRef, useState } from "react";
import { HiOutlineCalendarDays } from "react-icons/hi2";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import type { MessageInvite } from "@rapidmx/react-shared/calendar/inviteApi.js";
import { ANSWER_LABEL, formatRowStart } from "./inviteFormat.js";
import { useMessageInvite } from "./inviteStore.js";
import InviteRsvpPopover from "./InviteRsvpPopover.js";

export interface InviteRowChipProps {
    message: Message;
    /** Called with the row's message carrying the reader's new answer (`meetingResponse`), after an RSVP, so the list can show it. */
    onResponded?: (updated: Message) => void;
    /** The chip's horizontal margins - the row's own padding. Default `mx-4`. */
    className?: string;
}

/** Whether a list row draws the chip: a meeting request the server can read (an encrypted message's calendar file is inside its ciphertext). */
export function showsInviteChip(message: Pick<Message, "meetingMethod" | "encrypted">): boolean {
    return message.meetingMethod === "REQUEST" && !message.encrypted;
}

/**
 * The line a meeting request gets in a list of mail, under its preview, as Outlook draws it: a calendar icon, when the meeting starts (in the reader's
 * zone), under that whether it conflicts with the reader's calendar - or, once answered, the answer - and an RSVP button that opens the day view with
 * Accept, Decline and Tentative (`InviteRsvpPopover`).
 *
 * The invitation is looked up (once, through the shared cache) only for a row that `showsInviteChip()` - the rest of the list is never asked about. Until
 * it arrives, or when the lookup fails, the chip says only "Meeting request", with no button.
 *
 * It lives beside the row's open button, not inside it (a button can't hold a button), and keeps taps and touches to itself: pressing RSVP neither
 * opens the row nor starts a swipe of it. That holds for the popover too, which React nests under the chip even though it is drawn on the page.
 */
export default function InviteRowChip({ message, onResponded, className = "mx-4" }: InviteRowChipProps) {
    const eligible = showsInviteChip(message);
    const { invite, setInvite } = useMessageInvite(message.uid, eligible);
    const [open, setOpen] = useState(false);
    const rsvpRef = useRef<HTMLButtonElement>(null);
    if (!eligible) {
        return null;
    }

    const answer = invite?.response ?? message.meetingResponse;
    const conflicts = invite?.conflicts.length ?? 0;
    const start = invite ? formatRowStart(invite) : undefined;

    function answered(updated: MessageInvite) {
        setInvite(updated);
        onResponded?.({ ...message, meetingResponse: updated.response ?? message.meetingResponse });
    }

    const stop = (event: React.SyntheticEvent) => event.stopPropagation();
    return (
        <div
            data-invite-chip
            onClick={stop}
            onTouchStart={stop}
            onTouchMove={stop}
            onTouchEnd={stop}
            onTouchCancel={stop}
            className={[className, "mb-2 -mt-1 flex items-center gap-2 rounded-sm border border-border bg-surface px-2 py-1.5 text-xs font-normal"].join(" ")}
        >
            <HiOutlineCalendarDays size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
            <div className="min-w-0 flex-1">
                <div className="truncate text-text">{start ?? "Meeting request"}</div>
                {invite && (
                    <div
                        className={[
                            "truncate",
                            answer === "accepted" ? "text-success" : answer === "declined" ? "text-danger" : conflicts > 0 ? "text-danger" : "text-text-muted",
                        ].join(" ")}
                    >
                        {answer ? ANSWER_LABEL[answer] : conflicts > 0 ? `Conflicts with ${conflicts} ${conflicts === 1 ? "event" : "events"}` : "No conflicts"}
                    </div>
                )}
            </div>
            {invite?.canRespond && !invite.isOrganizer && (
                <button
                    ref={rsvpRef}
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-label={`RSVP to ${invite.summary?.trim() || "this meeting"}`}
                    onClick={() => setOpen((wasOpen) => !wasOpen)}
                    className="shrink-0 py-1 px-3 rounded-sm border border-border text-xs font-semibold text-text hover:bg-surface-alt"
                >
                    RSVP
                </button>
            )}
            {open && invite && (
                <InviteRsvpPopover
                    messageUid={message.uid}
                    invite={invite}
                    anchorRef={rsvpRef}
                    onDone={answered}
                    onClose={() => setOpen(false)}
                />
            )}
        </div>
    );
}
