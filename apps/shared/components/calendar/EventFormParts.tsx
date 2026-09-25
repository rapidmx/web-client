///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useRef, useState } from "react";
import { HiOutlineBars3BottomLeft, HiOutlineBell, HiOutlineMapPin, HiOutlineUserGroup, HiOutlineVideoCamera, HiOutlineXMark } from "react-icons/hi2";
import { AttendeeRole, EventVisibility, RecurrenceRule, WeekdayCode } from "@rapidmx/react-shared/calendar/calendarApi.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import LazyDescriptionEditor from "./LazyDescriptionEditor.js";
import RecurrenceEditor from "./RecurrenceEditor.js";
import ResourcePicker from "./ResourcePicker.js";
import { EventFormController } from "./eventForm.js";
import { hasDescriptionText } from "./eventDialogFields.js";
import {
    REMINDER_UNITS,
    ReminderUnit,
    RESPONSE_STATUS_LABEL,
    VISIBILITIES,
    VISIBILITY_HELP,
    VISIBILITY_LABEL,
    bestReminderUnit,
} from "./eventFormat.js";

export const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-md bg-surface text-text focus:outline-none focus:border-primary";
export const SELECT_CLASS =
    "text-sm py-2 px-2 border border-border rounded-md bg-surface text-text focus:outline-none focus:border-primary";
/** A text field that reads as plain text until it is hovered or focused, as a row of the quick-create popover does. */
const QUIET_INPUT_CLASS =
    "w-full min-w-0 text-sm py-1.5 bg-transparent text-text border-0 border-b border-transparent hover:border-border focus:border-primary focus:outline-none placeholder:text-text-muted";
const ROW_ICON_CLASS = "shrink-0 text-text-muted mt-1.5";

const ATTENDEE_ROLES: AttendeeRole[] = ["required", "optional", "resource"];

/** A form row: an icon in the left gutter and its content. */
export function IconRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
    return (
        <div className="flex items-start gap-3">
            <span aria-hidden="true" className={ROW_ICON_CLASS}>
                {icon}
            </span>
            <div className="flex-1 min-w-0">{children}</div>
        </div>
    );
}

/** The location row: a text box that is plain text until it is used. */
export function LocationRow({ c }: { c: EventFormController }) {
    return (
        <IconRow icon={<HiOutlineMapPin size={20} />}>
            <input
                type="text"
                aria-label="Location"
                placeholder="Add location"
                className={QUIET_INPUT_CLASS}
                value={c.values.location}
                onChange={(e) => c.update({ location: e.target.value })}
            />
        </IconRow>
    );
}

/** "Add video conferencing" and, once the event has a meeting, the button that joins it. */
export function VideoConferencingRow({ c }: { c: EventFormController }) {
    const { values } = c;
    return (
        <IconRow icon={<HiOutlineVideoCamera size={20} />}>
            <label className="flex items-center gap-2 text-sm py-1.5">
                <input type="checkbox" checked={values.videoEnabled} onChange={(e) => c.update({ videoEnabled: e.target.checked })} />
                Add video conferencing
            </label>
            {values.videoEnabled && (
                <p className="text-xs text-text-muted mb-1">
                    Changing attendees after enabling video conferencing won&rsquo;t update meeting invitees &mdash; turn this off and back on to
                    reissue links to the current attendee list.
                </p>
            )}
            {c.videoError && (
                <p role="alert" className="text-xs text-danger mb-1">
                    {c.videoError}
                </p>
            )}
            {c.videoMeetingUid && (
                <div className="flex items-center gap-3 mb-1">
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto"
                        disabled={!c.joinUrl}
                        onClick={() => window.open(c.joinUrl, "_blank", "noopener,noreferrer")}
                    >
                        Join video call
                    </Button>
                    {!c.joinUrl && (
                        <span className="text-xs text-text-muted">
                            {c.organizerJoinUrl === undefined ? "Loading the join link…" : "This meeting’s join link isn’t available."}
                        </span>
                    )}
                </div>
            )}
        </IconRow>
    );
}

/**
 * The guests field: an address box (Enter, a comma or a semicolon adds what is typed) and what has been added - chips in the quick popover,
 * rows with a role, the answer so far and a remove button in the full form, which also offers rooms and equipment.
 */
