///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";

/** The current time in epoch ms, re-read every `intervalMs` while `enabled` - for "3 min ago" texts and countdowns that keep themselves right. */
export function useNow(intervalMs: number, enabled = true): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!enabled) {
            return;
        }
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs, enabled]);
    return now;
}
