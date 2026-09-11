///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { BookingType, listBookingTypes } from "@rapidmx/react-shared/bookingApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Alert from "../../../shared/components/feedback/Alert.js";
import Button from "../../../shared/components/buttons/Button.js";

export type SettingsBookingTypesPageProps = Omit<SettingsShellProps, "active">;

export default function SettingsBookingTypesPage(props: SettingsBookingTypesPageProps) {
    return (
        <SettingsShell {...props} active="booking-types">
            <BookingTypesContent />
        </SettingsShell>
    );
}

function BookingTypesContent() {
    const { mailboxUid } = useSettingsShell();
    const [bookingTypes, setBookingTypes] = useState<BookingType[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // `SettingsShell` only ever renders its children once `mailboxUid` has resolved — same established
    // non-null pattern as `apps/www/settings/filters/index.tsx`.
    useEffect(() => {
        listBookingTypes(mailboxUid!)
            .then(setBookingTypes)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load your booking links."))
            .finally(() => setLoading(false));
    }, [mailboxUid]);

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-3xl">
                <div className="flex items-center justify-between mb-5">
                    <h1 className="text-lg font-bold tracking-tight">Booking Links</h1>
                    <a href={`/settings/booking-types/new?mailboxUid=${encodeURIComponent(mailboxUid!)}`}>
                        <Button type="button" className="!w-auto">
                            + New booking link
                        </Button>
                    </a>
                </div>
                <p className="text-sm text-text-muted mb-4">
                    Share a link and let anyone pick a real open slot on your calendar — no account needed on
                    their end.
                </p>

                {error && <Alert>{error}</Alert>}

                {loading ? (
                    <p className="text-sm text-text-muted">Loading&hellip;</p>
                ) : bookingTypes.length === 0 ? (
                    <p className="text-sm text-text-muted">No booking links yet.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                            <thead>
                                <tr>
                                    {["Name", "Link", "Duration", "Enabled", ""].map((h) => (
                                        <th
                                            key={h}
                                            className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                        >
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {bookingTypes.map((bookingType) => (
                                    <tr key={bookingType.uid}>
                                        <td className="py-2.5 px-2.5 border-b border-border">{bookingType.name}</td>
                                        <td className="py-2.5 px-2.5 border-b border-border">/book/{bookingType.slug}</td>
                                        <td className="py-2.5 px-2.5 border-b border-border">{bookingType.durationMinutes} min</td>
                                        <td className="py-2.5 px-2.5 border-b border-border">{bookingType.enabled ? "Yes" : "No"}</td>
                                        <td className="py-2.5 px-2.5 border-b border-border text-right">
                                            <a
                                                href={`/settings/booking-types/${encodeURIComponent(bookingType.uid)}?mailboxUid=${encodeURIComponent(mailboxUid!)}`}
                                                className="text-primary-dark hover:underline font-medium"
                                            >
                                                View
                                            </a>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}
