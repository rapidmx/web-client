///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { getMailbox, type Mailbox, updateMailbox, type ZeroAccessDataType, type ZeroAccessTypes as ChosenTypes } from "../../../../lib/mail/mailApi.js";
import { ApiRequestError } from "../../../../lib/util/api.js";
import { useApiClient } from "../../../../lib/util/apiClientContext.js";
import { notifyApiError } from "../../notifications/apiErrors.js";

/** What each data type's protection covers, what stays readable and why, and what it breaks on a phone or Outlook - the copy restapi
 * `specs/search.md` §3 *What It Covers* requires settings to state plainly. */
export const ZERO_ACCESS_TYPE_INFO: Record<ZeroAccessDataType, { label: string; encrypted: string; readable: string; onDevices: string }> = {
    mail: {
        label: "Mail",
        encrypted: "Message bodies, subjects, previews and attachments",
        readable: "Sender, recipients, dates, size, flags and folder - to deliver, thread and search your mail",
        onDevices: "can't open protected mail until you install your exported keys on it (Export keys below)",
    },
    calendar: {
        label: "Calendar",
        encrypted: "Event titles, locations and descriptions",
        readable: "Times, repeats, time zone, attendees, responses and busy status - for free/busy, invitations and reminders",
        onDevices:
            "shows protected events only as busy blocks named “Protected event”, and attendees aren't told when it changes a meeting (a phone) or sends one (Outlook) - send those from RapidMX",
    },
    contacts: {
        label: "Contacts",
        encrypted: "Names, company, job title, phone numbers, postal addresses, notes, categories and photos",
        readable: "Email addresses - the server needs them to deliver mail and to find each contact's encryption keys",
        onDevices: "shows protected contacts by their email address only",
    },
    tasks: {
        label: "Tasks",
        encrypted: "Task titles and notes",
        readable: "Due dates, reminders, priority, completion and list",
        onDevices: "shows protected tasks as “Protected task”",
    },
};

/** Whether `type` is included: the owner's choice, else (undecided) mail on and the rest off - restapi's `zeroAccessTypeIncluded()`. */
export function typeIncluded(types: ChosenTypes | undefined, type: ZeroAccessDataType): boolean {
    const chosen = types?.[type];
    return typeof chosen === "boolean" ? chosen : type === "mail";
}

/** The names of the owner's ActiveSync devices that sync `type`, and Outlook when it syncs the mailbox. */
export function devicesSyncing(mailbox: Pick<Mailbox, "syncClients">, type: ZeroAccessDataType): string[] {
    const names = (mailbox.syncClients?.activesync?.devices ?? []).filter((device) => device.types.includes(type)).map((device) => device.model || "A phone");
    return [...new Set(names), ...(mailbox.syncClients?.mapi ? ["Outlook"] : [])];
}

export interface ZeroAccessTypesProps {
    mailbox: Mailbox;
    /** The data types this client can protect, in order - each one's switch appears once its protection is implemented. */
    types: readonly ZeroAccessDataType[];
    /** The owner, not impersonating: only they change it. */
    canManage: boolean;
}

/**
 * "What to protect": one switch per data type zero-access encryption covers, each saying what it encrypts and - for a type one of the
 * owner's ActiveSync devices or Outlook syncs - plainly what that device will no longer show (restapi `specs/search.md` §3 *What It
 * Covers*). Then the table of what stays readable to the server and why.
 */
export default function ZeroAccessTypes({ mailbox, types, canManage }: ZeroAccessTypesProps) {
    const client = useApiClient();
    const [chosen, setChosen] = useState<ChosenTypes>(mailbox.zeroAccessTypes ?? {});
    const [saving, setSaving] = useState(false);

    async function save(type: ZeroAccessDataType, on: boolean) {
        const previous = chosen;
        setChosen({ ...chosen, [type]: on });
        setSaving(true);
        try {
            const write = (version: number) => updateMailbox({ uid: mailbox.uid, version, zeroAccessTypes: { [type]: on } }, client);
            try {
                await write(mailbox.version);
            } catch (err) {
                // The server records devices on the mailbox, moving its version on: read it again and retry once.
                if (!(err instanceof ApiRequestError && err.status === 409)) {
                    throw err;
                }
                await write((await getMailbox(mailbox.uid, {}, client)).version);
            }
        } catch (err) {
            setChosen(previous);
            notifyApiError(err, "Couldn't save what zero-access encryption protects");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="mt-3">
            <h3 className="text-sm font-semibold mb-1">What to protect</h3>
            <ul className="flex flex-col gap-2">
                {types.map((type) => {
                    const info = ZERO_ACCESS_TYPE_INFO[type];
                    const devices = devicesSyncing(mailbox, type);
                    const on = typeIncluded(chosen, type);
                    const keyInstalled = type === "mail" && !!mailbox.zeroAccessKeysExportedAt;
                    return (
                        <li key={type}>
                            <label className="flex items-start gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    className="mt-1"
                                    checked={on}
                                    disabled={!canManage || saving}
                                    onChange={(e) => void save(type, e.target.checked)}
                                />
                                <span>
                                    <span className="font-semibold block">{info.label}</span>
                                    <span className="text-xs text-text-muted block">{info.encrypted}.</span>
                                    {devices.length > 0 && !keyInstalled && (
                                        <span role={on ? "alert" : undefined} className={`text-xs block ${on ? "text-danger" : "text-text-muted"}`}>
                                            {on ? "Breaks: " : "Left off because "}
                                            {devices.join(", ")} {devices.length === 1 ? "syncs" : "sync"} this - {on ? "it " : "protected, it "}
                                            {info.onDevices}.
                                        </span>
                                    )}
                                </span>
                            </label>
                        </li>
                    );
                })}
            </ul>
            <details className="mt-3 text-sm">
                <summary className="cursor-pointer font-semibold">What&rsquo;s encrypted, and what isn&rsquo;t</summary>
                <table className="mt-2 w-full text-xs border-collapse">
                    <thead>
                        <tr className="text-left">
                            <th className="py-1 pr-2">Type</th>
                            <th className="py-1 pr-2">Encrypted</th>
                            <th className="py-1">Readable by the server, and why</th>
                        </tr>
                    </thead>
                    <tbody>
                        {types.map((type) => (
                            <tr key={type} className="border-t border-border align-top">
                                <td className="py-1 pr-2 font-semibold">{ZERO_ACCESS_TYPE_INFO[type].label}</td>
                                <td className="py-1 pr-2">{typeIncluded(chosen, type) ? ZERO_ACCESS_TYPE_INFO[type].encrypted : "Nothing - not protected"}</td>
                                <td className="py-1">{ZERO_ACCESS_TYPE_INFO[type].readable}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <p className="mt-2 text-xs text-text-muted">
                    For every type, the server can also see folder and list names, how many items there are and when they change. Zero-access
                    encryption protects what is stored: the server sees what you save while it saves it, then keeps only the encrypted copy.
                </p>
            </details>
        </div>
    );
}