export function GuestsField({ c, compact }: { c: EventFormController; compact: boolean }) {
    const { values } = c;
    const [hint, setHint] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const pickerAnchor = useRef<HTMLButtonElement>(null);

    function commit() {
        const invalid = c.addGuests(values.guestDraft);
        setHint(invalid.length > 0 ? `“${invalid[0]}” isn’t a valid email address.` : null);
    }

    return (
        <div className="flex flex-col gap-2">
            <input
                type="text"
                aria-label="Add guests"
                placeholder="Add guests"
                className={compact ? QUIET_INPUT_CLASS : INPUT_CLASS}
                value={values.guestDraft}
                onChange={(e) => {
                    setHint(null);
                    c.update({ guestDraft: e.target.value });
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "," || e.key === ";") {
                        e.preventDefault();
                        commit();
                    }
                }}
            />
            {hint && (
                <p role="alert" className="text-xs text-danger">
                    {hint}
                </p>
            )}
            {compact ? (
                values.attendees.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                        {values.attendees.map((attendee, i) => (
                            <li key={i} className="flex items-center gap-1 text-xs rounded-full bg-surface-alt pl-2.5 pr-1 py-0.5">
                                <span className="truncate max-w-[16rem]">{attendee.address}</span>
                                <button
                                    type="button"
                                    onClick={() => c.removeAttendee(i)}
                                    className="w-4 h-4 flex items-center justify-center rounded-full text-text-muted hover:text-text"
                                    aria-label={`Remove attendee ${i + 1}`}
                                >
                                    <HiOutlineXMark size={12} aria-hidden="true" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )
            ) : (
                <>
                    {values.attendees.length > 0 && (
                        <ul className="flex flex-col gap-2">
                            {values.attendees.map((attendee, i) => (
                                <li key={i} className="flex items-center gap-2">
                                    <span
                                        aria-hidden="true"
                                        className="w-7 h-7 shrink-0 rounded-full bg-primary/15 text-primary-dark text-xs font-semibold flex items-center justify-center uppercase"
                                    >
                                        {(attendee.displayName || attendee.address).charAt(0)}
                                    </span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm truncate">{attendee.displayName || attendee.address}</div>
                                        <div className="text-xs text-text-muted truncate">
                                            {attendee.displayName ? `${attendee.address} · ` : ""}
                                            {RESPONSE_STATUS_LABEL[attendee.responseStatus]}
                                        </div>
                                    </div>
                                    <select
                                        className={SELECT_CLASS}
                                        value={attendee.role}
                                        onChange={(e) => c.updateAttendee(i, { role: e.target.value as AttendeeRole })}
                                        aria-label={`Attendee role ${i + 1}`}
                                    >
                                        {ATTENDEE_ROLES.map((role) => (
                                            <option key={role} value={role}>
                                                {role}
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => c.removeAttendee(i)}
                                        className="w-7 h-7 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                                        aria-label={`Remove attendee ${i + 1}`}
                                    >
                                        <HiOutlineXMark size={16} aria-hidden="true" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <button
                        ref={pickerAnchor}
                        type="button"
                        onClick={() => setPickerOpen(true)}
                        className="self-start text-xs font-medium text-primary-dark hover:underline"
                    >
                        + Add room/equipment
                    </button>
                    {pickerOpen && (
                        <ResourcePicker
                            anchorRef={pickerAnchor}
                            onClose={() => setPickerOpen(false)}
                            onSelect={(mailbox) => {
                                c.addResource(mailbox);
                                setPickerOpen(false);
                            }}
                            excludeAddresses={c.guestAddresses}
                        />
                    )}
                </>
            )}
        </div>
    );
}

/** The guests row of the quick popover. */
export function GuestsRow({ c }: { c: EventFormController }) {
    return (
        <IconRow icon={<HiOutlineUserGroup size={20} />}>
            <GuestsField c={c} compact />
        </IconRow>
    );
}

/** The reminder row: the one notification an event has - an amount, its unit and a way to remove it - or "Add notification". */
export function ReminderRow({ value, onChange }: { value: string; onChange: (minutes: string) => void }) {
    const [active, setActive] = useState(value.trim() !== "");
    const [unit, setUnit] = useState<ReminderUnit>(() => (value.trim() === "" ? "minutes" : bestReminderUnit(Number(value)).unit));
    const factor = REMINDER_UNITS.find((u) => u.unit === unit)!.factor;
    // What the amount box shows: the stored minutes in the chosen unit. A blank stays blank while the row is open.
    const amount = value.trim() === "" ? "" : String(Math.round((Number(value) / factor) * 100) / 100);

    function change(nextAmount: string, nextUnit: ReminderUnit) {
        const nextFactor = REMINDER_UNITS.find((u) => u.unit === nextUnit)!.factor;
        onChange(nextAmount.trim() === "" ? "" : String(Math.round(Number(nextAmount) * nextFactor)));
    }

    if (!active) {
        return (
            <IconRow icon={<HiOutlineBell size={20} />}>
                <button
                    type="button"
                    className="text-sm text-text-muted hover:text-text py-1.5"
                    onClick={() => {
                        setActive(true);
                        setUnit("minutes");
                        onChange("30");
                    }}
                >
                    Add notification
                </button>
            </IconRow>
        );
    }
    return (
        <IconRow icon={<HiOutlineBell size={20} />}>
            <div className="flex items-center gap-2 text-sm">
                <span>Notification</span>
                <input
                    type="number"
                    min={0}
                    className={`${INPUT_CLASS} !w-20`}
                    aria-label="Reminder (minutes before)"
                    value={amount}
                    onChange={(e) => change(e.target.value, unit)}
                />
                <select
                    className={SELECT_CLASS}
                    aria-label="Reminder unit"
                    value={unit}
                    onChange={(e) => {
                        const nextUnit = e.target.value as ReminderUnit;
                        setUnit(nextUnit);
                        change(amount, nextUnit);
                    }}
                >
                    {REMINDER_UNITS.map((u) => (
                        <option key={u.unit} value={u.unit}>
                            {u.unit}
                        </option>
                    ))}
                </select>
                <span className="text-text-muted">before</span>
                <button
                    type="button"
                    aria-label="Remove notification"
                    className="ml-auto w-7 h-7 flex items-center justify-center rounded-full text-text-muted hover:bg-surface-alt hover:text-text"
                    onClick={() => {
                        setActive(false);
                        onChange("");
                    }}
                >
                    <HiOutlineXMark size={16} aria-hidden="true" />
                </button>
            </div>
        </IconRow>
    );
}

type RecurrencePresetKey = "none" | "daily" | "weekly" | "monthly" | "yearly" | "weekdays" | "custom";

const WEEKDAYS_ONLY: WeekdayCode[] = ["MO", "TU", "WE", "TH", "FR"];
const WEEKDAY_NAME: Record<WeekdayCode, string> = {
    MO: "Monday",
    TU: "Tuesday",
    WE: "Wednesday",
    TH: "Thursday",
    FR: "Friday",
    SA: "Saturday",
    SU: "Sunday",
};

function presetRule(key: Exclude<RecurrencePresetKey, "none" | "custom">, startWeekday: WeekdayCode | undefined): RecurrenceRule {
    switch (key) {
        case "daily":
            return { freq: "daily", interval: 1, exceptions: [] };
        case "weekly":
            return { freq: "weekly", interval: 1, byDay: [startWeekday ?? "MO"], exceptions: [] };
        case "monthly":
            return { freq: "monthly", interval: 1, exceptions: [] };
        case "yearly":
            return { freq: "yearly", interval: 1, exceptions: [] };
        case "weekdays":
            return { freq: "weekly", interval: 1, byDay: [...WEEKDAYS_ONLY], exceptions: [] };
    }
}

/** Which menu entry a rule is: one of the plain repeats, or "custom" for anything with an interval, an end or other weekdays. */
function presetOf(rule: RecurrenceRule | null, startWeekday: WeekdayCode | undefined): RecurrencePresetKey {
    if (!rule) {
        return "none";
    }
    if (rule.interval !== 1 || rule.count || rule.until || rule.byMonthDay?.length || rule.byMonth?.length) {
        return "custom";
    }
    if (rule.freq === "weekly") {
        const days = [...(rule.byDay ?? [])].sort().join(",");
        if (days === [...WEEKDAYS_ONLY].sort().join(",")) {
            return "weekdays";
        }
        return days === (startWeekday ?? "MO") ? "weekly" : "custom";
    }
    return rule.byDay?.length ? "custom" : rule.freq;
}

/**
 * "Does not repeat" and the plain repeats as a menu, with "Custom…" opening `RecurrenceEditor`'s full set (an interval, weekdays, an end).
 * Choosing one of the plain repeats keeps the rule's skipped dates; the menu shows "Custom…" for any rule it has no plain entry for.
 */
export function RecurrenceSelect({
    value,
    onChange,
    allDay,
    startWeekday,
}: {
    value: RecurrenceRule | null;
    onChange: (rule: RecurrenceRule | null) => void;
    allDay: boolean;
    startWeekday: WeekdayCode | undefined;
}) {
    // Picking "Custom…" for a rule that is also a plain repeat still opens the editor.
    const [customRequested, setCustomRequested] = useState(false);
    const selected: RecurrencePresetKey = customRequested && value ? "custom" : presetOf(value, startWeekday);

    function choose(key: RecurrencePresetKey) {
        setCustomRequested(key === "custom");
        if (key === "none") {
            onChange(null);
        } else if (key === "custom") {
            onChange(value ?? presetRule("weekly", startWeekday));
        } else {
            onChange({ ...presetRule(key, startWeekday), exceptions: value?.exceptions ?? [] });
        }
    }

    return (
        <div className="flex flex-col gap-2">
            <select
                id="event-recurrence"
                aria-label="Recurrence"
                className={SELECT_CLASS}
                value={selected}
                onChange={(e) => choose(e.target.value as RecurrencePresetKey)}
            >
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">{startWeekday ? `Weekly on ${WEEKDAY_NAME[startWeekday]}` : "Weekly"}</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Annually</option>
                <option value="weekdays">Every weekday (Monday to Friday)</option>
                <option value="custom">Custom…</option>
            </select>
            {selected === "custom" && <RecurrenceEditor value={value} onChange={onChange} allDay={allDay} startWeekday={startWeekday} hideToggle />}
        </div>
    );
}

/** [start date] [start time] to [end time] [end date], then "All day", the "Time zone" link (and its menu) and how the event repeats. */
export function DateTimeControls({ c }: { c: EventFormController }) {
    const { values } = c;
    const [zoneOpen, setZoneOpen] = useState(false);
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <input
                    type="date"
                    aria-label="Event start date"
                    className={`${SELECT_CLASS} min-w-0`}
                    value={values.start.slice(0, 10)}
                    onChange={(e) => c.setStart(`${e.target.value}${values.start.slice(10)}`)}
                />
                {!values.allDay && (
                    <input
                        type="time"
                        aria-label="Event start time"
                        className={`${SELECT_CLASS} min-w-0`}
                        value={values.start.slice(11, 16)}
                        onChange={(e) => c.setStart(`${values.start.slice(0, 11)}${e.target.value}`)}
                    />
                )}
                <span className="text-text-muted">to</span>
                {!values.allDay && (
                    <input
                        type="time"
                        aria-label="Event end time"
                        className={`${SELECT_CLASS} min-w-0`}
                        value={values.end.slice(11, 16)}
                        onChange={(e) => c.setEnd(`${values.end.slice(0, 11)}${e.target.value}`)}
                    />
                )}
                <input
                    type="date"
                    aria-label="Event end date"
                    className={`${SELECT_CLASS} min-w-0`}
                    value={values.end.slice(0, 10)}
                    onChange={(e) => c.setEnd(`${e.target.value}${values.end.slice(10)}`)}
                />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <label className="flex items-center gap-2">
                    <input type="checkbox" checked={values.allDay} onChange={(e) => c.onAllDayChange(e.target.checked)} />
                    All day
                </label>
                <button
                    type="button"
                    aria-expanded={zoneOpen}
                    className="text-primary-dark hover:underline"
                    onClick={() => setZoneOpen((open) => !open)}
                >
                    Time zone
                </button>
                {!c.editingSingleOccurrence && (
                    <RecurrenceSelect value={values.recurrenceRule} onChange={(rule) => c.update({ recurrenceRule: rule })} allDay={values.allDay} startWeekday={c.startWeekday} />
                )}
            </div>
            {zoneOpen && (
                <select
                    aria-label="Time zone"
                    className={`${SELECT_CLASS} self-start max-w-full`}
                    value={values.formZone}
                    onChange={(e) => c.onTimeZoneChange(e.target.value)}
                >
                    {c.timeZones.map((zone) => (
                        <option key={zone} value={zone}>
                            {zone}
                        </option>
                    ))}
                </select>
            )}
        </div>
    );
}

/** The calendar this event is in: its colour and name, a choice between calendars (and mailboxes) when an event is being created. */
export function CalendarField({ c }: { c: EventFormController }) {
    const { values } = c;
    const mailboxChoices = !c.occurrence && c.mailboxOptions && c.mailboxOptions.length > 1 ? c.mailboxOptions : undefined;
    const calendarChoices = !c.occurrence && c.calendarChoices && c.calendarChoices.length > 1 ? c.calendarChoices : undefined;
    return (
        <div className="flex flex-col gap-2">
            {mailboxChoices && (
                <select
                    aria-label="Mailbox"
                    className={`${SELECT_CLASS} self-start max-w-full`}
                    value={values.targetMailboxUid}
                    onChange={(e) => c.onMailboxChange(e.target.value)}
                >
                    {mailboxChoices.map(({ mailbox }) => (
                        <option key={mailbox.uid} value={mailbox.uid}>
                            {mailbox.displayName}
                            {mailbox.ownerUserUid ? "" : " (shared)"}
                        </option>
                    ))}
                </select>
            )}
            <div className="flex items-center gap-2 text-sm">
                <span aria-hidden="true" className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: c.calendarColor }} />
                {calendarChoices ? (
                    <select
                        aria-label="Calendar"
                        className={`${SELECT_CLASS} min-w-0 max-w-full`}
                        value={values.targetFolderUid}
                        onChange={(e) => c.update({ targetFolderUid: e.target.value })}
                    >
                        {calendarChoices.map((cal) => (
                            <option key={cal.uid} value={cal.uid}>
                                {cal.name}
                            </option>
                        ))}
                    </select>
                ) : (
                    <span className="truncate">{c.calendarName}</span>
                )}
            </div>
        </div>
    );
}

/**
 * The description row: the rich-text box (`DescriptionEditor`). In the full card it is always there; in the quick-create popover (`collapsible`) it is an
 * "Add description" row that opens the same box in place, as Google Calendar does - and stays open once there is text in it.
 */
export function DescriptionRow({ c, collapsible }: { c: EventFormController; collapsible: boolean }) {
    const [opened, setOpened] = useState(false);
    if (collapsible && !opened && !hasDescriptionText(c.values.descriptionHtml)) {
        return (
            <IconRow icon={<HiOutlineBars3BottomLeft size={20} />}>
                <button type="button" className="text-sm text-text-muted hover:text-text py-1.5" onClick={() => setOpened(true)}>
                    Add description
                </button>
            </IconRow>
        );
    }
    return (
        <IconRow icon={<HiOutlineBars3BottomLeft size={20} />}>
            <LazyDescriptionEditor value={c.values.descriptionHtml} onChange={(html) => c.update({ descriptionHtml: html })} autoFocus={collapsible && opened} />
        </IconRow>
    );
}

/** Who may see the event's details, with what each choice means underneath. */
export function VisibilitySelect({ c }: { c: EventFormController }) {
    const { visibility } = c.values;
    return (
        <div className="flex flex-col gap-1">
            <select
                aria-label="Visibility"
                aria-describedby="event-visibility-help"
                className={`${SELECT_CLASS} !w-auto self-start`}
                value={visibility}
                onChange={(e) => c.update({ visibility: e.target.value as EventVisibility })}
            >
                {VISIBILITIES.map((option) => (
                    <option key={option} value={option}>
                        {VISIBILITY_LABEL[option]}
                    </option>
                ))}
            </select>
            <p id="event-visibility-help" className="text-xs text-text-muted">
                {VISIBILITY_HELP[visibility]}
            </p>
        </div>
    );
}

const GUEST_PERMISSIONS = [
    {
        key: "guestsCanModify",
        label: "Modify event",
        help: "Guests can ask you to change the title, location, description or time. What they ask for is sent to you and applied automatically when this is on.",
    },
    {
        key: "guestsCanInviteOthers",
        label: "Invite others",
        help: "Guests can ask you to add more guests; those are added automatically when this is on.",
    },
    {
        key: "guestsCanSeeGuestList",
        label: "See guest list",
        help: "When this is off, each guest is sent an invitation that names only themselves and you.",
    },
] as const;

/** What guests may do with the event: ask for it to change, ask for guests to be added, see who else is invited. Only the organizer sets these. */
export function GuestPermissions({ c }: { c: EventFormController }) {
    return (
        <fieldset className="flex flex-col gap-2 min-w-0">
            <legend className="text-sm font-semibold mb-1">Guest permissions</legend>
            {GUEST_PERMISSIONS.map(({ key, label, help }) => (
                <div key={key}>
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            aria-describedby={`event-${key}-help`}
                            checked={c.values[key]}
                            onChange={(e) => c.update({ [key]: e.target.checked })}
                        />
                        {label}
                    </label>
                    <p id={`event-${key}-help`} className="text-xs text-text-muted pl-6">
                        {help}
                    </p>
                </div>
            ))}
        </fieldset>
    );
}

