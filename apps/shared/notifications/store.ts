///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The app's one notification store: every pop-up - new mail, a failed send, an API error, an expired session - goes through
 * `notify()`. It is deliberately framework-free (no React, no DOM beyond `sessionStorage`/timers), so it can be called from a hook,
 * a plain function or an `apiFetch` error path alike; `NotificationCenter` (the view, mounted once in the app frame) and
 * `useNotifications()` only *read* it.
 *
 * Rules, all enforced here rather than by the view so they hold whoever renders:
 *
 * - **At most `MAX_VISIBLE` (3) are visible**; the rest wait in a queue and appear as room is made. A sticky notification (an error, or
 * anything with actions) that finds the stack full pushes out the oldest one that would have gone by itself, rather than waiting behind
 * it. A queued notification that has waited `QUEUE_STALE_MS` is dropped (it would be news from the past) - it is still in the history.
 * - **Sticky until dismissed or resolved**: errors and notifications with actions never expire (`update()` or `dismiss()` resolve them).
 * Everything else goes by itself after its kind's default time, or `timeoutMs`. `sticky` overrides both ways.
 * - **A clock that stops**: a notification's remaining time stops while it is hovered or focused (`setPaused()`) and while the tab is
 * hidden (`setAllPaused()`), and continues from where it was.
 * - **Deduplicated by `dedupeKey`**: a second notification with a key that is still on screen (or waiting) does not stack - it replaces
 * the first one's content, restarts its clock and raises its `count`, so a flapping error is one pop-up saying "x3".
 * - **Nothing is lost when one goes**: the last `HISTORY_LIMIT` (30, except new-mail pop-ups, which the inbox already holds) are
 * kept, in memory and in `sessionStorage`, with which errors nobody has seen yet.
 *
 * Nothing is stored where there is no `window` (server-side rendering): the module state is shared between requests there, so
 * `notify()` only hands back an id.
 */

export type NotificationKind = "mail" | "info" | "success" | "warning" | "error";

export interface NotificationAction {
    label: string;
    /** Runs when the action is used. */
    onClick?: () => void;
    /** Or a link to follow (a plain `<a>`, so the router's link handling applies). */
    href?: string;
    /** Leave the notification on screen after the action ran. By default an action resolves (dismisses) it. */
    keepOpen?: boolean;
}

export interface NotifyInput {
    /** Reuse an id to replace a notification (it is the same one: its content is swapped and its clock restarted). Generated when absent. */
    id?: string;
    kind: NotificationKind;
    title: string;
    /** A second, muted line next to the title (a mail pop-up's sender address). */
    subtitle?: string;
    message?: string;
    /** A mail pop-up's preview text, under `message` (its subject). */
    preview?: string;
    /** A small muted explanation above the actions (the desktop-notification offer). */
    hint?: string;
    /** Technical detail: a list of lines, or one block of text. Shown collapsed, monospace, with a copy button. */
    details?: string[] | string;
    actions?: NotificationAction[];
    /** The whole pop-up is a link to this (new mail opens the message). */
    href?: string;
    /** Never expires by itself. Default: errors and anything with actions. */
    sticky?: boolean;
    /** How long it stays, in ms. Default by kind, see `DEFAULT_TIMEOUT_MS`. Ignored for a sticky one. */
    timeoutMs?: number;
    /** Notifications with the same key that are still showing are one: see the module doc comment. */
    dedupeKey?: string;
    /** Keep it out of the history (default: kept, except `mail`). */
    history?: boolean;
}

/** A notification as a view renders it. */
export interface NotificationView {
    id: string;
    kind: NotificationKind;
    title: string;
    subtitle?: string;
    message?: string;
    preview?: string;
    hint?: string;
    details: string[];
    actions: NotificationAction[];
    href?: string;
    /** How many times this one was raised (`dedupeKey`), 1 for a single one. */
    count: number;
    sticky: boolean;
    createdAt: number;
}

export interface HistoryEntry {
    id: string;
    kind: NotificationKind;
    title: string;
    message?: string;
    details: string[];
    count: number;
    /** When it was last raised (epoch ms). */
    at: number;
    /** Nobody has opened the history since it arrived. */
    unseen: boolean;
}

