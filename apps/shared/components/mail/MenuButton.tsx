///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useEffect, useRef, useState } from "react";
import { HiCheck, HiChevronDown, HiChevronLeft, HiChevronRight, HiMinus } from "react-icons/hi2";
import PopoverPortal from "@rapidmx/react-shared/components/overlays/PopoverPortal.js";

/** What every row has. `checked` turns it into a radio/checkbox item (the caller says which via `role`) and
 * draws the checkmark column; without it the row is a plain command. */
interface MenuItemBase {
    key: string;
    label: string;
    /** A one-line explanation under the label, for an item whose effect isn't obvious from its name. */
    description?: string;
    role?: "menuitem" | "menuitemradio" | "menuitemcheckbox";
    /** `"mixed"` is ARIA's third checkbox state - some of the things this row acts on have it and some
     * don't, which is what a label applied to only part of a multi-message selection looks like. */
    checked?: boolean | "mixed";
    /** A colour swatch before the label - a label's own colour. */
    swatchColor?: string;
    /** An icon before the label, for a menu whose rows are commands (the reading pane's "More actions"). */
    icon?: ReactNode;
    /** A tooltip for the row - the full text of a label the row truncates. */
    title?: string;
    disabled?: boolean;
    /** Leaves the menu open after choosing this row, for a multi-select list where several rows are ticked
     * before one command commits them all. */
    keepOpen?: boolean;
}

/** A row that does something when chosen. */
export interface MenuCommandSpec extends MenuItemBase {
    onSelect: () => void;
    submenu?: never;
}

/** A row that opens a submenu instead: choosing it replaces the menu's contents with these sections, under
 * a Back row. One level deep, which is all any menu here needs - so it has nothing of its own to do. */
export interface MenuSubmenuSpec extends MenuItemBase {
    submenu: MenuSectionSpec[];
    onSelect?: never;
}

export type MenuItemSpec = MenuCommandSpec | MenuSubmenuSpec;

/** A labelled group of items. Groups after the first are drawn with a separator above them. */
export interface MenuSectionSpec {
    key: string;
    label?: string;
    /** A short note under the group's items - e.g. why some of them are unavailable right now. */
    note?: string;
    items: MenuItemSpec[];
}

// `PopoverPortal` positions a fixed-size box (it has no auto-height mode), so the menu's height is
// computed from its own contents rather than measured - from whichever level is *shown*, so a submenu
// isn't left standing in the parent menu's taller box. These are the exact heights the classes below
// render at, so the box is never short enough to clip its last row: an item is `h-9`, a group label
// `h-6`, a note as many `leading-4` lines as it wraps to, a separator a 1px rule inside `my-1`, and the
// list itself `py-1`.
const ITEM_HEIGHT = 36;
const ITEM_DESCRIPTION_HEIGHT = 16;
const GROUP_LABEL_HEIGHT = 24;
const NOTE_LINE_HEIGHT = 16;
const NOTE_PADDING = 4;
/** A note wraps, so its height depends on how much of it fits a line: `text-xs` averages a little over 6px
 * a character, and the note sits inside the list's `px-3`. Rounded so the estimate is never *under* the
 * lines the browser actually draws - a box a few pixels too tall shows blank space, one too short clips. */
const NOTE_CHAR_WIDTH = 6.4;
const NOTE_PADDING_X = 24;
const SEPARATOR_HEIGHT = 9;
const LIST_PADDING = 8;
const MENU_MAX_HEIGHT = 460;
const DEFAULT_MENU_WIDTH = 248;

/** How tall `note` renders at `width`, wrapped. */
function noteHeight(note: string, width: number): number {
    const charsPerLine = Math.max(1, Math.floor((width - NOTE_PADDING_X) / NOTE_CHAR_WIDTH));
    return Math.ceil(note.length / charsPerLine) * NOTE_LINE_HEIGHT + NOTE_PADDING;
}

