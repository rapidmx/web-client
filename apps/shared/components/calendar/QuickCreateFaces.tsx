///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { MutableRefObject, useEffect, useRef, useState } from "react";
import { deviceTimeZone } from "@rapidmx/react-shared/util/timeZone.js";
import AppointmentQuickForm, { initialAppointmentDraft } from "./AppointmentQuickForm.js";
import EventExpandedForm from "./EventExpandedForm.js";
import EventQuickForm from "./EventQuickForm.js";
import { EventFormController } from "./eventForm.js";
import QuickCreateTabs, { QuickTab, quickPanelProps, quickTabId } from "./QuickCreateTabs.js";
import TaskQuickForm, { initialTaskDraft } from "./TaskQuickForm.js";

/** What `EventModal` tells the editor about the tabs of a new event's popover. */
export interface QuickCreateConfig {
    tab: QuickTab;
    onTabChange: (tab: QuickTab) => void;
    /** Where the booking plugin's Settings pages are, or `undefined` when the plugin is not running (and there is no Appointment schedule tab). */
    bookingHref?: string;
}

export interface QuickCreateFacesProps {
    /** The Event tab's form, which owns the title and the mailbox and calendar the other tabs share. */
    c: EventFormController;
    layout: "quick" | "expanded";
    onExpand: () => void;
    config: QuickCreateConfig;
    dirtyRef: MutableRefObject<boolean>;
    /** The signed-in mailbox's address: the host's name on booking pages when its display name is not known. */
    organizerAddress: string;
}

/**
 * The faces of a new event, one for each tab: Event (the quick popover or, after More options, the full card - unchanged), Task and
 * Appointment schedule. Stays mounted while the tab changes, so it is what keeps the other tabs' fields (the Event tab's live in
 * `EventEditor`) when the user looks at another one and comes back. The title, the mailbox and the calendar are the Event tab's, so they
 * are shared by all three.
 *
 * The tab strip is redrawn by whichever face is showing, so a tab change moves keyboard focus back to the selected tab here - what an
 * arrow-key walk along the strip needs.
 */
export default function QuickCreateFaces({ c, layout, onExpand, config, dirtyRef, organizerAddress }: QuickCreateFacesProps) {
    const { tab, onTabChange, bookingHref } = config;
    const [task, setTask] = useState(() => initialTaskDraft(c.values.start, c.values.allDay));
    const [appointment, setAppointment] = useState(initialAppointmentDraft);

    const shownTab = useRef(tab);
    useEffect(() => {
        if (shownTab.current !== tab) {
            shownTab.current = tab;
            document.getElementById(quickTabId(tab))?.focus();
        }
    }, [tab]);

    // Notes typed on the Task tab are worth a second thought before a stray click closes the popover, like a title.
    dirtyRef.current = dirtyRef.current || task.body.trim() !== "";

    const tabs = <QuickCreateTabs tab={tab} onChange={onTabChange} showAppointment={!!bookingHref} />;

    if (tab === "task") {
        return (
            <TaskQuickForm
                c={c}
                draft={task}
                onDraftChange={(patch) => setTask((prev) => ({ ...prev, ...patch }))}
                tabs={tabs}
                expanded={layout === "expanded"}
                onExpand={onExpand}
            />
        );
    }
    if (tab === "appointment") {
        const hostMailbox = c.mailboxOptions?.find((option) => option.mailbox.uid === c.values.targetMailboxUid)?.mailbox;
        return (
            <AppointmentQuickForm
                c={c}
                draft={appointment}
                onDraftChange={(patch) => setAppointment((prev) => ({ ...prev, ...patch }))}
                tabs={tabs}
                settingsHref={bookingHref!}
                hostName={hostMailbox?.displayName ?? organizerAddress}
                timeZone={hostMailbox?.timezone ?? deviceTimeZone()}
            />
        );
    }
    return layout === "quick" ? <EventQuickForm c={c} onExpand={onExpand} tabs={tabs} tabPanelProps={quickPanelProps("event")} /> : <EventExpandedForm c={c} />;
}
