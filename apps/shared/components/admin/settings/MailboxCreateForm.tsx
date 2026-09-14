///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { getMailboxPolicy } from "@rapidmx/react-shared/admin/mailboxPolicyApi.js";
import { createMailbox, listMailboxDomains, Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";
const SELECT_CLASS =
    "text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export interface MailboxCreateFormProps {
    onCreated: (mailbox: Mailbox) => void;
    /** Initial field values, e.g. the signed-in admin's own mailbox in the setup wizard. */
    defaults?: { localPart?: string; domain?: string; displayName?: string; ownerUserUid?: string };
    submitLabel?: string;
    cancelHref?: string;
}

/**
 * The "New mailbox" form, shared by the New Mailbox page and the setup wizard. The quota starts at the mailbox
 * policy's default.
 */
export default function MailboxCreateForm({ onCreated, defaults, submitLabel = "Create mailbox", cancelHref }: MailboxCreateFormProps) {
    const [primarySmtpAddress, setPrimarySmtpAddress] = useState("");
    const [localPart, setLocalPart] = useState(defaults?.localPart ?? "");
    const [domains, setDomains] = useState<string[]>([]);
    const [domain, setDomain] = useState("");
    const [displayName, setDisplayName] = useState(defaults?.displayName ?? "");
    const [ownerUserUid, setOwnerUserUid] = useState(defaults?.ownerUserUid ?? "");
    const [timezone, setTimezone] = useState("UTC");
    const [quotaGb, setQuotaGb] = useState(5);
    // Only replaced by the mailbox policy's default if the admin hasn't typed a quota of their own yet.
    const quotaTouched = useRef(false);
    const [isResource, setIsResource] = useState(false);
    const [resourceType, setResourceType] = useState<"room" | "equipment">("room");
    const [resourceCapacity, setResourceCapacity] = useState("");
    const [autoAcceptBookings, setAutoAcceptBookings] = useState(false);
    const [allowConflicts, setAllowConflicts] = useState(false);
    const [bookingWindowDays, setBookingWindowDays] = useState("");
    const [maxDurationMinutes, setMaxDurationMinutes] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    // An empty `mail:domains` list (the default) means this server enforces no domain restriction —
    // the address field stays free text, exactly as before. Once an admin configures at least one
    // domain, every mailbox this server creates must be on one of them (enforced server-side too, in
    // `BaseMailboxRoute.create()`), so the form switches to a local-part input + domain dropdown to
    // make that restriction visible rather than let an admin discover it only via a rejected submit.
    useEffect(() => {
        listMailboxDomains()
            .then((list) => {
                setDomains(list);
                setDomain(defaults?.domain && list.includes(defaults.domain) ? defaults.domain : (list[0] ?? ""));
            })
            .catch(() => undefined);
        getMailboxPolicy()
            .then((policy) => {
                if (!quotaTouched.current) {
                    setQuotaGb(Math.round(policy.defaultQuotaBytes / 1_000_000_000));
                }
            })
            .catch(() => undefined);
    }, []);

    const constrained = domains.length > 0;

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);

        const address = constrained ? `${localPart.trim()}@${domain}` : primarySmtpAddress.trim();
        if (constrained ? !localPart.trim() : !primarySmtpAddress.trim()) {
            setError("A primary SMTP address is required.");
            return;
        }
        if (!displayName.trim()) {
            setError("A display name is required.");
            return;
        }
        // restapi refuses these (400): a display name shown in From must not look like an address.
        if (/[@\r\n]/.test(displayName)) {
            setError("A display name can't contain \"@\" or line breaks.");
            return;
        }

        setSaving(true);
        try {
            // ownerUserUid left blank creates a true ownerless shared mailbox (e.g. support@example.com);
            // delegates are then granted access from the mailbox's detail page. A resource mailbox is
            // ownerless the same way — leave "Owner user uid" blank for one too.
            const mailbox = await createMailbox({
                primarySmtpAddress: address,
                displayName: displayName.trim(),
                ownerUserUid: ownerUserUid.trim() || undefined,
                timezone,
                quotaBytes: Math.round(quotaGb * 1_000_000_000),
                ...(isResource && {
                    isResource: true,
                    resourceType,
                    resourceCapacity: resourceCapacity ? Number(resourceCapacity) : undefined,
                    autoAcceptBookings,
                    allowConflicts,
                    bookingWindowDays: bookingWindowDays ? Number(bookingWindowDays) : undefined,
                    maxDurationMinutes: maxDurationMinutes ? Number(maxDurationMinutes) : undefined,
                }),
            });
            onCreated(mailbox);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create the mailbox.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            {error && <Alert>{error}</Alert>}

            <form onSubmit={handleSubmit} className="bg-surface border border-border rounded-md p-6">
                {constrained ? (
                    <FormField label="Local part" htmlFor="localPart">
                        <div className="flex gap-2 items-center">
                            <input
                                id="localPart"
                                type="text"
                                className={INPUT_CLASS}
                                value={localPart}
                                onChange={(e) => setLocalPart(e.target.value)}
                                placeholder="support"
                            />
                            <span className="text-text-muted shrink-0">@</span>
                            <select
                                aria-label="Domain"
                                className={SELECT_CLASS}
                                value={domain}
                                onChange={(e) => setDomain(e.target.value)}
                            >
                                {domains.map((d) => (
                                    <option key={d} value={d}>
                                        {d}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </FormField>
                ) : (
                    <FormField label="Primary SMTP address" htmlFor="primarySmtpAddress">
                        <input
                            id="primarySmtpAddress"
                            type="email"
                            className={INPUT_CLASS}
                            value={primarySmtpAddress}
                            onChange={(e) => setPrimarySmtpAddress(e.target.value)}
                            placeholder="support@example.com"
                        />
                    </FormField>
                )}

                <FormField label="Display name" htmlFor="displayName">
                    <input
                        id="displayName"
                        type="text"
                        className={INPUT_CLASS}
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Support"
                    />
                </FormField>

                <FormField label="Owner user uid (optional)" htmlFor="ownerUserUid">
                    <input
                        id="ownerUserUid"
                        type="text"
                        className={INPUT_CLASS}
                        value={ownerUserUid}
                        onChange={(e) => setOwnerUserUid(e.target.value)}
                        placeholder="Leave blank for a shared mailbox"
                    />
                </FormField>

                <FormField label="Timezone" htmlFor="timezone">
                    <input
                        id="timezone"
                        type="text"
                        className={INPUT_CLASS}
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        placeholder="America/Los_Angeles"
                    />
                </FormField>

                <FormField label="Quota (GB)" htmlFor="quotaGb">
                    <input
                        id="quotaGb"
                        type="number"
                        min={1}
                        step={1}
                        className={INPUT_CLASS}
                        value={quotaGb}
                        onChange={(e) => {
                            quotaTouched.current = true;
                            setQuotaGb(Number(e.target.value));
                        }}
                    />
                </FormField>

                <label className="flex items-center gap-2 text-sm mb-4">
                    <input type="checkbox" checked={isResource} onChange={(e) => setIsResource(e.target.checked)} />
                    This is a resource mailbox (a bookable room or piece of equipment)
                </label>

                {isResource && (
                    <div className="border border-border rounded-sm p-4 mb-4 flex flex-col gap-4">
                        <FormField label="Resource type" htmlFor="resourceType">
                            <select
                                id="resourceType"
                                className={SELECT_CLASS}
                                value={resourceType}
                                onChange={(e) => setResourceType(e.target.value as "room" | "equipment")}
                            >
                                <option value="room">Room</option>
                                <option value="equipment">Equipment</option>
                            </select>
                        </FormField>

                        <FormField label="Capacity (optional)" htmlFor="resourceCapacity">
                            <input
                                id="resourceCapacity"
                                type="number"
                                min={0}
                                step={1}
                                className={INPUT_CLASS}
                                value={resourceCapacity}
                                onChange={(e) => setResourceCapacity(e.target.value)}
                                placeholder="Informational only"
                            />
                        </FormField>

                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={autoAcceptBookings}
                                onChange={(e) => setAutoAcceptBookings(e.target.checked)}
                            />
                            Automatically accept booking requests
                        </label>

                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={allowConflicts}
                                onChange={(e) => setAllowConflicts(e.target.checked)}
                            />
                            Allow conflicting bookings (skip conflict checking entirely)
                        </label>

                        <FormField label="Booking window, in days (optional)" htmlFor="bookingWindowDays">
                            <input
                                id="bookingWindowDays"
                                type="number"
                                min={0}
                                step={1}
                                className={INPUT_CLASS}
                                value={bookingWindowDays}
                                onChange={(e) => setBookingWindowDays(e.target.value)}
                                placeholder="No limit"
                            />
                        </FormField>

                        <FormField label="Maximum duration, in minutes (optional)" htmlFor="maxDurationMinutes">
                            <input
                                id="maxDurationMinutes"
                                type="number"
                                min={0}
                                step={1}
                                className={INPUT_CLASS}
                                value={maxDurationMinutes}
                                onChange={(e) => setMaxDurationMinutes(e.target.value)}
                                placeholder="No limit"
                            />
                        </FormField>
                    </div>
                )}

                <div className="flex gap-3 mt-2">
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        {submitLabel}
                    </Button>
                    {cancelHref && (
                        <a href={cancelHref}>
                            <Button type="button" variant="secondary" className="!w-auto">
                                Cancel
                            </Button>
                        </a>
                    )}
                </div>
            </form>
        </>
    );
}
