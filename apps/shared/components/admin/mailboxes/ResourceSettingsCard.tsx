///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { Mailbox, updateMailbox } from "@rapidmx/react-shared/mailApi.js";
import Alert from "../../feedback/Alert.js";
import Button from "../../buttons/Button.js";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";
const SELECT_CLASS =
    "text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export interface ResourceSettingsCardProps {
    mailbox: Mailbox;
    /** Called with the freshly-saved mailbox after a successful save — mirrors `MemberListCard`'s
     * identical push-up-rather-than-reload pattern, since the caller already has everything the
     * response would return. */
    onUpdate: (mailbox: Mailbox) => void;
}

/**
 * Lets an admin view and edit a resource mailbox's booking settings — same load/edit/PUT/reload
 * interaction shape as `ShareAccessCard`, adapted the same way `MemberListCard` already adapted it:
 * these seven fields live directly on the `Mailbox` the parent detail page already loaded (not a
 * separate resource fetched by its own endpoint, unlike a mailbox's ACL), so this receives the
 * already-loaded `mailbox` and pushes the `PUT` response back up rather than fetching independently.
 * Only rendered by the detail page when `mailbox.isResource` is already `true` — a mailbox becomes a
 * resource at creation time (`apps/admin/mailboxes/new`), not retroactively from here.
 */
export default function ResourceSettingsCard({ mailbox, onUpdate }: ResourceSettingsCardProps) {
    const [resourceType, setResourceType] = useState<"room" | "equipment">(mailbox.resourceType ?? "room");
    const [resourceCapacity, setResourceCapacity] = useState(mailbox.resourceCapacity?.toString() ?? "");
    const [autoAcceptBookings, setAutoAcceptBookings] = useState(!!mailbox.autoAcceptBookings);
    const [allowConflicts, setAllowConflicts] = useState(!!mailbox.allowConflicts);
    const [bookingWindowDays, setBookingWindowDays] = useState(mailbox.bookingWindowDays?.toString() ?? "");
    const [maxDurationMinutes, setMaxDurationMinutes] = useState(mailbox.maxDurationMinutes?.toString() ?? "");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setSaved(false);
        setSaving(true);
        try {
            const updated = await updateMailbox({
                uid: mailbox.uid,
                version: mailbox.version,
                resourceType,
                resourceCapacity: resourceCapacity ? Number(resourceCapacity) : undefined,
                autoAcceptBookings,
                allowConflicts,
                bookingWindowDays: bookingWindowDays ? Number(bookingWindowDays) : undefined,
                maxDurationMinutes: maxDurationMinutes ? Number(maxDurationMinutes) : undefined,
            });
            onUpdate(updated);
            setSaved(true);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save resource settings.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="bg-surface border border-border rounded-md p-6">
            <h2 className="text-base font-bold uppercase tracking-wide mb-4">Resource settings</h2>

            {error && <Alert>{error}</Alert>}
            {saved && !error && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Resource type</span>
                    <select
                        aria-label="Resource type"
                        className={SELECT_CLASS}
                        value={resourceType}
                        onChange={(e) => setResourceType(e.target.value as "room" | "equipment")}
                    >
                        <option value="room">Room</option>
                        <option value="equipment">Equipment</option>
                    </select>
                </label>

                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Capacity (optional)</span>
                    <input
                        type="number"
                        min={0}
                        step={1}
                        aria-label="Capacity"
                        className={INPUT_CLASS}
                        value={resourceCapacity}
                        onChange={(e) => setResourceCapacity(e.target.value)}
                        placeholder="Informational only"
                    />
                </label>

                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={autoAcceptBookings}
                        onChange={(e) => setAutoAcceptBookings(e.target.checked)}
                    />
                    Automatically accept booking requests
                </label>

                <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={allowConflicts} onChange={(e) => setAllowConflicts(e.target.checked)} />
                    Allow conflicting bookings (skip conflict checking entirely)
                </label>

                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Booking window, in days (optional)</span>
                    <input
                        type="number"
                        min={0}
                        step={1}
                        aria-label="Booking window, in days"
                        className={INPUT_CLASS}
                        value={bookingWindowDays}
                        onChange={(e) => setBookingWindowDays(e.target.value)}
                        placeholder="No limit"
                    />
                </label>

                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">Maximum duration, in minutes (optional)</span>
                    <input
                        type="number"
                        min={0}
                        step={1}
                        aria-label="Maximum duration, in minutes"
                        className={INPUT_CLASS}
                        value={maxDurationMinutes}
                        onChange={(e) => setMaxDurationMinutes(e.target.value)}
                        placeholder="No limit"
                    />
                </label>

                <div>
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Save resource settings
                    </Button>
                </div>
            </form>
        </div>
    );
}