/** The height `PopoverPortal` is asked for - exact for a short menu, capped (the list scrolls) for a long one. */
export function menuHeight(sections: MenuSectionSpec[], width: number = DEFAULT_MENU_WIDTH): number {
    let height = LIST_PADDING;
    sections.forEach((section, index) => {
        if (index > 0) {
            height += SEPARATOR_HEIGHT;
        }
        if (section.label) {
            height += GROUP_LABEL_HEIGHT;
        }
        for (const item of section.items) {
            height += ITEM_HEIGHT + (item.description ? ITEM_DESCRIPTION_HEIGHT : 0);
        }
        if (section.note) {
            height += noteHeight(section.note, width);
        }
    });
    return Math.min(height, MENU_MAX_HEIGHT);
}

export interface MenuButtonProps {
    /** The trigger's visible label. Not drawn (nor is the chevron) with `iconOnly`, where `aria-label` is all the trigger says. */
    label: ReactNode;
    /** The trigger is just its `icon` - a round icon button like the reading pane's own command row, whose `className` it takes over
     * completely. `aria-label` (and `title`) name it. */
    iconOnly?: boolean;
    /** The trigger's accessible name, which also names the menu itself - includes the current selection
     * where there is one ("Filter: Unread"), so the button says what it's set to, not just what it does. */
    "aria-label": string;
    icon?: ReactNode;
    disabled?: boolean;
    title?: string;
    sections: MenuSectionSpec[];
    width?: number;
    /** Extra classes for the trigger, on top of the shared toolbar-button styling. */
    className?: string;
    /** Told whenever the menu opens or closes - how a caller resets a draft it keeps for the menu's own
     * multi-select rows (see `useLabelDraft()`). */
    onOpenChange?: (open: boolean) => void;
}

/**
 * A toolbar button that opens an ARIA menu: `role="menu"` rows with checkmarks for the current choice,
 * full keyboard support (Enter/Space or Arrow Down to open, arrows/Home/End to move with wrap, Enter/Space
 * to choose, Escape or Tab to close with focus returning to the trigger) and a click outside to dismiss.
 *
 * Rendered through `PopoverPortal` rather than as an absolutely-positioned child: the mail list toolbar
 * lives inside the list's own `overflow-y-auto` scroll container, which clips an absolute popup however
 * high its `z-index` - the same reason Compose's own pickers portal out (see `PopoverPortal`'s own doc
 * comment). The portal supplies the positioning, the outside-click dismissal and the box; the menu
 * semantics, roving focus and keyboard handling are this component's own.
 */
