///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";
import useCopyToClipboard from "../../util/useCopyToClipboard.js";
import Button from "./Button.js";

export interface CopyButtonProps {
    /** The text put on the clipboard. */
    value: string;
    /** The button's accessible name - say what is copied, e.g. "Copy value for the SPF record". */
    label: string;
    /** The visible caption. Defaults to "Copy". */
    children?: ReactNode;
    className?: string;
}

/**
 * A small "Copy" button for a value someone has to paste elsewhere (a DNS record, a code). Copies through
 * `copyTextToClipboard()` - the async Clipboard API, then a hidden-textarea `execCommand` fallback - and
 * announces the result next to the button in a polite live region ("Copied", or "Couldn't copy" when both
 * routes fail, in which case the value is still on screen to select by hand). The live region is always
 * rendered, empty until there is something to say, so screen readers pick the change up.
 */
export default function CopyButton({ value, label, children = "Copy", className }: CopyButtonProps) {
    const { status, copy } = useCopyToClipboard();

    return (
        <span className="inline-flex items-center gap-2 shrink-0">
            <Button
                type="button"
                variant="secondary"
                aria-label={label}
                className={["!w-auto !py-1 !px-2 text-xs", className].filter(Boolean).join(" ")}
                onClick={() => void copy(value)}
            >
                {children}
            </Button>
            <span role="status" aria-live="polite" className={status === "failed" ? "text-xs text-danger" : "text-xs text-success"}>
                {status === "copied" ? "Copied" : status === "failed" ? "Couldn’t copy" : ""}
            </span>
        </span>
    );
}
