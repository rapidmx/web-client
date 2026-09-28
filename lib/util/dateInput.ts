///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Shared by every form with a `<input type="datetime-local">` bound to a server-side ISO instant
 * (originally `EventModal.tsx`'s own private helper, split out once the Settings Auto-Reply page needed
 * the identical conversion — same "extract once a second consumer needs it" precedent as `apiQuery.ts`). */

/** `<input type="datetime-local">` reads/writes local time with no timezone suffix — `new Date(str)`
 * parses that as the browser's own local time, matching what the picker visually showed the user. */
export function toDatetimeLocal(iso: string): string {
    const d = new Date(iso);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
}
