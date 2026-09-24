///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useEffect, useState } from "react";
import {
    HiOutlineBell,
    HiOutlineBriefcase,
    HiOutlineCheck,
    HiOutlineClock,
    HiOutlineMapPin,
    HiOutlineUser,
    HiOutlineUserGroup,
    HiOutlineVideoCamera,
    HiOutlineXMark,
} from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { AttendeeResponseInput, respondToEvent } from "@rapidmx/react-shared/calendar/calendarApi.js";
import { deleteEventOccurrence, deleteEventSeries } from "@rapidmx/react-shared/calendar/calendarMutations.js";
import { CalendarOccurrence, describeRecurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import { getVideoMeeting } from "@rapidmx/react-shared/videoconf/videoMeetingsApi.js";
import { deviceTimeZone } from "@rapidmx/react-shared/util/timeZone.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { joinMeetingUrl } from "../../calendar/calendarReminders.js";
import { BUSY_STATUS_LABEL, RESPONSE_STATUS_LABEL, describeReminder, formatStoredWhen } from "./eventFormat.js";

const ROLE_LABEL = { required: "", optional: "Optional", resource: "Room/equipment" } as const;

function DetailRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
    return (
        <div className="flex items-start gap-3">
            <span aria-hidden="true" className="shrink-0 text-text-muted mt-0.5">
                {icon}
            </span>
            <div className="flex-1 min-w-0 break-words">{children}</div>
        </div>
    );
}

export interface EventDetailsProps {
    occurrence: CalendarOccurrence;
    /** Whether this mailbox is invited to the event rather than organizing it: only the organizer can change an event, so there is no
     * Modify, and the mailbox may answer instead. */
    isInvited: boolean;
    /** Set only when this mailbox is an invited attendee (one of the attendees, and not the organizer): the answer it has given so far, which
     * also switches on the Accept / Tentative / Decline block. */
    myResponse?: AttendeeResponseInput | "needsAction";
    calendarName?: string;
    calendarColor?: string;
    onClose: () => void;
    /** Modify: switch to the edit form. */
    onModify: () => void;
    onSaved: () => void;
    onDeleted: () => void;
}

/**
 * What clicking an existing event shows first: everything the event says, read-only. The reader who organized it (or whose event has no
 * other organizer) can Modify or Delete it; one who was invited can answer (Accept, Tentative, Decline) or remove it from their own
 * calendar, but not change it - the organizer's next update would overwrite that anyway.
 */
