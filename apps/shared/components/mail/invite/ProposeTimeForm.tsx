///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useId, useState } from "react";
import type { MessageInvite, ProposedTime } from "@rapidmx/react-shared/calendar/inviteApi.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { isoDay, validDate } from "./inviteFormat.js";

const INPUT_CLASS = "w-full text-sm border border-border rounded-sm py-1.5 px-2 bg-surface text-text";

/** `HH:MM` of an instant in the reader's zone, the value of a time input. */
function clock(date: Date): string {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export interface ProposeTimeFormProps {
    /** The invitation being answered: its own time (in the reader's zone) is what the fields start out as. */
    invite: Pick<MessageInvite, "startDate" | "endDate">;
    /** A proposal is on its way: the form is off. */
    busy?: boolean;
    /** Called with the proposed instants once the fields are valid. The caller reports a failure and closes the form on success. */
    onSubmit: (proposal: ProposedTime) => void;
    onCancel: () => void;
}

/**
 * The small form behind "Propose new time": a date and a start and end time - in the reader's own time zone, prefilled with the invitation's own
 * time - and an optional note to the organizer. It validates what it can (all three fields, and an end after the start) before anything is sent.
 * The end is on the start's day: a proposal spans one day, as Outlook's does from a list.
 */
export default function ProposeTimeForm({ invite, busy = false, onSubmit, onCancel }: ProposeTimeFormProps) {
    const start = validDate(invite.startDate);
    const end = validDate(invite.endDate);
    const [date, setDate] = useState(start ? isoDay(start) : "");
    const [startTime, setStartTime] = useState(start ? clock(start) : "");
    const [endTime, setEndTime] = useState(end ? clock(end) : "");
    const [comment, setComment] = useState("");
    const [error, setError] = useState<string | null>(null);
    const id = useId();

    function submit(event: React.FormEvent) {
        event.preventDefault();
        if (!date || !startTime || !endTime) {
            setError("Choose a date and a start and end time.");
            return;
        }
        const proposedStart = new Date(`${date}T${startTime}:00`);
        const proposedEnd = new Date(`${date}T${endTime}:00`);
        if (proposedEnd <= proposedStart) {
            setError("The end time must be after the start time.");
            return;
        }
        setError(null);
        const note = comment.trim();
        onSubmit({ startDate: proposedStart.toISOString(), endDate: proposedEnd.toISOString(), ...(note ? { comment: note } : {}) });
    }

    return (
        <form aria-label="Propose a new time" onSubmit={submit} noValidate className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap gap-2">
                <div className="flex-1 min-w-[9rem]">
                    <label htmlFor={`${id}-date`} className="block text-xs text-text-muted mb-0.5">
                        Date
                    </label>
                    <input id={`${id}-date`} type="date" value={date} disabled={busy} onChange={(e) => setDate(e.target.value)} className={INPUT_CLASS} />
                </div>
                <div className="flex-1 min-w-[6rem]">
                    <label htmlFor={`${id}-start`} className="block text-xs text-text-muted mb-0.5">
                        Start
                    </label>
                    <input id={`${id}-start`} type="time" value={startTime} disabled={busy} onChange={(e) => setStartTime(e.target.value)} className={INPUT_CLASS} />
                </div>
                <div className="flex-1 min-w-[6rem]">
                    <label htmlFor={`${id}-end`} className="block text-xs text-text-muted mb-0.5">
                        End
                    </label>
                    <input id={`${id}-end`} type="time" value={endTime} disabled={busy} onChange={(e) => setEndTime(e.target.value)} className={INPUT_CLASS} />
                </div>
            </div>
            <div>
                <label htmlFor={`${id}-comment`} className="block text-xs text-text-muted mb-0.5">
                    Comment (optional)
                </label>
                <textarea
                    id={`${id}-comment`}
                    rows={2}
                    value={comment}
                    disabled={busy}
                    onChange={(e) => setComment(e.target.value)}
                    className={`${INPUT_CLASS} resize-y`}
                />
            </div>
            {error && (
                <p role="alert" className="text-danger">
                    {error}
                </p>
            )}
            <div className="flex flex-wrap gap-2">
                <Button type="submit" className="!w-auto" loading={busy} disabled={busy} aria-busy={busy || undefined}>
                    Send proposal
                </Button>
                <Button type="button" variant="secondary" className="!w-auto" disabled={busy} onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
