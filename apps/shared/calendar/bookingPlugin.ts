///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The calendar's side of `@rapidmx/booking-plugin`: whether the plugin is running, and the one call the quick-create popover's
 * "Appointment schedule" tab makes on it - creating a booking type (`POST /api/mail/booking-types`).
 *
 * The plugin ships its own typed client, but inside its own UI (`apps/shared/bookingApi.ts` of the plugin), which this package cannot import,
 * so the few fields this popover writes are mirrored here. The plugin's `BaseBookingTypeRoute` is the authority: it normalizes the slug,
 * assigns the uids, refuses a taken slug with a 409 and validates the availability, durations and calendar folder.
 */
import { apiFetch } from "@rapidmx/react-shared/util/api.js";
import { PluginNav, isSafePluginHref } from "../plugins/pluginNav.js";

/** The id of the Settings section the booking plugin's manifest contributes (`ui.settingsSections`) - what tells the client it is running. */
export const BOOKING_SETTINGS_SECTION_ID = "booking-types";

/**
 * Where the booking plugin's Settings pages are mounted (`/settings/booking-types`), or `undefined` when the plugin is not running.
 *
 * A server only puts a plugin's navigation into `pluginNav` while the plugin is enabled and its pages built, so its section being there is the
 * client's one way of knowing (the plugin list itself is admin-only).
 */
export function bookingSettingsHref(pluginNav: PluginNav | undefined): string | undefined {
    const section = pluginNav?.settingsSections?.find((item) => item.id === BOOKING_SETTINGS_SECTION_ID);
    return section && isSafePluginHref(section.href) ? section.href.replace(/\/+$/, "") : undefined;
}

/** The plugin's "new booking link" page for `mailboxUid` - the full form behind the popover's More options. */
export function newBookingLinkHref(settingsHref: string, mailboxUid: string): string {
    return `${settingsHref}/new?mailboxUid=${encodeURIComponent(mailboxUid)}`;
}

export interface BookingAvailabilityWindow {
    /** 0 (Sunday) to 6 (Saturday). */
    dayOfWeek: number;
    startMinute: number;
    endMinute: number;
}

export type BookingLocationType = "phone" | "video" | "other";

export interface BookingMeetingType {
    name: string;
    durationMinutes: number;
    locationOptions: { type: BookingLocationType }[];
}

export interface CreateBookingTypeInput {
    mailboxUid: string;
    calendarFolderUid: string;
    slug: string;
    name: string;
    hostDisplayName: string;
    meetingTypes: BookingMeetingType[];
    timezone: string;
    availability: BookingAvailabilityWindow[];
    bufferAfterMinutes: number;
}

/** What comes back from a create: the fields the popover needs to show the link. */
export interface CreatedBookingType {
    uid: string;
    mailboxUid: string;
    slug: string;
    name: string;
}

/** Creates a booking type with the plugin's own defaults for everything the popover leaves out (an hour's notice, 30 days ahead, no approval). */
export function createBookingType(input: CreateBookingTypeInput): Promise<CreatedBookingType> {
    return apiFetch("/mail/booking-types", {
        method: "POST",
        body: JSON.stringify({
            dateOverrides: [],
            bufferBeforeMinutes: 0,
            minimumNoticeMinutes: 60,
            bookingWindowDays: 30,
            requiresApproval: false,
            enabled: true,
            ...input,
        }),
    });
}

/** A URL-safe slug for a schedule's name, the way the plugin's own `normalizeSlug()` reads it; `"appointments"` when nothing usable is left. */
export function slugFor(name: string): string {
    return (
        name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "appointments"
    );
}

/** The public page of a booking type on this site's own origin (`/book/<mailbox>/<slug>`, the `@` of a mailbox uid left as it is). Browser only. */
export function bookingPublicUrl(mailboxUid: string, slug: string): string {
    return `${window.location.origin}/book/${encodeURIComponent(mailboxUid).replace(/%40/g, "@")}/${encodeURIComponent(slug)}`;
}
