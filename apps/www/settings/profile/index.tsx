///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { routedPage } from "../../_routedPage.js";
import React, { FormEvent, useMemo, useState } from "react";
import { FreeBusyVisibility, freeBusyVisibilityOf, isSharedWithMe, updateMailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { DEFAULT_TIME_ZONE, deviceTimeZone, timeZoneOptions } from "@rapidmx/react-shared/util/timeZone.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import { notifyApiError } from "../../../shared/notifications/apiErrors.js";

export type SettingsProfilePageProps = Omit<SettingsShellProps, "active">;

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";
const SELECT_CLASS =
    "text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** Who may see when this mailbox is busy, as the Profile page words it: the label of each choice and the one line that says what it means. */
const FREE_BUSY_CHOICES: { value: FreeBusyVisibility; label: string; help: string }[] = [
    { value: "domain", label: "Everyone on my domain", help: "People with a mailbox on your domain can see when you are busy." },
    { value: "shared", label: "Only people I've shared my calendar with", help: "Only people you have given access to this mailbox or its calendars can see when you are busy." },
    { value: "nobody", label: "Nobody", help: "Nobody else can see when you are busy; people looking for a time see your availability as hidden." },
    { value: "everyone", label: "Everyone on this server", help: "Anyone signed in to this server can see when you are busy." },
];

/** The longest display name the server accepts. */
const MAX_DISPLAY_NAME_LENGTH = 255;

/**
 * Why `displayName` can't be saved as typed, or `undefined` if it can. The server refuses the same things (400): the name
 * is shown as the sender name on mail from this mailbox, so it must not look like an address (the fullwidth and small
 * look-alike @ signs included) or carry a line break.
 */
function displayNameProblem(displayName: string): string | undefined {
    if (!displayName) {
        return "Enter a display name.";
    }
    if (/[@＠﹫\r\n]/.test(displayName)) {
        return "A display name can't contain \"@\" (or a look-alike) or line breaks - it is shown as the sender name on mail you send.";
    }
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
        return `A display name can be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`;
    }
    return undefined;
}

function SettingsProfilePage(props: SettingsProfilePageProps) {
    return (
        <SettingsShell {...props} active="profile">
            <ProfileContent />
        </SettingsShell>
    );
}

