///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { ariaKeyShortcuts, ariaSpec, formatSpec, specsFor, withHint } from "../../../apps/shared/keyboard/format.js";
import { SHORTCUTS } from "../../../apps/shared/keyboard/keymap.js";

const WINDOWS = { mac: false, electron: false };
const MAC = { mac: true, electron: false };
const DESKTOP = { mac: false, electron: true };

describe("formatSpec", () => {
    it("spells modifiers out on Windows and Linux", () => {
        expect(formatSpec("ctrl+shift+a", WINDOWS)).toBe("Ctrl+Shift+A");
        expect(formatSpec("mod+r", WINDOWS)).toBe("Ctrl+R");
        expect(formatSpec("alt+n", WINDOWS)).toBe("Alt+N");
        expect(formatSpec("ctrl+alt+1", WINDOWS)).toBe("Ctrl+Alt+1");
        expect(formatSpec("cmd+k", WINDOWS)).toBe("Meta+K");
    });

    it("uses glyphs on a Mac: Cmd for mod, Option for alt, in Apple's order", () => {
        expect(formatSpec("mod+r", MAC)).toBe("⌘R");
        expect(formatSpec("mod+shift+r", MAC)).toBe("⇧⌘R");
        expect(formatSpec("alt+n", MAC)).toBe("⌥N");
        expect(formatSpec("ctrl+shift+a", MAC)).toBe("⌃⇧A");
        expect(formatSpec("ctrl+alt+1", MAC)).toBe("⌃⌥1");
    });

    it("names bare and named keys", () => {
        expect(formatSpec("?", WINDOWS)).toBe("?");
        expect(formatSpec("Delete", WINDOWS)).toBe("Delete");
        expect(formatSpec("Delete", MAC)).toBe("⌦");
        expect(formatSpec("backspace", MAC)).toBe("⌫");
        expect(formatSpec("backspace", WINDOWS)).toBe("Backspace");
        expect(formatSpec("mod+enter", WINDOWS)).toBe("Ctrl+Enter");
        expect(formatSpec("mod+enter", MAC)).toBe("⌘↩");
        expect(formatSpec("escape", WINDOWS)).toBe("Esc");
        expect(formatSpec("arrowup", WINDOWS)).toBe("↑");
        expect(formatSpec("mod+arrowleft", WINDOWS)).toBe("Ctrl+←");
        expect(formatSpec("insert", WINDOWS)).toBe("Insert");
        expect(formatSpec("space", WINDOWS)).toBe("Space");
        expect(formatSpec("F5", WINDOWS)).toBe("F5");
        expect(formatSpec("j", WINDOWS)).toBe("J");
    });
});

describe("ariaSpec and ariaKeyShortcuts", () => {
    it("writes aria-keyshortcuts syntax", () => {
        expect(ariaSpec("mod+shift+r", WINDOWS)).toBe("Control+Shift+R");
        expect(ariaSpec("mod+shift+r", MAC)).toBe("Shift+Meta+R");
        expect(ariaSpec("alt+n", WINDOWS)).toBe("Alt+N");
        expect(ariaSpec("ctrl+alt+1", WINDOWS)).toBe("Control+Alt+1");
        expect(ariaSpec("Delete", WINDOWS)).toBe("Delete");
        expect(ariaSpec("arrowdown", WINDOWS)).toBe("ArrowDown");
        expect(ariaSpec("space", WINDOWS)).toBe("Space");
        expect(ariaSpec("F5", WINDOWS)).toBe("F5");
        expect(ariaSpec("?", WINDOWS)).toBe("?");
    });

    it("lists every alternative, and the desktop client's own keys only in the desktop client", () => {
        expect(ariaKeyShortcuts(SHORTCUTS.mail.delete, WINDOWS)).toBe("Control+D Delete");
        expect(ariaKeyShortcuts(SHORTCUTS.mail.create, WINDOWS)).toBe("Alt+N");
        expect(ariaKeyShortcuts(SHORTCUTS.mail.create, DESKTOP)).toBe("Alt+N Control+N");
        expect(ariaKeyShortcuts(SHORTCUTS.mail.create, { mac: true, electron: true })).toBe("Alt+N Meta+N");
    });
});

describe("specsFor", () => {
    it("adds the desktop-only specs in the desktop client", () => {
        expect(specsFor(SHORTCUTS.global.tasks, WINDOWS)).toEqual(["ctrl+shift+l"]);
        expect(specsFor(SHORTCUTS.global.tasks, DESKTOP)).toEqual(["ctrl+shift+l", "ctrl+shift+t"]);
        expect(specsFor(SHORTCUTS.mail.reply, DESKTOP)).toEqual(["mod+r"]);
    });
});

describe("withHint", () => {
    it("suffixes a label with the shortcut's first key", () => {
        expect(withHint("Reply", SHORTCUTS.mail.reply, WINDOWS)).toBe("Reply (Ctrl+R)");
        expect(withHint("Reply", SHORTCUTS.mail.reply, MAC)).toBe("Reply (⌘R)");
        expect(withHint("Compose", SHORTCUTS.mail.create, WINDOWS)).toBe("Compose (Alt+N)");
        expect(withHint("Delete", SHORTCUTS.mail.delete, WINDOWS)).toBe("Delete (Ctrl+D)");
    });
});
