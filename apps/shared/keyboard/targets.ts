///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** `<input>` types that take no typed text, so a letter pressed on one is a shortcut, not input. (Radios and ranges use the arrows.) */
const NON_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "submit", "reset", "image", "file", "color"]);

/** Roles whose members have keys of their own (arrows, Enter, Escape, type-ahead): a bare key pressed inside one belongs to the widget. */
const WIDGET_SELECTOR = [
    "menu",
    "menubar",
    "listbox",
    "tablist",
    "tree",
    "grid",
    "radiogroup",
    "slider",
    "spinbutton",
    "combobox",
]
    .map((role) => `[role="${role}"]`)
    .join(",");

/** Elements Enter (and Space) already does something on. */
const ACTIVATABLE_SELECTOR = 'a[href], button, summary, [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"]';

/** An open popup's trigger: Escape closes the popup, so it is not a shortcut then. */
const OPEN_POPUP_TRIGGER = '[aria-haspopup][aria-expanded="true"], [role="combobox"][aria-expanded="true"]';

function elementOf(target: EventTarget | null): Element | null {
    return target instanceof Element ? target : null;
}

/** Whether the event target takes typed text: a text field, a select, a textarea, or anything contenteditable (the rich-text editor). */
export function isTextEntry(target: EventTarget | null): boolean {
    const element = elementOf(target);
    if (!element) {
        return false;
    }
    const tag = element.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") {
        return true;
    }
    if (tag === "INPUT") {
        return !NON_TEXT_INPUT_TYPES.has((element as HTMLInputElement).type);
    }
    return !!element.closest('[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"]');
}

/** Whether the target is inside a widget that reads bare keys itself (an open menu, a listbox, a tab list, ...). */
export function isInWidget(target: EventTarget | null): boolean {
    return !!elementOf(target)?.closest(WIDGET_SELECTOR);
}

/** Whether Enter/Space on the target already activates it (a button, a link, a menu item). */
export function isActivatable(target: EventTarget | null): boolean {
    return !!elementOf(target)?.closest(ACTIVATABLE_SELECTOR);
}

/** Whether the target is the trigger of a popup that is open right now (or the combobox that owns an open list). */
export function isPopupOpenAt(target: EventTarget | null): boolean {
    return !!elementOf(target)?.closest(OPEN_POPUP_TRIGGER);
}

/** Whether a modal dialog (`aria-modal="true"`: react-shared's `Modal` and `Drawer`, the unlock prompts, ...) is on screen. */
export function isModalOpen(doc: Document): boolean {
    return doc.querySelector('[aria-modal="true"]') !== null;
}

/** Whether the target is inside a popover that is a dialog of its own (the emoji and GIF pickers, the send-later picker): Escape is theirs, not a view's. A region that declares a shortcut scope (a compose window) is not one. */
export function isInPopoverDialog(target: EventTarget | null): boolean {
    return !!elementOf(target)?.closest('[role="dialog"]:not([data-shortcut-scope])');
}

/** The `data-shortcut-scope` of the region the target is in (a compose window), if any. */
export function regionScopeOf(target: EventTarget | null): string | undefined {
    return elementOf(target)?.closest("[data-shortcut-scope]")?.getAttribute("data-shortcut-scope") ?? undefined;
}
