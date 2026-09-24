///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineBriefcase, HiOutlineCalendarDays, HiOutlineXMark } from "react-icons/hi2";
import { BusyStatus } from "@rapidmx/react-shared/calendar/calendarApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { CalendarField, DateTimeControls, GuestsField, INPUT_CLASS, IconRow, LocationRow, ReminderRow, VideoConferencingRow } from "./EventFormParts.js";
import { EventFormController } from "./eventForm.js";
import { BUSY_STATUSES, BUSY_STATUS_LABEL } from "./eventFormat.js";

/**
 * The full event form, as a card: a close button and Save across the top, the title, when (dates, times, All day, Time zone, how it
 * repeats), and two columns - video conferencing, location, the reminder, calendar, busy status and automatic reply on the left, the guests
 * on the right. What "More options" opens for a new event and what Modify opens for an existing one.
 *
 * There is no "Find a time" tab (the server has no free/busy lookup for other people's calendars), no description (an event has no such
 * field) and no visibility or guest permissions (nor do they).
 */
export default function EventExpandedForm({ c }: { c: EventFormController }) {
    const { values } = c;
    return (
        <form onSubmit={c.onSubmit} className="flex flex-col">
            <div className="flex items-center justify-between px-3 pt-3">
                <button
                    type="button"
                    aria-label="Close"
                    onClick={c.onCancel}
                    className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                >
                    <HiOutlineXMark size={20} aria-hidden="true" />
                </button>
                <Button type="submit" loading={c.saving} disabled={c.saving} className="!w-auto">
                    Save
                </Button>
            </div>

            <div className="flex flex-col gap-4 px-5 pb-5 pt-1">
                {c.error && <Alert>{c.error}</Alert>}

                <input
                    type="text"
                    aria-label="Title"
                    placeholder="Add title"
                    data-autofocus
                    className="w-full text-2xl bg-transparent text-text border-0 border-b-2 border-primary/50 focus:border-primary focus:outline-none pb-1 placeholder:text-text-muted"
                    value={values.title}
                    onChange={(e) => c.update({ title: e.target.value })}
                />

                {c.showEditScope && (
                    <fieldset className="flex flex-col gap-1.5 text-sm">
                        <legend className="text-xs font-bold uppercase tracking-wide text-text-muted mb-1">Apply changes to</legend>
                        <label className="flex items-center gap-2">
                            <input
                                type="radio"
                                name="event-edit-scope"
                                checked={c.editScope === "occurrence"}
                                onChange={() => c.setEditScope("occurrence")}
                            />
                            This event only
                        </label>
                        <label className="flex items-center gap-2">
                            <input
                                type="radio"
                                name="event-edit-scope"
                                checked={c.editScope === "series"}
                                onChange={() => c.setEditScope("series")}
                            />
                            The entire series
                        </label>
                    </fieldset>
                )}

                <DateTimeControls c={c} />

                <div className="grid gap-x-8 gap-y-4 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
                    <div className="flex flex-col gap-3 min-w-0">
                        <VideoConferencingRow c={c} />
                        <LocationRow c={c} />
                        <ReminderRow value={values.reminderMinutes} onChange={(minutes) => c.update({ reminderMinutes: minutes })} />
                        <IconRow icon={<HiOutlineCalendarDays size={20} />}>
                            <CalendarField c={c} />
                        </IconRow>
                        <IconRow icon={<HiOutlineBriefcase size={20} />}>
                            <select
                                id="event-busyStatus"
                                aria-label="Busy status"
                                className={`${INPUT_CLASS} !w-auto`}
                                value={values.busyStatus}
                                onChange={(e) => c.update({ busyStatus: e.target.value as BusyStatus })}
                            >
                                {BUSY_STATUSES.map((status) => (
                                    <option key={status} value={status}>
                                        {BUSY_STATUS_LABEL[status]}
                                    </option>
                                ))}
                            </select>
                        </IconRow>

                        <div className="pl-8">
                            <label className="flex items-center gap-2 text-sm font-medium">
                                <input
                                    type="checkbox"
                                    checked={values.autoReplyEnabled}
                                    onChange={(e) => c.update({ autoReplyEnabled: e.target.checked })}
                                />
                                Send an automatic reply while this event is happening
                            </label>
                            <p className="text-xs text-text-muted mt-1">
                                Applies in addition to your mailbox&rsquo;s own Automatic Replies setting (see Settings) &mdash; this
                                event&rsquo;s message takes over for its own start/end window.
                            </p>
                            {values.autoReplyEnabled && (
                                <textarea
                                    aria-label="Automatic reply message"
                                    className={`${INPUT_CLASS} mt-2`}
                                    rows={3}
                                    value={values.autoReplyMessage}
                                    onChange={(e) => c.update({ autoReplyMessage: e.target.value })}
                                    placeholder="I'm out of office and back on..."
                                />
                            )}
                        </div>
                    </div>

                    <section aria-labelledby="event-guests-heading" className="flex flex-col gap-2 min-w-0">
                        <h3 id="event-guests-heading" className="text-sm font-semibold">
                            Guests
                        </h3>
                        <GuestsField c={c} compact={false} />
                    </section>
                </div>
            </div>
        </form>
    );
}
