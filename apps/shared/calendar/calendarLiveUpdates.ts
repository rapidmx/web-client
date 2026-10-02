///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Pure helper behind the calendar page's live updates: which push events say "an event changed". */

import type { PushEvent } from "../../../lib/mail/pushClient.js";

/** The published model name of a calendar event on either database (`CalendarEventMongo`, `CalendarEventSQL`) - and not the reminder's `"CalendarEvent"`,
 * which has its own action. */
const EVENT_MODEL = /^CalendarEvent(Mongo|SQL)$/;

/**
 * The event a push event says was created, changed or deleted - its uid, and whether it is gone - or `undefined` for anything else the shared push connection
 * delivers.
 *
 * The payload is never stored as the event: when somebody creates or changes a private or confidential event, restapi publishes it on the calendar's channel
 * once, for every subscriber, and that one payload has to be safe for a read-only reader of a shared calendar, so it is the busy block (`redacted: true`,
 * title "Busy", no details). Whoever may see the event in full fetches it again by its uid, which answers with as much as they may see - so every created or
 * changed event is handled that way, an ordinary one (an invitation arriving, an edit on another device) included.
 */
export function changedEventOf(event: PushEvent): { uid: string; deleted: boolean } | undefined {
    if (!EVENT_MODEL.test(event.type) || (event.action !== "create" && event.action !== "update" && event.action !== "delete")) {
        return undefined;
    }
    const data = event.data as { uid?: unknown } | null | undefined;
    return typeof data?.uid === "string" ? { uid: data.uid, deleted: event.action === "delete" } : undefined;
}
