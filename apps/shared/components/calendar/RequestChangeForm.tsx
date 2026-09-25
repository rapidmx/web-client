///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { HiOutlineXMark } from "react-icons/hi2";
import { Attendee, EventChangeRequest, requestEventChange } from "@rapidmx/react-shared/calendar/calendarApi.js";
import { htmlToPlainText, sanitizeEventDescriptionHtml } from "@rapidmx/react-shared/calendar/eventDescription.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { toDatetimeLocal } from "@rapidmx/react-shared/util/dateInput.js";
import { notifyApiError } from "../../notifications/apiErrors.js";
import { notify } from "../../notifications/store.js";
import { INPUT_CLASS } from "./EventFormParts.js";
import GuestInput, { GuestEntries } from "./GuestInput.js";
import LazyDescriptionEditor from "./LazyDescriptionEditor.js";
import { descriptionProblem, initialDescriptionHtml } from "./eventDialogFields.js";
import { mergeGuests } from "./eventFormat.js";

/** The event a guest asks about: what it says now (the form starts from it and sends only what differs) and which row of it the request is for. */
export interface ChangeSubject {
    /** The event's uid on this mailbox (`CalendarEvent.uid`, or `MessageInvite.calendarEventUid`): the row the organizer's answer will come back to. */
    uid: string;
    title: string;
    location?: string | null;
    /** ISO 8601 instants; absent for an event whose time is not known. */
    startDate?: string;
    endDate?: string;
    allDay: boolean;
    /** Part of a series: a request changes the whole series (its own row), so its time - which is one occurrence's - is not offered. */
    recurring: boolean;
    description?: string | null;
    descriptionHtml?: string | null;
    /** Everyone already invited, whatever the case, so a guest is not added twice. */
    guestAddresses: string[];
}

export interface RequestChangeFormProps {
    subject: ChangeSubject;
    /** The organizer lets guests change the title, location, description and time (`guestsCanModify`). */
    canChange: boolean;
    /** The organizer lets guests add guests (`guestsCanInviteOthers`). */
    canInvite: boolean;
    /** The request was sent. */
    onSent: () => void;
    onCancel: () => void;
}

const MINUTE_MS = 60_000;

/** Whether two instants (ISO, or a form's local time) name the same minute. */
function sameMinute(a: string, b: string): boolean {
    return Math.round(new Date(a).getTime() / MINUTE_MS) === Math.round(new Date(b).getTime() / MINUTE_MS);
}

/**
 * A guest's request to the organizer, for an event whose organizer lets guests change it and/or invite others (`POST /calendar-events/:id/request-change`).
 * Starts from the event as it is and sends only what the guest changed: the title, location, description and time (with `canChange`) and guests to add (with
 * `canInvite`). Nothing changes on the guest's own calendar - the organizer's copy is updated (automatically, when the flags allow it) and the change
 * comes back as the organizer's next update - so the form says so, and afterwards a "Your change was sent to the organizer" notification confirms it.
 * A title or location can be changed, not cleared (the server refuses that), and the time of a series or an all-day event is not offered.
 */
