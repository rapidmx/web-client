///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useEffect, useState } from "react";
import {
    HiOutlineBars3BottomLeft,
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
import { ApiRequestError } from "../../../../lib/util/api.js";
import { useApiClient } from "../../../../lib/util/apiClientContext.js";
import { AttendeeResponseInput, guestPermissionsOf, respondToEvent, visibilityOf } from "../../../../lib/calendar/calendarApi.js";
import { htmlToPlainText } from "../../../../lib/calendar/eventDescription.js";
import { deleteEventOccurrence, deleteEventSeries } from "../../../../lib/calendar/calendarMutations.js";
import { CalendarOccurrence, describeRecurrence } from "../../../../lib/calendar/recurrence.js";
import { getVideoMeeting } from "../../../../lib/videoconf/videoMeetingsApi.js";
import { describeTimeZone, deviceTimeZone } from "../../../../lib/util/timeZone.js";
import Alert from "../../../../lib/components/feedback/Alert.js";
import Button from "../../../../lib/components/buttons/Button.js";
import { joinMeetingUrl } from "../../calendar/calendarReminders.js";
import ParticipantLink from "../contacts/ParticipantLink.js";
import EventDescriptionView from "./EventDescriptionView.js";
import RequestChangeForm from "./RequestChangeForm.js";
import { BUSY_STATUS_LABEL, RESPONSE_STATUS_LABEL, VISIBILITY_LABEL, describeGuestPermissions, describeReminder, formatStoredWhen, formatStoredWhenInZone } from "./eventFormat.js";

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
    /** Whether an address is one of this mailbox's own (its primary address or an alias): tells the reader's own entry from the other guests when the organizer
     * has hidden the guest list. */
    isOwnAddress?: (address: string) => boolean;
    calendarName?: string;
    calendarColor?: string;
    /** Whether the reader may change this mailbox's events: `false` for one shared with them view-only, which gets no Modify, Delete or answer. Default `true`. */
    canWrite?: boolean;
    onClose: () => void;
    /** Modify: switch to the edit form. */
    onModify: () => void;
    onSaved: () => void;
    onDeleted: () => void;
}

/**
 * What clicking an existing event shows first: everything the event says, read-only. The reader who organized it (or whose event has no
 * other organizer) can Modify or Delete it; one who was invited can answer (Accept, Tentative, Decline) or remove it from their own
 * calendar, but not change it - the organizer's next update would overwrite that anyway. When the organizer allows guests to ask for changes (or for
 * guests to be added) the invited reader can "Request a change" / "Add guests": the request goes to the organizer (`RequestChangeForm`) and nothing here
 * changes until their update arrives. When the organizer hides the guest list the reader sees only themselves and is told so.
 *
 * An event this reader may only see as a busy block (`occurrence.redacted`: a private or confidential event on a shared calendar) is drawn as just that -
 * its time and that it is busy - with nothing to change, delete or answer.
 */
