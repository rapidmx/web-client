///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Where a shortcut applies. `global` works in every view; a view scope (`mail`, `calendar`, `contacts`, `tasks`) exists only while that
 * view is mounted; `compose` applies while focus is inside a compose window; `dialog` is for what a modal dialog binds itself - a
 * dialog on screen silences every other scope.
 */
export type ShortcutScope = "global" | "mail" | "compose" | "calendar" | "contacts" | "tasks" | "dialog";

/** The scopes the help dialog lists, in the order it lists them. */
export const HELP_SCOPES: readonly ShortcutScope[] = ["global", "mail", "compose", "calendar", "contacts", "tasks"];

export const SCOPE_LABELS: Record<ShortcutScope, string> = {
    global: "Global",
    mail: "Mail",
    compose: "Compose",
    calendar: "Calendar",
    contacts: "Contacts",
    tasks: "Tasks",
    dialog: "Dialog",
};

/** One action the keyboard can trigger, and the keys that trigger it. Views register handlers for these; nothing else defines a key. */
export interface ShortcutDef {
    /** Stable name, unique across the map - what the help dialog de-duplicates on. */
    id: string;
    /** Specs (see `parseSpec()`) that trigger it, the first being the one shown first. `mod` is Ctrl, or Cmd on macOS. */
    keys: readonly string[];
    /** Extra specs that apply only in the desktop client, where the browser's own reserved keys (Ctrl+N, Ctrl+T) are the app's. */
    electronKeys?: readonly string[];
    /** What the help dialog and a button's tooltip call it. */
    label: string;
    scope: ShortcutScope;
    /** Fires from a focused button or link too (Enter on a message row); by default Enter/Space are left to what has the focus. */
    allowOnActivatable?: boolean;
    /** Keeps firing while the key is held (arrows); by default a held key runs a one-shot action once. */
    repeat?: boolean;
}

function def<T extends ShortcutDef>(shortcut: T): T {
    return shortcut;
}

/**
 * The whole key map, in the order the help dialog lists it. The navigation set is literally Ctrl+Shift+<letter> on every platform (Cmd+Shift
 * on macOS collides with the browsers' own - Cmd+Shift+A/B/C/L/M/S are tab search, the bookmarks bar, Inspect, the sidebar, the profile
 * switcher and Save As - so it is not offered); the mail actions use `mod`, so Reply is Ctrl+R on Windows and Linux and Cmd+R on a Mac.
 * Ctrl+Q (mark read) stays Ctrl on a Mac because Cmd+Q is the system's Quit.
 */