export default function RequestChangeForm({ subject, canChange, canInvite, onSent, onCancel }: RequestChangeFormProps) {
    const canChangeTime = canChange && !subject.allDay && !subject.recurring && !!subject.startDate && !!subject.endDate;
    const [title, setTitle] = useState(subject.title);
    const [location, setLocation] = useState(subject.location ?? "");
    const [start, setStart] = useState(subject.startDate ? toDatetimeLocal(subject.startDate) : "");
    const [end, setEnd] = useState(subject.endDate ? toDatetimeLocal(subject.endDate) : "");
    const [descriptionHtml, setDescriptionHtml] = useState(() => initialDescriptionHtml(subject));
    // The guests to add (not the ones already invited: `subject.guestAddresses` are skipped), what is flagged in the field, and what is being typed.
    const [entries, setEntries] = useState<GuestEntries>({ guests: [], invalid: [], draft: "" });
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const heading = canChange ? "Request a change" : "Add guests";

    /** Adds what was typed into the guests box, returning the guests to add as they now stand; something that is not an address is said. */
    function addTypedGuests(): Attendee[] | undefined {
        const merged = mergeGuests(entries.guests, [...entries.invalid, entries.draft].join(", "), subject.guestAddresses);
        if (merged.invalid.length > 0) {
            setError(`“${merged.invalid[0]}” isn’t a valid email address.`);
            return undefined;
        }
        setEntries({ guests: merged.attendees, invalid: [], draft: "" });
        return merged.attendees;
    }

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        setError(null);
        const added = canInvite ? addTypedGuests() : [];
        if (!added) {
            return;
        }
        const guests = added.map((guest) => (guest.displayName ? { address: guest.address, displayName: guest.displayName } : { address: guest.address }));
        const request: EventChangeRequest = {};

        if (canChange) {
            if (title.trim() !== subject.title.trim()) {
                if (!title.trim()) {
                    setError("Enter a title, or leave it as it is.");
                    return;
                }
                request.title = title.trim();
            }
            if (location.trim() !== (subject.location ?? "").trim()) {
                if (!location.trim()) {
                    setError("Enter a location, or leave it as it is.");
                    return;
                }
                request.location = location.trim();
            }
            if (canChangeTime && (!sameMinute(start, subject.startDate as string) || !sameMinute(end, subject.endDate as string))) {
                const startMs = new Date(start).getTime();
                const endMs = new Date(end).getTime();
                if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
                    setError("The end time must be after the start time.");
                    return;
                }
                request.startDate = new Date(startMs).toISOString();
                request.endDate = new Date(endMs).toISOString();
            }
            const html = sanitizeEventDescriptionHtml(descriptionHtml);
            if (html !== sanitizeEventDescriptionHtml(initialDescriptionHtml(subject)) && descriptionHtml !== initialDescriptionHtml(subject)) {
                const plain = htmlToPlainText(html);
                if (!plain) {
                    setError("Enter a description, or leave it as it is.");
                    return;
                }
                const tooLong = descriptionProblem(html);
                if (tooLong) {
                    setError(tooLong);
                    return;
                }
                request.descriptionHtml = html;
                request.description = plain;
            }
        }
        if (guests.length > 0) {
            request.addAttendees = guests;
        }
        if (Object.keys(request).length === 0) {
            setError("Change something first.");
            return;
        }

        setSending(true);
        try {
            await requestEventChange(subject.uid, request);
            notify({
                kind: "success",
                title: "Your change was sent to the organizer",
                message: "The event on your calendar updates when the organizer's update comes back.",
            });
            onSent();
        } catch (err) {
            notifyApiError(err, "Couldn't send your change");
            setSending(false);
        }
    }

    return (
        <form onSubmit={(event) => void handleSubmit(event)} aria-label={heading} className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">{heading}</h3>
                <button
                    type="button"
                    aria-label="Cancel request"
                    onClick={onCancel}
                    className="w-7 h-7 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                >
                    <HiOutlineXMark size={16} aria-hidden="true" />
                </button>
            </div>
            <p className="text-xs text-text-muted">
                Your request goes to the organizer. Nothing on your calendar changes until their update arrives; when the organizer allows it, it is applied for you.
            </p>
            {error && <Alert>{error}</Alert>}

            {canChange && (
                <>
                    <label className="flex flex-col gap-1 text-xs font-medium">
                        Title
                        <input type="text" className={INPUT_CLASS} value={title} onChange={(e) => setTitle(e.target.value)} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium">
                        Location
                        <input type="text" className={INPUT_CLASS} value={location} onChange={(e) => setLocation(e.target.value)} />
                    </label>
                    {canChangeTime && (
                        <div className="flex flex-wrap gap-3">
                            <label className="flex flex-col gap-1 text-xs font-medium">
                                Starts
                                <input type="datetime-local" className={INPUT_CLASS} value={start} onChange={(e) => setStart(e.target.value)} />
                            </label>
                            <label className="flex flex-col gap-1 text-xs font-medium">
                                Ends
                                <input type="datetime-local" className={INPUT_CLASS} value={end} onChange={(e) => setEnd(e.target.value)} />
                            </label>
                        </div>
                    )}
                    {!canChangeTime && (
                        <p className="text-xs text-text-muted">
                            {subject.recurring ? "A change here applies to the whole series; its times can only be changed by the organizer." : "The time of this event can only be changed by the organizer."}
                        </p>
                    )}
                    <div className="flex flex-col gap-1">
                        <span className="text-xs font-medium">Description</span>
                        <LazyDescriptionEditor value={descriptionHtml} onChange={setDescriptionHtml} />
                    </div>
                </>
            )}

            {canInvite && (
                <div className="flex flex-col gap-1">
                    <label htmlFor="request-guests" className="text-xs font-medium">
                        Guests to add
                    </label>
                    <GuestInput
                        id="request-guests"
                        label="Guests to add"
                        placeholder="Name or name@example.com"
                        variant="box"
                        skipAddresses={subject.guestAddresses}
                        {...entries}
                        onChange={setEntries}
                    />
                </div>
            )}

            <div className="flex items-center gap-2">
                <Button type="submit" loading={sending} disabled={sending} className="!w-auto">
                    Send request
                </Button>
                <Button type="button" variant="text" className="!w-auto" disabled={sending} onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
