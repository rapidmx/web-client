///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { Contact } from "@rapidmx/react-shared/contacts/contactsApi.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import ContactAvatar from "@rapidmx/react-shared/components/avatar/ContactAvatar.js";

/** Groups a hex fingerprint into 4-character blocks (`ab12 cd34 ...`) for out-of-band verification -
 * the spec's own use case ("compare this over the phone") is materially easier with a grouped string
 * than one 64-character run. */
function formatFingerprint(fingerprint: string): string {
    return fingerprint.match(/.{1,4}/g)?.join(" ") ?? fingerprint;
}

export interface ContactDetailPaneProps {
    contact: Contact;
    onEdit: () => void;
    onDelete: () => void;
    /** Present only on the mobile detail route — renders a "back to contacts" link above the header. Absent
     * on the desktop inline pane, which never navigates away (selecting a different contact just swaps
     * `contact` in place). */
    backHref?: string;
}

/**
 * A contact's read-only detail view. Shared by the desktop inline pane (`apps/www/contacts/index.tsx`,
 * always visible alongside the contact list) and the mobile detail route
 * (`apps/www/contacts/[uid].tsx`, a full page on its own reached by tapping a contact row).
 */
export default function ContactDetailPane({ contact, onEdit, onDelete, backHref }: ContactDetailPaneProps) {
    return (
        <div role="region" aria-label="Contact details" className="max-w-xl flex flex-col gap-5">
            {backHref && (
                <a href={backHref} className="text-sm text-primary-dark hover:underline">
                    &larr; Back to contacts
                </a>
            )}
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                    <ContactAvatar displayName={contact.displayName} size={48} />
                    <div>
                        <h1 className="text-xl font-bold tracking-tight">{contact.displayName}</h1>
                        {contact.jobTitle && contact.company && (
                            <p className="text-sm text-text-muted mt-0.5">
                                {contact.jobTitle} at {contact.company}
                            </p>
                        )}
                    </div>
                </div>
                <div className="flex gap-2 shrink-0">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={onEdit}>
                        Edit
                    </Button>
                    <Button type="button" variant="secondary" className="!w-auto text-danger" onClick={onDelete}>
                        Delete
                    </Button>
                </div>
            </div>

            <div className="bg-surface border border-border rounded-md p-6 flex flex-col gap-4 text-sm">
                {contact.emails.length > 0 && (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Email</div>
                        {contact.emails.map((e, i) => (
                            <div key={i}>
                                {e.address} <span className="text-text-muted">({e.type})</span>
                            </div>
                        ))}
                    </div>
                )}
                {contact.phones.length > 0 && (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Phone</div>
                        {contact.phones.map((p, i) => (
                            <div key={i}>
                                {p.phoneNumber} <span className="text-text-muted">({p.type})</span>
                            </div>
                        ))}
                    </div>
                )}
                {contact.addresses.length > 0 && (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Address</div>
                        {contact.addresses.map((a, i) => (
                            <div key={i}>{[a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(", ")}</div>
                        ))}
                    </div>
                )}
                {contact.categories && contact.categories.length > 0 && (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Categories</div>
                        <div>{contact.categories.join(", ")}</div>
                    </div>
                )}
                {contact.notes && (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Notes</div>
                        <div>{contact.notes}</div>
                    </div>
                )}
                {(contact.keys && contact.keys.length > 0) || contact.encryptPreference || contact.keyConflict ? (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Encryption</div>
                        {contact.keyConflict && (
                            <div className="mb-2">
                                <Alert>
                                    <p className="mb-2">
                                        A different encryption key was observed for this contact on{" "}
                                        {new Date(contact.keyConflict.observedAt).toLocaleDateString()}. The
                                        previously verified key below is still the one in use — this is routine
                                        after a device change or reinstall, but it&rsquo;s also what a real attack
                                        looks like, so verify the new fingerprint with {contact.displayName}{" "}
                                        directly (e.g. by phone) before trusting it. There is no automatic way to
                                        accept or reject this yet.
                                    </p>
                                    <p className="font-mono text-xs">
                                        Newly observed: {formatFingerprint(contact.keyConflict.observedFingerprint)}
                                    </p>
                                </Alert>
                            </div>
                        )}
                        {contact.encryptPreference && (
                            <div className="mb-1">
                                {contact.encryptPreference.preferEncrypt === "mutual"
                                    ? "This contact also encrypts to you — messages to them can be encrypted."
                                    : "This contact has not indicated a mutual encryption preference."}
                            </div>
                        )}
                        {contact.keys?.map((key) => (
                            <div key={key.fingerprint} className="font-mono text-xs py-0.5">
                                {key.useType === "sign" ? "Signing" : "Encryption"} key: {formatFingerprint(key.fingerprint)}
                                {key.revokedAt && <span className="text-danger"> (revoked)</span>}
                            </div>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