export default function EventDetails({
    occurrence,
    isInvited,
    myResponse,
    isOwnAddress,
    calendarName,
    calendarColor,
    canWrite = true,
    onClose,
    onModify,
    onSaved,
    onDeleted,
}: EventDetailsProps) {
    const client = useApiClient();
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    // An answer to one occurrence of a series waits here for the reader to confirm: the server records it for the entire series.
    const [pendingResponse, setPendingResponse] = useState<AttendeeResponseInput | null>(null);
    const [requesting, setRequesting] = useState(false);
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
        void getVideoMeeting(videoMeetingUid, client)
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
    }, [videoMeetingUid, client]);
    // The same scheme allow-list a reminder's own location gets: a hostile or malformed join link never reaches `window.open()`.
    const joinUrl = joinMeetingUrl(organizerJoinUrl);

    async function handleDelete(scope: "occurrence" | "series") {
        setError(null);
        setBusy(true);
        try {
            if (occurrence.isRecurringOccurrence && scope === "occurrence") {
                await deleteEventOccurrence(occurrence, client);
            } else {
                await deleteEventSeries(occurrence, client);
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
        setPendingResponse(null);
        setError(null);
        setBusy(true);
        try {
            await respondToEvent(occurrence.uid, responseStatus, client);
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

    if (occurrence.redacted) {
        return (
            <div className="flex flex-col">
                <div className="flex items-start gap-3 px-5 pt-4">
                    <span aria-hidden="true" className="w-3.5 h-3.5 rounded-full shrink-0 mt-2" style={{ backgroundColor: calendarColor }} />
                    <h2 className="flex-1 min-w-0 text-xl font-semibold break-words">Busy</h2>
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
                    <DetailRow icon={<HiOutlineClock size={18} />}>
                        <div>{formatStoredWhen(occurrence.startDate, occurrence.endDate, occurrence.allDay)}</div>
                        {occurrence.recurrenceRule && <div className="text-text-muted">Repeats {describeRecurrence(occurrence.recurrenceRule)}</div>}
                    </DetailRow>
                    <p className="text-xs text-text-muted">This time is busy. The event&rsquo;s details are private, so only its time is shown.</p>
                </div>
                <div className="flex px-5 pb-4">
                    <Button type="button" variant="secondary" className="!w-auto ml-auto" onClick={onClose}>
                        Close
                    </Button>
                </div>
            </div>
        );
    }

    const permissions = guestPermissionsOf(occurrence);
    // The organizer hid the guest list: this mailbox's own copy lists only itself (the server sends nothing more), and that is all that is shown.
    const hiddenList = isInvited && !permissions.guestsCanSeeGuestList;
    const allGuests = occurrence.attendees.filter((a) => !a.isOrganizer);
    const guests = hiddenList ? allGuests.filter((a) => !!isOwnAddress?.(a.address)) : allGuests;
    const hasDescription = htmlToPlainText(occurrence.descriptionHtml) !== "" || !!occurrence.description?.trim();
    // An invited reader may ask the organizer for what the organizer allows.
    const askable = isInvited && myResponse !== undefined;
    const canChange = askable && permissions.guestsCanModify;
    const canInvite = askable && permissions.guestsCanInviteOthers;
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
                    {!occurrence.allDay && eventZone && eventZone !== deviceTimeZone() ? (
                        // Set somewhere else: the time on the reader's own clock, and on the clock it was set on, each said in full so nobody has to convert.
                        <>
                            <div>
                                {formatStoredWhen(occurrence.startDate, occurrence.endDate, false)} &bull; {describeTimeZone(deviceTimeZone(), new Date(occurrence.startDate))}
                            </div>
                            <div className="text-text-muted">
                                {formatStoredWhenInZone(occurrence.startDate, occurrence.endDate, eventZone)} &bull; {describeTimeZone(eventZone, new Date(occurrence.startDate))}
                            </div>
                        </>
                    ) : (
                        <div>{formatStoredWhen(occurrence.startDate, occurrence.endDate, occurrence.allDay)}</div>
                    )}
                    {occurrence.recurrenceRule && <div className="text-text-muted">Repeats {describeRecurrence(occurrence.recurrenceRule)}</div>}
                </DetailRow>

                {occurrence.location && (
                    <DetailRow icon={<HiOutlineMapPin size={18} />}>
                        <div>{occurrence.location}</div>
                    </DetailRow>
                )}

                {hasDescription && (
                    <DetailRow icon={<HiOutlineBars3BottomLeft size={18} />}>
                        <EventDescriptionView html={occurrence.descriptionHtml} text={occurrence.description} />
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
                    <div>
                        <ParticipantLink participant={occurrence.organizer}>{organizerName || occurrence.organizer.address}</ParticipantLink>
                    </div>
                    <div className="text-text-muted">
                        {organizerName ? `${occurrence.organizer.address} · ` : ""}Organizer
                    </div>
                </DetailRow>

                {(guests.length > 0 || hiddenList) && (
                    <DetailRow icon={<HiOutlineUserGroup size={18} />}>
                        <div className="font-medium mb-1">
                            {hiddenList ? "The organizer has hidden the guest list" : guests.length === 1 ? "1 guest" : `${guests.length} guests`}
                        </div>
                        <ul className="flex flex-col gap-1">
                            {guests.map((guest, i) => (
                                <li key={i} className="flex items-baseline justify-between gap-3">
                                    <span className="min-w-0 truncate">
                                        <ParticipantLink participant={guest}>{guest.displayName || guest.address}</ParticipantLink>
                                        {ROLE_LABEL[guest.role] && <span className="text-text-muted"> ({ROLE_LABEL[guest.role]})</span>}
                                    </span>
                                    <span className="shrink-0 text-xs text-text-muted">{RESPONSE_STATUS_LABEL[guest.responseStatus]}</span>
                                </li>
                            ))}
                        </ul>
                        {!isInvited && <div className="text-xs text-text-muted mt-1">{describeGuestPermissions(permissions)}</div>}
                    </DetailRow>
                )}

                <DetailRow icon={<HiOutlineBriefcase size={18} />}>
                    <div>{BUSY_STATUS_LABEL[occurrence.busyStatus]}</div>
                    <div className="text-text-muted">{VISIBILITY_LABEL[visibilityOf(occurrence)]}</div>
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
                    <p className="text-xs text-text-muted">
                        You were invited to this event. Only the organizer can change its details
                        {canChange || canInvite ? ", but you can ask them to." : "."}
                    </p>
                )}
            </div>

            {requesting && (
                <div className="mx-5 mb-3 p-3 rounded-md bg-surface-alt">
                    <RequestChangeForm
                        subject={{
                            uid: occurrence.uid,
                            title: occurrence.title,
                            location: occurrence.location,
                            startDate: occurrence.startDate,
                            endDate: occurrence.endDate,
                            allDay: occurrence.allDay,
                            recurring: occurrence.isRecurringOccurrence,
                            description: occurrence.description,
                            descriptionHtml: occurrence.descriptionHtml,
                            guestAddresses: occurrence.attendees.map((a) => a.address),
                        }}
                        canChange={canChange}
                        canInvite={canInvite}
                        onSent={() => setRequesting(false)}
                        onCancel={() => setRequesting(false)}
                    />
                </div>
            )}

            {myResponse !== undefined && canWrite && (
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
                                        onClick={() => (occurrence.isRecurringOccurrence ? setPendingResponse(response) : void handleRespond(response))}
                                    >
                                        {current && <HiOutlineCheck size={14} aria-hidden="true" />}
                                        {label}
                                    </Button>
                                );
                            })}
                        </div>
                    </div>
                    {pendingResponse && (
                        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
                            <span className="flex-1 min-w-0">
                                {pendingResponse === "declined" ? "Declining" : "Your answer"} applies to every event in this series, not just this one
                                {pendingResponse === "declined" ? ", and removes the series from your calendar" : ""}.
                            </span>
                            <Button type="button" variant="secondary" className="!w-auto" disabled={busy} onClick={() => setPendingResponse(null)}>
                                Cancel
                            </Button>
                            <Button type="button" className="!w-auto" disabled={busy} onClick={() => void handleRespond(pendingResponse)}>
                                {answers.find((a) => a.response === pendingResponse)!.label} the series
                            </Button>
                        </div>
                    )}
                    <p className="text-xs text-text-muted">Other attendees&rsquo; responses may take a few minutes to update.</p>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-3 px-5 pb-4">
                {!isInvited && canWrite && (
                    <Button type="button" className="!w-auto" disabled={busy} onClick={onModify}>
                        Modify
                    </Button>
                )}
                {(canChange || canInvite) && !requesting && (
                    <Button type="button" variant="secondary" className="!w-auto" disabled={busy} onClick={() => setRequesting(true)}>
                        {canChange ? "Request a change" : "Add guests"}
                    </Button>
                )}
                {!canWrite ? null : !confirmingDelete ? (
                    <Button type="button" variant="secondary" className="!w-auto text-danger" disabled={busy} onClick={() => setConfirmingDelete(true)}>
                        Delete
                    </Button>
                ) : !occurrence.isRecurringOccurrence ? (
                    <div role="alert" className="flex items-center gap-2">
                        <span className="text-sm">Delete this event?</span>
                        <Button type="button" variant="secondary" className="!w-auto text-danger" disabled={busy} onClick={() => void handleDelete("series")}>
                            Yes, delete
                        </Button>
                        <Button type="button" variant="secondary" className="!w-auto" disabled={busy} onClick={() => setConfirmingDelete(false)}>
                            Keep
                        </Button>
                    </div>
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
