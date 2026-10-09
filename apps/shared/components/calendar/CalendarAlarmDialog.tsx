///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import Button from "../../../../lib/components/buttons/Button.js";
import Modal from "../../../../lib/components/overlays/Modal.js";
import { calendarEventHref, joinMeetingUrl, locationActionLabel, reminderMessage } from "../../calendar/calendarReminders.js";
import type { CalendarAlarms } from "../../calendar/useCalendarReminders.js";
import { useNavigate } from "../../navigation/index.js";

export interface CalendarAlarmDialogProps {
    alarms: CalendarAlarms;
}

/**
 * The modal an event's alarm raises (see `useCalendarReminders()`): what is starting and when, where, and three actions. **View** opens the event's card
 * in the Calendar. **Join** or **Open** - named for what the event's location is, a video meeting or any other web address - opens that address in a new
 * tab; it is only there when the location is a web address, and says which site it goes to, since anyone who can invite you can put any address in an
 * event. **Snooze** closes the dialog and brings it back after five minutes. Closing it with the close button or Escape dismisses the alarm.
 * View and Join/Open also dismiss it: the person has answered it.
 */
export default function CalendarAlarmDialog({ alarms }: CalendarAlarmDialogProps) {
    const navigate = useNavigate();
    const { current: alarm, waiting, snooze, dismiss } = alarms;
    if (!alarm) {
        return null;
    }
    const url = joinMeetingUrl(alarm.location);
    const location = alarm.location?.trim();
    return (
        <Modal open onClose={dismiss} title={alarm.title}>
            <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1 text-sm">
                    <p className="font-semibold">{reminderMessage(alarm.startDate)}</p>
                    {location && <p className="text-text-muted break-words">{location}</p>}
                    {waiting > 0 && (
                        <p className="text-xs text-text-muted">
                            {waiting} more alarm{waiting === 1 ? "" : "s"} after this one
                        </p>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto"
                        onClick={() => {
                            navigate(calendarEventHref(alarm.eventUid, alarm.startDate));
                            dismiss();
                        }}
                    >
                        View
                    </Button>
                    {url && (
                        <Button
                            type="button"
                            className="!w-auto"
                            onClick={() => {
                                window.open(url, "_blank", "noopener,noreferrer");
                                dismiss();
                            }}
                        >
                            {locationActionLabel(url)}
                        </Button>
                    )}
                    <Button type="button" variant="secondary" className="!w-auto" onClick={snooze}>
                        Snooze
                    </Button>
                </div>
                {url && <p className="text-xs text-text-muted">{`${locationActionLabel(url)} opens ${new URL(url).host}`}</p>}
            </div>
        </Modal>
    );
}
