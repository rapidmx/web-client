///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ParsedSpec, isSymbolKey, resolveModifiers } from "./parse.js";
import type { KeyEnvironment } from "./platform.js";

/** The part of a `KeyboardEvent` matching reads. */
export interface KeyEventLike {
    key: string;
    code?: string;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    metaKey: boolean;
}

/** Whether `key` is what a Latin layout produces for a printable key: then `event.key` says which key it is, whatever `event.code` is. */
function isAsciiKey(key: string): boolean {
    return /^[\x21-\x7e]$/.test(key);
}

/**
 * Whether a key event is the shortcut `parsed`, on `env`.
 *
 * The key is matched on `event.key` (case-insensitively), so a shortcut means the letter on the key cap on any layout that has it -
 * Dvorak, AZERTY - and falls back to `event.code` only when `event.key` is not a Latin character at all: macOS Option+N produces a
 * dead key or `~`-like symbol, and a Cyrillic or Greek layout produces `ф`/`α` for the key that is A on a QWERTY board. Modifiers must
 * match exactly (Ctrl+Shift+R is not Ctrl+R), except Shift for a printable symbol, which some layouts need to type it (`?`).
 */
export function matchesEvent(parsed: ParsedSpec, event: KeyEventLike, env: KeyEnvironment): boolean {
    const modifiers = resolveModifiers(parsed, env);
    if (event.ctrlKey !== modifiers.ctrl || event.altKey !== modifiers.alt || event.metaKey !== modifiers.meta) {
        return false;
    }
    if (event.shiftKey !== modifiers.shift && !(isSymbolKey(parsed.key) && !parsed.shift)) {
        return false;
    }
    const key = (event.key ?? "").toLowerCase();
    if (key === parsed.key) {
        return true;
    }
    return !!parsed.code && event.code === parsed.code && !isAsciiKey(key);
}