export const SHORTCUTS = {
    global: {
        account: def({ id: "go.account", keys: ["ctrl+shift+a"], label: "Go to Account", scope: "global" }),
        settings: def({ id: "go.settings", keys: ["ctrl+shift+s"], label: "Go to Settings", scope: "global" }),
        contacts: def({ id: "go.contacts", keys: ["ctrl+shift+b"], label: "Go to Contacts", scope: "global" }),
        mail: def({ id: "go.mail", keys: ["ctrl+shift+m"], label: "Go to Mail", scope: "global" }),
        calendar: def({ id: "go.calendar", keys: ["ctrl+shift+c"], label: "Go to Calendar", scope: "global" }),
        tasks: def({ id: "go.tasks", keys: ["ctrl+shift+l"], electronKeys: ["ctrl+shift+t"], label: "Go to Tasks", scope: "global" }),
        help: def({ id: "help", keys: ["?", "ctrl+/"], label: "Keyboard shortcuts", scope: "global" }),
    },
    mail: {
        create: def({ id: "mail.new", keys: ["alt+n"], electronKeys: ["mod+n"], label: "New message", scope: "mail" }),
        reply: def({ id: "mail.reply", keys: ["mod+r"], label: "Reply", scope: "mail" }),
        replyAll: def({ id: "mail.replyAll", keys: ["mod+shift+r"], label: "Reply all", scope: "mail" }),
        forward: def({ id: "mail.forward", keys: ["mod+shift+f"], label: "Forward", scope: "mail" }),
        delete: def({ id: "mail.delete", keys: ["mod+d", "delete"], label: "Delete", scope: "mail" }),
        archive: def({ id: "mail.archive", keys: ["e", "backspace"], label: "Archive", scope: "mail" }),
        move: def({ id: "mail.move", keys: ["mod+shift+v"], label: "Move to folder", scope: "mail" }),
        markRead: def({ id: "mail.markRead", keys: ["ctrl+q"], label: "Mark as read", scope: "mail" }),
        markUnread: def({ id: "mail.markUnread", keys: ["mod+u"], label: "Mark as unread", scope: "mail" }),
        flag: def({ id: "mail.flag", keys: ["insert"], label: "Flag or unflag", scope: "mail" }),
        next: def({ id: "mail.next", keys: ["arrowdown", "j"], label: "Next message", scope: "mail", repeat: true }),
        previous: def({ id: "mail.previous", keys: ["arrowup", "k"], label: "Previous message", scope: "mail", repeat: true }),
        nextUnread: def({ id: "mail.nextUnread", keys: ["ctrl+."], label: "Next unread message", scope: "mail" }),
        previousUnread: def({ id: "mail.previousUnread", keys: ["ctrl+,"], label: "Previous unread message", scope: "mail" }),
        open: def({ id: "mail.open", keys: ["enter"], label: "Open the message on its own page", scope: "mail", allowOnActivatable: true }),
        close: def({ id: "mail.close", keys: ["escape"], label: "Clear the selection", scope: "mail" }),
        search: def({ id: "mail.search", keys: ["/", "mod+e"], label: "Search mail", scope: "mail" }),
    },
    compose: {
        create: def({ id: "compose.new", keys: ["alt+n"], electronKeys: ["mod+n"], label: "New message", scope: "compose" }),
        send: def({ id: "compose.send", keys: ["mod+enter"], label: "Send", scope: "compose" }),
        saveDraft: def({ id: "compose.saveDraft", keys: ["mod+s"], label: "Save draft", scope: "compose" }),
        close: def({ id: "compose.close", keys: ["escape"], label: "Close (keeps the draft)", scope: "compose" }),
    },
    calendar: {
        create: def({ id: "calendar.new", keys: ["alt+n"], electronKeys: ["mod+n"], label: "New event", scope: "calendar" }),
        today: def({ id: "calendar.today", keys: ["t"], label: "Go to today", scope: "calendar" }),
        previous: def({ id: "calendar.previous", keys: ["arrowleft", "mod+arrowleft"], label: "Previous period", scope: "calendar", repeat: true }),
        next: def({ id: "calendar.next", keys: ["arrowright", "mod+arrowright"], label: "Next period", scope: "calendar", repeat: true }),
        day: def({ id: "calendar.day", keys: ["ctrl+alt+1"], label: "Day view", scope: "calendar" }),
        workWeek: def({ id: "calendar.workWeek", keys: ["ctrl+alt+2"], label: "Work week view", scope: "calendar" }),
        week: def({ id: "calendar.week", keys: ["ctrl+alt+3"], label: "Week view", scope: "calendar" }),
        month: def({ id: "calendar.month", keys: ["ctrl+alt+4"], label: "Month view", scope: "calendar" }),
    },
    contacts: {
        create: def({ id: "contacts.new", keys: ["alt+n"], electronKeys: ["mod+n"], label: "New contact", scope: "contacts" }),
        search: def({ id: "contacts.search", keys: ["/", "mod+e"], label: "Search contacts", scope: "contacts" }),
    },
    tasks: {
        create: def({ id: "tasks.new", keys: ["alt+n"], electronKeys: ["mod+n"], label: "New task", scope: "tasks" }),
    },
} as const;

/** Every shortcut of the map flattened, in listing order. */
export const ALL_SHORTCUTS: readonly ShortcutDef[] = Object.values(SHORTCUTS).flatMap((group) => Object.values(group) as ShortcutDef[]);

/** Where a shortcut sits in the listing, for ordering registrations that arrive in whatever order components mount. */
export function shortcutRank(shortcut: ShortcutDef): number {
    const index = ALL_SHORTCUTS.findIndex((candidate) => candidate.id === shortcut.id);
    return index === -1 ? ALL_SHORTCUTS.length : index;
}
