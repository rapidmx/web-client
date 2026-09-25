///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useRef, useState } from "react";
import { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import EventDetails from "./EventDetails.js";
import EventEditor from "./EventEditor.js";
import EventShell, { EventAnchor, EventShellVariant } from "./EventShell.js";
import { QuickTab } from "./QuickCreateTabs.js";

export { VIDEO_LOCATION_PLACEHOLDER } from "./EventEditor.js";
export type { EventAnchor } from "./EventShell.js";

export interface EventModalProps {
    open: boolean;
    onClose: () => void;
    mailboxUid: string;
    /** The calendar folder a new event is created into (ignored when editing — an existing event keeps
     * its own `folderUid`). When `calendars` names more than one option, a "Calendar" selector lets the
     * user override this default before saving. */
    folderUid: string;
    /** Every calendar the caller could create this event into. Omitted, or a single entry, means "only
     * one calendar exists" — no selector is shown and `folderUid` is used as-is, matching this
     * component's original single-calendar behavior exactly. */
    calendars?: { uid: string; name: string }[];
    /** Every mailbox a new event could be created in, each with its own calendars. With more than one, a
     * "Mailbox" selector (create mode only) chooses the mailbox, which in turn drives the Calendar selector
     * and the organizer address; `mailboxUid`/`folderUid` are the initial selection. */
    mailboxOptions?: { mailbox: Mailbox; calendars: { uid: string; name: string }[] }[];
    /** Each calendar's colour, keyed by folder uid: the dot next to the calendar's name. */
    folderColors?: Record<string, string>;
    organizerAddress: string;
    /** The viewing mailbox's alias addresses - an event it organizes (or an invitation to it) may name any of
     * them instead of `organizerAddress`. Defaults to that mailbox's `aliasAddresses` from `mailboxOptions`. */
    organizerAliases?: string[];
    /** `null` when creating a new event. */
    occurrence: CalendarOccurrence | null;
    /** Prefilled start/end for create mode (e.g. the day/slot the user clicked). */
    initialStart?: Date;
    initialEnd?: Date;
    /** Create mode: start as an all-day event on `initialStart`'s day (a day of the month view was clicked). */
    initialAllDay?: boolean;
    /** Create mode: what was clicked (a slot, a day, the New event button), which the quick-create popover opens beside. Without one it
     * opens centered near the top of the window. */
    anchor?: EventAnchor;
    /** Where the booking plugin's Settings pages are (`/settings/booking-types`) when it is running: a new event then has an Appointment
     * schedule tab, and its More options opens the plugin's own new-link page. Without it there are only the Event and Task tabs. */
    bookingHref?: string;
    onSaved: () => void;
    onDeleted: () => void;
}

/** How wide each face of the dialog gets, in px. */
const QUICK_WIDTH = 450;
const DETAILS_WIDTH = 480;
const FORM_WIDTH = 880;
const TASK_FORM_WIDTH = 560;

/**
 * The calendar's event dialog, in three faces drawn through one frame (`EventShell`):
 *
 * - **A new event** opens as a quick-create popover (`EventQuickForm`, beside what was clicked; a bottom sheet on a phone). "More options"
 * grows it into the full card (`EventExpandedForm`) with everything typed so far still in it.
 * The popover has tabs (`QuickCreateTabs`): Event, Task, and - when the booking plugin is running (`bookingHref`) - Appointment schedule.
 * The Task and Appointment faces are drawn by `QuickCreateFaces`, share the Event tab's title, mailbox and calendar, and only ever
 * create a task or a booking type; the Event tab is the form it always was.
 * - **An existing event** opens read-only (`EventDetails`): what the event says, the invited reader's Accept / Tentative / Decline,
 * and Delete. The reader who organized it also gets Modify, which turns the same card into the full form; closing that form returns
 * to the details, discarding the edits (a save closes everything, as it always did).
 *
 * Editing or deleting a recurring event's occurrence offers a choice between "this event" and "the entire series" (see
 * `calendarMutations.ts`) — Outlook's own convention for the same ambiguity.
 */
export default function EventModal({
    open,
    onClose,
    mailboxUid,
    folderUid,
    calendars,
    mailboxOptions,
    folderColors,
    organizerAddress,
    organizerAliases,
    occurrence,
    initialStart,
    initialEnd,
    initialAllDay,
    anchor,
    bookingHref,
    onSaved,
    onDeleted,
}: EventModalProps) {
    const isMobile = useIsMobile();
    // An existing event: Modify was pressed. A new event: More options was.
    const [editing, setEditing] = useState(false);
    const [expanded, setExpanded] = useState(false);
    // A new event: what the popover creates (an event, a task or an appointment schedule). More options only ever grows the tab it was pressed on.
    const [tab, setTab] = useState<QuickTab>("event");
    const [syncWarning, setSyncWarning] = useState(false);
    // Whether the form holds anything a click on the backdrop would throw away (kept up to date by the editor).
    const dirtyRef = useRef(false);

    if (!open) {
        return null;
    }

    if (syncWarning) {
        return (
            <Modal open={open} onClose={onSaved} title="Series saved">
                <p role="alert" className="text-sm mb-4">
                    The series was saved, but some occurrences you had changed individually couldn&rsquo;t be moved with it. They
                    may now appear twice - check the calendar and delete any duplicate.
                </p>
                <Button type="button" className="!w-auto" onClick={onSaved}>
                    OK
                </Button>
            </Modal>
        );
    }

    // Every address the viewing mailbox receives at - its primary address and its aliases, case-insensitively.
    const ownAddresses = new Set(
        [organizerAddress, ...(organizerAliases ?? mailboxOptions?.find((option) => option.mailbox.uid === mailboxUid)?.mailbox.aliasAddresses ?? [])].map(
            (address) => address.toLowerCase(),
        ),
    );
    const isOwnAddress = (address: string) => ownAddresses.has(address.toLowerCase());
    // An existing event organized by someone else is the viewing mailbox's copy of an invitation: only the
    // organizer can change it (their next update would overwrite local edits anyway), so it can't be modified.
    const isInvited =
        !!occurrence && !isOwnAddress(occurrence.organizer.address) && !occurrence.attendees.some((a) => a.isOrganizer && isOwnAddress(a.address));
    // The viewing mailbox can respond to an *existing* event it's invited to but doesn't organize - finding one of its own
    // addresses among the attendees (and not as that attendee's own organizer flag) identifies exactly that case.
    const myAttendee = occurrence?.attendees.find((a) => isOwnAddress(a.address));
    const canRespond = !!myAttendee && !myAttendee.isOrganizer;

    const isForm = !occurrence || editing;
    const layout = occurrence || expanded ? "expanded" : "quick";
    const variant: EventShellVariant = !isForm || layout === "expanded" ? "card" : isMobile ? "sheet" : "popover";
    const width = !isForm ? DETAILS_WIDTH : layout === "expanded" ? (tab === "event" || occurrence ? FORM_WIDTH : TASK_FORM_WIDTH) : QUICK_WIDTH;
    // Leaving the form: an existing event goes back to its details, a new one is done.
    const leaveForm = occurrence ? () => setEditing(false) : onClose;

    return (
        <EventShell
            variant={variant}
            label={!occurrence ? "New event" : editing ? "Edit event" : "Event details"}
            focusKey={isForm ? layout : "details"}
            anchor={anchor}
            width={width}
            onClose={isForm ? leaveForm : onClose}
            onBackdropPress={isForm ? () => !dirtyRef.current && leaveForm() : undefined}
        >
            {isForm ? (
                <EventEditor
                    layout={layout}
                    onExpand={() => setExpanded(true)}
                    onCancel={leaveForm}
                    onSaved={onSaved}
                    onSyncWarning={() => setSyncWarning(true)}
                    dirtyRef={dirtyRef}
                    mailboxUid={mailboxUid}
                    folderUid={folderUid}
                    calendars={calendars}
                    mailboxOptions={mailboxOptions}
                    folderColors={folderColors}
                    organizerAddress={organizerAddress}
                    occurrence={occurrence}
                    initialStart={initialStart}
                    initialEnd={initialEnd}
                    initialAllDay={initialAllDay}
                    quickCreate={
                        occurrence
                            ? undefined
                            : {
                                  tab,
                                  onTabChange: (next) => {
                                      setTab(next);
                                      setExpanded(false);
                                  },
                                  bookingHref,
                              }
                    }
                />
            ) : (
                <EventDetails
                    occurrence={occurrence}
                    isInvited={isInvited}
                    myResponse={canRespond ? myAttendee.responseStatus : undefined}
                    isOwnAddress={isOwnAddress}
                    calendarName={calendars?.find((cal) => cal.uid === occurrence.folderUid)?.name}
                    calendarColor={folderColors?.[occurrence.folderUid]}
                    onClose={onClose}
                    onModify={() => setEditing(true)}
                    onSaved={onSaved}
                    onDeleted={onDeleted}
                />
            )}
        </EventShell>
    );
}