function ProfileContent() {
    const { mailboxUid, mailboxes } = useSettingsShell();
    // `SettingsShell` only ever renders its children once `mailboxes` has loaded and `mailboxUid` has
    // resolved to one of them — same established non-null pattern as `apps/www/settings/auto-reply/index.tsx`.
    const mailbox = mailboxes.find((mb) => mb.uid === mailboxUid)!;

    const deviceZone = useMemo(() => deviceTimeZone(), []);
    // What the server holds, which is what "changed" is measured against - moved along by each successful save.
    const [savedName, setSavedName] = useState(mailbox.displayName);
    const [savedZone, setSavedZone] = useState(mailbox.timezone);
    const [displayName, setDisplayName] = useState(mailbox.displayName);
    // "UTC" is the server's placeholder for a mailbox nobody chose a zone for, not a choice anyone made, so this device's
    // zone is offered instead. It stays unsaved until Save, like any other edit.
    const [timezone, setTimezone] = useState(() =>
        mailbox.timezone === DEFAULT_TIME_ZONE && deviceZone !== DEFAULT_TIME_ZONE ? deviceZone : mailbox.timezone,
    );
    const [savedFreeBusy, setSavedFreeBusy] = useState(freeBusyVisibilityOf(mailbox));
    const [freeBusy, setFreeBusy] = useState(savedFreeBusy);
    // Only the mailbox's owner may change who sees its free/busy: on one shared with you the setting is shown, not offered.
    const canChangeFreeBusy = !isSharedWithMe(mailbox);
    const [nameError, setNameError] = useState<string | null>(null);
    // See auto-reply/index.tsx's identical note - later saves must carry the version the previous save returned.
    const [version, setVersion] = useState(mailbox.version);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const zones = useMemo(() => timeZoneOptions(savedZone, deviceZone, timezone), [savedZone, deviceZone, timezone]);
    const zoneWasPreselected = savedZone === DEFAULT_TIME_ZONE && deviceZone !== DEFAULT_TIME_ZONE && timezone === deviceZone;

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setSaved(false);

        const name = displayName.trim();
        const problem = displayNameProblem(name);
        if (problem) {
            setNameError(problem);
            return;
        }
        setNameError(null);
        setDisplayName(name);

        const nameChanged = name !== savedName;
        const zoneChanged = timezone !== savedZone;
        const freeBusyChanged = canChangeFreeBusy && freeBusy !== savedFreeBusy;
        if (!nameChanged && !zoneChanged && !freeBusyChanged) {
            setSaved(true);
            return;
        }

        setSaving(true);
        try {
            const updated = await updateMailbox({
                uid: mailbox.uid,
                version,
                ...(nameChanged && { displayName: name }),
                ...(zoneChanged && { timezone }),
                ...(freeBusyChanged && { freeBusyVisibility: freeBusy }),
            });
            setVersion(updated.version);
            setSavedName(name);
            setSavedZone(timezone);
            setSavedFreeBusy(freeBusy);
            setSaved(true);
        } catch (err) {
            notifyApiError(err, "Couldn't save your profile");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-xl">
                <h1 className="text-lg font-bold tracking-tight mb-1">Profile</h1>
                <p className="text-sm text-text-muted mb-4">
                    How this mailbox presents itself to the people you write to, and where you are.
                </p>

                {saved && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

                <form onSubmit={handleSubmit} className="flex flex-col">
                    <FormField label="Display name" htmlFor="profile-display-name">
                        <input
                            id="profile-display-name"
                            type="text"
                            className={INPUT_CLASS}
                            value={displayName}
                            onChange={(e) => {
                                setDisplayName(e.target.value);
                                setNameError(null);
                                setSaved(false);
                            }}
                            aria-invalid={nameError ? true : undefined}
                            aria-describedby={nameError ? "profile-display-name-error" : "profile-display-name-help"}
                        />
                        {nameError && (
                            <p id="profile-display-name-error" role="alert" className="mt-1 text-xs text-danger">
                                {nameError}
                            </p>
                        )}
                        <p id="profile-display-name-help" className="mt-1 text-xs text-text-muted">
                            The sender name on mail you send, shown to recipients beside your address (for example
                            &ldquo;Jane Doe&rdquo;). It can&rsquo;t contain an &ldquo;@&rdquo;.
                        </p>
                    </FormField>

                    <FormField label="Time zone" htmlFor="profile-time-zone">
                        <div className="flex flex-wrap items-center gap-2">
                            <select
                                id="profile-time-zone"
                                className={SELECT_CLASS}
                                value={timezone}
                                onChange={(e) => {
                                    setTimezone(e.target.value);
                                    setSaved(false);
                                }}
                                aria-describedby="profile-time-zone-help"
                            >
                                {zones.map((zone) => (
                                    <option key={zone} value={zone}>
                                        {zone}
                                    </option>
                                ))}
                            </select>
                            {timezone !== deviceZone && (
                                <Button
                                    type="button"
                                    variant="text"
                                    className="!w-auto"
                                    onClick={() => {
                                        setTimezone(deviceZone);
                                        setSaved(false);
                                    }}
                                >
                                    Use this device&rsquo;s time zone ({deviceZone})
                                </Button>
                            )}
                        </div>
                        {zoneWasPreselected && (
                            <p className="mt-1 text-xs text-text-muted">
                                Your mailbox has no time zone chosen yet; this device&rsquo;s is preselected. Save to keep it.
                            </p>
                        )}
                        <p id="profile-time-zone-help" className="mt-1 text-xs text-text-muted">
                            How calendar times and reminders are shown and scheduled for this mailbox, such as when an
                            event or a reminder falls.
                        </p>
                    </FormField>

                    <FormField label="Free/busy visibility" htmlFor="profile-free-busy">
                        <select
                            id="profile-free-busy"
                            className={SELECT_CLASS}
                            value={freeBusy}
                            disabled={!canChangeFreeBusy}
                            onChange={(e) => {
                                setFreeBusy(e.target.value as FreeBusyVisibility);
                                setSaved(false);
                            }}
                            aria-describedby="profile-free-busy-help"
                        >
                            {FREE_BUSY_CHOICES.map((choice) => (
                                <option key={choice.value} value={choice.value}>
                                    {choice.label}
                                </option>
                            ))}
                        </select>
                        <p id="profile-free-busy-help" className="mt-1 text-xs text-text-muted">
                            {FREE_BUSY_CHOICES.find((choice) => choice.value === freeBusy)!.help}
                        </p>
                        <p className="mt-1 text-xs text-text-muted">
                            Who can see the hours you are busy when they look for a time to meet - never the title, place or guests of an event.
                        </p>
                        {!canChangeFreeBusy && (
                            <p className="mt-1 text-xs text-text-muted">This mailbox is shared with you: only its owner can change who sees its free/busy times.</p>
                        )}
                    </FormField>

                    <div>
                        <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                            Save
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}

export default routedPage("/settings/profile", SettingsProfilePage);
