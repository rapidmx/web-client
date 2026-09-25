///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, ReactNode, useState } from "react";
import { HiOutlineArrowTopRightOnSquare, HiOutlineCalendar, HiOutlineCalendarDays, HiOutlineClock, HiOutlineLink, HiOutlineMapPin } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import CopyButton from "@rapidmx/react-shared/components/buttons/CopyButton.js";
import {
    BookingLocationType,
    CreateBookingTypeInput,
    CreatedBookingType,
    bookingPublicUrl,
    createBookingType,
    newBookingLinkHref,
    slugFor,
} from "../../calendar/bookingPlugin.js";
import { EventFormController } from "./eventForm.js";
import { CalendarField, INPUT_CLASS, IconRow, SELECT_CLASS } from "./EventFormParts.js";
import QuickFaceFrame from "./QuickFaceFrame.js";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DURATIONS = ["15", "30", "45", "60"];
const BUFFERS = ["0", "5", "10", "15", "30"];
/** How often the plugin lets a slot repeat and how long one may be (`MIN_SLOT_MINUTES` to a day), in minutes. */
const MIN_DURATION = 5;
const MAX_DURATION = 1440;
/** How many times a taken link name is retried with a number after it (`intro`, `intro-2`, ...). */
const MAX_SLUG_ATTEMPTS = 5;

const LOCATIONS: { key: "video" | "phone" | "other"; type: BookingLocationType; label: string }[] = [
    { key: "video", type: "video", label: "Video call" },
    { key: "phone", type: "phone", label: "Phone call" },
    { key: "other", type: "other", label: "Other" },
];

/** What the Appointment schedule tab holds besides the title (which is the Event tab's): kept by `QuickCreateFaces`, so it survives a trip to another tab. */
export interface AppointmentDraft {
    /** One of `DURATIONS`, or `"custom"` to use `customMinutes`. */
    duration: string;
    customMinutes: string;
    /** Whether each weekday (0 = Sunday) is bookable. */
    days: boolean[];
    /** `HH:mm`, the hours every bookable day is open. */
    startTime: string;
    endTime: string;
    /** Minutes kept free after each appointment. */
    buffer: string;
    video: boolean;
    phone: boolean;
    other: boolean;
    /** Set once the schedule is saved: the face then shows its link. */
    created: { name: string; url: string; uid: string; mailboxUid: string } | null;
}

/** A new schedule: 30 minutes, Monday to Friday 9:00 to 17:00, a video call, no buffer. */
export function initialAppointmentDraft(): AppointmentDraft {
    return {
        duration: "30",
        customMinutes: "",
        days: [false, true, true, true, true, true, false],
        startTime: "09:00",
        endTime: "17:00",
        buffer: "0",
        video: true,
        phone: false,
        other: false,
        created: null,
    };
}

/** Creates the booking type, trying the next number after `base` (`intro`, `intro-2`, ...) while its link name is taken (a 409). */
async function createWithFreeSlug(base: string, input: Omit<CreateBookingTypeInput, "slug">): Promise<CreatedBookingType> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await createBookingType({ ...input, slug: attempt === 1 ? base : `${base}-${attempt}` });
        } catch (err) {
            if (!(err instanceof ApiRequestError && err.status === 409 && attempt < MAX_SLUG_ATTEMPTS)) {
                throw err;
            }
        }
    }
}

function minutesOf(time: string): number {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
}

export interface AppointmentQuickFormProps {
    c: EventFormController;
    draft: AppointmentDraft;
    onDraftChange: (patch: Partial<AppointmentDraft>) => void;
    tabs: ReactNode;
    /** The booking plugin's Settings path (`/settings/booking-types`), where More options goes. */
    settingsHref: string;
    /** The name booking pages show for the host. */
    hostName: string;
    /** The IANA zone the open hours are in. */
    timeZone: string;
}

