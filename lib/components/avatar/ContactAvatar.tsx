///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";

export interface ContactAvatarProps {
    displayName: string;
    size?: number;
}

/** A fixed palette of background colors, cycled by a hash of the contact's name — no photo upload feature
 * exists yet (`Contact.photoBlobKey` is modeled server-side but nothing in this app sets/reads it), so every
 * contact gets one of these deterministically rather than a plain generic gray circle for everyone. */
const PALETTE = ["#7c3aed", "#2563eb", "#0891b2", "#059669", "#d97706", "#dc2626", "#db2777", "#4f46e5"];

function initialsOf(displayName: string): string {
    const parts = displayName.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        return "?";
    }
    const first = parts[0][0];
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase();
}

function colorOf(displayName: string): string {
    let hash = 0;
    for (let i = 0; i < displayName.length; i++) {
        hash = (hash * 31 + displayName.charCodeAt(i)) | 0;
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** A small circular initials avatar for a contact, matching Outlook People's list-row avatars — deterministic
 * per name (same contact always gets the same color/initials), no photo-upload dependency. */
export default function ContactAvatar({ displayName, size = 32 }: ContactAvatarProps) {
    return (
        <span
            aria-hidden="true"
            style={{ width: size, height: size, backgroundColor: colorOf(displayName), fontSize: size * 0.4 }}
            className="inline-flex items-center justify-center rounded-full text-white font-semibold shrink-0"
        >
            {initialsOf(displayName)}
        </span>
    );
}
