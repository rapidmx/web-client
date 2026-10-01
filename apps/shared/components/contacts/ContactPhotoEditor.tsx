///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import ContactPhotoAvatar from "../../../../lib/components/avatar/ContactPhotoAvatar.js";
import ImageEditBadge from "../../../../lib/components/forms/ImageEditBadge.js";
import { type Contact, deleteContactPhoto, uploadContactPhoto } from "../../../../lib/contacts/contactsApi.js";
import { ContactPhotoError, prepareContactPhoto } from "../../../../lib/contacts/preparePhoto.js";
import { useApiClient } from "../../../../lib/util/apiClientContext.js";
import { notify } from "../../notifications/store.js";
import { notifyApiError } from "../../notifications/apiErrors.js";

export interface ContactPhotoEditorProps {
    /** The stored contact whose picture is changed. */
    contact: Contact;
    displayName: string;
    size: number;
    /** The contact's address, for the Gravatar shown while they have no picture of their own. */
    email?: string;
    /** `"sm"` for an avatar too small for the default badge. */
    badgeSize?: "sm" | "md";
    /** Called with the contact as stored after its picture was set or removed. */
    onChanged: (contact: Contact) => void;
}

const FAILURE_TITLE = "Couldn't change this contact's photo";

/**
 * A stored contact's avatar with the camera badge of `ImageEditBadge` at its lower right: unlike the edit form (`ContactPhotoField`), which keeps a chosen picture until the
 * contact is saved, a picture chosen or taken here is made ready and saved at once, and removing it is too. A refusal (a view-only share, a stale version) is a pop-up.
 */
export default function ContactPhotoEditor({ contact, displayName, size, email, badgeSize, onChanged }: ContactPhotoEditorProps) {
    const client = useApiClient();
    const [busy, setBusy] = useState(false);

    async function change(work: () => Promise<Contact>) {
        setBusy(true);
        try {
            onChanged(await work());
        } catch (err) {
            if (err instanceof ContactPhotoError) {
                notify({ kind: "error", title: FAILURE_TITLE, message: err.message });
            } else {
                notifyApiError(err, FAILURE_TITLE);
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="relative inline-block shrink-0">
            <ContactPhotoAvatar displayName={displayName} size={size} contact={contact} email={email} />
            <ImageEditBadge
                position="bottom-right"
                size={badgeSize}
                label="Change contact photo"
                fileInputLabel="Contact photo file"
                hasImage={!!contact.photoBlobKey}
                busy={busy}
                onFile={(file) =>
                    void change(async () => uploadContactPhoto(contact.uid, contact.version, await prepareContactPhoto(file), client))
                }
                onRemove={() => void change(() => deleteContactPhoto(contact.uid, contact.version, client))}
            />
        </div>
    );
}
