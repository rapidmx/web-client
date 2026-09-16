///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useEffect, useRef, useState } from "react";
import { HiCheck, HiChevronDown } from "react-icons/hi2";
import PopoverPortal from "@rapidmx/react-shared/components/overlays/PopoverPortal.js";

/** One row of a menu. `checked` turns it into a radio/checkbox item (the caller says which via `role`) and
 * draws the checkmark column; without it the row is a plain command. */
export interface MenuItemSpec {
    key: string;
    label: string;
    /** A one-line explanation under the label, for an item whose effect isn't obvious from its name. */
    description?: string;
    role?: "menuitem" | "menuitemradio" | "menuitemcheckbox";
    checked?: boolean;
    disabled?: boolean;
    onSelect: () => void;
}

/** A labelled group of items. Groups after the first are drawn with a separator above them. */
export interface MenuSectionSpec {
    key: string;
    label?: string;
    /** A short note under the group's items - e.g. why some of them are unavailable right now. */
    note?: string;
    items: MenuItemSpec[];
}

// `PopoverPortal` positions a fixed-size box (it has no auto-height mode), so the menu's height is
// computed from its own contents rather than measured. These are the exact heights the classes below
// render at, so the box is never short enough to clip its last row: an item is `h-9`, a group label
// `h-6`, a note two `leading-4` lines, a separator a 1px rule inside `my-1`, and the list itself `py-1`.
const ITEM_HEIGHT = 36;
const ITEM_DESCRIPTION_HEIGHT = 16;
const GROUP_LABEL_HEIGHT = 24;
const NOTE_HEIGHT = 36;
const SEPARATOR_HEIGHT = 9;
const LIST_PADDING = 8;
const MENU_MAX_HEIGHT = 460;

/** The height `PopoverPortal` is asked for - exact for a short menu, capped (the list scrolls) for a long one. */
export function menuHeight(sections: MenuSectionSpec[]): number {
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
            height += NOTE_HEIGHT;
        }
    });
    return Math.min(height, MENU_MAX_HEIGHT);
}

export interface MenuButtonProps {
    /** The trigger's visible label. */
    label: ReactNode;
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
    icon,
    disabled,
    title,
    sections,
    width = 248,
    className = "",
    "aria-label": ariaLabel,
}: MenuButtonProps) {
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(0);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
    // State, not a ref: `PopoverPortal` renders nothing at all until its own positioning effect has run, so
    // the rows don't exist yet when this component's effects first fire. Keying the focus effect on the
    // menu node itself makes it run again once they do.
    const [menuNode, setMenuNode] = useState<HTMLDivElement | null>(null);

    const items = sections.flatMap((section) => section.items);
    const enabledIndexes = items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index !== -1);

    function openMenu() {
        const checked = items.findIndex((item) => item.checked && !item.disabled);
        setActiveIndex(checked === -1 ? (enabledIndexes[0] ?? 0) : checked);
        setOpen(true);
    }

    function closeMenu(returnFocus: boolean) {
        setOpen(false);
        if (returnFocus) {
            triggerRef.current?.focus();
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
    }, [open, activeIndex, menuNode]);

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
                className={[
                    // `min-w-0` so a long label ("Filter: Has attachments") truncates instead of pushing
                    // whatever sits beside it in the toolbar off the edge of a 384px list column.
                    "inline-flex min-w-0 items-center gap-1 px-2 py-1 rounded-md text-sm text-text hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent",
                    className,
                ].join(" ")}
            >
                {icon}
                <span className="truncate">{label}</span>
                <HiChevronDown size={14} aria-hidden="true" className="shrink-0 text-text-muted" />
            </button>
            {open && (
                <PopoverPortal
                    anchorRef={triggerRef}
                    onClose={() => closeMenu(false)}
                    width={width}
                    height={menuHeight(sections)}
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
                        {sections.map((section, sectionIndex) => (
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
                                            tabIndex={index === activeIndex ? 0 : -1}
                                            {...(role === "menuitem" ? {} : { "aria-checked": !!item.checked })}
                                            onClick={() => {
                                                item.onSelect();
                                                closeMenu(true);
                                            }}
                                            className="w-full flex items-start gap-2 px-3 py-2 text-left text-sm text-text hover:bg-surface-alt disabled:opacity-50 disabled:hover:bg-transparent"
                                        >
                                            <span className="w-4 shrink-0 flex justify-center pt-0.5">
                                                {item.checked && <HiCheck size={14} aria-hidden="true" className="text-primary-dark" />}
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block h-5 truncate">{item.label}</span>
                                                {item.description && (
                                                    <span className="block h-4 text-xs leading-4 text-text-muted truncate font-normal">
                                                        {item.description}
                                                    </span>
                                                )}
                                            </span>
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
