///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { KeyEnvironment } from "./platform.js";

/** A shortcut such as `ctrl+shift+a`, `alt+n`, `Delete` or `?`, broken into what a key event is compared with. */
export interface ParsedSpec {
    /** The spec as written. */
    spec: string;
    /** The key, lower-case: a letter or digit, a symbol (`?`, `/`, `.`, `,`), or a named key (`enter`, `delete`, `arrowup`, ...). */
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
    /** Ctrl on Windows and Linux, Cmd on macOS - resolved against the environment by `resolveModifiers()`. */
    mod: boolean;
    /** The `KeyboardEvent.code` of the key on a QWERTY keyboard, for layouts where `event.key` is not the letter (see `match.ts`). */
    code?: string;
}

const MODIFIERS: Record<string, "ctrl" | "shift" | "alt" | "meta" | "mod"> = {
    ctrl: "ctrl",
    control: "ctrl",
    shift: "shift",
    alt: "alt",
    option: "alt",
    opt: "alt",
    meta: "meta",
    cmd: "meta",
    command: "meta",
    mod: "mod",
};

/** Spec spellings of keys whose `event.key` is something else. */
const KEY_ALIASES: Record<string, string> = {
    esc: "escape",
    del: "delete",
    ins: "insert",
    return: "enter",
    up: "arrowup",
    down: "arrowdown",
    left: "arrowleft",
    right: "arrowright",
    space: " ",
    spacebar: " ",
    plus: "+",
    pgup: "pageup",
    pgdn: "pagedown",
};

/** The named keys a spec may use besides a single character and `F1`-`F12`. */
const NAMED_KEYS = new Set([
    "escape",
    "enter",
    "tab",
    "backspace",
    "delete",
    "insert",
    "home",
    "end",
    "pageup",
    "pagedown",
    "arrowup",
    "arrowdown",
    "arrowleft",
    "arrowright",
]);

const SYMBOL_CODES: Record<string, string> = { "/": "Slash", ".": "Period", ",": "Comma" };

/** The `code` a key has on a QWERTY keyboard, for the keys where one is worth falling back to. */
function codeFor(key: string): string | undefined {
    if (/^[a-z]$/.test(key)) {
        return `Key${key.toUpperCase()}`;
    }
    if (/^[0-9]$/.test(key)) {
        return `Digit${key}`;
    }
    return SYMBOL_CODES[key];
}

/**
 * Parses a shortcut spec: modifiers and one key joined by `+`, in any order and any case - `ctrl+shift+a`, `Alt+N`, `mod+enter`,
 * `Delete`, `?`, `ctrl+/`, `ctrl++`. `mod` is Ctrl on Windows/Linux and Cmd on macOS. Throws on a spec that cannot be understood, so a
 * typo in a key map fails at once rather than silently never matching.
 */
export function parseSpec(spec: string): ParsedSpec {
    // A trailing `+` is the plus key itself (`ctrl++`), which a plain split would lose.
    const plusKey = spec.length > 1 && spec.endsWith("++");
    const tokens = (plusKey ? spec.slice(0, -2) : spec).split("+").map((token) => token.trim());
    if (plusKey) {
        tokens.push("+");
    }
    const parsed: ParsedSpec = { spec, key: "", ctrl: false, shift: false, alt: false, meta: false, mod: false };
    for (const token of tokens) {
        if (token === "") {
            throw new Error(`Invalid shortcut "${spec}": empty part.`);
        }
        const lower = token.toLowerCase();
        const modifier = MODIFIERS[lower];
        if (modifier) {
            parsed[modifier] = true;
            continue;
        }
        if (parsed.key !== "") {
            throw new Error(`Invalid shortcut "${spec}": more than one key.`);
        }
        const key = KEY_ALIASES[lower] ?? lower;
        if ([...key].length > 1 && !NAMED_KEYS.has(key) && !/^f([1-9]|1[0-2])$/.test(key)) {
            throw new Error(`Invalid shortcut "${spec}": unknown key "${token}".`);
        }
        parsed.key = key;
        parsed.code = codeFor(key);
    }
    if (parsed.key === "") {
        throw new Error(`Invalid shortcut "${spec}": no key.`);
    }
    return parsed;
}

/** The modifiers a spec needs on a given platform, with `mod` turned into Cmd (macOS) or Ctrl. */
export function resolveModifiers(parsed: ParsedSpec, env: KeyEnvironment): { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean } {
    return {
        ctrl: parsed.ctrl || (parsed.mod && !env.mac),
        shift: parsed.shift,
        alt: parsed.alt,
        meta: parsed.meta || (parsed.mod && env.mac),
    };
}

/** Whether the key is a printable symbol whose shifted-ness depends on the layout (`?` is Shift+/ on a US keyboard, not on others). */
export function isSymbolKey(key: string): boolean {
    return [...key].length === 1 && !/[a-z0-9]/.test(key);
}
