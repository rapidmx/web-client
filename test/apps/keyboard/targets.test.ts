///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it } from "vitest";
import {
    isActivatable,
    isInPopoverDialog,
    isInWidget,
    isModalOpen,
    isPopupOpenAt,
    isTextEntry,
    regionScopeOf,
} from "../../../apps/shared/keyboard/targets.js";

function mount(html: string): HTMLElement {
    document.body.innerHTML = html;
    return document.body;
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("isTextEntry", () => {
    it("is true for text fields, textareas, selects and contenteditable regions", () => {
        const body = mount(
            '<input id="t" type="text"><input id="s" type="search"><input id="d" type="date"><textarea id="a"></textarea><select id="sel"></select>' +
                '<div id="ce" contenteditable="true"><p id="inner">x</p></div><div id="tb" role="textbox"></div><div id="sb" role="searchbox"></div>',
        );
        for (const id of ["t", "s", "d", "a", "sel", "ce", "inner", "tb", "sb"]) {
            expect(isTextEntry(body.querySelector(`#${id}`)), id).toBe(true);
        }
    });

    it("is false for buttons, checkboxes, non-editable content and things that are not elements", () => {
        const body = mount(
            '<input id="cb" type="checkbox"><input id="b" type="button"><input id="f" type="file"><button id="btn">x</button><div id="off" contenteditable="false"><span id="in">x</span></div><p id="p">x</p>',
        );
        for (const id of ["cb", "b", "f", "btn", "off", "in", "p"]) {
            expect(isTextEntry(body.querySelector(`#${id}`)), id).toBe(false);
        }
        expect(isTextEntry(null)).toBe(false);
        expect(isTextEntry(window)).toBe(false);
    });
});

describe("isInWidget", () => {
    it("is true inside a menu, a list box or another keyboard widget", () => {
        const body = mount('<div role="menu"><button id="m">x</button></div><div role="listbox"><span id="l">x</span></div><button id="out">x</button>');
        expect(isInWidget(body.querySelector("#m"))).toBe(true);
        expect(isInWidget(body.querySelector("#l"))).toBe(true);
        expect(isInWidget(body.querySelector("#out"))).toBe(false);
        expect(isInWidget(null)).toBe(false);
    });
});

describe("isActivatable", () => {
    it("is true for buttons, links and menu items - including what is inside them", () => {
        const body = mount('<button id="b"><span id="s">x</span></button><a id="a" href="/x">x</a><a id="nolink">x</a><div id="mi" role="menuitem">x</div><p id="p">x</p>');
        expect(isActivatable(body.querySelector("#b"))).toBe(true);
        expect(isActivatable(body.querySelector("#s"))).toBe(true);
        expect(isActivatable(body.querySelector("#a"))).toBe(true);
        expect(isActivatable(body.querySelector("#mi"))).toBe(true);
        expect(isActivatable(body.querySelector("#nolink"))).toBe(false);
        expect(isActivatable(body.querySelector("#p"))).toBe(false);
    });
});

describe("isPopupOpenAt", () => {
    it("is true on the trigger of an open popup or an expanded combobox", () => {
        const body = mount(
            '<button id="open" aria-haspopup="true" aria-expanded="true">x</button><button id="closed" aria-haspopup="true" aria-expanded="false">x</button>' +
                '<input id="combo" role="combobox" aria-expanded="true"><input id="combo2" role="combobox" aria-expanded="false">',
        );
        expect(isPopupOpenAt(body.querySelector("#open"))).toBe(true);
        expect(isPopupOpenAt(body.querySelector("#combo"))).toBe(true);
        expect(isPopupOpenAt(body.querySelector("#closed"))).toBe(false);
        expect(isPopupOpenAt(body.querySelector("#combo2"))).toBe(false);
    });
});

describe("isModalOpen", () => {
    it("is true only while an aria-modal element is in the document", () => {
        mount("<p>x</p>");
        expect(isModalOpen(document)).toBe(false);
        mount('<div role="dialog" aria-modal="true">x</div>');
        expect(isModalOpen(document)).toBe(true);
    });
});

describe("isInPopoverDialog", () => {
    it("is true inside a dialog that declares no shortcut scope, false inside a compose window or outside any", () => {
        const body = mount(
            '<div role="dialog"><input id="pop"></div><div role="dialog" data-shortcut-scope="compose"><input id="compose"></div><input id="free">',
        );
        expect(isInPopoverDialog(body.querySelector("#pop"))).toBe(true);
        expect(isInPopoverDialog(body.querySelector("#compose"))).toBe(false);
        expect(isInPopoverDialog(body.querySelector("#free"))).toBe(false);
    });
});

describe("regionScopeOf", () => {
    it("names the shortcut scope of the region the target is in", () => {
        const body = mount('<div data-shortcut-scope="compose"><input id="in"></div><input id="out">');
        expect(regionScopeOf(body.querySelector("#in"))).toBe("compose");
        expect(regionScopeOf(body.querySelector("#out"))).toBeUndefined();
        expect(regionScopeOf(null)).toBeUndefined();
    });
});
