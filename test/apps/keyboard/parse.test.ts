///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { isSymbolKey, parseSpec, resolveModifiers } from "../../../apps/shared/keyboard/parse.js";

describe("parseSpec", () => {
    it("reads modifiers and a key, in any order and any case", () => {
        expect(parseSpec("ctrl+shift+a")).toMatchObject({ key: "a", ctrl: true, shift: true, alt: false, meta: false, mod: false, code: "KeyA" });
        expect(parseSpec("Shift+CTRL+A")).toMatchObject({ key: "a", ctrl: true, shift: true });
        expect(parseSpec("alt+n")).toMatchObject({ key: "n", alt: true, code: "KeyN" });
    });

    it("understands the modifier aliases", () => {
        expect(parseSpec("control+option+cmd+x")).toMatchObject({ ctrl: true, alt: true, meta: true });
        expect(parseSpec("opt+command+x")).toMatchObject({ alt: true, meta: true });
        expect(parseSpec("mod+r")).toMatchObject({ mod: true, ctrl: false, meta: false });
    });

    it("reads bare keys, named keys and aliases", () => {
        expect(parseSpec("Delete")).toMatchObject({ key: "delete", ctrl: false });
        expect(parseSpec("del").key).toBe("delete");
        expect(parseSpec("esc").key).toBe("escape");
        expect(parseSpec("return").key).toBe("enter");
        expect(parseSpec("ins").key).toBe("insert");
        expect(parseSpec("up").key).toBe("arrowup");
        expect(parseSpec("ArrowDown").key).toBe("arrowdown");
        expect(parseSpec("left").key).toBe("arrowleft");
        expect(parseSpec("right").key).toBe("arrowright");
        expect(parseSpec("space").key).toBe(" ");
        expect(parseSpec("pgup").key).toBe("pageup");
        expect(parseSpec("pgdn").key).toBe("pagedown");
        expect(parseSpec("F5").key).toBe("f5");
        expect(parseSpec("tab").key).toBe("tab");
    });

    it("reads symbols and gives the ones with a physical key a code", () => {
        expect(parseSpec("?")).toMatchObject({ key: "?", code: undefined });
        expect(parseSpec("ctrl+/")).toMatchObject({ key: "/", ctrl: true, code: "Slash" });
        expect(parseSpec("ctrl+.").code).toBe("Period");
        expect(parseSpec("ctrl+,").code).toBe("Comma");
        expect(parseSpec("ctrl+alt+1").code).toBe("Digit1");
    });

    it("reads the plus key", () => {
        expect(parseSpec("ctrl++")).toMatchObject({ key: "+", ctrl: true });
        expect(parseSpec("plus").key).toBe("+");
    });

    it("rejects specs it cannot understand", () => {
        expect(() => parseSpec("")).toThrow(/empty part/);
        expect(() => parseSpec("ctrl+")).toThrow(/empty part/);
        expect(() => parseSpec("ctrl+shift")).toThrow(/no key/);
        expect(() => parseSpec("ctrl+a+b")).toThrow(/more than one key/);
        expect(() => parseSpec("ctrl+banana")).toThrow(/unknown key/);
        expect(() => parseSpec("f13")).toThrow(/unknown key/);
    });
});

describe("resolveModifiers", () => {
    it("turns mod into Ctrl, or Cmd on a Mac", () => {
        const spec = parseSpec("mod+shift+r");
        expect(resolveModifiers(spec, { mac: false, electron: false })).toEqual({ ctrl: true, shift: true, alt: false, meta: false });
        expect(resolveModifiers(spec, { mac: true, electron: false })).toEqual({ ctrl: false, shift: true, alt: false, meta: true });
    });

    it("leaves a literal ctrl alone on a Mac", () => {
        expect(resolveModifiers(parseSpec("ctrl+shift+a"), { mac: true, electron: false })).toEqual({ ctrl: true, shift: true, alt: false, meta: false });
    });
});

describe("isSymbolKey", () => {
    it("is true for a printable symbol and false for letters, digits and named keys", () => {
        expect(isSymbolKey("?")).toBe(true);
        expect(isSymbolKey("/")).toBe(true);
        expect(isSymbolKey("a")).toBe(false);
        expect(isSymbolKey("1")).toBe(false);
        expect(isSymbolKey("enter")).toBe(false);
    });
});