/**
 * The Appointment schedule tab of the New event popover: publishes a bookable schedule (a booking type of `@rapidmx/booking-plugin`) with
 * `POST /api/mail/booking-types` - a name (the title), a duration, the weekdays and hours people can book, the buffer after each
 * appointment, how they may meet (video, phone, other) and which calendar takes the bookings - and then shows the public booking link with a
 * Copy button. Everything else about a booking link (approval, notice, a window, per-day hours, date overrides, several meeting types, a
 * description, the page's avatar and banner) is on the plugin's own page, which More options opens.
 */
export default function AppointmentQuickForm({ c, draft, onDraftChange, tabs, settingsHref, hostName, timeZone }: AppointmentQuickFormProps) {
    const { values } = c;
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (draft.created) {
            c.onCancel();
            return;
        }
        setError(null);
        const name = values.title.trim();
        const durationMinutes = Number(draft.duration === "custom" ? draft.customMinutes : draft.duration);
        const startMinute = minutesOf(draft.startTime);
        const endMinute = minutesOf(draft.endTime);
        const locationOptions = LOCATIONS.filter((location) => draft[location.key]).map((location) => ({ type: location.type }));
        let problem: string | undefined;
        if (!name) {
            problem = "A title is required.";
        } else if (!Number.isInteger(durationMinutes) || durationMinutes < MIN_DURATION || durationMinutes > MAX_DURATION) {
            problem = `A duration is a whole number of minutes from ${MIN_DURATION} to ${MAX_DURATION}.`;
        } else if (!draft.days.some(Boolean)) {
            problem = "Choose at least one day people can book.";
        } else if (!(startMinute < endMinute)) {
            problem = "The first bookable time must be before the last.";
        } else if (endMinute - startMinute < durationMinutes) {
            problem = "The hours people can book are shorter than one appointment.";
        } else if (locationOptions.length === 0) {
            problem = "Choose at least one way to meet.";
        }
        if (problem) {
            setError(problem);
            return;
        }

        setSaving(true);
        try {
            const base = slugFor(name);
            const availability = draft.days.flatMap((open, dayOfWeek) => (open ? [{ dayOfWeek, startMinute, endMinute }] : []));
            const created = await createWithFreeSlug(base, {
                mailboxUid: values.targetMailboxUid,
                calendarFolderUid: values.targetFolderUid,
                name,
                hostDisplayName: hostName,
                meetingTypes: [{ name, durationMinutes, locationOptions }],
                timezone: timeZone,
                availability,
                bufferAfterMinutes: Number(draft.buffer),
            });
            onDraftChange({
                created: { name: created.name, url: bookingPublicUrl(created.mailboxUid, created.slug), uid: created.uid, mailboxUid: created.mailboxUid },
            });
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create this appointment schedule.");
        } finally {
            setSaving(false);
        }
    }

    const { created } = draft;
    return (
        <QuickFaceFrame
            c={c}
            tabs={tabs}
            tab="appointment"
            error={error}
            hideTitle={!!created}
            onSubmit={(event) => void handleSubmit(event)}
            footer={
                created ? (
                    <Button type="submit" className="!w-auto">
                        Done
                    </Button>
                ) : (
                    <>
                        <a
                            href={newBookingLinkHref(settingsHref, values.targetMailboxUid)}
                            className="inline-flex items-center gap-1 text-sm font-semibold text-accent-dark hover:underline px-1 py-1"
                        >
                            More options
                            <HiOutlineArrowTopRightOnSquare size={14} aria-hidden="true" />
                        </a>
                        <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                            Save
                        </Button>
                    </>
                )
            }
        >
            {created ? (
                <IconRow icon={<HiOutlineLink size={20} />}>
                    <p role="status" className="text-sm font-medium mb-1">
                        &ldquo;{created.name}&rdquo; is ready to book.
                    </p>
                    <p className="text-xs text-text-muted mb-2">Share this link and anyone can pick an open time - no account needed.</p>
                    <div className="flex items-center gap-2">
                        <input type="text" readOnly aria-label="Booking link" className={`${INPUT_CLASS} min-w-0`} value={created.url} onFocus={(e) => e.target.select()} />
                        <CopyButton value={created.url} label="Copy the booking link" />
                    </div>
                    <a
                        href={`${settingsHref}/${encodeURIComponent(created.uid)}?mailboxUid=${encodeURIComponent(created.mailboxUid)}`}
                        className="inline-block text-xs text-primary-dark hover:underline mt-2"
                    >
                        Change its settings
                    </a>
                </IconRow>
            ) : (
                <>
                    <IconRow icon={<HiOutlineClock size={20} />}>
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                            <select
                                aria-label="Duration"
                                className={SELECT_CLASS}
                                value={draft.duration}
                                onChange={(e) => onDraftChange({ duration: e.target.value })}
                            >
                                {DURATIONS.map((minutes) => (
                                    <option key={minutes} value={minutes}>
                                        {minutes} minutes
                                    </option>
                                ))}
                                <option value="custom">Custom</option>
                            </select>
                            {draft.duration === "custom" && (
                                <>
                                    <input
                                        type="number"
                                        min={MIN_DURATION}
                                        max={MAX_DURATION}
                                        aria-label="Custom duration in minutes"
                                        className={`${INPUT_CLASS} !w-24`}
                                        value={draft.customMinutes}
                                        onChange={(e) => onDraftChange({ customMinutes: e.target.value })}
                                    />
                                    <span className="text-text-muted">minutes</span>
                                </>
                            )}
                            <span className="text-text-muted">with</span>
                            <select
                                aria-label="Buffer after each appointment"
                                className={SELECT_CLASS}
                                value={draft.buffer}
                                onChange={(e) => onDraftChange({ buffer: e.target.value })}
                            >
                                {BUFFERS.map((minutes) => (
                                    <option key={minutes} value={minutes}>
                                        {minutes === "0" ? "no buffer" : `${minutes} min buffer after`}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </IconRow>

                    <IconRow icon={<HiOutlineCalendarDays size={20} />}>
                        <div role="group" aria-label="Days people can book" className="flex gap-1 mb-2">
                            {DAY_NAMES.map((day, index) => (
                                <button
                                    key={day}
                                    type="button"
                                    aria-label={day}
                                    aria-pressed={draft.days[index]}
                                    title={day}
                                    onClick={() => onDraftChange({ days: draft.days.map((open, i) => (i === index ? !open : open)) })}
                                    className={[
                                        "w-8 h-8 rounded-full text-xs font-medium border",
                                        draft.days[index] ? "bg-primary text-white border-primary" : "border-border text-text-muted hover:bg-surface-alt",
                                    ].join(" ")}
                                >
                                    {day[0]}
                                </button>
                            ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                            <input
                                type="time"
                                aria-label="Bookable from"
                                className={`${SELECT_CLASS} min-w-0`}
                                value={draft.startTime}
                                onChange={(e) => onDraftChange({ startTime: e.target.value })}
                            />
                            <span className="text-text-muted">to</span>
                            <input
                                type="time"
                                aria-label="Bookable until"
                                className={`${SELECT_CLASS} min-w-0`}
                                value={draft.endTime}
                                onChange={(e) => onDraftChange({ endTime: e.target.value })}
                            />
                        </div>
                        <p className="text-xs text-text-muted mt-1">Times are in {timeZone.replace(/_/g, " ")}.</p>
                    </IconRow>

                    <IconRow icon={<HiOutlineMapPin size={20} />}>
                        <div role="group" aria-label="How people can meet" className="flex flex-wrap gap-x-4 gap-y-1 text-sm py-1">
                            {LOCATIONS.map((location) => (
                                <label key={location.key} className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={draft[location.key]}
                                        onChange={(e) => onDraftChange({ [location.key]: e.target.checked })}
                                    />
                                    {location.label}
                                </label>
                            ))}
                        </div>
                    </IconRow>

                    <IconRow icon={<HiOutlineCalendar size={20} />}>
                        <p className="text-xs text-text-muted mb-1">Bookings are added to</p>
                        <CalendarField c={c} />
                    </IconRow>
                </>
            )}
        </QuickFaceFrame>
    );
}
