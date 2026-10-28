///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ConfigKeyRotation, ConfigKeys } from "../../../../../lib/admin/configKeysApi.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `iso` to `now`, as the age of a key. */
export function ageText(iso: string, now: number): string {
    const days = Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS));
    return days < 1 ? "less than a day" : days === 1 ? "1 day" : `${days} days`;
}

/**
 * The key the deployment encrypts with. A key's own `active` is only what the copy that answered encrypts with, which differs between copies while they
 * reload the keyring, so once the rotation has activated its new key that is the one, and before then it is the one the copy reports other than the new key.
 */
export function activeKidOf(keys: ConfigKeys): string | null {
    const rotation = keys.rotation;
    if (rotation?.kid && rotation.activatedAt) {
        return rotation.kid;
    }
    if (rotation?.kid && (rotation.phase === "adding" || rotation.phase === "activating")) {
        return (
            keys.keys.find((key) => key.active && key.kid !== rotation.kid)?.kid ??
            keys.keys.find((key) => key.kid !== rotation.kid)?.kid ??
            null
        );
    }
    return keys.keys.find((key) => key.active)?.kid ?? keys.activeKid;
}

/** Whether `rotation` is still going: a finished or failed one is only shown. */
export function isRunning(rotation: ConfigKeyRotation | null | undefined): rotation is ConfigKeyRotation {
    return !!rotation && rotation.phase !== "done" && rotation.phase !== "failed";
}
