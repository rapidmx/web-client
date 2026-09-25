///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EventVisibility, guestPermissionsOf, visibilityOf } from "@rapidmx/react-shared/calendar/calendarApi.js";
import {
    MAX_EVENT_DESCRIPTION_HTML_LENGTH,
    MAX_EVENT_DESCRIPTION_LENGTH,
    htmlToPlainText,
    sanitizeEventDescriptionHtml,
} from "@rapidmx/react-shared/calendar/eventDescription.js";
import { CalendarOccurrence } from "@rapidmx/react-shared/calendar/recurrence.js";
import { EventFormValues } from "./eventForm.js";

/** The event dialog's own fields of a `CalendarEventInput` - only the ones that differ from what the event has, so saving an event no one touched these on
 * says nothing about them (and asks for no new invitations). */
export interface EventDialogFields {
    /** `null` clears. */
    description?: string | null;
    descriptionHtml?: string | null;
    visibility?: EventVisibility;
    guestsCanModify?: boolean;
    guestsCanInviteOthers?: boolean;
    guestsCanSeeGuestList?: boolean;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Whether the editor's HTML holds any text (an emptied editor writes `<p></p>`). */
export function hasDescriptionText(html: string): boolean {
    return html.replace(/<[^>]*>/g, "").trim() !== "";
}

/** A plain-text description as the paragraphs the editor starts from: one for each line (an event whose description has no HTML). */
export function plainTextToHtml(text: string): string {
    return text
        .split(/\r\n|\r|\n/)
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join("");
}

/** What the description editor starts with for `occurrence`: its HTML, else its plain text as paragraphs, else nothing. */
export function initialDescriptionHtml(occurrence: Pick<CalendarOccurrence, "description" | "descriptionHtml"> | null): string {
    if (occurrence?.descriptionHtml) {
        return occurrence.descriptionHtml;
    }
    return occurrence?.description ? plainTextToHtml(occurrence.description) : "";
}

/** Why the description cannot be saved as it is - too long for the server (400) - or `undefined`. */
export function descriptionProblem(descriptionHtml: string): string | undefined {
    const html = sanitizeEventDescriptionHtml(descriptionHtml);
    return html.length > MAX_EVENT_DESCRIPTION_HTML_LENGTH || htmlToPlainText(html).length > MAX_EVENT_DESCRIPTION_LENGTH
        ? "The description is too long."
        : undefined;
}

/**
 * What the form says about the description, visibility and guest permissions that differs from `occurrence` (`null` for a new event, which starts from the
 * defaults: no description, default visibility, guests cannot modify, can invite, can see the list). A description is sent as both its sanitized HTML and the
 * plain text derived from it, or as `null` twice when it was emptied; one the user did not change is not sent.
 */
export function dialogFields(values: EventFormValues, occurrence: CalendarOccurrence | null): EventDialogFields {
    const fields: EventDialogFields = {};

    const initial = initialDescriptionHtml(occurrence);
    const html = sanitizeEventDescriptionHtml(values.descriptionHtml);
    if (values.descriptionHtml !== initial && html !== sanitizeEventDescriptionHtml(initial)) {
        const plain = htmlToPlainText(html);
        fields.description = plain || null;
        fields.descriptionHtml = plain ? html : null;
    }

    if (values.visibility !== (occurrence ? visibilityOf(occurrence) : "default")) {
        fields.visibility = values.visibility;
    }
    const permissions = guestPermissionsOf(occurrence ?? {});
    for (const key of ["guestsCanModify", "guestsCanInviteOthers", "guestsCanSeeGuestList"] as const) {
        if (values[key] !== permissions[key]) {
            fields[key] = values[key];
        }
    }
    return fields;
}
