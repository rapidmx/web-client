///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ShortcutScope } from "./keymap.js";
import { matchesEvent } from "./match.js";
import { ParsedSpec, resolveModifiers } from "./parse.js";
import type { KeyEnvironment } from "./platform.js";
import type { Registration, ShortcutRegistry } from "./registry.js";
import { isActivatable, isInPopoverDialog, isInWidget, isModalOpen, isPopupOpenAt, isTextEntry, regionScopeOf } from "./targets.js";

/** The keys of the four view scopes: only the mounted view has registrations, so precedence among them is moot. */
const VIEW_SCOPES: readonly ShortcutScope[] = ["mail", "calendar", "contacts", "tasks"];

/** Keys that move the caret or delete text, which a text field owns even with Ctrl or Alt held (word jumps, delete-word). */
const EDITING_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end", "pageup", "pagedown", "backspace", "delete"]);

/** The Copy / Cut / Paste / Select all / Undo / Redo / Find chords: never a shortcut, anywhere - they act on the page's selection, not on a view. */
function isReservedChord(parsed: ParsedSpec, env: KeyEnvironment): boolean {
    const modifiers = resolveModifiers(parsed, env);
    return (modifiers.ctrl || modifiers.meta) && !modifiers.alt && !modifiers.shift && ["a", "c", "v", "x", "z", "y", "f"].includes(parsed.key);
}

/** Paste as plain text (Ctrl+Shift+V) and Redo (Ctrl+Shift+Z): text-editing chords in a field, free everywhere else (Ctrl+Shift+V is Move to). */
function isShiftedEditingChord(parsed: ParsedSpec, env: KeyEnvironment): boolean {
    const modifiers = resolveModifiers(parsed, env);
    return (modifiers.ctrl || modifiers.meta) && !modifiers.alt && modifiers.shift && ["z", "v"].includes(parsed.key);
}

/**
 * Whether `parsed` may fire with the event on this target.
 *
 * A text field (input, textarea, select, contenteditable - the rich-text editor) keeps everything that types or edits: bare keys
 * (`j`, `?`, Delete), the caret keys with any modifier, and paste-as-plain-text and redo. A chord with Ctrl/Cmd/Alt works from one (that is how Ctrl+Enter sends from
 * the body), except that Option on a Mac and Ctrl+Alt (AltGr) elsewhere type characters, so those don't. Escape works from a field unless a
 * popup it owns is open (or it is in a popover dialog of its own). Outside a field, a bare key still isn't taken from a widget that reads keys itself (an open menu, a list box), and
 * Enter/Space are left to the button or link that has the focus - unless the shortcut asked for them.
 */
function allowedOnTarget(registration: Registration, parsed: ParsedSpec, target: EventTarget | null, env: KeyEnvironment): boolean {
    const modifiers = resolveModifiers(parsed, env);
    const command = modifiers.ctrl || modifiers.meta || modifiers.alt;
    if (parsed.key === "escape" && (isPopupOpenAt(target) || isInPopoverDialog(target))) {
        return false;
    }
    if (isTextEntry(target)) {
        if (parsed.key === "escape") {
            return true;
        }
        if (!command || EDITING_KEYS.has(parsed.key) || isShiftedEditingChord(parsed, env)) {
            return false;
        }
        return !(modifiers.alt && !modifiers.meta && (env.mac || modifiers.ctrl));
    }
    if (!command) {
        if (isInWidget(target)) {
            return false;
        }
        if ((parsed.key === "enter" || parsed.key === " ") && !registration.shortcut.allowOnActivatable && isActivatable(target)) {
            return false;
        }
    }
    return true;
}

/** The scopes that may act on this event, highest precedence first. */
function activeScopes(event: KeyboardEvent, doc: Document): readonly ShortcutScope[] {
    if (isModalOpen(doc)) {
        return ["dialog"];
    }
    if (regionScopeOf(event.target) === "compose") {
        return ["compose", "global"];
    }
    return [...VIEW_SCOPES, "global"];
}

/** Whether the registration applies to where the event happened (a compose window's shortcuts only inside it). */
function inContainer(registration: Registration, event: KeyboardEvent): boolean {
    if (!registration.container) {
        return true;
    }
    return !!registration.container.current?.contains(event.target as Node | null);
}

/**
 * Handles one `keydown`: finds the registered shortcut it is, and runs its handler. Returns whether a handler ran - and only then is the
 * event's default prevented and its propagation stopped, so a key nobody claims (or a handler that declines) behaves exactly as if this layer
 * did not exist.
 *
 * Skipped outright: an event some other handler already `defaultPrevented` (a menu, the rich-text editor's own bindings), one from an IME
 * composition, a bare modifier key, and the Copy/Cut/Paste/Select all/Undo/Redo/Find chords. A held key repeats: an action that is not
 * marked `repeat` runs on the first press only, and the repeats are swallowed (so a browser doesn't reload on a held Ctrl+R) without running it.
 *
 * Which registration wins: the dialog scope alone while a modal is open; else, inside a compose window, `compose` then `global`; else
 * whichever view is mounted, then `global`. Within a scope the most recently mounted registration goes first, and one that returns
 * `false` passes the key on to the next.
 */
export function dispatchKeyEvent(registry: ShortcutRegistry, event: KeyboardEvent, env: KeyEnvironment, doc: Document): boolean {
    if (event.defaultPrevented || event.isComposing || event.key === "Process" || ["Control", "Shift", "Alt", "Meta"].includes(event.key)) {
        return false;
    }
    const scopes = activeScopes(event, doc);
    const candidates = registry
        .getSnapshot()
        .filter((registration) => scopes.includes(registration.scope) && inContainer(registration, event))
        .sort((a, b) => scopes.indexOf(a.scope) - scopes.indexOf(b.scope) || b.order - a.order);
    for (const registration of candidates) {
        const specs = env.electron ? [...registration.keys, ...registration.electronKeys] : registration.keys;
        const parsed = specs.find((spec) => matchesEvent(spec, event, env));
        if (!parsed || isReservedChord(parsed, env) || !allowedOnTarget(registration, parsed, event.target, env)) {
            continue;
        }
        if (event.repeat && !registration.shortcut.repeat) {
            event.preventDefault();
            event.stopPropagation();
            return true;
        }
        if (registration.run(event) !== false) {
            event.preventDefault();
            event.stopPropagation();
            return true;
        }
    }
    return false;
}