export interface NotificationsSnapshot {
    /** What is on screen, oldest first. */
    visible: NotificationView[];
    /** How many are waiting for room. */
    queued: number;
    /** The last `HISTORY_LIMIT`, newest first. */
    history: HistoryEntry[];
    /** Errors in the history that nobody has looked at. */
    unseenErrors: number;
}

export const MAX_VISIBLE = 3;
export const MAX_QUEUED = 20;
export const QUEUE_STALE_MS = 30_000;
export const HISTORY_LIMIT = 30;
export const HISTORY_STORAGE_KEY = "rapidmx-notification-history";
/** The most technical lines and the longest line kept per notification - a transport error can carry a whole SMTP transcript. */
export const MAX_DETAIL_LINES = 50;
export const MAX_DETAIL_LINE_LENGTH = 500;

/** How long a non-sticky notification stays, by kind. Errors are sticky, so theirs is only for an explicit `sticky: false`. */
export const DEFAULT_TIMEOUT_MS: Record<NotificationKind, number> = {
    mail: 8_000,
    info: 6_000,
    success: 5_000,
    warning: 10_000,
    error: 10_000,
};

interface Entry {
    id: string;
    kind: NotificationKind;
    title: string;
    subtitle?: string;
    message?: string;
    preview?: string;
    hint?: string;
    details: string[];
    actions: NotificationAction[];
    href?: string;
    dedupeKey?: string;
    sticky: boolean;
    timeoutMs: number;
    count: number;
    createdAt: number;
    history: boolean;
    status: "visible" | "queued";
    remainingMs: number;
    startedAt?: number;
    timer?: ReturnType<typeof setTimeout>;
    paused: boolean;
}

const EMPTY_SNAPSHOT: NotificationsSnapshot = { visible: [], queued: 0, history: [], unseenErrors: 0 };

let entries: Entry[] = [];
let history: HistoryEntry[] = [];
let historyLoaded = false;
let allPaused = false;
let counter = 0;
let snapshot: NotificationsSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();

function isClient(): boolean {
    return typeof window !== "undefined";
}

function normalizeDetails(details: string[] | string | undefined): string[] {
    if (details === undefined) {
        return [];
    }
    const lines = (Array.isArray(details) ? details : details.split(/\r?\n/)).filter((line) => line.length > 0);
    return lines.slice(0, MAX_DETAIL_LINES).map((line) => (line.length > MAX_DETAIL_LINE_LENGTH ? `${line.slice(0, MAX_DETAIL_LINE_LENGTH)}...` : line));
}

function loadHistory(): void {
    if (historyLoaded || !isClient()) {
        return;
    }
    historyLoaded = true;
    try {
        const stored = JSON.parse(sessionStorage.getItem(HISTORY_STORAGE_KEY) ?? "[]") as HistoryEntry[];
        history = Array.isArray(stored)
            ? stored
                  .filter((item) => !!item && typeof item.id === "string" && typeof item.title === "string" && typeof item.at === "number")
                  .slice(0, HISTORY_LIMIT)
                  .map((item) => ({ ...item, details: Array.isArray(item.details) ? item.details : [], unseen: item.unseen === true }))
            : [];
    } catch {
        history = [];
    }
}

function saveHistory(): void {
    try {
        sessionStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch {
        // Storage unavailable or full: the history is only kept in memory, which is all it needs to be for this page.
    }
}

function view(entry: Entry): NotificationView {
    return {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        subtitle: entry.subtitle,
        message: entry.message,
        preview: entry.preview,
        hint: entry.hint,
        details: entry.details,
        actions: entry.actions,
        href: entry.href,
        count: entry.count,
        sticky: entry.sticky,
        createdAt: entry.createdAt,
    };
}

function rebuild(): void {
    const visible = entries.filter((entry) => entry.status === "visible").map(view);
    snapshot = {
        visible,
        queued: entries.length - visible.length,
        history,
        unseenErrors: history.filter((item) => item.unseen && item.kind === "error").length,
    };
}

function emit(): void {
    rebuild();
    for (const listener of [...listeners]) {
        listener();
    }
}

function findEntry(id: string): Entry | undefined {
    return entries.find((entry) => entry.id === id);
}

/** Records (or refreshes) `entry` in the history, newest first. */
function record(entry: Entry): void {
    if (!entry.history) {
        return;
    }
    loadHistory();
    const item: HistoryEntry = {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        message: entry.message,
        details: entry.details,
        count: entry.count,
        at: Date.now(),
        unseen: true,
    };
    history = [item, ...history.filter((existing) => existing.id !== entry.id)].slice(0, HISTORY_LIMIT);
    saveHistory();
}

function disarm(entry: Entry): void {
    if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.remainingMs = Math.max(0, entry.remainingMs - (Date.now() - entry.startedAt!));
    }
}

