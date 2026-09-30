///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiCheck, HiOutlineClipboardDocument } from "react-icons/hi2";
import useCopyToClipboard from "../../util/useCopyToClipboard.js";

export interface CopyIconButtonProps {
    /** The text put on the clipboard. */
    value: string;
    /** The button's accessible name and tooltip - say what is copied, e.g. "Copy address". */
    label: string;
    className?: string;
}

/**
 * A small icon-only "copy" button to sit right after a value (an email address). The icon turns into a check mark for a moment once the value is on
 * the clipboard, and a polite live region says "Copied" (or "Couldn't copy") for screen readers.
 */
export default function CopyIconButton({ value, label, className }: CopyIconButtonProps) {
    const { status, copy } = useCopyToClipboard();

    return (
        <span className="inline-flex items-center align-middle">
            <button
                type="button"
                aria-label={label}
                title={label}
                onClick={() => void copy(value)}
                className={[
                    "inline-flex items-center justify-center rounded-sm p-1 text-text-muted hover:text-text hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-primary",
                    className,
                ]
                    .filter(Boolean)
                    .join(" ")}
            >
                {status === "copied" ? (
                    <HiCheck aria-hidden="true" className="size-4 text-success" />
                ) : (
                    <HiOutlineClipboardDocument aria-hidden="true" className="size-4" />
                )}
            </button>
            <span role="status" aria-live="polite" className="sr-only">
                {status === "copied" ? "Copied" : status === "failed" ? "Couldn’t copy" : ""}
            </span>
        </span>
    );
}
