///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ShortcutDef } from "./keymap.js";
import { parseSpec, resolveModifiers } from "./parse.js";
import type { KeyEnvironment } from "./platform.js";

const KEY_NAMES: Record<string, string> = {
    escape: "Esc",
    enter: "Enter",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    insert: "Insert",
    home: "Home",
    end: "End",
    pageup: "Page Up",
    pagedown: "Page Down",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    " ": "Space",
};

const MAC_KEY_NAMES: Record<string, string> = { ...KEY_NAMES, enter: "↩", backspace: "⌫", delete: "⌦" };

/** The key as it is printed on a key cap: `R`, `F5`, `Enter`, an arrow. */
function keyLabel(key: string, mac: boolean): string {
    return (mac ? MAC_KEY_NAMES : KEY_NAMES)[key] ?? key.toUpperCase();
}

/** A spec as a person reads it: `Ctrl+Shift+R`, or `⌃⇧R`-style glyphs on a Mac (`⌘` for Cmd, `⌥` for Option). */
export function formatSpec(spec: string, env: KeyEnvironment): string {
    const parsed = parseSpec(spec);
    const modifiers = resolveModifiers(parsed, env);
    if (env.mac) {
        return [modifiers.ctrl && "⌃", modifiers.alt && "⌥", modifiers.shift && "⇧", modifiers.meta && "⌘", keyLabel(parsed.key, true)]
            .filter(Boolean)
            .join("");
    }
    return [modifiers.ctrl && "Ctrl", modifiers.shift && "Shift", modifiers.alt && "Alt", modifiers.meta && "Meta", keyLabel(parsed.key, false)]
        .filter(Boolean)
        .join("+");
}

const ARIA_NAMED_KEYS: Record<string, string> = {
    escape: "Escape",
    enter: "Enter",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    insert: "Insert",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    " ": "Space",
};

/** A spec in `aria-keyshortcuts` syntax: `Control+Shift+R`, `Meta+R`. */
export function ariaSpec(spec: string, env: KeyEnvironment): string {
    const parsed = parseSpec(spec);
    const modifiers = resolveModifiers(parsed, env);
    const key = ARIA_NAMED_KEYS[parsed.key] ?? parsed.key.toUpperCase();
    return [modifiers.ctrl && "Control", modifiers.alt && "Alt", modifiers.shift && "Shift", modifiers.meta && "Meta", key].filter(Boolean).join("+");
}

/** Every spec that triggers a shortcut here: its keys, and in the desktop client also its desktop-only ones. */
export function specsFor(shortcut: ShortcutDef, env: KeyEnvironment): string[] {
    return env.electron && shortcut.electronKeys ? [...shortcut.keys, ...shortcut.electronKeys] : [...shortcut.keys];
}

/** The `aria-keyshortcuts` value for a control that runs a shortcut: every alternative, space separated. */
export function ariaKeyShortcuts(shortcut: ShortcutDef, env: KeyEnvironment): string {
    return specsFor(shortcut, env)
        .map((spec) => ariaSpec(spec, env))
        .join(" ");
}

/** A tooltip/name suffix such as `Reply (Ctrl+R)`: the label with the shortcut's first key. */
export function withHint(label: string, shortcut: ShortcutDef, env: KeyEnvironment): string {
    return `${label} (${formatSpec(shortcut.keys[0], env)})`;
}
