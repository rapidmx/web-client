///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState } from "react";
import ContactAvatar from "../../../../lib/components/avatar/ContactAvatar.js";
import Button from "../../../../lib/components/buttons/Button.js";
import { CONTACT_PHOTO_MAX_BYTES, CONTACT_PHOTO_TYPES } from "../../../../lib/contacts/contactsApi.js";

export interface ContactPhotoFieldProps {
    displayName: string;
    /** The contact's first address, for the Gravatar shown while they have no picture of their own. */
    email?: string;
    /** The picture the contact has now (`contactPhotoUrl()`), if any. */
    currentUrl?: string;
    /** The picture chosen to replace it, not uploaded until the contact is saved; `null` for none. */
    picked: File | null;
    /** Whether the current picture is to be removed when the contact is saved. */
    removed: boolean;
    onPick: (file: File) => void;
    onRemove: () => void;
    /** Called with the reason a chosen file was turned down. */
    onReject: (message: string) => void;
}

/**
 * The picture of a contact in the edit form: the avatar as it is (their picture, else Gravatar, else initials) with "Change photo" and, when
 * there is a picture of their own, "Remove photo". A file is checked here (type and size) and only uploaded when the form is saved.
 */
export default function ContactPhotoField({ displayName, email, currentUrl, picked, removed, onPick, onRemove, onReject }: ContactPhotoFieldProps) {
    const input = useRef<HTMLInputElement>(null);
    const [preview, setPreview] = useState<string | undefined>();

    useEffect(() => {
        if (!picked) {
            setPreview(undefined);
            return;
        }
        const url = URL.createObjectURL(picked);
        setPreview(url);
        return () => URL.revokeObjectURL(url);
    }, [picked]);

    function handleChange(file: File | undefined) {
        if (!file) {
            return;
        }
        if (!CONTACT_PHOTO_TYPES.includes(file.type)) {
            onReject("Choose a JPEG, PNG, GIF or WebP image.");
        } else if (file.size > CONTACT_PHOTO_MAX_BYTES) {
            onReject("Choose an image no larger than 1 MB.");
        } else {
            onPick(file);
        }
    }

    const shown = picked ? preview : removed ? undefined : currentUrl;
    const hasOwn = !!picked || (!!currentUrl && !removed);
    return (
        <div className="flex items-center gap-4 mb-3">
            <ContactAvatar displayName={displayName || "?"} size={72} photoUrl={shown} email={picked || (currentUrl && !removed) ? undefined : email} />
            <div className="flex flex-wrap gap-2">
                <input
                    ref={input}
                    type="file"
                    accept={CONTACT_PHOTO_TYPES.join(",")}
                    aria-label="Contact photo file"
                    className="sr-only"
                    tabIndex={-1}
                    onChange={(e) => {
                        handleChange(e.target.files?.[0]);
                        e.target.value = "";
                    }}
                />
                <Button type="button" variant="secondary" className="!w-auto !py-1 !px-3 text-xs" onClick={() => input.current?.click()}>
                    {hasOwn ? "Change photo" : "Add photo"}
                </Button>
                {hasOwn && (
                    <Button type="button" variant="secondary" className="!w-auto !py-1 !px-3 text-xs" onClick={onRemove}>
                        Remove photo
                    </Button>
                )}
            </div>
        </div>
    );
}
