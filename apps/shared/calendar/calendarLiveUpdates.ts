///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/** Pure helper behind the calendar page's live updates: which push events say "an event changed, and the payload is only a busy block". */

import type { PushEvent } from "@rapidmx/react-shared/mail/pushClient.js";

/** The published model name of a calendar event on either database (`CalendarEventMongo`, `CalendarEventSQL`) - and not the reminder's `"CalendarEvent"`,
 * which has its own action. */
const EVENT_MODEL = /^CalendarEvent(Mongo|SQL)$/;

/**
 * The uid of the event a push event announces as a redacted busy block, or `undefined` for anything else the shared push connection delivers.
 *
 * When somebody creates or changes a private or confidential event, restapi publishes it on the calendar's channel once, for every subscriber - and that one
 * payload has to be safe for a read-only reader of a shared calendar, so it is the busy block (`redacted: true`, title "Busy", no details). It must not be
 * stored as the event by the calendar's owner (or anybody else who may see it in full): they fetch the event again by its uid, which answers with as
 * much as they may see.
 */
export function redactedEventUidOf(event: PushEvent): string | undefined {
    if (!EVENT_MODEL.test(event.type) || (event.action !== "create" && event.action !== "update")) {
        return undefined;
    }
    const data = event.data as { uid?: unknown; redacted?: unknown } | null | undefined;
    return data?.redacted === true && typeof data.uid === "string" ? data.uid : undefined;
}
