///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { pageTitle } from "../../shared/navigation/pageTitle.js";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { ApiRequestError } from "../../../lib/util/api.js";
import { useApiClient } from "../../../lib/util/apiClientContext.js";
import useIsMobile from "../../../lib/util/useIsMobile.js";
import { CalendarEvent, getCalendarEvent, listCalendarEvents } from "../../../lib/calendar/calendarApi.js";
import { useFolderLiveUpdates } from "../../shared/live/useFolderLiveUpdates.js";
import { moveOccurrence, resizeOccurrenceEnd } from "../../../lib/calendar/calendarMutations.js";
import { resolveDragAction } from "../../../lib/calendar/calendarDragIds.js";
import { createFolder } from "../../../lib/mail/mailApi.js";
import { CalendarOccurrence, expandAllOccurrences } from "../../../lib/calendar/recurrence.js";
import { useDayKey } from "../../../lib/calendar/useDayKey.js";
import { allOccurrences, initialMatchIndex, occurrencesInRange, searchOccurrences, searchTerms, stepSequenceIndex } from "../../../lib/calendar/eventSearch.js";
import Drawer from "../../../lib/components/overlays/Drawer.js";
import CalendarShell, { CalendarShellProps, useCalendarShell } from "../../shared/components/calendar/layout/CalendarShell.js";
import CalendarListSidebar from "../../shared/components/calendar/CalendarListSidebar.js";
import CalendarSearchBox from "../../shared/components/calendar/CalendarSearchBox.js";
import { ActiveOccurrenceContext } from "../../shared/components/calendar/activeOccurrence.js";
import { isUpcoming, occurrenceDay } from "../../shared/components/calendar/allDay.js";
import { useWritableMailboxes } from "../../shared/components/mail/writableMailboxes.js";
import EventModal from "../../shared/components/calendar/EventModal.js";
import FloatingActionButton from "../../shared/components/layout/FloatingActionButton.js";
import { EventAnchor, anchorOf } from "../../shared/components/calendar/EventShell.js";
import MiniDatePicker from "../../../lib/components/pickers/MiniDatePicker.js";
import ListView, { ListStep } from "../../shared/components/calendar/ListView.js";
import MonthView from "../../shared/components/calendar/MonthView.js";
import SplitDayView from "../../shared/components/calendar/SplitDayView.js";
import TimeGridView from "../../shared/components/calendar/TimeGridView.js";
import Alert from "../../../lib/components/feedback/Alert.js";
import Button from "../../../lib/components/buttons/Button.js";
import { CALENDAR_VIEWS, CalendarView, getStoredCalendarView, isCalendarView, storeCalendarView } from "../../shared/components/calendar/calendarView.js";
import { SlideFrom } from "../../shared/components/calendar/SlideIn.js";
import { SWIPE_PERIOD_SHIFT } from "../../shared/components/calendar/swipeNavigation.js";
import { nextHalfHour } from "../../shared/components/calendar/timePicker.js";
import { useSwipeSlide } from "../../shared/gestures/useSwipeSlide.js";
import { useEnterSlide } from "../../shared/gestures/useEnterSlide.js";
import { useWheelPaging, type WheelEdge } from "../../shared/gestures/useWheelPaging.js";
import { SHORTCUTS, ShortcutDef } from "../../shared/keyboard/keymap.js";
import { useShortcut } from "../../shared/keyboard/useShortcut.js";
import { useShortcutProps } from "../../shared/keyboard/useShortcutProps.js";
import { notifyApiError } from "../../shared/notifications/apiErrors.js";
import { bookingSettingsHref } from "../../shared/calendar/bookingPlugin.js";
import { changedEventOf } from "../../shared/calendar/calendarLiveUpdates.js";

/** The push client channel group (`PushClient.setChannels()`) the page's calendars are subscribed under. */
const CALENDAR_CHANNEL_GROUP = "calendar";