/** Starts (or resumes) the clock of a visible, non-sticky, unpaused notification. */
function arm(entry: Entry): void {
    if (entry.status !== "visible" || entry.sticky || entry.paused || allPaused || entry.timer !== undefined) {
        return;
    }
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => {
        entry.timer = undefined;
        remove(entry.id);
    }, entry.remainingMs);
}

function visibleCount(): number {
    return entries.filter((entry) => entry.status === "visible").length;
}

function show(entry: Entry): void {
    entry.status = "visible";
    entry.remainingMs = entry.timeoutMs;
    arm(entry);
}

/** Fills free places from the queue, dropping what has waited too long. */
function promote(): void {
    const now = Date.now();
    entries = entries.filter((entry) => entry.status === "visible" || entry.sticky || now - entry.createdAt < QUEUE_STALE_MS);
    while (visibleCount() < MAX_VISIBLE) {
        const next = entries.find((entry) => entry.status === "queued");
        if (!next) {
            return;
        }
        show(next);
    }
}

function remove(id: string): void {
    const entry = findEntry(id);
    if (!entry) {
        return;
    }
    disarm(entry);
    entries = entries.filter((existing) => existing !== entry);
    promote();
    emit();
}

/** Makes room for a sticky notification: the oldest visible one that would have gone by itself leaves (it stays in the history). */
function evictForSticky(): boolean {
    const victim = entries.find((entry) => entry.status === "visible" && !entry.sticky);
    if (!victim) {
        return false;
    }
    disarm(victim);
    entries = entries.filter((entry) => entry !== victim);
    return true;
}

function applyInput(entry: Entry, input: NotifyInput): void {
    entry.kind = input.kind;
    entry.title = input.title;
    entry.subtitle = input.subtitle;
    entry.message = input.message;
    entry.preview = input.preview;
    entry.hint = input.hint;
    entry.details = normalizeDetails(input.details);
    entry.actions = input.actions ?? [];
    entry.href = input.href;
    entry.sticky = input.sticky ?? (input.kind === "error" || (input.actions?.length ?? 0) > 0);
    entry.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS[input.kind];
    entry.history = input.history ?? input.kind !== "mail";
}

/**
 * Raises a notification and returns its id. See the module doc comment for what happens to it. Usable from anywhere - a component, a
 * hook, a plain function, an `apiFetch` error path - and safe where there is no window (it does nothing there).
 */
export function notify(input: NotifyInput): string {
    counter += 1;
    const id = input.id ?? `notification-${counter}`;
    if (!isClient()) {
        return id;
    }
    const sameKey = input.dedupeKey !== undefined ? entries.find((entry) => entry.dedupeKey === input.dedupeKey) : undefined;
    const existing = sameKey ?? findEntry(id);
    if (existing) {
        // The same notification again: its content is replaced and it gets its full time again. Only a repeated dedupe key counts up
        // (an explicit id is a replacement, not another occurrence).
        disarm(existing);
        applyInput(existing, input);
        existing.count += sameKey ? 1 : 0;
        existing.remainingMs = existing.timeoutMs;
        arm(existing);
        record(existing);
        emit();
        return existing.id;
    }
    const entry: Entry = {
        id,
        dedupeKey: input.dedupeKey,
        kind: input.kind,
        title: input.title,
        details: [],
        actions: [],
        sticky: false,
        timeoutMs: 0,
        count: 1,
        createdAt: Date.now(),
        history: true,
        status: "queued",
        remainingMs: 0,
        paused: false,
    };
    applyInput(entry, input);
    const room = visibleCount() < MAX_VISIBLE;
    entries.push(entry);
    if (room) {
        show(entry);
    } else if (entry.sticky && evictForSticky()) {
        show(entry);
    } else {
        // Waiting for room: the queue itself is bounded, and the oldest waiting one that would not have stayed is the first to go.
        const waiting = entries.filter((e) => e.status === "queued");
        if (waiting.length > MAX_QUEUED) {
            const dropped = waiting.find((e) => !e.sticky) ?? waiting[0];
            entries = entries.filter((e) => e !== dropped);
        }
    }
    record(entry);
    emit();
    return id;
}

