///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useSyncExternalStore } from "react";
import { gravatarEnabled, setGravatarEnabled, subscribeGravatarPreference } from "../../../../lib/contacts/gravatar.js";

/**
 * The opt-in for Gravatar contact pictures. A per-browser preference (not the mailbox's), off until turned on, because looking a picture up tells
 * gravatar.com the contact's address hash and the reader's IP address.
 */
export default function GravatarSetting() {
    const enabled = useSyncExternalStore(subscribeGravatarPreference, gravatarEnabled, () => false);
    return (
        <div>
            <h2 className="text-sm font-semibold mb-2">Contact pictures</h2>
            <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={enabled} onChange={(e) => setGravatarEnabled(e.target.checked)} />
                Show profile pictures from Gravatar
            </label>
            <p className="text-xs text-text-muted mt-2">
                Looks up each contact&apos;s picture by sending a hash of their email address to gravatar.com, which also sees your IP address. Off by
                default; applies to this browser only.
            </p>
        </div>
    );
}