/** The furthest instants a `Date` can hold: the List's "range" reaches both. */
const MAX_DATE_MS = 8.64e15;

function CalendarPage(props: CalendarShellProps) {
    return (
        <CalendarShell {...props}>
            <CalendarContent userUid={props.userUid} bookingHref={bookingSettingsHref(props.pluginNav)} />
        </CalendarShell>
    );
}

type ViewType = CalendarView;
const VIEW_LABELS: Record<ViewType, string> = { list: "List", month: "Month", week: "Week", workWeek: "Work Week", day: "Day", split: "Split" };
/** The shortcut that switches to a view (Outlook's Ctrl+Alt+1-4, the List one more); the split view has none. */
const VIEW_SHORTCUTS: Partial<Record<ViewType, ShortcutDef>> = {
    list: SHORTCUTS.calendar.list,
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
    const client = useApiClient();
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
    // Month, until the effects below know better: a remembered view, or the List on a phone (never read while rendering, so the server's markup and the
    // first client render agree). A desktop always opens on the Month unless the link or a remembered Week, Work Week, Day, Split or Month says otherwise.
    const [view, setViewState] = useState<ViewType>("month");
    // Whether the view was decided by the URL, a remembered choice or the reader (and so is not the device's default to follow).
    const viewChosenRef = useRef(false);
    /** Switches the view; a reader's own choice (`remember`) is also what the Calendar opens on next time - except the List on a desktop, which
     * only a phone opens on, so it is never written there (and so can never turn up as the next desktop visit's view). */
    function setView(next: ViewType, remember = true) {
        viewChosenRef.current = true;
        setViewState(next);
        if (remember && (next !== "list" || isMobile)) {
            storeCalendarView(next);
        }
    }
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
        const storedView = getStoredCalendarView();
        if (isCalendarView(requestedView)) {
            // Asked for by the link: shown, but not remembered - it is not a choice of the reader's.
            setView(requestedView, false);
        } else if (storedView && storedView !== "list") {
            // A remembered List is not restored: it is the phone's default (below) and never the desktop's, whatever an older visit left in storage.
            setView(storedView, false);
        }
        const requestedDate = params.get("date");
        // `parseISO()`, not `new Date()` - `?date=2026-06-16` is a local calendar day, but `new Date()` reads a
        // date-only string as UTC midnight, i.e. the previous day anywhere west of UTC.
        const parsedDate = requestedDate ? parseISO(requestedDate) : null;
        if (parsedDate && !isNaN(parsedDate.getTime())) {
            setViewDate(startOfDay(parsedDate));
        }
    }, []);

    // With nothing remembered the device decides: the List on a phone, the Month elsewhere (`useIsMobile()` only knows after mounting).
    const isMobile = useIsMobile();
    useEffect(() => {
        if (!viewChosenRef.current) {
            setViewState(isMobile ? "list" : "month");
        }
    }, [isMobile]);

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
        const created = await createFolder({ mailboxUid: targetMailboxUid, name, type: "calendar", color }, client);
        setCheckedFolderUidsState((prev) => new Set([...(prev ?? calendarFolders.map((f) => f.uid)), created.uid]));
        reloadFolders();
    }

    const { rangeStart, rangeEnd, days } = useMemo(() => {
        if (view === "list") {
            // The list is not a range at all: every event, whenever it falls (a series bounded as the search bounds it - see `allOccurrences()`).
            return { rangeStart: new Date(-MAX_DATE_MS), rangeEnd: new Date(MAX_DATE_MS), days: [] as Date[] };
        }
        if (view === "month") {
            const start = startOfWeek(startOfMonth(viewDate), { weekStartsOn: 0 });
            const end = endOfWeek(endOfMonth(viewDate), { weekStartsOn: 0 });
            return { rangeStart: start, rangeEnd: end, days: [] as Date[] };
        }
        if (view === "week") {
            const start = startOfWeek(viewDate, { weekStartsOn: 0 });
            const end = endOfWeek(viewDate, { weekStartsOn: 0 });
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
        void Promise.allSettled(targets.map((f) => listCalendarEvents(f.uid, client)))
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

    // An event that somebody creates, changes or deletes is announced on the push connection - a private or confidential one as its busy block, whatever the
    // reader may see (see `changedEventOf()`): that payload is never stored here. The event is fetched again by its uid, which comes back as much as this
    // reader may see - all of it for the owner - and replaces (or joins) what the calendar holds; one that is gone (a 404, or a delete) leaves it. A failed
    // fetch changes nothing: the next load shows the event as it is.
    const checkedFolderUidsRef = useRef(checkedFolderUids);
    checkedFolderUidsRef.current = checkedFolderUids;
    // Those events are published on the calendar's own channel, so the page subscribes to every calendar it lists - checked or not, so checking
    // one needs no new subscription - while it is open.
    useFolderLiveUpdates(
        CALENDAR_CHANNEL_GROUP,
        calendarFolders.map((f) => f.uid),
        changedEventOf,
        (change) => {
            const { uid } = change;
            if (change.deleted) {
                setEvents((previous) => previous.filter((existing) => existing.uid !== uid));
                return;
            }
            void getCalendarEvent(uid, client).then(
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
        },
    );

    // Search: `searchText` is the box, `query` what it held once typing paused (or Enter was pressed) and is what is searched for. A search covers every
    // event of the checked calendars whatever the view shows (see `searchOccurrences()`); while one runs the views show only its matches, and
    // `activeKey` is the match being pointed at (Previous/Next match step through `matches`).
    const [searchText, setSearchText] = useState("");
    const [query, setQuery] = useState("");
    const [activeKey, setActiveKey] = useState<string | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const searching = searchTerms(query).length > 0;
    useEffect(() => {
        const timer = setTimeout(() => setQuery(searchText), 300);
        return () => clearTimeout(timer);
    }, [searchText]);
    // The List shows only what is from today on, so that is all a search steps through there; the other views reach the past ones.
    // Today moves on at midnight: the List's "from today on" is worked out again then (`listDay` is only a dependency).
    const listDay = useDayKey();
    const dayOfList = view === "list" ? listDay : "";
    const matches = useMemo(() => {
        const found = searching ? searchOccurrences(events, query) : [];
        const today = new Date();
        return view === "list" ? found.filter((occurrence) => isUpcoming(occurrence, today)) : found;
    }, [events, query, searching, view, dayOfList]);
    const activeIndex = matches.findIndex((m) => m.occurrenceKey === activeKey);

    // What an open event card steps through, in order: the matches while a search runs, else every event of the checked calendars (bounded as a
    // search is). The List holds only what is from today on, so that is all its card steps through. Worked out only when something needs it.
    const everything = useMemo(() => (view === "list" || modal?.occurrence ? allOccurrences(events) : []), [events, view, !!modal?.occurrence]);
    const sequence = useMemo(() => {
        if (searching) {
            return matches;
        }
        if (view === "list") {
            const today = new Date();
            return everything.filter((occurrence) => isUpcoming(occurrence, today));
        }
        return everything;
    }, [searching, matches, view, everything, dayOfList]);

    const occurrences = useMemo(() => {
        if (view === "list") {
            return sequence;
        }
        return searching ? occurrencesInRange(matches, rangeStart, rangeEnd) : expandAllOccurrences(events, rangeStart, rangeEnd);
    }, [events, matches, searching, view, sequence, rangeStart, rangeEnd]);

    /** Points at `match`, moving the view to the day it is on unless the view already shows it. */
    function showMatch(match: CalendarOccurrence) {
        setActiveKey(match.occurrenceKey);
        // An event's card that is open moves on to it, so the card and the view stay together.
        setModal((current) => (current?.occurrence ? { occurrence: match } : current));
        if (occurrencesInRange([match], rangeStart, rangeEnd).length === 0) {
            setViewDate(occurrenceDay(match));
        }
    }

    // The step that moved an open event card on, for the card to slide in from the side of the button pressed (also on a wrap-around).
    const [slide, setSlide] = useState<{ from: SlideFrom; occurrenceKey: string } | undefined>(undefined);

    // The card open is where the sequence stands; with none, the match the search is on. A search wraps round at either end, the events of the
    // calendar do not.
    const stepFrom = modal?.occurrence;
    const stepIndex = (direction: 1 | -1) =>
        stepSequenceIndex(sequence, stepFrom?.occurrenceKey ?? activeKey, stepFrom ? new Date(stepFrom.startDate) : undefined, direction, searching);

    function stepMatch(direction: 1 | -1) {
        const next = sequence[stepIndex(direction)];
        if (next) {
            setSlide({ from: direction === 1 ? "right" : "left", occurrenceKey: next.occurrenceKey });
            showMatch(next);
        }
    }

    function clearSearch() {
        setSearchText("");
        setQuery("");
    }

    function submitSearch(backwards: boolean) {
        if (searchText !== query) {
            setQuery(searchText);
        } else {
            stepMatch(backwards ? -1 : 1);
        }
    }

    // A new search goes to its first match: the first one in the view if there is one, else the first from the day being viewed on (the nearest
    // before it when there is none after). Matches that change under the same query (a saved edit, a live update) leave the view where it is.
    const searchedQueryRef = useRef("");
    useEffect(() => {
        if (!searching || matches.length === 0) {
            searchedQueryRef.current = "";
            setActiveKey(null);
            return;
        }
        if (searchedQueryRef.current !== query) {
            searchedQueryRef.current = query;
            // The List holds every match: it starts at the first from the day being viewed on rather than the first of all.
            const from = startOfDay(viewDate);
            showMatch(matches[view === "list" ? initialMatchIndex(matches, from, rangeEnd, from) : initialMatchIndex(matches, rangeStart, rangeEnd, from)]);
        }
    }, [matches, query, searching]);


    const splitColumns = useMemo(
        () =>
            calendarFolders
                .filter((f) => checkedFolderUids.has(f.uid))
                .map((f) => ({ folderUid: f.uid, name: f.name, color: colorFor(f) })),
        [calendarFolders, checkedFolderUidsKey, colorFor],
    );

    function shiftView(direction: 1 | -1) {
        if (view === "list") {
            // Previous and Next move the list a month, from wherever it has been scrolled to (the list does the scrolling).
            setListStep((step) => ({ direction, nonce: (step?.nonce ?? 0) + 1 }));
            return;
        }
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
    const swipe = useSwipeSlide({
        enabled: isMobile && !dragging && !modal && view !== "list",
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
        enabled: !isMobile && !dragging && !modal && view !== "list",
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

    // Brings the match being pointed at into sight (the views scroll their own hours; the page may too).
    useEffect(() => {
        const marked = Array.from(swipe.ref.current!.querySelectorAll<HTMLElement>("[data-occurrence-key]"));
        marked.find((el) => el.dataset.occurrenceKey === activeKey)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [activeKey, view === "list" ? null : viewDate, view, loading]);

    // The List scrolls to `viewDate` when this changes (Today, a day picked in the mini calendar), even when it is the date it already has.
    const [jumpNonce, setJumpNonce] = useState(0);
    const [listStep, setListStep] = useState<ListStep | null>(null);
    function goToday() {
        setViewDate(startOfDay(new Date()));
        setJumpNonce((n) => n + 1);
    }

    function handleSelectDay(date: Date) {
        setView("day", false);
        setViewDate(startOfDay(date));
    }

    function openNewEvent(start?: Date, end?: Date, targetFolderUid?: string, anchor?: EventAnchor, initialAllDay?: boolean) {
        if (!mailboxUid || !folderUid) {
            return;
        }
        // With nothing clicked, the next half hour, for an hour.
        const from = start ?? nextHalfHour(new Date());
        setModal({
            occurrence: null,
            initialStart: from,
            initialEnd: end ?? new Date(from.getTime() + 60 * 60_000),
            targetFolderUid,
            anchor,
            initialAllDay,
        });
    }

    // Stable (it only sets state), so the List's rows are not rendered again by every keystroke in the search box.
    const openEvent = useCallback((occurrence: CalendarOccurrence) => {
        setSlide(undefined);
        setActiveKey(occurrence.occurrenceKey);
        setModal({ occurrence });
    }, []);

    function closeModal() {
        setModal(null);
    }

    // Keyboard shortcuts - the toolbar's own actions. (A dialog open - the event editor - silences them.)
    useShortcut(SHORTCUTS.calendar.create, () => openNewEvent(), { enabled: !!mailboxUid && !!folderUid });
    useShortcut(SHORTCUTS.calendar.today, goToday);
    useShortcut(SHORTCUTS.calendar.previous, () => shiftView(-1));
    useShortcut(SHORTCUTS.calendar.next, () => shiftView(1));
    useShortcut(SHORTCUTS.calendar.list, () => setView("list"));
    useShortcut(SHORTCUTS.calendar.day, () => setView("day"));
    useShortcut(SHORTCUTS.calendar.workWeek, () => setView("workWeek"));
    useShortcut(SHORTCUTS.calendar.week, () => setView("week"));
    useShortcut(SHORTCUTS.calendar.month, () => setView("month"));
    useShortcut(SHORTCUTS.calendar.search, () => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
    });
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
                await moveOccurrence(action.occurrence, action.deltaMs, client);
            } else {
                await resizeOccurrenceEnd(action.occurrence, action.newEnd, client);
            }
            reload();
        } catch (err) {
            notifyApiError(err, action.type === "move" ? "Couldn't move the event" : "Couldn't resize the event");
            // A refused change (a 409 most of all) means the page holds a stale version: load again, or every later drag of this event fails the same way.
            reload();
        }
    }

    const title =
        view === "list"
            ? "Upcoming events"
            : view === "month"
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
            <MiniDatePicker
                selected={viewDate}
                onSelect={(date) => {
                    setViewDate(startOfDay(date));
                    setJumpNonce((n) => n + 1);
                }}
            />
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
                    <CalendarSearchBox
                        value={searchText}
                        onChange={setSearchText}
                        onSubmit={submitSearch}
                        onClear={clearSearch}
                        onPrevious={() => stepMatch(-1)}
                        onNext={() => stepMatch(1)}
                        active={searching}
                        count={matches.length}
                        position={activeIndex}
                        inputRef={searchInputRef}
                    />
                    <div className="flex flex-wrap gap-1">
                        {CALENDAR_VIEWS.map((v) => (
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
                                <ActiveOccurrenceContext.Provider value={searching ? activeKey : null}>
                                    <DndContext
                                        sensors={sensors}
                                        onDragStart={() => setDragging(true)}
                                        onDragEnd={handleDragEnd}
                                        onDragCancel={() => setDragging(false)}
                                    >
                                        {view === "list" ? (
                                            <ListView
                                                occurrences={occurrences}
                                                folderColors={folderColors}
                                                onSelectEvent={openEvent}
                                                focusDate={viewDate}
                                                jumpNonce={jumpNonce}
                                                step={listStep}
                                            />
                                        ) : view === "month" ? (
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
                                </ActiveOccurrenceContext.Provider>
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
                        matchNav={
                            modal.occurrence && sequence.length > 0
                                ? {
                                      onPrevious: () => stepMatch(-1),
                                      onNext: () => stepMatch(1),
                                      canPrevious: stepIndex(-1) >= 0,
                                      canNext: stepIndex(1) >= 0,
                                      noun: searching ? "match" : "event",
                                      slide,
                                  }
                                : undefined
                        }
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

export default CalendarPage;

/** The tab's title: `Brand: Calendar` (see `pageTitle()`). */
export const title = pageTitle("Calendar");
