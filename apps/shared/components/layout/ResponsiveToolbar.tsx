///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { KeyboardEvent, ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IconType } from "react-icons";
import { HiOutlineEllipsisHorizontal } from "react-icons/hi2";

/** One button of a `ResponsiveToolbar`. */
export interface ToolbarAction {
    id: string;
    /** The visible caption while there is room, else the tooltip and the accessible name. */
    label: string;
    icon: IconType;
    onClick: () => void;
    disabled?: boolean;
    /** A toggle: the button's pressed state. */
    pressed?: boolean;
    /** `title` and `aria-keyshortcuts` for a button with a shortcut - kept as given, whatever the layout. */
    hint?: { title: string; "aria-keyshortcuts"?: string };
    /** Actions with the same `group` sit together; a divider goes between groups. */
    group: number;
    /** Which goes into the "More" menu first when there is not room: the lowest number first. Never used for `essential`. */
    rank: number;
    /** Never moves into the "More" menu (the primary action). */
    essential?: boolean;
}

/** Room (px) each kind of button takes, and what the bar spends on its padding, a divider and the "More" button - the layout is computed from them
 * rather than measured, so the first paint on the client is already right and nothing jumps. */
export const LABELLED_BUTTON_WIDTH = 64;
export const ICON_BUTTON_WIDTH = 36;
const BAR_PADDING = 16;
const DIVIDER_WIDTH = 9;

export interface ToolbarLayout {
    /** Captions under the icons. */
    labels: boolean;
    /** The ids of the actions shown as buttons, in order. The rest are in the "More" menu. */
    visible: string[];
}

function widthOf(actions: ToolbarAction[], perButton: number, more: boolean): number {
    const groups = new Set(actions.map((action) => action.group)).size;
    return BAR_PADDING + actions.length * perButton + Math.max(0, groups - 1) * DIVIDER_WIDTH + (more ? perButton : 0);
}

/**
 * Which buttons a bar of `width` px shows, and how: every one with its caption when that fits; else every one as an icon (the captions go first);
 * else as many icons as fit, the least important (`rank`) going into a "More" menu one at a time - the essential ones stay whatever the width.
 * Pure, so it is the same on the server and the client for a given width; `width === undefined` (not measured yet, no ResizeObserver) shows
 * everything.
 */
export function layoutToolbar(actions: ToolbarAction[], width: number | undefined): ToolbarLayout {
    const ordered = [...actions].sort((a, b) => a.group - b.group);
    const all = ordered.map((action) => action.id);
    if (width === undefined) {
        return { labels: true, visible: all };
    }
    if (widthOf(ordered, LABELLED_BUTTON_WIDTH, false) <= width) {
        return { labels: true, visible: all };
    }
    if (widthOf(ordered, ICON_BUTTON_WIDTH, false) <= width) {
        return { labels: false, visible: all };
    }
    // Not everything fits: the least important actions go into "More" one at a time, until what is left and the "More" button do.
    let shown = ordered;
    for (const dropped of ordered.filter((action) => !action.essential).sort((x, y) => x.rank - y.rank)) {
        if (widthOf(shown, ICON_BUTTON_WIDTH, true) <= width) {
            break;
        }
        shown = shown.filter((action) => action !== dropped);
    }
    return { labels: false, visible: shown.map((action) => action.id) };
}

/** The width of `ref`'s element, kept current with a ResizeObserver; `undefined` until measured (and where there is no ResizeObserver). */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number | undefined {
    const [width, setWidth] = useState<number | undefined>(undefined);
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element || typeof ResizeObserver === "undefined") {
            return;
        }
        setWidth(element.getBoundingClientRect().width);
        const observer = new ResizeObserver((entries) => {
            const box = entries[0]?.contentRect.width;
            if (box !== undefined) {
                setWidth(Math.round(box));
            }
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref]);
    return width;
}

function ToolbarButton({ action, labels }: { action: ToolbarAction; labels: boolean }) {
    const Icon = action.icon;
    return (
        <button
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            aria-pressed={action.pressed}
            // A tooltip when the caption is not on show (the shortcut's own title, when it has one, wins).
            title={action.hint?.title ?? (labels ? undefined : action.label)}
            aria-keyshortcuts={action.hint?.["aria-keyshortcuts"]}
            data-toolbar-item=""
            className={[
                "flex shrink-0 flex-col items-center justify-center gap-1 rounded-sm text-xs disabled:opacity-40 disabled:cursor-not-allowed",
                labels ? "w-16 py-1.5" : "h-9 w-9",
                action.pressed ? "bg-primary/10 text-primary-dark" : "text-text-muted hover:not-disabled:bg-surface-alt hover:not-disabled:text-text",
            ].join(" ")}
        >
            <Icon size={18} aria-hidden="true" />
            <span className={labels ? "leading-tight text-center" : "sr-only"}>{action.label}</span>
        </button>
    );
}

