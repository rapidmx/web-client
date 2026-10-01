///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import ContactAvatar from "../../../../lib/components/avatar/ContactAvatar.js";
import { ContactPhotoError, prepareContactPhoto } from "../../../../lib/contacts/preparePhoto.js";
import ImageEditBadge from "../../../../lib/components/forms/ImageEditBadge.js";

export interface ContactPhotoFieldProps {
    displayName: string;
    /** The contact's first address, for the Gravatar shown while they have no picture of their own. */
    email?: string;
    /** The picture the contact has now (`useContactPhotoSrc()`), if any. */
    currentUrl?: string;
    /** The picture chosen to replace it, not uploaded until the contact is saved; `null` for none. */
    picked: File | null;
    /** Whether the current picture is to be removed when the contact is saved. */
    removed: boolean;
    onPick: (file: File) => void;
    onRemove: () => void;
    /** Called with the reason a chosen file was turned down. */
    onReject: (message: string) => void;
    /** Called with `true` while a chosen file is being made ready, so the form is not saved before it is, and with `false` after. */
    onBusyChange: (busy: boolean) => void;
}

/**
 * The picture of a contact in the edit form: the avatar as it is (their picture, else Gravatar, else initials) with a camera badge at its lower right that opens a
 * menu (`ImageEditBadge`) - "Upload file", "Take photo" and, when there is a picture of their own, "Remove photo". Any picture is taken (a phone's camera photo of several megabytes,
 * in any orientation, included): it is made small enough here by `prepareContactPhoto()` and only uploaded when the form is saved.
 */
export default function ContactPhotoField({ displayName, email, currentUrl, picked, removed, onPick, onRemove, onReject, onBusyChange }: ContactPhotoFieldProps) {
    const [preview, setPreview] = useState<string | undefined>();
    const [preparing, setPreparing] = useState(false);

    useEffect(() => {
        if (!picked) {
            setPreview(undefined);
            return;
        }
        const url = URL.createObjectURL(picked);
        setPreview(url);
        return () => URL.revokeObjectURL(url);
    }, [picked]);

    async function handleChange(file: File) {
        setPreparing(true);
        onBusyChange(true);
        try {
            onPick(await prepareContactPhoto(file));
        } catch (err) {
            onReject(err instanceof ContactPhotoError ? err.message : "This picture could not be read - choose another one.");
        } finally {
            setPreparing(false);
            onBusyChange(false);
        }
    }

    const shown = picked ? preview : removed ? undefined : currentUrl;
    const hasOwn = !!picked || (!!currentUrl && !removed);
    return (
        <div className="flex items-center gap-4 mb-3">
            <div className="relative inline-block shrink-0">
                <ContactAvatar displayName={displayName || "?"} size={72} photoUrl={shown} email={picked || (currentUrl && !removed) ? undefined : email} />
                <ImageEditBadge
                    position="bottom-right"
                    label="Change contact photo"
                    fileInputLabel="Contact photo file"
                    hasImage={hasOwn}
                    busy={preparing}
                    onFile={(file) => void handleChange(file)}
                    onRemove={onRemove}
                />
            </div>
            {preparing && (
                <span role="status" className="text-xs text-text-muted">
                    Preparing picture…
                </span>
            )}
        </div>
    );
}
