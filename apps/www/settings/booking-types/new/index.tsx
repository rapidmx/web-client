///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { Folder, listFolders } from "@rapidmx/react-shared/mailApi.js";
import { BookingAvailabilityWindow, createBookingType } from "@rapidmx/react-shared/bookingApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../../shared/components/settings/layout/SettingsShell.js";
import AvailabilityEditor from "../../../../shared/components/booking/AvailabilityEditor.js";
import Alert from "../../../../shared/components/feedback/Alert.js";
import Button from "../../../../shared/components/buttons/Button.js";
import FormField from "../../../../shared/components/forms/FormField.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export type NewBookingTypePageProps = Omit<SettingsShellProps, "active">;

export default function NewBookingTypePage(props: NewBookingTypePageProps) {
    return (
        <SettingsShell {...props} active="booking-types">
            <NewBookingTypeForm />
        </SettingsShell>
    );
}

function NewBookingTypeForm() {
    const { mailboxUid, mailboxes } = useSettingsShell();
    // Same established non-null pattern as `apps/www/settings/filters/new/index.tsx`.
    const mailbox = mailboxes.find((mb) => mb.uid === mailboxUid)!;

    const [calendarFolderUid, setCalendarFolderUid] = useState<string | null>(null);
    const [folderError, setFolderError] = useState<string | null>(null);
    const [slug, setSlug] = useState("");
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [hostDisplayName, setHostDisplayName] = useState(mailbox.displayName);
    const [durationMinutes, setDurationMinutes] = useState(30);
    const [timezone, setTimezone] = useState(mailbox.timezone);
    const [availability, setAvailability] = useState<BookingAvailabilityWindow[]>([]);
    const [minimumNoticeMinutes, setMinimumNoticeMinutes] = useState(60);
    const [bookingWindowDays, setBookingWindowDays] = useState(30);
    const [requiresApproval, setRequiresApproval] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        listFolders(mailboxUid!)
            .then((folders) => {
                const calendar = folders.find((f: Folder) => f.type === "calendar");
                if (!calendar) {
                    setFolderError("This mailbox has no Calendar folder yet.");
                    return;
                }
                setCalendarFolderUid(calendar.uid);
            })
            .catch((err) => setFolderError(err instanceof ApiRequestError ? err.message : "Could not load this mailbox's folders."));
    }, [mailboxUid]);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);

        if (!slug.trim() || !name.trim() || !hostDisplayName.trim()) {
            setError("Slug, name, and host name are all required.");
            return;
        }
        if (!calendarFolderUid) {
            setError("This mailbox has no Calendar folder yet.");
            return;
        }

        setSaving(true);
        try {
            const created = await createBookingType({
                mailboxUid: mailboxUid!,
                calendarFolderUid,
                slug: slug.trim(),
                name: name.trim(),
                description: description.trim() || undefined,
                hostDisplayName: hostDisplayName.trim(),
                durationMinutes,
                timezone,
                availability,
                minimumNoticeMinutes,
                bookingWindowDays,
                requiresApproval,
            });
            window.location.href = `/settings/booking-types/${encodeURIComponent(created.uid)}?mailboxUid=${encodeURIComponent(mailboxUid!)}`;
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create this booking link.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-2xl">
                <h1 className="text-lg font-bold tracking-tight mb-1">New booking link</h1>
                <p className="text-sm text-text-muted mb-5">
                    Anyone with the link can pick an open slot from your live availability below — no account
                    needed on their end.
                </p>

                {error && <Alert>{error}</Alert>}
                {folderError && <Alert>{folderError}</Alert>}

                <form onSubmit={handleSubmit} className="flex flex-col gap-1">
                    <FormField label="Name" htmlFor="name">
                        <input
                            id="name"
                            type="text"
                            className={INPUT_CLASS}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="30 Minute Intro Call"
                        />
                    </FormField>
                    <FormField label="Slug (used in the public link)" htmlFor="slug">
                        <input
                            id="slug"
                            type="text"
                            className={INPUT_CLASS}
                            value={slug}
                            onChange={(e) => setSlug(e.target.value)}
                            placeholder="intro-call"
                        />
                    </FormField>
                    <FormField label="Description (optional)" htmlFor="description">
                        <textarea
                            id="description"
                            className={INPUT_CLASS}
                            rows={2}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                        />
                    </FormField>
                    <FormField label="Host name shown to visitors" htmlFor="hostDisplayName">
                        <input
                            id="hostDisplayName"
                            type="text"
                            className={INPUT_CLASS}
                            value={hostDisplayName}
                            onChange={(e) => setHostDisplayName(e.target.value)}
                        />
                    </FormField>
                    <div className="grid grid-cols-2 gap-3">
                        <FormField label="Duration (minutes)" htmlFor="durationMinutes">
                            <input
                                id="durationMinutes"
                                type="number"
                                min={1}
                                className={INPUT_CLASS}
                                value={durationMinutes}
                                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                            />
                        </FormField>
                        <FormField label="Timezone" htmlFor="timezone">
                            <input
                                id="timezone"
                                type="text"
                                className={INPUT_CLASS}
                                value={timezone}
                                onChange={(e) => setTimezone(e.target.value)}
                                placeholder="America/New_York"
                            />
                        </FormField>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <FormField label="Minimum notice (minutes)" htmlFor="minimumNoticeMinutes">
                            <input
                                id="minimumNoticeMinutes"
                                type="number"
                                min={0}
                                className={INPUT_CLASS}
                                value={minimumNoticeMinutes}
                                onChange={(e) => setMinimumNoticeMinutes(Number(e.target.value))}
                            />
                        </FormField>
                        <FormField label="Booking window (days ahead)" htmlFor="bookingWindowDays">
                            <input
                                id="bookingWindowDays"
                                type="number"
                                min={1}
                                className={INPUT_CLASS}
                                value={bookingWindowDays}
                                onChange={(e) => setBookingWindowDays(Number(e.target.value))}
                            />
                        </FormField>
                    </div>
                    <label className="flex items-center gap-2 text-sm my-3">
                        <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} />
                        Require my approval before confirming a booking
                    </label>

                    <div className="mb-4">
                        <span className="block text-sm font-semibold mb-1.5 text-text">Weekly availability</span>
                        <AvailabilityEditor value={availability} onChange={setAvailability} />
                    </div>

                    <div>
                        <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                            Create
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