/** The menu that holds what does not fit: a button, and a portalled `role="menu"` so nothing clips it. Arrow keys, Home, End and Escape; focus returns to the button. */
function MoreMenu({ actions }: { actions: ToolbarAction[] }) {
    const [open, setOpen] = useState(false);
    const [anchor, setAnchor] = useState<{ right: number; top: number } | null>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        if (!open) {
            setAnchor(null);
            return;
        }
        function place() {
            const rect = buttonRef.current!.getBoundingClientRect();
            setAnchor({ right: Math.max(8, window.innerWidth - rect.right), top: rect.bottom + 4 });
        }
        place();
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
        return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
        };
    }, [open]);

    // On open, the first item that can be used gets the focus.
    useEffect(() => {
        if (open && anchor) {
            menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
        }
    }, [open, anchor !== null]);

    useEffect(() => {
        if (!open) {
            return;
        }
        function handlePointerDown(event: MouseEvent) {
            if (event.target instanceof Node && !buttonRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) {
                setOpen(false);
            }
        }
        document.addEventListener("mousedown", handlePointerDown);
        return () => document.removeEventListener("mousedown", handlePointerDown);
    }, [open]);

    function close(refocus: boolean) {
        setOpen(false);
        if (refocus) {
            buttonRef.current?.focus();
        }
    }

    function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        const items = Array.from(menuRef.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
        const index = items.indexOf(document.activeElement as HTMLElement);
        const focusAt = (next: number) => {
            event.preventDefault();
            items[(next + items.length) % items.length]?.focus();
        };
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close(true);
        } else if (event.key === "ArrowDown") {
            focusAt(index + 1);
        } else if (event.key === "ArrowUp") {
            focusAt(index - 1);
        } else if (event.key === "Home") {
            focusAt(0);
        } else if (event.key === "End") {
            focusAt(items.length - 1);
        } else if (event.key === "Tab") {
            close(false);
        }
    }

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="More actions"
                title="More actions"
                data-toolbar-item=""
                onClick={() => setOpen((current) => !current)}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && !open) {
                        event.preventDefault();
                        setOpen(true);
                    }
                }}
                className={[
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text",
                    open ? "bg-surface-alt text-text" : "",
                ].join(" ")}
            >
                <HiOutlineEllipsisHorizontal size={18} aria-hidden="true" />
            </button>
            {open &&
                anchor &&
                createPortal(
                    <div
                        ref={menuRef}
                        role="menu"
                        aria-label="More actions"
                        onKeyDown={handleMenuKeyDown}
                        style={{ position: "fixed", right: anchor.right, top: anchor.top }}
                        className="z-[70] w-52 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-surface py-1.5 shadow-modal"
                    >
                        {actions.map((action) => {
                            const Icon = action.icon;
                            return (
                                <button
                                    key={action.id}
                                    type="button"
                                    role="menuitem"
                                    disabled={action.disabled}
                                    title={action.hint?.title}
                                    aria-keyshortcuts={action.hint?.["aria-keyshortcuts"]}
                                    onClick={() => {
                                        close(true);
                                        action.onClick();
                                    }}
                                    className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-sm text-text hover:not-disabled:bg-surface-alt focus-visible:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                    <Icon size={18} aria-hidden="true" className="shrink-0 text-text-muted" />
                                    {action.label}
                                </button>
                            );
                        })}
                    </div>,
                    document.body,
                )}
        </>
    );
}

/**
 * A toolbar that fits the column it is in - never wider, never over another pane. It measures its own width (`ResizeObserver`) and shows every
 * action with a caption when there is room; when there is not, the captions go first (each button keeps its tooltip and accessible name), then the
 * least important actions move into a "More" menu (`layoutToolbar()`). Arrow keys, Home and End move between the buttons; the menu is a real
 * `role="menu"`. `children` (a hidden file input, say) are rendered inside the toolbar's element but take no room.
 */
export default function ResponsiveToolbar({ label, actions, leading, children }: { label: string; actions: ToolbarAction[]; leading?: ReactNode; children?: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    const width = useElementWidth(ref);
    const layout = layoutToolbar(actions, width);
    const ordered = [...actions].sort((a, b) => a.group - b.group);
    const shown = ordered.filter((action) => layout.visible.includes(action.id));
    const hidden = ordered.filter((action) => !layout.visible.includes(action.id));

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || (event.target as HTMLElement).closest('[role="menu"]')) {
            return;
        }
        const items = Array.from(ref.current!.querySelectorAll<HTMLElement>("[data-toolbar-item]:not(:disabled)"));
        const index = items.indexOf(event.target as HTMLElement);
        if (index === -1) {
            return;
        }
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : index + (event.key === "ArrowRight" ? 1 : -1);
        items[(next + items.length) % items.length].focus();
    }

    return (
        <div
            ref={ref}
            role="toolbar"
            aria-label={label}
            onKeyDown={handleKeyDown}
            // `overflow-x-clip` is the guarantee: whatever the layout says, the bar can never paint outside its own column.
            className="flex min-w-0 items-stretch gap-0.5 overflow-x-clip border-b border-border bg-surface-alt px-2 py-1"
        >
            {leading}
            {shown.map((action, index) => (
                <React.Fragment key={action.id}>
                    {index > 0 && shown[index - 1].group !== action.group && <div className="my-1 w-px shrink-0 self-stretch bg-border" aria-hidden="true" />}
                    <ToolbarButton action={action} labels={layout.labels} />
                </React.Fragment>
            ))}
            {hidden.length > 0 && (
                <>
                    <div className="my-1 w-px shrink-0 self-stretch bg-border" aria-hidden="true" />
                    <MoreMenu actions={hidden} />
                </>
            )}
            {children}
        </div>
    );
}
