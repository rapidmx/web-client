///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useCallback, useState } from "react";
import type { Contact } from "../../contacts/contactsApi.js";
import { useContactPhoto } from "../../contacts/useContactPhotoSrc.js";
import { useApiClient } from "../../util/apiClientContext.js";
import ContactAvatar, { type ContactAvatarProps } from "./ContactAvatar.js";

export interface ContactPhotoAvatarProps extends Omit<ContactAvatarProps, "photoUrl"> {
    /** The stored contact whose own picture is shown, if any. */
    contact?: Pick<Contact, "uid" | "version" | "photoBlobKey">;
    /** For a row of a long list: a picture that has to be fetched (a token-authenticated app) is only fetched once the avatar scrolls into view. */
    lazy?: boolean;
}

/** A `ContactAvatar` showing a stored contact's own picture the way the current app can load it - see `useContactPhotoSrc()`. */
export default function ContactPhotoAvatar({ contact, lazy, ...rest }: ContactPhotoAvatarProps) {
    // Without IntersectionObserver there is no telling what is on screen, so the picture is fetched at once.
    const [visible, setVisible] = useState(() => !lazy || typeof IntersectionObserver === "undefined");
    const show = useCallback(() => setVisible(true), []);
    const { src, failed } = useContactPhoto(contact, useApiClient(), visible);
    // A picture that exists but is not here yet - not fetched yet or on its way - keeps Gravatar from being asked; one that could not be fetched does not.
    return <ContactAvatar {...rest} photoUrl={src} photoPending={!!contact?.photoBlobKey && !src && !failed} onVisible={visible ? undefined : show} />;
}