/**
 * Changes a notification that is still showing or waiting - the way to resolve it ("Sending..." becoming "Sent"). Only the given
 * fields change. Its clock restarts, and it may become sticky or stop being so with its new kind. Returns `false` when there is no such
 * notification any more (it was dismissed or expired); its history entry is updated all the same.
 */
export function update(id: string, patch: Partial<Omit<NotifyInput, "id" | "dedupeKey">>): boolean {
    const entry = findEntry(id);
    if (!entry) {
        loadHistory();
        const item = history.find((existing) => existing.id === id);
        if (item) {
            history = history.map((existing) =>
                existing === item
                    ? {
                          ...existing,
                          kind: patch.kind ?? existing.kind,
                          title: patch.title ?? existing.title,
                          message: "message" in patch ? patch.message : existing.message,
                          details: "details" in patch ? normalizeDetails(patch.details) : existing.details,
                      }
                    : existing,
            );
            saveHistory();
            emit();
        }
        return false;
    }
    disarm(entry);
    applyInput(entry, {
        kind: entry.kind,
        title: entry.title,
        subtitle: entry.subtitle,
        message: entry.message,
        preview: entry.preview,
        hint: entry.hint,
        details: entry.details,
        actions: entry.actions,
        href: entry.href,
        history: entry.history,
        // A change of kind or actions recomputes stickiness (unless the patch says), so it is only carried over otherwise.
        sticky: "kind" in patch || "actions" in patch ? undefined : entry.sticky,
        // Its own time again, unless the kind changed (then the new kind's default) or the patch says.
        timeoutMs: "kind" in patch ? undefined : entry.timeoutMs,
        ...patch,
    });
    entry.remainingMs = entry.timeoutMs;
    arm(entry);
    record(entry);
    emit();
    return true;
}

/** Removes a notification from the screen (or the queue). Its history entry stays. Does nothing for an unknown id. */
export function dismiss(id: string): void {
    remove(id);
}

/** Removes everything showing and waiting. */
export function dismissAll(): void {
    for (const entry of entries) {
        disarm(entry);
    }
    entries = [];
    emit();
}

/** Stops (or restarts) one notification's clock: it is being hovered or holds the keyboard focus. */
export function setPaused(id: string, paused: boolean): void {
    const entry = findEntry(id);
    if (!entry || entry.paused === paused) {
        return;
    }
    entry.paused = paused;
    if (paused) {
        disarm(entry);
    } else {
        arm(entry);
    }
}

/** Stops (or restarts) every clock: the tab is hidden, so nobody could have read what is on screen. */
export function setAllPaused(paused: boolean): void {
    if (allPaused === paused) {
        return;
    }
    allPaused = paused;
    for (const entry of entries) {
        if (paused) {
            disarm(entry);
        } else {
            arm(entry);
        }
    }
}

/** Marks every history entry as seen - the user has opened the history. */
export function markHistorySeen(): void {
    loadHistory();
    if (!history.some((item) => item.unseen)) {
        return;
    }
    history = history.map((item) => (item.unseen ? { ...item, unseen: false } : item));
    saveHistory();
    emit();
}

/** Empties the history. */
export function clearHistory(): void {
    loadHistory();
    history = [];
    saveHistory();
    emit();
}

export function subscribeNotifications(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getNotificationsSnapshot(): NotificationsSnapshot {
    if (!historyLoaded && isClient()) {
        // The history is read from storage on first use, without telling listeners (this runs during a render).
        loadHistory();
        rebuild();
    }
    return snapshot;
}

export function getServerNotificationsSnapshot(): NotificationsSnapshot {
    return EMPTY_SNAPSHOT;
}

/** Forgets everything and stops every clock - for a test, or a page that outlives its session. */
export function resetNotifications(): void {
    for (const entry of entries) {
        disarm(entry);
    }
    entries = [];
    history = [];
    historyLoaded = false;
    allPaused = false;
    counter = 0;
    snapshot = EMPTY_SNAPSHOT;
    try {
        sessionStorage.removeItem(HISTORY_STORAGE_KEY);
    } catch {
        // Nothing stored.
    }
}
