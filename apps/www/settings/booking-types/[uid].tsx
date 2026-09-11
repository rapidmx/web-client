///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import {
    BookingAvailabilityWindow,
    BookingType,
    deleteBookingType,
    getBookingType,
    updateBookingType,
} from "@rapidmx/react-shared/bookingApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import AvailabilityEditor from "../../../shared/components/booking/AvailabilityEditor.js";
import Alert from "../../../shared/components/feedback/Alert.js";
import Button from "../../../shared/components/buttons/Button.js";
import FormField from "../../../shared/components/forms/FormField.js";
import Modal from "@rapidmx/react-shared/Modal.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export type BookingTypeDetailPageProps = Omit<SettingsShellProps, "active"> & { params: { uid: string } };

export default function BookingTypeDetailPage(props: BookingTypeDetailPageProps) {
    return (
        <SettingsShell {...props} active="booking-types">
            <BookingTypeDetailContent uid={props.params.uid} />
        </SettingsShell>
    );
}

function BookingTypeDetailContent({ uid }: { uid: string }) {
    const { mailboxUid } = useSettingsShell();
    const [bookingType, setBookingType] = useState<BookingType | null>(null);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [hostDisplayName, setHostDisplayName] = useState("");
    const [durationMinutes, setDurationMinutes] = useState(30);
    const [timezone, setTimezone] = useState("");
    const [availability, setAvailability] = useState<BookingAvailabilityWindow[]>([]);
    const [minimumNoticeMinutes, setMinimumNoticeMinutes] = useState(60);
    const [bookingWindowDays, setBookingWindowDays] = useState(30);
    const [requiresApproval, setRequiresApproval] = useState(false);
    const [enabled, setEnabled] = useState(true);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [copied, setCopied] = useState(false);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        getBookingType(uid)
            .then((bt) => {
                setBookingType(bt);
                setName(bt.name);
                setDescription(bt.description ?? "");
                setHostDisplayName(bt.hostDisplayName);
                setDurationMinutes(bt.durationMinutes);
                setTimezone(bt.timezone);
                setAvailability(bt.availability);
                setMinimumNoticeMinutes(bt.minimumNoticeMinutes);
                setBookingWindowDays(bt.bookingWindowDays);
                setRequiresApproval(bt.requiresApproval);
                setEnabled(bt.enabled);
            })
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this booking link."))
            .finally(() => setLoading(false));
    }, [uid]);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setSaved(false);
        setSaving(true);
        try {
            const updated = await updateBookingType({
                uid: bookingType!.uid,
                version: bookingType!.version,
                name,
                description: description.trim() || undefined,
                hostDisplayName,
                durationMinutes,
                timezone,
                availability,
                minimumNoticeMinutes,
                bookingWindowDays,
                requiresApproval,
                enabled,
            });
            setBookingType(updated);
            setSaved(true);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save this booking link.");
        } finally {
            setSaving(false);
        }
    }

    async function handleCopy(value: string) {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard access can be denied by the browser — the value is still selectable/copyable by hand.
        }
    }

    async function handleDelete() {
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteBookingType(bookingType!.uid, bookingType!.version);
            window.location.href = `/settings/booking-types?mailboxUid=${encodeURIComponent(mailboxUid!)}`;
        } catch (err) {
            setDeleteError(err instanceof ApiRequestError ? err.message : "Could not delete this booking link.");
            setDeleting(false);
        }
    }

    if (loading) {
        return <p className="p-6 text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error || !bookingType) {
        // `error` is always set whenever `bookingType` is falsy here: the load effect above destructures
        // every field off the resolved value directly (`bt.name`, `bt.hostDisplayName`, ...), so a
        // successful-but-empty response throws into `.catch()` — which sets `error` — before this
        // component ever renders past the `loading` guard above. `!bookingType` alone (with `error` still
        // `null`) is therefore unreachable, unlike e.g. `messages/[uid].tsx`'s identical-looking check,
        // which stores its fetched value whole rather than destructuring it.
        return (
            <div className="p-6">
                <Alert>{error!}</Alert>
            </div>
        );
    }

    // `bookingType` only ever becomes non-null via the client-only fetch above, so by the time this line
    // runs `window` is always defined — the `!bookingType` early return just above covers every real SSR
    // pass, where `bookingType` is still `null`.
    const publicUrl = `${window.location.origin}/book/${encodeURIComponent(bookingType.slug)}`;

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-2xl">
                <div className="flex items-start justify-between gap-4 mb-1">
                    <div>
                        <a
                            href={`/settings/booking-types?mailboxUid=${encodeURIComponent(mailboxUid!)}`}
                            className="text-sm text-primary-dark hover:underline"
                        >
                            &larr; All booking links
                        </a>
                        <h1 className="text-xl font-bold tracking-tight mt-1">{bookingType.name}</h1>
                    </div>
                    <Button
                        type="button"
                        variant="secondary"
                        className="!w-auto shrink-0 !border-danger !text-danger hover:!border-danger hover:!text-danger"
                        onClick={() => setConfirmingDelete(true)}
                    >
                        Delete
                    </Button>
                </div>

                <div className="flex items-center gap-2 mb-5">
                    <code className="flex-1 text-xs bg-surface-alt border border-border rounded-sm py-2 px-3 overflow-x-auto whitespace-nowrap">
                        {publicUrl}
                    </code>
                    <Button type="button" variant="secondary" className="!w-auto shrink-0" onClick={() => handleCopy(publicUrl)}>
                        {copied ? "Copied" : "Copy"}
                    </Button>
                </div>

                {saved && !error && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

                <form onSubmit={handleSubmit} className="flex flex-col gap-1">
                    <label className="flex items-center gap-2 text-sm mb-3">
                        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                        Enabled (publicly bookable)
                    </label>
                    <FormField label="Name" htmlFor="name">
                        <input id="name" type="text" className={INPUT_CLASS} value={name} onChange={(e) => setName(e.target.value)} />
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
                            Save
                        </Button>
                    </div>
                </form>

                <Modal open={confirmingDelete} onClose={() => setConfirmingDelete(false)} title="Delete booking link">
                    <p className="text-sm mb-5">
                        Are you sure you want to delete <strong>{bookingType.name}</strong>? Its public link will stop
                        working immediately. This cannot be undone.
                    </p>
                    {deleteError && <Alert>{deleteError}</Alert>}
                    <div className="flex gap-3 justify-end mt-5">
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto"
                            disabled={deleting}
                            onClick={() => setConfirmingDelete(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            className="!w-auto !bg-none !bg-danger !border-danger hover:!bg-danger"
                            loading={deleting}
                            disabled={deleting}
                            onClick={handleDelete}
                        >
                            Delete
                        </Button>
                    </div>
                </Modal>
            </div>
        </div>
    );
}
