///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useMemo, useState } from "react";
import { DndContext, DragEndEvent, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { HiOutlineBars3 } from "react-icons/hi2";
import {
    addDays,
    addMonths,
    addWeeks,
    eachDayOfInterval,
    endOfDay,
    endOfMonth,
    endOfWeek,
    format,
    startOfDay,
    startOfMonth,
    startOfWeek,
} from "date-fns";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { colorForFolder } from "@rapidmx/react-shared/calendarColors.js";
import { CalendarEvent, listCalendarEvents } from "@rapidmx/react-shared/calendarApi.js";
import { moveOccurrence, resizeOccurrenceEnd } from "@rapidmx/react-shared/calendarMutations.js";
import { resolveDragAction } from "@rapidmx/react-shared/calendarDragIds.js";
import { createFolder } from "@rapidmx/react-shared/mailApi.js";
import { CalendarOccurrence, expandAllOccurrences } from "@rapidmx/react-shared/recurrence.js";
import Drawer from "@rapidmx/react-shared/Drawer.js";
import CalendarShell, { CalendarShellProps, useCalendarShell } from "../../shared/components/calendar/layout/CalendarShell.js";
import CalendarListSidebar from "../../shared/components/calendar/CalendarListSidebar.js";
import EventModal from "../../shared/components/calendar/EventModal.js";
import MiniDatePicker from "../../shared/components/calendar/MiniDatePicker.js";
import MonthView from "../../shared/components/calendar/MonthView.js";
import SplitDayView from "../../shared/components/calendar/SplitDayView.js";
import TimeGridView from "../../shared/components/calendar/TimeGridView.js";
import Alert from "../../shared/components/feedback/Alert.js";
import Button from "../../shared/components/buttons/Button.js";

export default function CalendarPage(props: CalendarShellProps) {
    return (
        <CalendarShell {...props}>
            <CalendarContent />
        </CalendarShell>
    );
}

type ViewType = "month" | "week" | "workWeek" | "day" | "split";
const VIEW_TYPES: ViewType[] = ["month", "week", "workWeek", "day", "split"];
const VIEW_LABELS: Record<ViewType, string> = { month: "Month", week: "Week", workWeek: "Work Week", day: "Day", split: "Split" };

interface ModalState {
    occurrence: CalendarOccurrence | null;
    initialStart?: Date;
    initialEnd?: Date;
    /** Overrides the default calendar a new event is created into (e.g. the column clicked in Split
     * view) — ignored when editing an existing occurrence, which always keeps its own `folderUid`. */
    targetFolderUid?: string;
}

function CalendarContent() {
    const { mailboxUid, folderUid, calendarFolders, mailboxes, reloadFolders } = useCalendarShell();
    // `CalendarShell` only ever renders this component once `mailboxUid` is set, and always to a value
    // drawn from `mailboxes` itself (see its own resolution logic) — the lookup below always succeeds.
    const organizerAddress = mailboxes.find((mb) => mb.uid === mailboxUid)!.primarySmtpAddress;
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
    const [actionError, setActionError] = useState<string | null>(null);
    const [modal, setModal] = useState<ModalState | null>(null);
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
        const parsedDate = requestedDate ? new Date(requestedDate) : null;
        if (parsedDate && !isNaN(parsedDate.getTime())) {
            setViewDate(startOfDay(parsedDate));
        }
    }, []);

    const checkedFolderUids = checkedFolderUidsState ?? new Set(calendarFolders.map((f) => f.uid));
    const folderColors = useMemo(
        () => Object.fromEntries(calendarFolders.map((f) => [f.uid, colorForFolder(f)])),
        [calendarFolders],
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

    async function handleAddCalendar(name: string, color: string) {
        // `CalendarContent` only renders once `mailboxUid` is resolved — same invariant as `organizerAddress` above.
        const created = await createFolder({ mailboxUid: mailboxUid!, name, type: "calendar", color });
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

    function reload() {
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
            .finally(() => setLoading(false));
    }

    // Keyed on stable string summaries (not the array/set objects themselves, which are new references
    // every render) so this only re-fires when the actual set of folders to fetch changes.
    const calendarFolderUidsKey = calendarFolders.map((f) => f.uid).sort().join(",");
    const checkedFolderUidsKey = Array.from(checkedFolderUids).sort().join(",");
    useEffect(reload, [calendarFolderUidsKey, checkedFolderUidsKey]);

    const occurrences = useMemo(
        () => expandAllOccurrences(events, rangeStart, rangeEnd),
        [events, rangeStart, rangeEnd],
    );

    const splitColumns = useMemo(
        () =>
            calendarFolders
                .filter((f) => checkedFolderUids.has(f.uid))
                .map((f) => ({ folderUid: f.uid, name: f.name, color: colorForFolder(f) })),
        [calendarFolders, checkedFolderUidsKey],
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

    function goToday() {
        setViewDate(startOfDay(new Date()));
    }

    function handleSelectDay(date: Date) {
        setView("day");
        setViewDate(startOfDay(date));
    }

    function openNewEvent(start?: Date, end?: Date, targetFolderUid?: string) {
        if (!mailboxUid || !folderUid) {
            return;
        }
        setModal({
            occurrence: null,
            initialStart: start ?? new Date(),
            initialEnd: end ?? new Date(Date.now() + 30 * 60_000),
            targetFolderUid,
        });
    }

    function openEvent(occurrence: CalendarOccurrence) {
        setModal({ occurrence });
    }

    function closeModal() {
        setModal(null);
    }

    function handleSaved() {
        setModal(null);
        reload();
    }

    function handleDeleted() {
        setModal(null);
        reload();
    }

    async function handleDragEnd(event: DragEndEvent) {
        const overId = event.over ? String(event.over.id) : undefined;
        const action = resolveDragAction(String(event.active.id), overId, occurrences);
        if (!action) {
            return;
        }
        setActionError(null);
        try {
            if (action.type === "move") {
                await moveOccurrence(action.occurrence, action.deltaMs);
            } else {
                await resizeOccurrenceEnd(action.occurrence, action.newEnd);
            }
            reload();
        } catch (err) {
            setActionError(err instanceof ApiRequestError ? err.message : "Could not update this event.");
        }
    }

    const title =
        view === "month"
            ? format(viewDate, "MMMM yyyy")
            : view === "week" || view === "workWeek"
              ? `${format(rangeStart, "MMM d")} – ${format(rangeEnd, "MMM d, yyyy")}`
              : format(viewDate, "EEEE, MMMM d, yyyy");

    const sidebarContent = (
        <>
            <MiniDatePicker selected={viewDate} onSelect={(date) => setViewDate(startOfDay(date))} />
            <CalendarListSidebar
                calendars={calendarFolders}
                checkedFolderUids={checkedFolderUids}
                onToggle={toggleCalendar}
                onAddCalendar={handleAddCalendar}
            />
        </>
    );

    return (
        <div className="flex-1 flex min-h-0">
            <div className="hidden md:flex w-56 shrink-0 border-r border-border flex-col overflow-y-auto">{sidebarContent}</div>
            <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="Calendars">
                <div className="flex flex-col">{sidebarContent}</div>
            </Drawer>
            <div className="flex-1 flex flex-col min-h-0">
                <div className="flex items-center gap-3 p-3 border-b border-border shrink-0">
                    <button
                        type="button"
                        className="md:hidden w-9 h-9 flex items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text shrink-0"
                        aria-label="Open calendars"
                        onClick={() => setDrawerOpen(true)}
                    >
                        <HiOutlineBars3 size={20} aria-hidden="true" />
                    </button>
                    <Button type="button" onClick={() => openNewEvent()} className="!w-auto shrink-0">
                        + New event
                    </Button>
                    <div className="flex items-center gap-1">
                        <button type="button" onClick={() => shiftView(-1)} aria-label="Previous" className="w-7 h-7 text-sm rounded-sm hover:bg-surface-alt">
                            &lsaquo;
                        </button>
                        <button type="button" onClick={goToday} className="px-2 h-7 text-sm rounded-sm hover:bg-surface-alt">
                            Today
                        </button>
                        <button type="button" onClick={() => shiftView(1)} aria-label="Next" className="w-7 h-7 text-sm rounded-sm hover:bg-surface-alt">
                            &rsaquo;
                        </button>
                    </div>
                    <h1 className="hidden md:block text-lg font-bold tracking-tight">{title}</h1>
                    <div className="ml-auto flex gap-1 overflow-x-auto">
                        {VIEW_TYPES.map((v) => (
                            <button
                                key={v}
                                type="button"
                                onClick={() => setView(v)}
                                className={[
                                    "px-3 h-7 text-sm rounded-sm whitespace-nowrap",
                                    view === v ? "bg-primary text-white" : "hover:bg-surface-alt",
                                    (v === "workWeek" || v === "split") && "hidden md:inline-block",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                            >
                                {VIEW_LABELS[v]}
                            </button>
                        ))}
                    </div>
                </div>

                {error && (
                    <div className="p-3">
                        <Alert>{error}</Alert>
                    </div>
                )}
                {actionError && (
                    <div className="p-3">
                        <Alert>{actionError}</Alert>
                    </div>
                )}

                {loading ? (
                    <p className="p-4 text-sm text-text-muted">Loading&hellip;</p>
                ) : (
                    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
                        {view === "month" ? (
                            <MonthView
                                viewDate={viewDate}
                                occurrences={occurrences}
                                folderColors={folderColors}
                                onSelectDay={handleSelectDay}
                                onSelectEvent={openEvent}
                            />
                        ) : view === "split" ? (
                            <SplitDayView
                                day={viewDate}
                                columns={splitColumns}
                                occurrences={occurrences}
                                onSelectEvent={openEvent}
                                onSelectSlot={(start, end, targetFolderUid) => openNewEvent(start, end, targetFolderUid)}
                            />
                        ) : (
                            <TimeGridView
                                days={days}
                                occurrences={occurrences}
                                folderColors={folderColors}
                                onSelectEvent={openEvent}
                                onSelectSlot={openNewEvent}
                            />
                        )}
                    </DndContext>
                )}

                {/* `mailboxUid`/`folderUid` are guaranteed defined whenever `modal` is: `openNewEvent` only sets it
                    after checking both, and `openEvent` only fires from an occurrence that itself required a
                    successful, folder-scoped load to render. */}
                {modal && (
                    <EventModal
                        open
                        onClose={closeModal}
                        mailboxUid={mailboxUid!}
                        folderUid={modal.targetFolderUid ?? modal.occurrence?.folderUid ?? folderUid!}
                        calendars={calendarFolders.map((f) => ({ uid: f.uid, name: f.name }))}
                        organizerAddress={organizerAddress}
                        occurrence={modal.occurrence}
                        initialStart={modal.initialStart}
                        initialEnd={modal.initialEnd}
                        onSaved={handleSaved}
                        onDeleted={handleDeleted}
                    />
                )}
            </div>
        </div>
    );
}