export default function EventDetails({ occurrence, isInvited, myResponse, calendarName, calendarColor, onClose, onModify, onSaved, onDeleted }: EventDetailsProps) {
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    // The organizer's own join link for the event's video meeting: `undefined` while it is fetched, `null` once known to be none.
    const [organizerJoinUrl, setOrganizerJoinUrl] = useState<string | null | undefined>(undefined);
    const videoMeetingUid = occurrence.videoMeetingUid;

    // The link lives on the meeting, not on the event, so it is fetched once here. A failure and a meeting with no link at all are the
    // same thing to this view - there is nothing to open either way - so both settle on `null`.
    useEffect(() => {
        if (!videoMeetingUid) {
            return;
        }
        let cancelled = false;
        void getVideoMeeting(videoMeetingUid)
            .then((meeting) => meeting.organizerJoinUrl ?? null)
            .catch(() => null)
            .then((url) => {
                if (!cancelled) {
                    setOrganizerJoinUrl(url);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [videoMeetingUid]);
    // The same scheme allow-list a reminder's own location gets: a hostile or malformed join link never reaches `window.open()`.
    const joinUrl = joinMeetingUrl(organizerJoinUrl);

    async function handleDelete(scope: "occurrence" | "series") {
        setError(null);
        setBusy(true);
        try {
            if (occurrence.isRecurringOccurrence && scope === "occurrence") {
                await deleteEventOccurrence(occurrence);
            } else {
                await deleteEventSeries(occurrence);
            }
            onDeleted();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not delete this event.");
            setBusy(false);
        }
    }

    // `@rapidmx/restapi`'s `respond()` route has no occurrence-vs-series scope of its own (see `calendarApi.ts`'s `respondToEvent` doc
    // comment) - it always acts on `occurrence.uid` as a single event document.
    async function handleRespond(responseStatus: AttendeeResponseInput) {
        setError(null);
        setBusy(true);
        try {
            await respondToEvent(occurrence.uid, responseStatus);
            // A decline soft-deletes the mailbox's own copy server-side - treat it the same as a
            // delete rather than a save so the calendar view drops it immediately.
            if (responseStatus === "declined") {
                onDeleted();
            } else {
                onSaved();
            }
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not send your response.");
            setBusy(false);
        }
    }

    const guests = occurrence.attendees.filter((a) => !a.isOrganizer);
    const organizerName = occurrence.organizer.displayName;
    const eventZone = occurrence.timezone;
    const answers: { response: AttendeeResponseInput; label: string }[] = [
        { response: "accepted", label: "Accept" },
        { response: "tentative", label: "Tentative" },
        { response: "declined", label: "Decline" },
    ];

    return (
        <div className="flex flex-col">
            <div className="flex items-start gap-3 px-5 pt-4">
                <span aria-hidden="true" className="w-3.5 h-3.5 rounded-full shrink-0 mt-2" style={{ backgroundColor: calendarColor }} />
                <h2 className="flex-1 min-w-0 text-xl font-semibold break-words">{occurrence.title || "(no title)"}</h2>
                <button
                    type="button"
                    aria-label="Close details"
                    onClick={onClose}
                    className="w-8 h-8 shrink-0 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                >
                    <HiOutlineXMark size={20} aria-hidden="true" />
                </button>
            </div>

            <div className="flex flex-col gap-3 px-5 pt-3 pb-4 text-sm">
                {error && <Alert>{error}</Alert>}

                <DetailRow icon={<HiOutlineClock size={18} />}>
                    <div>{formatStoredWhen(occurrence.startDate, occurrence.endDate, occurrence.allDay)}</div>
                    {occurrence.recurrenceRule && <div className="text-text-muted">Repeats {describeRecurrence(occurrence.recurrenceRule)}</div>}
                    {!occurrence.allDay && eventZone && eventZone !== deviceTimeZone() && (
                        <div className="text-text-muted">Event time zone: {eventZone.replace(/_/g, " ")}</div>
                    )}
                </DetailRow>

                {occurrence.location && (
                    <DetailRow icon={<HiOutlineMapPin size={18} />}>
                        <div>{occurrence.location}</div>
                    </DetailRow>
                )}

                {videoMeetingUid && (
                    <DetailRow icon={<HiOutlineVideoCamera size={18} />}>
                        <div className="flex items-center gap-3 flex-wrap">
                            <Button
                                type="button"
                                variant="secondary"
                                className="!w-auto"
                                disabled={!joinUrl}
                                onClick={() => window.open(joinUrl, "_blank", "noopener,noreferrer")}
                            >
                                Join video call
                            </Button>
                            {!joinUrl && (
                                <span className="text-xs text-text-muted">
                                    {organizerJoinUrl === undefined ? "Loading the join link…" : "This meeting’s join link isn’t available."}
                                </span>
                            )}
                        </div>
                    </DetailRow>
                )}

                <DetailRow icon={<HiOutlineUser size={18} />}>
                    <div>{organizerName || occurrence.organizer.address}</div>
                    <div className="text-text-muted">
                        {organizerName ? `${occurrence.organizer.address} · ` : ""}Organizer
                    </div>
                </DetailRow>

                {guests.length > 0 && (
                    <DetailRow icon={<HiOutlineUserGroup size={18} />}>
                        <div className="font-medium mb-1">{guests.length === 1 ? "1 guest" : `${guests.length} guests`}</div>
                        <ul className="flex flex-col gap-1">
                            {guests.map((guest, i) => (
                                <li key={i} className="flex items-baseline justify-between gap-3">
                                    <span className="min-w-0 truncate">
                                        {guest.displayName || guest.address}
                                        {ROLE_LABEL[guest.role] && <span className="text-text-muted"> ({ROLE_LABEL[guest.role]})</span>}
                                    </span>
                                    <span className="shrink-0 text-xs text-text-muted">{RESPONSE_STATUS_LABEL[guest.responseStatus]}</span>
                                </li>
                            ))}
                        </ul>
                    </DetailRow>
                )}

                <DetailRow icon={<HiOutlineBriefcase size={18} />}>
                    <div>{BUSY_STATUS_LABEL[occurrence.busyStatus]}</div>
                    {occurrence.autoReplyEnabled && (
                        <div className="text-text-muted">Sends an automatic reply while this event is happening</div>
                    )}
                </DetailRow>

                <DetailRow icon={<HiOutlineBell size={18} />}>
                    <div>{describeReminder(occurrence.reminderMinutesBeforeStart)}</div>
                </DetailRow>

                {calendarName && (
                    <div className="flex items-center gap-3 text-text-muted">
                        <span aria-hidden="true" className="w-3 h-3 ml-[3px] rounded-full shrink-0" style={{ backgroundColor: calendarColor }} />
                        <span className="truncate">{calendarName}</span>
                    </div>
                )}

                {isInvited && (
                    <p className="text-xs text-text-muted">You were invited to this event. Only the organizer can change its details.</p>
                )}
            </div>

            {myResponse !== undefined && (
                <div className="flex flex-col gap-2 mx-5 mb-3 p-3 rounded-md bg-surface-alt">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                        <span className="text-sm font-medium">Your response</span>
                        <div className="flex gap-2">
                            {answers.map(({ response, label }) => {
                                const current = myResponse === response;
                                return (
                                    <Button
                                        key={response}
                                        type="button"
                                        variant="secondary"
                                        className={["!w-auto", response === "declined" ? "text-danger" : "", current ? "!bg-primary/10 !border-primary" : ""].join(" ")}
                                        aria-pressed={current}
                                        disabled={busy}
                                        onClick={() => void handleRespond(response)}
                                    >
                                        {current && <HiOutlineCheck size={14} aria-hidden="true" />}
                                        {label}
                                    </Button>
                                );
                            })}
                        </div>
                    </div>
                    <p className="text-xs text-text-muted">Other attendees&rsquo; responses may take a few minutes to update.</p>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-3 px-5 pb-4">
                {!isInvited && (
                    <Button type="button" className="!w-auto" disabled={busy} onClick={onModify}>
                        Modify
                    </Button>
                )}
                {!occurrence.isRecurringOccurrence ? (
                    <Button type="button" variant="secondary" className="!w-auto text-danger" disabled={busy} onClick={() => void handleDelete("series")}>
                        Delete
                    </Button>
                ) : !confirmingDelete ? (
                    <Button type="button" variant="secondary" className="!w-auto text-danger" disabled={busy} onClick={() => setConfirmingDelete(true)}>
                        Delete
                    </Button>
                ) : (
                    <div className="flex gap-2">
                        <Button type="button" variant="secondary" className="!w-auto text-danger" disabled={busy} onClick={() => void handleDelete("occurrence")}>
                            Delete this event
                        </Button>
                        <Button type="button" variant="secondary" className="!w-auto text-danger" disabled={busy} onClick={() => void handleDelete("series")}>
                            Delete series
                        </Button>
                    </div>
                )}
                <Button type="button" variant="secondary" className="!w-auto ml-auto" onClick={onClose}>
                    Close
                </Button>
            </div>
        </div>
    );
}
