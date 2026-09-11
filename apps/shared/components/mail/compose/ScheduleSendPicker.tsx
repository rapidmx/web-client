///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, RefObject, useState } from "react";
import PopoverPortal from "./PopoverPortal.js";

export interface ScheduleSendPickerProps {
    anchorRef: RefObject<HTMLElement | null>;
    onClose: () => void;
    /** Called with the chosen instant as a UTC ISO string, already validated to be in the future. */
    onSchedule: (scheduledSendTimeIso: string) => void;
}

/**
 * The "Send later" popover next to Compose's Send button — same `PopoverPortal` shell
 * `EmojiPicker`/`GifPicker`/`ResourcePicker` already use, just holding a single `datetime-local` input
 * instead of a grid/list. Validates the chosen time is genuinely in the future before calling
 * `onSchedule` — `@rapidmx/restapi`'s own `send()` only defers when `scheduledSendTime` is strictly
 * later than "now", so a past/immediate pick here would silently send right away instead of scheduling,
 * which would surprise a reader expecting the picker's own choice to be honored.
 */
export default function ScheduleSendPicker({ anchorRef, onClose, onSchedule }: ScheduleSendPickerProps) {
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);

    function handleSubmit(e: FormEvent) {
        e.preventDefault();
        if (!value) {
            setError("Pick a date and time.");
            return;
        }
        const iso = new Date(value).toISOString();
        if (new Date(iso).getTime() <= Date.now()) {
            setError("Pick a time in the future.");
            return;
        }
        onSchedule(iso);
    }

    return (
        <PopoverPortal anchorRef={anchorRef} onClose={onClose} width={260} height={150} aria-label="Schedule send">
            <form onSubmit={handleSubmit} className="p-3 flex flex-col gap-2">
                <label className="text-xs font-semibold" htmlFor="schedule-send-time">
                    Send at
                </label>
                <input
                    id="schedule-send-time"
                    type="datetime-local"
                    className="text-sm py-1.5 px-2 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                />
                {error && <p className="text-xs text-danger">{error}</p>}
                <button
                    type="submit"
                    className="text-sm font-semibold py-1.5 px-3 rounded-pill bg-primary text-white hover:bg-primary-dark"
                >
                    Send later
                </button>
            </form>
        </PopoverPortal>
    );
}
