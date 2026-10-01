///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { Contact } from "../../contacts/contactsApi.js";
import { useContactPhotoSrc } from "../../contacts/useContactPhotoSrc.js";
import { useApiClient } from "../../util/apiClientContext.js";
import ContactAvatar, { type ContactAvatarProps } from "./ContactAvatar.js";

export interface ContactPhotoAvatarProps extends Omit<ContactAvatarProps, "photoUrl"> {
    /** The stored contact whose own picture is shown, if any. */
    contact?: Pick<Contact, "uid" | "version" | "photoBlobKey">;
}

/** A `ContactAvatar` showing a stored contact's own picture the way the current app can load it - see `useContactPhotoSrc()`. */
export default function ContactPhotoAvatar({ contact, ...rest }: ContactPhotoAvatarProps) {
    const photoUrl = useContactPhotoSrc(contact, useApiClient());
    return <ContactAvatar {...rest} photoUrl={photoUrl} />;
}
