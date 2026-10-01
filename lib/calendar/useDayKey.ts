///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";
import { addDays, format, startOfDay } from "date-fns";

/** How long past local midnight the key is re-read, so a timer that fires a hair early does not land on the day that is ending. */
const MIDNIGHT_SLACK_MS = 1000;

/**
 * Today's local date as `YYYY-MM-DD`, kept current: it ticks over at the next local midnight, so a page left open overnight stops treating yesterday
 * as today (use it as a dependency of whatever was worked out from "now"). It is also re-read when the tab becomes visible again, as a hidden tab's timers
 * are throttled or suspended (a sleeping laptop).
 */
export function useDayKey(): string {
    const [dayKey, setDayKey] = useState(() => format(new Date(), "yyyy-MM-dd"));
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        // Re-reads the day and sets the timer for the midnight after it, replacing any that is pending.
        function arm() {
            clearTimeout(timer);
            const now = new Date();
            setDayKey(format(now, "yyyy-MM-dd"));
            timer = setTimeout(arm, addDays(startOfDay(now), 1).getTime() - now.getTime() + MIDNIGHT_SLACK_MS);
        }
        function onVisible() {
            if (document.visibilityState === "visible") {
                arm();
            }
        }
        arm();
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);
    return dayKey;
}
