///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { gravatarEnabled, gravatarUrl, isGravatarMissing, markGravatarMissing, subscribeGravatarPreference } from "../../contacts/gravatar.js";

export interface ContactAvatarProps {
    displayName: string;
    size?: number;
    /** The contact's own picture (see `contactPhotoUrl()`); shown in preference to anything else. */
    photoUrl?: string;
    /** The contact's address: without a picture of their own, its Gravatar is shown when there is one (and the reader turned that on in Settings > Privacy). */
    email?: string;
}

/** A fixed palette of background colors, cycled by a hash of the contact's name, for the initials shown when there is no picture. */
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

/**
 * A small circular avatar for a contact, matching Outlook People's: the contact's own picture when they have one, else their Gravatar (when `email`
 * is given), else initials on a color that is deterministic per name. A picture that fails to load falls through to the next.
 */
export default function ContactAvatar({ displayName, size = 32, photoUrl, email }: ContactAvatarProps) {
    const [gravatar, setGravatar] = useState<string | undefined>();
    const [failed, setFailed] = useState<string[]>([]);
    const enabled = useSyncExternalStore(subscribeGravatarPreference, gravatarEnabled, () => false);
    // Without IntersectionObserver there is no telling what is on screen, so look up at once.
    const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
    const placeholder = useRef<HTMLSpanElement>(null);
    const ownPicture = !!photoUrl && !failed.includes(photoUrl);

    // A new picture gets a fresh start, whatever failed to load before.
    useEffect(() => {
        setFailed((list) => (list.length ? [] : list));
    }, [photoUrl]);

    // Only an avatar that is on screen (and has no picture of its own to show) asks Gravatar, so a long list does not send a request per row.
    useEffect(() => {
        const element = placeholder.current;
        if (visible || !enabled || !email || ownPicture || !element) {
            return;
        }
        const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setVisible(true));
        observer.observe(element);
        return () => observer.disconnect();
    }, [visible, enabled, email, ownPicture]);

    useEffect(() => {
        setGravatar(undefined);
        if (!email || !enabled || !visible || ownPicture) {
            return;
        }
        let cancelled = false;
        void gravatarUrl(email, size * 2).then((url) => !cancelled && setGravatar(url && !isGravatarMissing(url) ? url : undefined));
        return () => {
            cancelled = true;
        };
    }, [email, size, enabled, visible, ownPicture]);

    const src = [photoUrl, gravatar].find((url) => url && !failed.includes(url));
    if (src) {
        return (
            <img
                src={src}
                alt=""
                aria-hidden="true"
                width={size}
                height={size}
                referrerPolicy="no-referrer"
                onError={() => {
                    if (src === gravatar) {
                        markGravatarMissing(src);
                    }
                    setFailed((list) => [...list, src]);
                }}
                className="inline-block rounded-full object-cover shrink-0"
                style={{ width: size, height: size }}
            />
        );
    }
    return (
        <span
            ref={placeholder}
            aria-hidden="true"
            style={{ width: size, height: size, backgroundColor: colorOf(displayName), fontSize: size * 0.4 }}
            className="inline-flex items-center justify-center rounded-full text-white font-semibold shrink-0"
        >
            {initialsOf(displayName)}
        </span>
    );
}
