///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useContext, useState } from "react";
import { HiOutlineBars2, HiOutlineCalendarDays, HiOutlineClock, HiOutlineXMark } from "react-icons/hi2";
import { describeRecurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { EventShellContext } from "./EventShell.js";
import { CalendarField, DateTimeControls, GuestsRow, IconRow, LocationRow, VideoConferencingRow } from "./EventFormParts.js";
import { EventFormController } from "./eventForm.js";
import { BUSY_STATUS_LABEL, describeReminder, formatFormWhen, reminderOf } from "./eventFormat.js";

export interface EventQuickFormProps {
    c: EventFormController;
    /** "More options": the same form, larger. */
    onExpand: () => void;
}

/**
 * The quick-create popover: a title, when (a click opens the date, time, zone and repeat controls in place), guests, video conferencing,
 * a location and which calendar - with the busy status and reminder it will have written under it - then "More options" and Save. Its
 * values are `EventEditor`'s, shared with the full form.
 */
export default function EventQuickForm({ c, onExpand }: EventQuickFormProps) {
    const { values } = c;
    const { dragHandleProps } = useContext(EventShellContext);
    const [timeOpen, setTimeOpen] = useState(false);

    return (
        <form onSubmit={c.onSubmit} className="flex flex-col">
            <div className="flex items-center justify-between px-2 pt-2">
                {dragHandleProps ? (
                    <div {...dragHandleProps} aria-hidden="true" className="flex-1 h-7 flex items-center cursor-move text-text-muted select-none touch-none">
                        <HiOutlineBars2 size={20} />
                    </div>
                ) : (
                    <div className="flex-1" />
                )}
                <button
                    type="button"
                    aria-label="Close"
                    onClick={c.onCancel}
                    className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                >
                    <HiOutlineXMark size={20} aria-hidden="true" />
                </button>
            </div>

            <div className="flex flex-col gap-3 px-5 pb-3">
                {c.error && <Alert>{c.error}</Alert>}

                <div className="pl-8">
                    <input
                        type="text"
                        aria-label="Title"
                        placeholder="Add title"
                        data-autofocus
                        className="w-full text-xl bg-transparent text-text border-0 border-b-2 border-primary/50 focus:border-primary focus:outline-none pb-1 placeholder:text-text-muted"
                        value={values.title}
                        onChange={(e) => c.update({ title: e.target.value })}
                    />
                </div>

                <IconRow icon={<HiOutlineClock size={20} />}>
                    <button
                        type="button"
                        aria-expanded={timeOpen}
                        onClick={() => setTimeOpen((open) => !open)}
                        className="w-full text-left rounded-md hover:bg-surface-alt -mx-1 px-1 py-0.5"
                    >
                        <span className="block text-sm">{formatFormWhen(values.start, values.end, values.allDay)}</span>
                        <span className="block text-xs text-text-muted">
                            {values.formZone.replace(/_/g, " ")} &bull;{" "}
                            {values.recurrenceRule ? `Repeats ${describeRecurrence(values.recurrenceRule)}` : "Does not repeat"}
                        </span>
                    </button>
                    {timeOpen && (
                        <div className="mt-2">
                            <DateTimeControls c={c} />
                        </div>
                    )}
                </IconRow>

                <GuestsRow c={c} />
                <VideoConferencingRow c={c} />
                <LocationRow c={c} />

                <IconRow icon={<HiOutlineCalendarDays size={20} />}>
                    <CalendarField c={c} />
                    <p className="text-xs text-text-muted mt-0.5">
                        {BUSY_STATUS_LABEL[values.busyStatus]} &bull; {describeReminder(reminderOf(values.reminderMinutes))}
                    </p>
                </IconRow>
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3">
                <Button type="button" variant="text" className="!w-auto" onClick={onExpand}>
                    More options
                </Button>
                <Button type="submit" loading={c.saving} disabled={c.saving} className="!w-auto">
                    Save
                </Button>
            </div>
        </form>
    );
}
