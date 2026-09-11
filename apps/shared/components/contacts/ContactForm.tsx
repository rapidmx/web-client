///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import {
    Contact,
    ContactAddressKind,
    ContactEmail,
    ContactPhone,
    ContactPostalAddress,
    createContact,
    updateContact,
} from "@rapidmx/react-shared/contactsApi.js";
import Alert from "../feedback/Alert.js";
import Button from "../buttons/Button.js";
import FormField from "../forms/FormField.js";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";
const SELECT_CLASS =
    "text-sm py-2 px-2 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export interface ContactFormProps {
    contact?: Contact;
    mailboxUid?: string;
    folderUid?: string;
    onSaved: (contact: Contact) => void;
    onCancel: () => void;
}

const ADDRESS_KINDS: ContactAddressKind[] = ["home", "work", "other"];

/**
 * A contact's create/edit form. Shared by the desktop inline pane (`apps/www/contacts/index.tsx`) and the
 * mobile detail route's own edit mode (`apps/www/contacts/[uid].tsx`) — creation itself stays
 * desktop-and-mobile-inline (see that route's own doc comment on why "new" never gets a dedicated route).
 */
export default function ContactForm({ contact, mailboxUid, folderUid, onSaved, onCancel }: ContactFormProps) {
    const [displayName, setDisplayName] = useState(contact?.displayName ?? "");
    const [givenName, setGivenName] = useState(contact?.givenName ?? "");
    const [surname, setSurname] = useState(contact?.surname ?? "");
    const [company, setCompany] = useState(contact?.company ?? "");
    const [jobTitle, setJobTitle] = useState(contact?.jobTitle ?? "");
    const [notes, setNotes] = useState(contact?.notes ?? "");
    const [favorite, setFavorite] = useState(contact?.favorite ?? false);
    const [categoriesText, setCategoriesText] = useState((contact?.categories ?? []).join(", "));
    const [emails, setEmails] = useState<ContactEmail[]>(contact?.emails ?? []);
    const [phones, setPhones] = useState<ContactPhone[]>(contact?.phones ?? []);
    const [address, setAddress] = useState<ContactPostalAddress | null>(contact?.addresses[0] ?? null);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    function updateEmail(index: number, patch: Partial<ContactEmail>) {
        setEmails((prev) => prev.map((e, i) => (i === index ? { ...e, ...patch } : e)));
    }
    function removeEmail(index: number) {
        setEmails((prev) => prev.filter((_, i) => i !== index));
    }
    function updatePhone(index: number, patch: Partial<ContactPhone>) {
        setPhones((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
    }
    function removePhone(index: number) {
        setPhones((prev) => prev.filter((_, i) => i !== index));
    }

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);

        if (!displayName.trim()) {
            setError("A display name is required.");
            return;
        }

        setSaving(true);
        try {
            const categories = categoriesText
                .split(",")
                .map((c) => c.trim())
                .filter(Boolean);
            const input = {
                displayName: displayName.trim(),
                givenName: givenName.trim() || undefined,
                surname: surname.trim() || undefined,
                company: company.trim() || undefined,
                jobTitle: jobTitle.trim() || undefined,
                notes: notes.trim() || undefined,
                favorite,
                categories,
                emails,
                phones,
                addresses: address ? [address] : [],
            };
            const saved = contact
                ? await updateContact({ uid: contact.uid, version: contact.version, mailboxUid: contact.mailboxUid, folderUid: contact.folderUid, ...input })
                : await createContact({ mailboxUid: mailboxUid as string, folderUid: folderUid as string, ...input });
            onSaved(saved);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save this contact.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="max-w-xl flex flex-col gap-1">
            <h1 className="text-xl font-bold uppercase tracking-wide mb-3">{contact ? "Edit contact" : "New contact"}</h1>

            {error && <Alert>{error}</Alert>}

            <FormField label="Display name" htmlFor="contact-displayName">
                <input
                    id="contact-displayName"
                    type="text"
                    className={INPUT_CLASS}
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                />
            </FormField>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label="First name" htmlFor="contact-givenName">
                    <input id="contact-givenName" type="text" className={INPUT_CLASS} value={givenName} onChange={(e) => setGivenName(e.target.value)} />
                </FormField>
                <FormField label="Last name" htmlFor="contact-surname">
                    <input id="contact-surname" type="text" className={INPUT_CLASS} value={surname} onChange={(e) => setSurname(e.target.value)} />
                </FormField>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label="Company" htmlFor="contact-company">
                    <input id="contact-company" type="text" className={INPUT_CLASS} value={company} onChange={(e) => setCompany(e.target.value)} />
                </FormField>
                <FormField label="Job title" htmlFor="contact-jobTitle">
                    <input id="contact-jobTitle" type="text" className={INPUT_CLASS} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
                </FormField>
            </div>

            <label className="flex items-center gap-2 text-sm mb-4">
                <input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />
                Favorite
            </label>

            <FormField label="Categories (comma-separated)" htmlFor="contact-categories">
                <input
                    id="contact-categories"
                    type="text"
                    className={INPUT_CLASS}
                    value={categoriesText}
                    onChange={(e) => setCategoriesText(e.target.value)}
                    placeholder="VIP, Work"
                />
            </FormField>

            <FormField label="Email" htmlFor="contact-emails">
                <div id="contact-emails" className="flex flex-col gap-2">
                    {emails.map((email, i) => (
                        <div key={i} className="flex gap-2">
                            <input
                                type="email"
                                className={`${INPUT_CLASS} flex-1`}
                                value={email.address}
                                onChange={(e) => updateEmail(i, { address: e.target.value })}
                                aria-label={`Email address ${i + 1}`}
                            />
                            <select
                                className={SELECT_CLASS}
                                value={email.type}
                                onChange={(e) => updateEmail(i, { type: e.target.value as ContactAddressKind })}
                                aria-label={`Email type ${i + 1}`}
                            >
                                {ADDRESS_KINDS.map((kind) => (
                                    <option key={kind} value={kind}>
                                        {kind}
                                    </option>
                                ))}
                            </select>
                            <button type="button" onClick={() => removeEmail(i)} className="text-sm text-danger px-2" aria-label={`Remove email ${i + 1}`}>
                                &times;
                            </button>
                        </div>
                    ))}
                    <button
                        type="button"
                        onClick={() => setEmails((prev) => [...prev, { address: "", type: "work" }])}
                        className="self-start text-xs font-medium text-primary-dark hover:underline"
                    >
                        + Add email
                    </button>
                </div>
            </FormField>

            <FormField label="Phone" htmlFor="contact-phones">
                <div id="contact-phones" className="flex flex-col gap-2">
                    {phones.map((phone, i) => (
                        <div key={i} className="flex gap-2">
                            <input
                                type="tel"
                                className={`${INPUT_CLASS} flex-1`}
                                value={phone.phoneNumber}
                                onChange={(e) => updatePhone(i, { phoneNumber: e.target.value })}
                                aria-label={`Phone number ${i + 1}`}
                            />
                            <select
                                className={SELECT_CLASS}
                                value={phone.type}
                                onChange={(e) => updatePhone(i, { type: e.target.value as ContactAddressKind })}
                                aria-label={`Phone type ${i + 1}`}
                            >
                                {ADDRESS_KINDS.map((kind) => (
                                    <option key={kind} value={kind}>
                                        {kind}
                                    </option>
                                ))}
                            </select>
                            <button type="button" onClick={() => removePhone(i)} className="text-sm text-danger px-2" aria-label={`Remove phone ${i + 1}`}>
                                &times;
                            </button>
                        </div>
                    ))}
                    <button
                        type="button"
                        onClick={() => setPhones((prev) => [...prev, { phoneNumber: "", type: "work" }])}
                        className="self-start text-xs font-medium text-primary-dark hover:underline"
                    >
                        + Add phone
                    </button>
                </div>
            </FormField>

            <FormField label="Address" htmlFor="contact-address">
                {address ? (
                    <div className="flex flex-col gap-2">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <input
                                type="text"
                                placeholder="Street"
                                className={INPUT_CLASS}
                                value={address.street ?? ""}
                                onChange={(e) => setAddress({ ...address, street: e.target.value })}
                            />
                            <input
                                type="text"
                                placeholder="City"
                                className={INPUT_CLASS}
                                value={address.city ?? ""}
                                onChange={(e) => setAddress({ ...address, city: e.target.value })}
                            />
                            <input
                                type="text"
                                placeholder="State/Province"
                                className={INPUT_CLASS}
                                value={address.state ?? ""}
                                onChange={(e) => setAddress({ ...address, state: e.target.value })}
                            />
                            <input
                                type="text"
                                placeholder="Postal code"
                                className={INPUT_CLASS}
                                value={address.postalCode ?? ""}
                                onChange={(e) => setAddress({ ...address, postalCode: e.target.value })}
                            />
                            <input
                                type="text"
                                placeholder="Country"
                                className={INPUT_CLASS}
                                value={address.country ?? ""}
                                onChange={(e) => setAddress({ ...address, country: e.target.value })}
                            />
                            <select
                                className={SELECT_CLASS}
                                value={address.type}
                                onChange={(e) => setAddress({ ...address, type: e.target.value as ContactAddressKind })}
                                aria-label="Address type"
                            >
                                {ADDRESS_KINDS.map((kind) => (
                                    <option key={kind} value={kind}>
                                        {kind}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <button type="button" onClick={() => setAddress(null)} className="self-start text-xs font-medium text-danger hover:underline">
                            Remove address
                        </button>
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={() => setAddress({ type: "home" })}
                        className="self-start text-xs font-medium text-primary-dark hover:underline"
                    >
                        + Add address
                    </button>
                )}
            </FormField>

            <FormField label="Notes" htmlFor="contact-notes">
                <textarea id="contact-notes" rows={3} className={INPUT_CLASS} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </FormField>

            <div className="flex gap-3 mt-2">
                <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                    Save
                </Button>
                <Button type="button" variant="secondary" className="!w-auto" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
