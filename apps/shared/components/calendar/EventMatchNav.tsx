///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect } from "react";
import { HiOutlineChevronLeft, HiOutlineChevronRight } from "react-icons/hi2";
import { isTextEntry } from "../../keyboard/targets.js";

export interface EventMatchNavProps {
    onPrevious: () => void;
    onNext: () => void;
    /** Whether there is an event before / after this one to go to (default: yes). A button with none is disabled, and its arrow key does nothing. */
    canPrevious?: boolean;
    canNext?: boolean;
    /** What is stepped through, for the buttons' names: the matches of a search, or the events of the calendar. */
    noun?: "match" | "event";
}

/** Widgets that take the arrow keys themselves (a menu's items, a radio group, a slider, a list's options, a tab list, ...) and an open popup's trigger. */
const ARROW_WIDGET_SELECTOR = [
    ...["menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "radiogroup", "radio", "listbox", "option"].map((role) => `[role="${role}"]`),
    ...["slider", "spinbutton", "tablist", "tab", "tree", "grid", "combobox"].map((role) => `[role="${role}"]`),
    '[aria-haspopup][aria-expanded="true"]',
].join(",");

/** Whether the arrow keys pressed at `target` belong to what is there: a field or select, or a widget with arrows of its own. */
function takesArrowKeys(target: EventTarget | null): boolean {
    return isTextEntry(target) || (target instanceof Element && target.closest(ARROW_WIDGET_SELECTOR) !== null);
}

/**
 * The Previous / Next match buttons beside an event's card while a search is running: the card moves on to the neighbouring result. They sit
 * inside the dialog (so Tab reaches them and the dialog's focus trap holds) but are positioned against the window - either side of the
 * centered card on a desktop, the bottom corners on a phone, where the card fills the width. The left and right arrow keys do the same unless
 * a field or a widget (a select, a menu, a slider, ...) is taking them.
 */
export default function EventMatchNav({ onPrevious, onNext, canPrevious = true, canNext = true, noun = "match" }: EventMatchNavProps) {
    useEffect(() => {
        function handleKeyDown(event: KeyboardEvent) {
            if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || event.defaultPrevented || takesArrowKeys(event.target)) {
                return;
            }
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
            }
            event.preventDefault();
            if (event.key === "ArrowLeft" ? canPrevious : canNext) {
                (event.key === "ArrowLeft" ? onPrevious : onNext)();
            }
        }
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onPrevious, onNext, canPrevious, canNext]);

    // The card is centered, at most 480px wide (`DETAILS_WIDTH`): 240px either side of the middle, then a gap and the button itself.
    const buttonClass =
        "fixed bottom-4 md:bottom-auto md:top-1/2 md:-translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full bg-surface border border-border shadow-modal text-text-muted";
    const enabledClass = "hover:bg-surface-alt hover:text-text";
    const disabledClass = "opacity-40 cursor-not-allowed";
    return (
        <>
            <button
                type="button"
                aria-label={`Previous ${noun}`}
                aria-disabled={canPrevious ? undefined : true}
                title={`Previous ${noun} (Left arrow)`}
                onClick={canPrevious ? onPrevious : undefined}
                className={`${buttonClass} ${canPrevious ? enabledClass : disabledClass} left-4 md:left-[calc(50vw-296px)]`}
            >
                <HiOutlineChevronLeft size={20} aria-hidden="true" />
            </button>
            <button
                type="button"
                aria-label={`Next ${noun}`}
                aria-disabled={canNext ? undefined : true}
                title={`Next ${noun} (Right arrow)`}
                onClick={canNext ? onNext : undefined}
                className={`${buttonClass} ${canNext ? enabledClass : disabledClass} right-4 md:right-[calc(50vw-296px)]`}
            >
                <HiOutlineChevronRight size={20} aria-hidden="true" />
            </button>
        </>
    );
}
