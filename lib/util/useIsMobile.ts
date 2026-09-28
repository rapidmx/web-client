///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useState } from "react";

/** Matches this app's Tailwind `md` breakpoint, the cutoff used throughout for mobile vs. desktop layout. */
const DEFAULT_BREAKPOINT_PX = 768;

/**
 * `true` below `breakpointPx` (default 768, i.e. Tailwind's `md`). Always `false` during SSR and the
 * initial client render — corrected in an effect after mount, the same "read real client state once
 * mounted" convention already used by `MailShell`'s query-param reads — so server-rendered markup and
 * the first hydrated frame always agree (no hydration-mismatch warning), at the cost of a one-frame
 * desktop-layout flash for mobile visitors on first load. Prefer plain Tailwind `md:` classes for pure
 * layout/visibility; reach for this hook only when a component needs to make an actual JS-level
 * decision (e.g. real navigation vs. local state).
 */
export default function useIsMobile(breakpointPx: number = DEFAULT_BREAKPOINT_PX): boolean {
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const mql = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
        setIsMobile(mql.matches);

        function handleChange(e: MediaQueryListEvent) {
            setIsMobile(e.matches);
        }
        mql.addEventListener("change", handleChange);
        return () => mql.removeEventListener("change", handleChange);
    }, [breakpointPx]);

    return isMobile;
}