export default function MenuButton({
    label,
    iconOnly = false,
    icon,
    disabled,
    title,
    sections,
    width = DEFAULT_MENU_WIDTH,
    className = "",
    "aria-label": ariaLabel,
    onOpenChange,
}: MenuButtonProps) {
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    // The key of the item whose submenu is showing, or `null` at the top level. Held as a key, not as the
    // item itself, because `sections` is rebuilt on every render.
    const [submenuKey, setSubmenuKey] = useState<string | null>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
    // State, not a ref: `PopoverPortal` renders nothing at all until its own positioning effect has run, so
    // the rows don't exist yet when this component's effects first fire. Keying the focus effect on the
    // menu node itself makes it run again once they do.
    const [menuNode, setMenuNode] = useState<HTMLDivElement | null>(null);

    const openSubmenu = sections
        .flatMap((section) => section.items)
        .find((item): item is MenuSubmenuSpec => item.key === submenuKey && !!item.submenu);
    /** The row that leaves a submenu again - synthesized rather than asked of the caller, so every submenu
     * has the same way back however it was built. */
    const backItem: MenuCommandSpec = {
        key: "__back",
        label: `Back to ${ariaLabel}`,
        keepOpen: true,
        onSelect: () => leaveSubmenu(),
    };
    const shownSections: MenuSectionSpec[] = openSubmenu
        ? [{ key: "__back", items: [backItem] }, ...openSubmenu.submenu]
        : sections;
    const items = shownSections.flatMap((section) => section.items);
    const enabledIndexes = items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index !== -1);

    /** The row focus starts on: the current choice where there is one, else the first row that can take focus. */
    function initialActiveIndex(within: MenuItemSpec[]): number {
        const checked = within.findIndex((item) => item.checked === true && !item.disabled);
        const enabled = within.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index !== -1);
        return checked === -1 ? (enabled[0] ?? 0) : checked;
    }

    function openMenu() {
        setSubmenuKey(null);
        setActiveIndex(initialActiveIndex(sections.flatMap((section) => section.items)));
        setOpen(true);
        onOpenChange?.(true);
    }

    function closeMenu(returnFocus: boolean) {
        setOpen(false);
        setSubmenuKey(null);
        onOpenChange?.(false);
        if (returnFocus) {
            triggerRef.current?.focus();
        }
    }

    function enterSubmenu(item: MenuSubmenuSpec) {
        setSubmenuKey(item.key);
        const rows = item.submenu.flatMap((section) => section.items);
        // Past the Back row, onto the first row of the submenu itself - or, when none of them can take focus (every row is unavailable right now), onto
        // the Back row, so the keyboard still has a place to be.
        setActiveIndex(rows.some((row) => !row.disabled) ? 1 + initialActiveIndex(rows) : 0);
    }

    function leaveSubmenu() {
        // Back on the row the submenu was opened from.
        const parentIndex = sections.flatMap((section) => section.items).findIndex((item) => item.key === submenuKey);
        setSubmenuKey(null);
        setActiveIndex(parentIndex);
    }

    /** What a row does when it is chosen: open its submenu, or run it and close unless it asked to stay. */
    function selectItem(item: MenuItemSpec) {
        if (item.submenu) {
            enterSubmenu(item);
            return;
        }
        item.onSelect();
        if (!item.keepOpen) {
            closeMenu(true);
        }
    }

    // Roving focus: only the active row is tabbable, and it takes DOM focus whenever it changes, so the
    // arrow keys move the screen reader's cursor too rather than only a visual highlight.
    useEffect(() => {
        if (open && menuNode) {
            // A disabled row can't take focus, so a menu with nothing enabled focuses its own container -
            // otherwise the keys it handles would go to whatever had focus before it opened.
            if (enabledIndexes.length === 0) {
                menuNode.focus();
            } else {
                itemRefs.current[activeIndex]?.focus();
            }
        }
        // `submenuKey` too: drilling in or out can land on the same index in the other level's list, and
        // the row that index *means* is a different button, which the effect must move focus to.
    }, [open, activeIndex, submenuKey, menuNode]);

    function moveActive(delta: number) {
        if (enabledIndexes.length === 0) {
            return;
        }
        const position = enabledIndexes.indexOf(activeIndex);
        setActiveIndex(enabledIndexes[(position + delta + enabledIndexes.length) % enabledIndexes.length]);
    }

    function handleMenuKeyDown(e: React.KeyboardEvent) {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            moveActive(1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            moveActive(-1);
        } else if (e.key === "Home") {
            e.preventDefault();
            setActiveIndex(enabledIndexes[0] ?? 0);
        } else if (e.key === "End") {
            e.preventDefault();
            setActiveIndex(enabledIndexes[enabledIndexes.length - 1] ?? 0);
        } else if (e.key === "ArrowRight" && items[activeIndex]?.submenu) {
            e.preventDefault();
            enterSubmenu(items[activeIndex]);
        } else if ((e.key === "ArrowLeft" || e.key === "Escape") && openSubmenu) {
            // ARIA's own submenu behaviour: Escape leaves the submenu for its parent menu rather than
            // dismissing the whole thing.
            e.preventDefault();
            leaveSubmenu();
        } else if (e.key === "Escape" || e.key === "Tab") {
            e.preventDefault();
            closeMenu(true);
        }
    }

    function handleTriggerKeyDown(e: React.KeyboardEvent) {
        if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openMenu();
        }
    }

    let itemIndex = -1;

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={ariaLabel}
                title={title}
                disabled={disabled}
                onClick={() => (open ? closeMenu(false) : openMenu())}
                onKeyDown={handleTriggerKeyDown}
                className={
                    iconOnly
                        ? className
                        : [
                              // `min-w-0` so a long label ("Filter: Has attachments") truncates instead of pushing
                              // whatever sits beside it in the toolbar off the edge of a 384px list column.
                              "inline-flex min-w-0 items-center gap-1 px-2 py-1 rounded-md text-sm text-text hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent",
                              className,
                          ].join(" ")
                }
            >
                {icon}
                {!iconOnly && <span className="truncate">{label}</span>}
                {!iconOnly && <HiChevronDown size={14} aria-hidden="true" className="shrink-0 text-text-muted" />}
            </button>
            {open && (
                <PopoverPortal
                    anchorRef={triggerRef}
                    onClose={() => closeMenu(false)}
                    width={width}
                    height={menuHeight(shownSections, width)}
                    aria-label={ariaLabel}
                >
                    <div
                        ref={setMenuNode}
                        role="menu"
                        tabIndex={-1}
                        aria-label={ariaLabel}
                        onKeyDown={handleMenuKeyDown}
                        className="flex-1 overflow-y-auto py-1"
                    >
                        {shownSections.map((section, sectionIndex) => (
                            <div key={section.key} role="group" aria-label={section.label} className={sectionIndex > 0 ? "border-t border-border mt-1 pt-1" : ""}>
                                {section.label && (
                                    <div aria-hidden="true" className="h-6 flex items-center px-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                                        {section.label}
                                    </div>
                                )}
                                {section.items.map((item) => {
                                    itemIndex += 1;
                                    const index = itemIndex;
                                    const role = item.role ?? "menuitem";
                                    return (
                                        <button
                                            key={item.key}
                                            ref={(node) => {
                                                itemRefs.current[index] = node;
                                            }}
                                            type="button"
                                            role={role}
                                            disabled={item.disabled}
                                            title={item.title}
                                            tabIndex={index === activeIndex ? 0 : -1}
                                            {...(role === "menuitem"
                                                ? {}
                                                : { "aria-checked": item.checked === "mixed" ? ("mixed" as const) : !!item.checked })}
                                            {...(item.submenu ? { "aria-haspopup": "menu" as const, "aria-expanded": false } : {})}
                                            onClick={() => selectItem(item)}
                                            className="w-full flex items-start gap-2 px-3 py-2 text-left text-sm text-text hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent"
                                        >
                                            <span className="w-4 shrink-0 flex justify-center pt-0.5">
                                                {item.key === "__back" && (
                                                    <HiChevronLeft size={14} aria-hidden="true" className="text-text-muted" />
                                                )}
                                                {item.checked === "mixed" ? (
                                                    <HiMinus size={14} aria-hidden="true" className="text-primary-dark" />
                                                ) : (
                                                    item.checked && <HiCheck size={14} aria-hidden="true" className="text-primary-dark" />
                                                )}
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="flex h-5 items-center gap-1.5">
                                                    {item.icon && (
                                                        <span aria-hidden="true" className="shrink-0 text-text-muted">
                                                            {item.icon}
                                                        </span>
                                                    )}
                                                    {item.swatchColor && (
                                                        <span
                                                            aria-hidden="true"
                                                            className="w-2.5 h-2.5 rounded-full shrink-0"
                                                            style={{ backgroundColor: item.swatchColor }}
                                                        />
                                                    )}
                                                    <span className="truncate">{item.label}</span>
                                                </span>
                                                {item.description && (
                                                    <span className="block h-4 text-xs leading-4 text-text-muted truncate font-normal">
                                                        {item.description}
                                                    </span>
                                                )}
                                            </span>
                                            {item.submenu && (
                                                <HiChevronRight size={14} aria-hidden="true" className="shrink-0 mt-0.5 text-text-muted" />
                                            )}
                                        </button>
                                    );
                                })}
                                {section.note && <p className="px-3 py-1 text-xs leading-4 text-text-muted">{section.note}</p>}
                            </div>
                        ))}
                    </div>
                </PopoverPortal>
            )}
        </>
    );
}
