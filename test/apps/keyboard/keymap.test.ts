///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { ALL_SHORTCUTS, HELP_SCOPES, SCOPE_LABELS, SHORTCUTS, ShortcutDef, shortcutRank } from "../../../apps/shared/keyboard/keymap.js";
import { parseSpec, resolveModifiers } from "../../../apps/shared/keyboard/parse.js";

const ENVIRONMENTS = [
    { mac: false, electron: false },
    { mac: false, electron: true },
    { mac: true, electron: false },
    { mac: true, electron: true },
];

/** A spec as what a keyboard produces: modifiers resolved, so `mod+r` and `ctrl+r` are the same key on Windows. */
function chord(spec: string, env: { mac: boolean; electron: boolean }): string {
    const parsed = parseSpec(spec);
    const m = resolveModifiers(parsed, env);
    const shift = m.shift ? "shift+" : "";
    return `${m.ctrl ? "ctrl+" : ""}${m.alt ? "alt+" : ""}${shift}${m.meta ? "meta+" : ""}${parsed.key}`;
}

describe("the key map", () => {
    it("is exactly the decided map", () => {
        const keysOf = (defs: Record<string, ShortcutDef>) => Object.fromEntries(Object.entries(defs).map(([name, d]) => [name, [...d.keys, ...(d.electronKeys ?? []).map((k) => `desktop:${k}`)]]));
        expect(keysOf(SHORTCUTS.global)).toEqual({
            account: ["ctrl+shift+a"],
            settings: ["ctrl+shift+s"],
            contacts: ["ctrl+shift+b"],
            mail: ["ctrl+shift+m"],
            calendar: ["ctrl+shift+c"],
            tasks: ["ctrl+shift+l", "desktop:ctrl+shift+t"],
            help: ["?", "ctrl+/"],
        });
        expect(keysOf(SHORTCUTS.mail)).toEqual({
            create: ["alt+n", "desktop:mod+n"],
            reply: ["mod+r"],
            replyAll: ["mod+shift+r"],
            forward: ["mod+shift+f"],
            delete: ["mod+d", "delete"],
            archive: ["e", "backspace"],
            move: ["mod+shift+v"],
            markRead: ["ctrl+q"],
            markUnread: ["mod+u"],
            flag: ["insert"],
            next: ["arrowdown", "j"],
            previous: ["arrowup", "k"],
            nextUnread: ["ctrl+."],
            previousUnread: ["ctrl+,"],
            open: ["enter"],
            close: ["escape"],
            search: ["/", "mod+e"],
        });
        expect(keysOf(SHORTCUTS.compose)).toEqual({
            create: ["alt+n", "desktop:mod+n"],
            send: ["mod+enter"],
            saveDraft: ["mod+s"],
            close: ["escape"],
        });
        expect(keysOf(SHORTCUTS.calendar)).toEqual({
            create: ["alt+n", "desktop:mod+n"],
            today: ["t"],
            previous: ["arrowleft", "mod+arrowleft"],
            next: ["arrowright", "mod+arrowright"],
            day: ["ctrl+alt+1"],
            workWeek: ["ctrl+alt+2"],
            week: ["ctrl+alt+3"],
            month: ["ctrl+alt+4"],
        });
        expect(keysOf(SHORTCUTS.contacts)).toEqual({ create: ["alt+n", "desktop:mod+n"], search: ["/", "mod+e"] });
        expect(keysOf(SHORTCUTS.tasks)).toEqual({ create: ["alt+n", "desktop:mod+n"] });
    });

    it("parses every spec, and gives every shortcut a unique id, a label and the scope of its group", () => {
        for (const [group, defs] of Object.entries(SHORTCUTS)) {
            for (const shortcut of Object.values(defs) as ShortcutDef[]) {
                expect(shortcut.scope, shortcut.id).toBe(group);
                expect(shortcut.label, shortcut.id).not.toBe("");
                for (const spec of [...shortcut.keys, ...(shortcut.electronKeys ?? [])]) {
                    expect(() => parseSpec(spec), `${shortcut.id}: ${spec}`).not.toThrow();
                }
            }
        }
        const ids = ALL_SHORTCUTS.map((shortcut) => shortcut.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("never gives two shortcuts of one scope the same chord, on any platform (they would shadow each other)", () => {
        for (const env of ENVIRONMENTS) {
            const seen = new Map<string, string>();
            for (const shortcut of ALL_SHORTCUTS) {
                const specs = env.electron ? [...shortcut.keys, ...(shortcut.electronKeys ?? [])] : shortcut.keys;
                for (const spec of specs) {
                    const key = `${shortcut.scope}:${chord(spec, env)}`;
                    expect(seen.get(key), `${JSON.stringify(env)} ${key} is claimed by ${shortcut.id} and ${seen.get(key)}`).toBeUndefined();
                    seen.set(key, shortcut.id);
                }
            }
        }
    });

    it("never lets a view's or the compose window's chord shadow a global one", () => {
        for (const env of ENVIRONMENTS) {
            const global = new Set(SHORTCUTS_OF("global").flatMap((s) => specsOf(s, env).map((spec) => chord(spec, env))));
            for (const shortcut of ALL_SHORTCUTS.filter((s) => s.scope !== "global")) {
                for (const spec of specsOf(shortcut, env)) {
                    expect(global.has(chord(spec, env)), `${shortcut.id} ${spec} shadows a global shortcut`).toBe(false);
                }
            }
        }
    });

    it("never claims Copy, Cut, Paste, Select all, Undo, Redo or Find", () => {
        const reserved = ["a", "c", "v", "x", "z", "y", "f"];
        for (const env of ENVIRONMENTS) {
            for (const shortcut of ALL_SHORTCUTS) {
                for (const spec of specsOf(shortcut, env)) {
                    const parsed = parseSpec(spec);
                    const m = resolveModifiers(parsed, env);
                    const plainChord = (m.ctrl || m.meta) && !m.alt && !m.shift && reserved.includes(parsed.key);
                    expect(plainChord, `${shortcut.id} ${spec}`).toBe(false);
                }
            }
        }
    });

    it("keeps the navigation set on Ctrl+Shift on every platform, and the mail actions on mod", () => {
        for (const shortcut of (Object.values(SHORTCUTS.global) as ShortcutDef[]).filter((s) => s.id.startsWith("go."))) {
            for (const spec of [...shortcut.keys, ...(shortcut.electronKeys ?? [])]) {
                expect(parseSpec(spec)).toMatchObject({ ctrl: true, shift: true, meta: false, mod: false });
            }
        }
        for (const shortcut of [SHORTCUTS.mail.reply, SHORTCUTS.mail.replyAll, SHORTCUTS.mail.forward, SHORTCUTS.mail.move]) {
            expect(parseSpec(shortcut.keys[0]).mod).toBe(true);
        }
        // Cmd+Q is the system's Quit, so mark read is a literal Ctrl+Q even on a Mac.
        expect(parseSpec(SHORTCUTS.mail.markRead.keys[0])).toMatchObject({ ctrl: true, mod: false });
    });

    it("has the create shortcut of every view on Alt+N, with Ctrl/Cmd+N only in the desktop client", () => {
        for (const shortcut of ALL_SHORTCUTS.filter((s) => s.id.endsWith(".new"))) {
            expect(shortcut.keys).toEqual(["alt+n"]);
            expect(shortcut.electronKeys).toEqual(["mod+n"]);
        }
        expect(ALL_SHORTCUTS.filter((s) => s.id.endsWith(".new")).map((s) => s.scope)).toEqual(["mail", "compose", "calendar", "contacts", "tasks"]);
    });

    it("ranks shortcuts in listing order, and unknown ones last", () => {
        expect(shortcutRank(SHORTCUTS.global.account)).toBe(0);
        expect(shortcutRank(SHORTCUTS.mail.reply)).toBeGreaterThan(shortcutRank(SHORTCUTS.global.help));
        expect(shortcutRank({ id: "nope", keys: ["x"], label: "x", scope: "global" })).toBe(ALL_SHORTCUTS.length);
    });

    it("labels every scope the help dialog lists", () => {
        for (const scope of HELP_SCOPES) {
            expect(SCOPE_LABELS[scope]).toBeTruthy();
        }
        expect(SCOPE_LABELS.dialog).toBe("Dialog");
    });
});

function SHORTCUTS_OF(scope: string): ShortcutDef[] {
    return ALL_SHORTCUTS.filter((s) => s.scope === scope);
}

function specsOf(shortcut: ShortcutDef, env: { mac: boolean; electron: boolean }): string[] {
    return env.electron ? [...shortcut.keys, ...(shortcut.electronKeys ?? [])] : [...shortcut.keys];
}
