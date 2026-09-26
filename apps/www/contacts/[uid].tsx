///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { pageTitle } from "../../shared/navigation/pageTitle.js";
import { useNavigate } from "../../shared/navigation/index.js";
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Contact, deleteContact, getContact } from "@rapidmx/react-shared/contacts/contactsApi.js";
import ContactsShell, { ContactsShellProps } from "../../shared/components/contacts/layout/ContactsShell.js";
import ContactDetailPane from "../../shared/components/contacts/ContactDetailPane.js";
import ContactForm from "../../shared/components/contacts/ContactForm.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import { clearPinnedSignerCache } from "../../shared/components/mail/pinnedSigners.js";
import { notifyApiError } from "../../shared/notifications/apiErrors.js";

/**
 * Only reached on mobile (below the `md` breakpoint) — desktop's `apps/www/contacts/index.tsx` keeps its
 * existing inline detail pane and never navigates here; see that file's `handleSelectRow`. There is no
 * equivalent "new contact" route — an unsaved contact has no uid to route on, so creation stays an
 * in-place mode-switch on every device (see `apps/www/contacts/index.tsx`'s `handleNew`).
 */
function ContactDetailPage(props: ContactsShellProps & { params: { uid: string } }) {
    return (
        <ContactsShell {...props}>
            <ContactDetailContent uid={props.params.uid} />
        </ContactsShell>
    );
}

type Mode = "view" | "edit";

function ContactDetailContent({ uid }: { uid: string }) {
    const navigate = useNavigate();
    const [contact, setContact] = useState<Contact | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<Mode>("view");

    useEffect(() => {
        setLoading(true);
        setError(null);
        getContact(uid)
            .then(setContact)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this contact."))
            .finally(() => setLoading(false));
    }, [uid]);

    // Takes `contact` as a parameter rather than reading it from the closure/state — mirrors the desktop
    // pane's own `handleDelete` in `apps/www/contacts/index.tsx`. The only caller (below) is only ever
    // rendered once `contact` is already resolved (see the `error || !contact` guard above it), so this
    // never runs with a stale/absent contact — no redundant null check needed here.
    async function handleDelete(contact: Contact) {
        try {
            await deleteContact(contact.uid, contact.version);
            // A deleted contact's pinned signing keys must stop vouching for signatures.
            clearPinnedSignerCache();
            navigate("/contacts");
        } catch (err) {
            // A pop-up: a failed delete leaves the contact on screen rather than replacing the page with an error.
            notifyApiError(err, "Couldn't delete the contact");
        }
    }

    // After a key change was resolved (or found stale): re-read the contact, keeping the one shown if that fails.
    function handleKeysChanged() {
        getContact(uid).then(setContact, () => undefined);
    }

    if (loading) {
        return <p className="p-8 text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error || !contact) {
        return <Alert>{error ?? "Contact not found."}</Alert>;
    }

    const backHref = "/contacts";
    if (mode === "edit") {
        return (
            <div>
                <a href={backHref} className="text-sm text-primary-dark hover:underline block px-6 pt-6">
                    &larr; Back to contacts
                </a>
                <ContactForm
                    contact={contact}
                    onSaved={(saved) => {
                        setContact(saved);
                        setMode("view");
                    }}
                    onCancel={() => setMode("view")}
                />
            </div>
        );
    }

    return (
        <div className="p-6">
            <ContactDetailPane
                contact={contact}
                onEdit={() => setMode("edit")}
                onDelete={() => handleDelete(contact)}
                backHref={backHref}
                onKeysChanged={handleKeysChanged}
            />
        </div>
    );
}

export default ContactDetailPage;

/** The tab's title: `Brand: Contacts` (see `pageTitle()`). */
export const title = pageTitle("Contacts");
