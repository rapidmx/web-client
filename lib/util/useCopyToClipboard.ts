///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "./clipboard.js";

/** `"copied"`/`"failed"` are transient - they fall back to `"idle"` after the hook's reset delay. */
export type CopyStatus = "idle" | "copied" | "failed";

/** How long "Copied" stays up by default. */
export const COPY_FEEDBACK_MS = 2000;

/**
 * Copy-to-clipboard with brief feedback state: `copy(text)` (see `copyTextToClipboard()`) sets `status` to
 * `"copied"` or `"failed"` and back to `"idle"` after `resetMs`. Safe to unmount mid-copy or mid-feedback.
 */
export default function useCopyToClipboard(resetMs: number = COPY_FEEDBACK_MS): {
    status: CopyStatus;
    copy: (text: string) => Promise<boolean>;
} {
    const [status, setStatus] = useState<CopyStatus>("idle");
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            clearTimeout(timer.current);
        };
    }, []);

    const copy = useCallback(
        async (text: string) => {
            const copied = await copyTextToClipboard(text);
            if (mounted.current) {
                setStatus(copied ? "copied" : "failed");
                clearTimeout(timer.current);
                timer.current = setTimeout(() => setStatus("idle"), resetMs);
            }
            return copied;
        },
        [resetMs],
    );

    return { status, copy };
}
