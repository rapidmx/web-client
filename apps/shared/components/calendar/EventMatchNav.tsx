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
}

/**
 * The Previous / Next match buttons beside an event's card while a search is running: the card moves on to the neighbouring result. They sit
 * inside the dialog (so Tab reaches them and the dialog's focus trap holds) but are positioned against the window - either side of the
 * centered card on a desktop, the bottom corners on a phone, where the card fills the width. The left and right arrow keys do the same unless
 * a field is taking them.
 */
export default function EventMatchNav({ onPrevious, onNext }: EventMatchNavProps) {
    useEffect(() => {
        function handleKeyDown(event: KeyboardEvent) {
            if ((event.key !== "ArrowLeft" && event.key !== "ArrowRight") || event.defaultPrevented || isTextEntry(event.target)) {
                return;
            }
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                return;
            }
            event.preventDefault();
            (event.key === "ArrowLeft" ? onPrevious : onNext)();
        }
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onPrevious, onNext]);

    // The card is centered, at most 480px wide (`DETAILS_WIDTH`): 240px either side of the middle, then a gap and the button itself.
    const buttonClass =
        "fixed bottom-4 md:bottom-auto md:top-1/2 md:-translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full bg-surface border border-border shadow-modal text-text-muted hover:bg-surface-alt hover:text-text";
    return (
        <>
            <button
                type="button"
                aria-label="Previous match"
                title="Previous match (Left arrow)"
                onClick={onPrevious}
                className={`${buttonClass} left-4 md:left-[calc(50vw-296px)]`}
            >
                <HiOutlineChevronLeft size={20} aria-hidden="true" />
            </button>
            <button
                type="button"
                aria-label="Next match"
                title="Next match (Right arrow)"
                onClick={onNext}
                className={`${buttonClass} right-4 md:right-[calc(50vw-296px)]`}
            >
                <HiOutlineChevronRight size={20} aria-hidden="true" />
            </button>
        </>
    );
}
