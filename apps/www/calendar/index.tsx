///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { routedPage } from "../_routedPage.js";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DndContext, DragEndEvent, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { HiOutlineBars3, HiOutlinePlus } from "react-icons/hi2";
import {
    addDays,
    addMonths,
    addWeeks,
    eachDayOfInterval,
    endOfDay,
    endOfMonth,
    endOfWeek,
    format,
    parseISO,
    startOfDay,
    startOfMonth,
    startOfWeek,
} from "date-fns";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import { CalendarEvent, getCalendarEvent, listCalendarEvents } from "@rapidmx/react-shared/calendar/calendarApi.js";
import { getPushClient } from "@rapidmx/react-shared/mail/pushClient.js";
import { moveOccurrence, resizeOccurrenceEnd } from "@rapidmx/react-shared/calendar/calendarMutations.js";
import { resolveDragAction } from "@rapidmx/react-shared/calendar/calendarDragIds.js";
import { createFolder } from "@rapidmx/react-shared/mail/mailApi.js";
import { CalendarOccurrence, expandAllOccurrences } from "@rapidmx/react-shared/calendar/recurrence.js";
import Drawer from "@rapidmx/react-shared/components/overlays/Drawer.js";
import CalendarShell, { CalendarShellProps, useCalendarShell } from "../../shared/components/calendar/layout/CalendarShell.js";
import CalendarListSidebar from "../../shared/components/calendar/CalendarListSidebar.js";
import { useWritableMailboxes } from "../../shared/components/mail/writableMailboxes.js";
import EventModal from "../../shared/components/calendar/EventModal.js";
import FloatingActionButton from "../../shared/components/layout/FloatingActionButton.js";
import { EventAnchor, anchorOf } from "../../shared/components/calendar/EventShell.js";
import MiniDatePicker from "@rapidmx/react-shared/components/pickers/MiniDatePicker.js";
import MonthView from "../../shared/components/calendar/MonthView.js";
import SplitDayView from "../../shared/components/calendar/SplitDayView.js";
import TimeGridView from "../../shared/components/calendar/TimeGridView.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { SWIPE_PERIOD_SHIFT } from "../../shared/components/calendar/swipeNavigation.js";
import { useSwipeSlide } from "../../shared/gestures/useSwipeSlide.js";
import { useEnterSlide } from "../../shared/gestures/useEnterSlide.js";
import { useWheelPaging, type WheelEdge } from "../../shared/gestures/useWheelPaging.js";
import { SHORTCUTS, ShortcutDef } from "../../shared/keyboard/keymap.js";
import { useShortcut } from "../../shared/keyboard/useShortcut.js";
import { useShortcutProps } from "../../shared/keyboard/useShortcutProps.js";
import { notifyApiError } from "../../shared/notifications/apiErrors.js";
import { bookingSettingsHref } from "../../shared/calendar/bookingPlugin.js";
import { redactedEventUidOf } from "../../shared/calendar/calendarLiveUpdates.js";

function CalendarPage(props: CalendarShellProps) {
    return (
        <CalendarShell {...props}>
            <CalendarContent userUid={props.userUid} bookingHref={bookingSettingsHref(props.pluginNav)} />
        </CalendarShell>
    );
}

type ViewType = "month" | "week" | "workWeek" | "day" | "split";
const VIEW_TYPES: ViewType[] = ["month", "week", "workWeek", "day", "split"];
const VIEW_LABELS: Record<ViewType, string> = { month: "Month", week: "Week", workWeek: "Work Week", day: "Day", split: "Split" };
/** The shortcut that switches to a view (Outlook's Ctrl+Alt+1-4); the split view has none. */
const VIEW_SHORTCUTS: Partial<Record<ViewType, ShortcutDef>> = {
    day: SHORTCUTS.calendar.day,
    workWeek: SHORTCUTS.calendar.workWeek,
    week: SHORTCUTS.calendar.week,
    month: SHORTCUTS.calendar.month,
};

/** One of the view switcher's buttons, with its shortcut in the tooltip. */
function ViewButton({ view, current, onSelect }: { view: ViewType; current: ViewType; onSelect: (view: ViewType) => void }) {
    const shortcut = VIEW_SHORTCUTS[view];
    const hint = useShortcutProps(VIEW_LABELS[view], shortcut ?? SHORTCUTS.calendar.day, !!shortcut);
    return (
        <button
            type="button"
            onClick={() => onSelect(view)}
            {...hint}
            className={[
                "px-3 h-7 text-sm rounded-sm whitespace-nowrap",
                current === view ? "bg-primary text-white" : "hover:bg-surface-alt",
                (view === "workWeek" || view === "split") && "hidden md:inline-block",
            ]
                .filter(Boolean)
                .join(" ")}
        >
            {VIEW_LABELS[view]}
        </button>
    );
}

