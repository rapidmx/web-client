///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { KeyEventLike, matchesEvent } from "../../../apps/shared/keyboard/match.js";
import { parseSpec } from "../../../apps/shared/keyboard/parse.js";

const WINDOWS = { mac: false, electron: false };
const MAC = { mac: true, electron: false };

function event(key: string, init: Partial<KeyEventLike> = {}): KeyEventLike {
    return { key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...init };
}

describe("matchesEvent", () => {
    it("matches the key case-insensitively (Shift makes a letter upper case)", () => {
        expect(matchesEvent(parseSpec("ctrl+shift+a"), event("A", { ctrlKey: true, shiftKey: true }), WINDOWS)).toBe(true);
        expect(matchesEvent(parseSpec("ctrl+r"), event("R", { ctrlKey: true }), WINDOWS)).toBe(true);
        expect(matchesEvent(parseSpec("ctrl+r"), event("r", { ctrlKey: true }), WINDOWS)).toBe(true);
    });

    it("needs every modifier to match exactly", () => {
        expect(matchesEvent(parseSpec("ctrl+r"), event("r", { ctrlKey: true, shiftKey: true }), WINDOWS)).toBe(false);
        expect(matchesEvent(parseSpec("ctrl+shift+r"), event("R", { ctrlKey: true }), WINDOWS)).toBe(false);
        expect(matchesEvent(parseSpec("alt+n"), event("n", { altKey: true, ctrlKey: true }), WINDOWS)).toBe(false);
        expect(matchesEvent(parseSpec("alt+n"), event("n", { altKey: true, metaKey: true }), WINDOWS)).toBe(false);
        expect(matchesEvent(parseSpec("e"), event("e", { ctrlKey: true }), WINDOWS)).toBe(false);
        expect(matchesEvent(parseSpec("ctrl+r"), event("r"), WINDOWS)).toBe(false);
    });

    it("compares the key itself", () => {
        expect(matchesEvent(parseSpec("ctrl+r"), event("f", { ctrlKey: true }), WINDOWS)).toBe(false);
        expect(matchesEvent(parseSpec("Delete"), event("Delete"), WINDOWS)).toBe(true);
        expect(matchesEvent(parseSpec("ArrowDown"), event("ArrowDown"), WINDOWS)).toBe(true);
        expect(matchesEvent(parseSpec("escape"), event("Escape"), WINDOWS)).toBe(true);
    });

    it("treats mod as Ctrl on Windows and Linux and Cmd on a Mac", () => {
        expect(matchesEvent(parseSpec("mod+r"), event("r", { ctrlKey: true }), WINDOWS)).toBe(true);
        expect(matchesEvent(parseSpec("mod+r"), event("r", { metaKey: true }), WINDOWS)).toBe(false);
        expect(matchesEvent(parseSpec("mod+r"), event("r", { metaKey: true }), MAC)).toBe(true);
        expect(matchesEvent(parseSpec("mod+r"), event("r", { ctrlKey: true }), MAC)).toBe(false);
    });

    it("keeps the Ctrl+Shift navigation set on Ctrl on a Mac", () => {
        expect(matchesEvent(parseSpec("ctrl+shift+a"), event("A", { ctrlKey: true, shiftKey: true }), MAC)).toBe(true);
        expect(matchesEvent(parseSpec("ctrl+shift+a"), event("A", { metaKey: true, shiftKey: true }), MAC)).toBe(false);
    });

    it("ignores Shift for a printable symbol, since some layouts need it to type one", () => {
        expect(matchesEvent(parseSpec("?"), event("?", { shiftKey: true }), WINDOWS)).toBe(true);
        expect(matchesEvent(parseSpec("?"), event("?"), WINDOWS)).toBe(true);
        expect(matchesEvent(parseSpec("ctrl+/"), event("/", { ctrlKey: true }), WINDOWS)).toBe(true);
        // ...but not when the spec asks for it.
        expect(matchesEvent(parseSpec("shift+/"), event("/"), WINDOWS)).toBe(false);
        expect(matchesEvent(parseSpec("shift+/"), event("/", { shiftKey: true }), WINDOWS)).toBe(true);
    });

    describe("layouts", () => {
        it("falls back to the physical key when event.key is not a Latin character (macOS Option+N types a dead key)", () => {
            expect(matchesEvent(parseSpec("alt+n"), event("Dead", { altKey: true, code: "KeyN" }), MAC)).toBe(true);
            expect(matchesEvent(parseSpec("alt+n"), event("˜", { altKey: true, code: "KeyN" }), MAC)).toBe(true);
            expect(matchesEvent(parseSpec("ctrl+alt+1"), event("¡", { ctrlKey: true, altKey: true, code: "Digit1" }), MAC)).toBe(true);
        });

        it("falls back to the physical key on a non-Latin layout", () => {
            // The A key of a Russian layout types a Cyrillic letter.
            expect(matchesEvent(parseSpec("ctrl+shift+a"), event("Ф", { ctrlKey: true, shiftKey: true, code: "KeyA" }), WINDOWS)).toBe(true);
        });

        it("does not use the physical key when event.key is a Latin letter (Dvorak's R is not the QWERTY R)", () => {
            expect(matchesEvent(parseSpec("ctrl+r"), event("p", { ctrlKey: true, code: "KeyR" }), WINDOWS)).toBe(false);
            expect(matchesEvent(parseSpec("ctrl+r"), event("r", { ctrlKey: true, code: "KeyP" }), WINDOWS)).toBe(true);
        });

        it("does not fall back to another key's code", () => {
            expect(matchesEvent(parseSpec("alt+n"), event("Dead", { altKey: true, code: "KeyM" }), MAC)).toBe(false);
            expect(matchesEvent(parseSpec("alt+n"), event("Dead", { altKey: true }), MAC)).toBe(false);
        });

        it("has no code for a named key, so a key of another name never matches it", () => {
            expect(matchesEvent(parseSpec("Delete"), event("Backspace", { code: "Backspace" }), WINDOWS)).toBe(false);
        });
    });

    it("tolerates an event with no key at all", () => {
        expect(matchesEvent(parseSpec("ctrl+r"), { ctrlKey: true, shiftKey: false, altKey: false, metaKey: false } as unknown as KeyEventLike, WINDOWS)).toBe(false);
    });
});