interface ModalState {
    occurrence: CalendarOccurrence | null;
    initialStart?: Date;
    initialEnd?: Date;
    /** Overrides the default calendar a new event is created into (e.g. the column clicked in Split
     * view) — ignored when editing an existing occurrence, which always keeps its own `folderUid`. */
    targetFolderUid?: string;
    /** What was clicked to start a new event, for the quick-create popover to open beside (none: centered near the top). */
    anchor?: EventAnchor;
    /** A new event that starts as an all-day one (a day of the month view was clicked). */
    initialAllDay?: boolean;
}

function CalendarContent({ userUid, bookingHref }: { userUid?: string; bookingHref?: string }) {
    const { mailboxUid, folderUid, calendarFolders, mailboxCalendars, mailboxes, reloadFolders, colorFor } = useCalendarShell();
    // `PointerSensor` alone activates a drag on the very first touch-move, indistinguishable from a
    // scroll gesture on a touch device. `MouseSensor` (a small `distance` — desktop drags still start
    // immediately on a deliberate movement, no change from before) + `TouchSensor` (a `delay`+`tolerance`
    // — a touch drag only activates after a brief press-and-hold, so a quick swipe scrolls normally) is
    // dnd-kit's own documented pattern for this exact conflict.
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    );

    const [drawerOpen, setDrawerOpen] = useState(false);
    const [view, setView] = useState<ViewType>("month");
    const [viewDate, setViewDate] = useState(() => startOfDay(new Date()));
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [modal, setModal] = useState<ModalState | null>(null);
    // True from the moment a touch drag of an event (or its resize handle) activates until it ends or is cancelled.
    const [dragging, setDragging] = useState(false);
    // `null` means "not yet customized by the user" — every calendar is treated as checked without
    // needing to be seeded from `calendarFolders` the moment it loads (see `checkedFolderUids` below).
    // Once the user toggles anything, this becomes a real (possibly empty) set of exactly what's checked.
    const [checkedFolderUidsState, setCheckedFolderUidsState] = useState<Set<string> | null>(null);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const requestedView = params.get("view");
        if ((VIEW_TYPES as string[]).includes(requestedView ?? "")) {
            setView(requestedView as ViewType);
        }
        const requestedDate = params.get("date");
        // `parseISO()`, not `new Date()` - `?date=2026-06-16` is a local calendar day, but `new Date()` reads a
        // date-only string as UTC midnight, i.e. the previous day anywhere west of UTC.
        const parsedDate = requestedDate ? parseISO(requestedDate) : null;
        if (parsedDate && !isNaN(parsedDate.getTime())) {
            setViewDate(startOfDay(parsedDate));
        }
    }, []);

    const checkedFolderUids = checkedFolderUidsState ?? new Set(calendarFolders.map((f) => f.uid));
    const folderColors = useMemo(
        () => Object.fromEntries(calendarFolders.map((f) => [f.uid, colorFor(f)])),
        [calendarFolders, colorFor],
    );

    function toggleCalendar(toggledUid: string) {
        setCheckedFolderUidsState((prev) => {
            const next = new Set(prev ?? calendarFolders.map((f) => f.uid));
            if (next.has(toggledUid)) {
                next.delete(toggledUid);
            } else {
                next.add(toggledUid);
            }
            return next;
        });
    }

    async function handleAddCalendar(targetMailboxUid: string, name: string, color: string) {
        const created = await createFolder({ mailboxUid: targetMailboxUid, name, type: "calendar", color });
        setCheckedFolderUidsState((prev) => new Set([...(prev ?? calendarFolders.map((f) => f.uid)), created.uid]));
        reloadFolders();
    }

    const { rangeStart, rangeEnd, days } = useMemo(() => {
        if (view === "month") {
            const start = startOfWeek(startOfMonth(viewDate), { weekStartsOn: 1 });
            const end = endOfWeek(endOfMonth(viewDate), { weekStartsOn: 1 });
            return { rangeStart: start, rangeEnd: end, days: [] as Date[] };
        }
        if (view === "week") {
            const start = startOfWeek(viewDate, { weekStartsOn: 1 });
            const end = endOfWeek(viewDate, { weekStartsOn: 1 });
            return { rangeStart: start, rangeEnd: end, days: eachDayOfInterval({ start, end }) };
        }
        if (view === "workWeek") {
            const start = startOfWeek(viewDate, { weekStartsOn: 1 });
            const weekdays = eachDayOfInterval({ start, end: endOfWeek(viewDate, { weekStartsOn: 1 }) }).slice(0, 5);
            return { rangeStart: start, rangeEnd: endOfDay(weekdays[weekdays.length - 1]), days: weekdays };
        }
        // "day" and "split" both show a single day, just laid out differently below.
        const start = startOfDay(viewDate);
        const end = endOfDay(viewDate);
        return { rangeStart: start, rangeEnd: end, days: [start] };
    }, [view, viewDate]);

    // Only the most recent reload() may apply its results - toggling calendars (or saving/dragging an event)
    // while an earlier, slower fetch is still in flight must not let that stale response overwrite newer
    // events. (No date range is passed: `listCalendarEvents()` deliberately fetches the whole calendar and
    // filters client-side - see its own doc comment on the server-side range query it works around.)
    const reloadSeqRef = useRef(0);

    function reload() {
        const seq = ++reloadSeqRef.current;
        const targets = calendarFolders.filter((f) => checkedFolderUids.has(f.uid));
        if (targets.length === 0) {
            setEvents([]);
            setLoading(false);
            return;
        }
        setLoading(true);
        setError(null);
        void Promise.allSettled(targets.map((f) => listCalendarEvents(f.uid)))
            .then((results) => {
                if (seq !== reloadSeqRef.current) {
                    return;
                }
                const loaded: CalendarEvent[] = [];
                const failures: { name: string; err: unknown }[] = [];
                results.forEach((result, i) => {
                    if (result.status === "fulfilled") {
                        loaded.push(...result.value);
                    } else {
                        failures.push({ name: targets[i].name, err: result.reason });
                    }
                });
                setEvents(loaded);
                if (failures.length === 0) {
                    return;
                }
                // A single calendar's failure (by far the common case — most mailboxes have exactly one)
                // surfaces that calendar's own error message unchanged, matching this page's original
                // single-calendar behavior exactly; only a genuine multi-calendar partial failure falls
                // back to a combined message naming which calendars didn't load.
                if (failures.length === 1 && targets.length === 1) {
                    const err = failures[0].err;
                    setError(err instanceof ApiRequestError ? err.message : "Could not load your calendar.");
                } else {
                    setError(`Could not load events for: ${failures.map((f) => f.name).join(", ")}.`);
                }
            })
            .finally(() => {
                if (seq === reloadSeqRef.current) {
                    setLoading(false);
                }
            });
    }

    // Keyed on stable string summaries (not the array/set objects themselves, which are new references
    // every render) so this only re-fires when the actual set of folders to fetch changes.
    const calendarFolderUidsKey = calendarFolders.map((f) => f.uid).sort().join(",");
    const checkedFolderUidsKey = Array.from(checkedFolderUids).sort().join(",");
    useEffect(reload, [calendarFolderUidsKey, checkedFolderUidsKey]);

    // A private or confidential event that somebody creates or changes is announced on the push connection as its busy block, whatever the reader may
    // see (see `redactedEventUidOf()`): that payload is never stored here. The event is fetched again by its uid, which comes back as much as this
    // reader may see - all of it for the owner - and replaces (or joins) what the calendar holds; one that is gone (a 404) leaves it. A failed fetch
    // changes nothing: the next load shows the event as it is.
    const checkedFolderUidsRef = useRef(checkedFolderUids);
    checkedFolderUidsRef.current = checkedFolderUids;
    useEffect(
        () =>
            getPushClient().onEvent((event) => {
                const uid = redactedEventUidOf(event);
                if (!uid) {
                    return;
                }
                void getCalendarEvent(uid).then(
                    (fresh) => {
                        if (checkedFolderUidsRef.current.has(fresh.folderUid)) {
                            setEvents((previous) =>
                                previous.some((existing) => existing.uid === fresh.uid)
                                    ? previous.map((existing) => (existing.uid === fresh.uid ? fresh : existing))
                                    : [...previous, fresh],
                            );
                        }
                    },
                    (err: unknown) => {
                        if (err instanceof ApiRequestError && err.status === 404) {
                            setEvents((previous) => previous.filter((existing) => existing.uid !== uid));
                        }
                    },
                );
            }),
        [],
    );

    const occurrences = useMemo(
        () => expandAllOccurrences(events, rangeStart, rangeEnd),
        [events, rangeStart, rangeEnd],
    );

    const splitColumns = useMemo(
        () =>
            calendarFolders
                .filter((f) => checkedFolderUids.has(f.uid))
                .map((f) => ({ folderUid: f.uid, name: f.name, color: colorFor(f) })),
        [calendarFolders, checkedFolderUidsKey, colorFor],
    );

    function shiftView(direction: 1 | -1) {
        setViewDate((d) =>
            view === "month"
                ? addMonths(d, direction)
                : view === "week" || view === "workWeek"
                  ? addWeeks(d, direction)
                  : addDays(d, direction),
        );
    }

    // The phone layout's swipe between periods. Only the view area carries it (not the toolbar), it calls the same `shiftView()`
    // the Previous/Next buttons and shortcuts do, and it is off while an event is being dragged or the editor is open. The views
    // never scroll sideways (their columns share the width), so there is no horizontal scroller for the gesture to fight with.
    // The view follows the finger and, once the swipe commits, slides out while the next period slides in (see `useSwipeSlide()`).
    const isMobile = useIsMobile();
    const swipe = useSwipeSlide({
        enabled: isMobile && !dragging && !modal,
        onShift: (direction) => shiftView(SWIPE_PERIOD_SHIFT[direction]),
    });

    // The desktop's mouse wheel steps through the months without end; in the views that scroll through the hours of a day it scrolls
    // them as usual and, pushed past the last (or first) hour, carries on into the next (or previous) day, week or work week. Each
    // step is the same `shiftView()` and enters with a short vertical slide (`useEnterSlide()`), which never waits for the last one.
    const wheelSlide = useEnterSlide();
    /** Where the scroller of the page a wheel step arrived at starts: its top after going on, its bottom after going back. */
    const arrivalEdge = useRef<WheelEdge | null>(null);
    const scrollerOf = (): HTMLElement | null => swipe.ref.current?.querySelector<HTMLElement>("[data-calendar-scroller]") ?? null;
    useWheelPaging(swipe.ref, {
        enabled: !isMobile && !dragging && !modal,
        getScroller: () => (view === "month" ? null : scrollerOf()),
        onStep: (direction, edge) => {
            arrivalEdge.current = edge;
            shiftView(direction);
            wheelSlide.enter(direction);
        },
    });
    useLayoutEffect(() => {
        const edge = arrivalEdge.current;
        arrivalEdge.current = null;
        const scroller = edge ? scrollerOf() : null;
        if (scroller) {
            scroller.scrollTop = edge === "top" ? 0 : scroller.scrollHeight;
        }
    }, [viewDate]);

    function goToday() {
        setViewDate(startOfDay(new Date()));
    }

    function handleSelectDay(date: Date) {
        setView("day");
        setViewDate(startOfDay(date));
    }

    function openNewEvent(start?: Date, end?: Date, targetFolderUid?: string, anchor?: EventAnchor, initialAllDay?: boolean) {
        if (!mailboxUid || !folderUid) {
            return;
        }
        setModal({
            occurrence: null,
            initialStart: start ?? new Date(),
            initialEnd: end ?? new Date(Date.now() + 30 * 60_000),
            targetFolderUid,
            anchor,
            initialAllDay,
        });
    }

    function openEvent(occurrence: CalendarOccurrence) {
        setModal({ occurrence });
    }

    function closeModal() {
        setModal(null);
    }

    // Keyboard shortcuts - the toolbar's own actions. (A dialog open - the event editor - silences them.)
    useShortcut(SHORTCUTS.calendar.create, () => openNewEvent(), { enabled: !!mailboxUid && !!folderUid });
    useShortcut(SHORTCUTS.calendar.today, goToday);
    useShortcut(SHORTCUTS.calendar.previous, () => shiftView(-1));
    useShortcut(SHORTCUTS.calendar.next, () => shiftView(1));
    useShortcut(SHORTCUTS.calendar.day, () => setView("day"));
    useShortcut(SHORTCUTS.calendar.workWeek, () => setView("workWeek"));
    useShortcut(SHORTCUTS.calendar.week, () => setView("week"));
    useShortcut(SHORTCUTS.calendar.month, () => setView("month"));
    const newEventHint = useShortcutProps("New event", SHORTCUTS.calendar.create, !!mailboxUid && !!folderUid);
    const previousHint = useShortcutProps("Previous", SHORTCUTS.calendar.previous);
    const todayHint = useShortcutProps("Today", SHORTCUTS.calendar.today);
    const nextHint = useShortcutProps("Next", SHORTCUTS.calendar.next);

    function handleSaved() {
        setModal(null);
        reload();
    }

    function handleDeleted() {
        setModal(null);
        reload();
    }

    async function handleDragEnd(event: DragEndEvent) {
        setDragging(false);
        const overId = event.over ? String(event.over.id) : undefined;
        const action = resolveDragAction(String(event.active.id), overId, occurrences);
        if (!action) {
            return;
        }
        try {
            if (action.type === "move") {
                await moveOccurrence(action.occurrence, action.deltaMs);
            } else {
                await resizeOccurrenceEnd(action.occurrence, action.newEnd);
            }
            reload();
        } catch (err) {
            notifyApiError(err, action.type === "move" ? "Couldn't move the event" : "Couldn't resize the event");
        }
    }

    const title =
        view === "month"
            ? format(viewDate, "MMMM yyyy")
            : view === "week" || view === "workWeek"
              ? `${format(rangeStart, "MMM d")} – ${format(rangeEnd, "MMM d, yyyy")}`
              : format(viewDate, "EEEE, MMMM d, yyyy");

    const modalFolderUid = modal ? (modal.targetFolderUid ?? modal.occurrence?.folderUid ?? folderUid) : undefined;
    const modalMailboxUid = calendarFolders.find((f) => f.uid === modalFolderUid)?.mailboxUid ?? mailboxUid;
    const modalMailbox = mailboxes.find((mb) => mb.uid === modalMailboxUid);
    // Mailboxes a new event can be created in - only those with at least one calendar that the caller can
    // write to (a view-only share is left out; see writableMailboxes.ts).
    const writableMailboxes = useWritableMailboxes(mailboxes, userUid, modalMailboxUid);
    const mailboxOptions = useMemo(
        () =>
            mailboxCalendars
                .filter((mc) => mc.calendarFolders.length > 0 && writableMailboxes.some((mb) => mb.uid === mc.mailbox.uid))
                .map((mc) => ({ mailbox: mc.mailbox, calendars: mc.calendarFolders.map((f) => ({ uid: f.uid, name: f.name })) })),
        [mailboxCalendars, writableMailboxes],
    );

    const sidebarContent = (
        <>
            <MiniDatePicker selected={viewDate} onSelect={(date) => setViewDate(startOfDay(date))} />
            <CalendarListSidebar
                mailboxCalendars={mailboxCalendars}
                checkedFolderUids={checkedFolderUids}
                onToggle={toggleCalendar}
                onAddCalendar={handleAddCalendar}
                colorFor={colorFor}
            />
        </>
    );

    return (
        <div className="flex-1 min-w-0 flex min-h-0">
            <div className="hidden lg:flex w-56 shrink-0 border-r border-border flex-col overflow-y-auto">{sidebarContent}</div>
            <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Calendars" fullScreen>
                <div className="flex flex-col">{sidebarContent}</div>
            </Drawer>
            {/* `min-w-0`: without it the column is as wide as its widest row (the toolbar, the month grid) and runs off the window instead of the row wrapping. */}
            <div className="flex-1 min-w-0 flex flex-col min-h-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 border-b border-border shrink-0">
                    <button
                        type="button"
                        className="lg:hidden w-9 h-9 flex items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text shrink-0"
                        aria-label="Open calendars"
                        onClick={() => setDrawerOpen(true)}
                    >
                        <HiOutlineBars3 size={20} aria-hidden="true" />
                    </button>
                    {/* On a phone New event is the floating button at the bottom of the page instead, as in Mail. */}
                    {!isMobile && (
                        <Button type="button" onClick={(e) => openNewEvent(undefined, undefined, undefined, anchorOf(e.currentTarget, "below"))} className="!w-auto shrink-0" {...newEventHint}>
                            + New event
                        </Button>
                    )}
                    <div className="flex items-center gap-1">
                        <button type="button" onClick={() => shiftView(-1)} aria-label="Previous" {...previousHint} className="w-7 h-7 text-sm rounded-sm hover:bg-surface-alt">
                            &lsaquo;
                        </button>
                        <button type="button" onClick={goToday} {...todayHint} className="px-2 h-7 text-sm rounded-sm hover:bg-surface-alt">
                            Today
                        </button>
                        <button type="button" onClick={() => shiftView(1)} aria-label="Next" {...nextHint} className="w-7 h-7 text-sm rounded-sm hover:bg-surface-alt">
                            &rsaquo;
                        </button>
                    </div>
                    <h1 className="hidden md:block text-lg font-bold tracking-tight">{title}</h1>
                    <div className="ml-auto flex flex-wrap gap-1">
                        {VIEW_TYPES.map((v) => (
                            <ViewButton key={v} view={v} current={view} onSelect={setView} />
                        ))}
                    </div>
                </div>

                {error && (
                    <div className="p-3">
                        <Alert>{error}</Alert>
                    </div>
                )}

                <div ref={swipe.ref} className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden" {...swipe.handlers} style={swipe.style}>
                    <div data-swipe-phase={swipe.phase} className="flex-1 min-w-0 flex flex-col min-h-0" style={swipe.contentStyle}>
                        <div className="flex-1 min-w-0 flex flex-col min-h-0" style={wheelSlide.style}>
                            {loading ? (
                                <p className="p-4 text-sm text-text-muted">Loading&hellip;</p>
                            ) : (
                                <DndContext
                                    sensors={sensors}
                                    onDragStart={() => setDragging(true)}
                                    onDragEnd={handleDragEnd}
                                    onDragCancel={() => setDragging(false)}
                                >
                                    {view === "month" ? (
                                        <MonthView
                                            viewDate={viewDate}
                                            occurrences={occurrences}
                                            folderColors={folderColors}
                                            onSelectDay={handleSelectDay}
                                            onSelectEvent={openEvent}
                                            onSelectSlot={(start, end, anchor) => openNewEvent(start, end, undefined, anchor, true)}
                                        />
                                    ) : view === "split" ? (
                                        <SplitDayView
                                            day={viewDate}
                                            columns={splitColumns}
                                            occurrences={occurrences}
                                            onSelectEvent={openEvent}
                                            onSelectSlot={(start, end, targetFolderUid, anchor) => openNewEvent(start, end, targetFolderUid, anchor)}
                                        />
                                    ) : (
                                        <TimeGridView
                                            days={days}
                                            occurrences={occurrences}
                                            folderColors={folderColors}
                                            onSelectEvent={openEvent}
                                            onSelectSlot={(start, end, anchor) => openNewEvent(start, end, undefined, anchor)}
                                        />
                                    )}
                                </DndContext>
                            )}
                        </div>
                    </div>
                </div>

                {/* `folderUid` is guaranteed defined whenever `modal` is: `openNewEvent` only sets it after
                    checking it, and `openEvent` only fires from an occurrence that itself required a
                    successful, folder-scoped load to render. The modal is scoped to that folder's own mailbox
                    (which may be a shared one) - its organizer address and calendar picker come from there. */}
                {modal && modalMailbox && (
                    <EventModal
                        open
                        onClose={closeModal}
                        mailboxUid={modalMailbox.uid}
                        folderUid={modalFolderUid!}
                        calendars={calendarFolders.filter((f) => f.mailboxUid === modalMailbox.uid).map((f) => ({ uid: f.uid, name: f.name }))}
                        mailboxOptions={mailboxOptions}
                        folderColors={folderColors}
                        organizerAddress={modalMailbox.primarySmtpAddress}
                        organizerAliases={modalMailbox.aliasAddresses}
                        occurrence={modal.occurrence}
                        initialStart={modal.initialStart}
                        initialEnd={modal.initialEnd}
                        initialAllDay={modal.initialAllDay}
                        anchor={modal.anchor}
                        bookingHref={bookingHref}
                        onSaved={handleSaved}
                        onDeleted={handleDeleted}
                    />
                )}
                {/* The phone layout's New event: the old toolbar button's action (its quick form is a bottom sheet there, so no anchor), offered
                    only where that button could act - a calendar to put the event in - and not while the editor or its sheet is open. */}
                {isMobile && mailboxUid && folderUid && !modal && <FloatingActionButton label="New event" icon={HiOutlinePlus} onClick={() => openNewEvent()} />}
            </div>
        </div>
    );
}

export default routedPage("/calendar", CalendarPage);
