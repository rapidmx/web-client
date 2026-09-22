///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineExclamationTriangle, HiOutlineLockClosed } from "react-icons/hi2";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { useResolvedTheme } from "../../../appearance/resolvedTheme.js";
import { formatColour } from "./color.js";
import { useThemeSurface } from "./themeSurface.js";

export interface EncryptedBodyProps {
    /** This device has no unlocked key session for the message's mailbox: unlocking could help. */
    locked: boolean;
    /** Why the message couldn't be decrypted when the keys were available (shown for the failed state). */
    reason?: string;
    /** Opens the app's unlock prompt (`useUnlockPrompt().requestUnlock`). Only used - and only offered - when `locked`. */
    onUnlock: () => void;
    /** An unlock is being asked for: the button waits. */
    unlocking?: boolean;
}

/**
 * What an encrypted message's body is until (and unless) it can be read, drawn as card content in the app's own tokens: on the theme's opaque surface, so
 * it stays legible over a translucent card and a background photo.
 *
 * **Locked** - the keys are not unlocked: a lock, "This message is encrypted", a hint and a primary Unlock button, which opens the same prompt compose's
 * "Unlock to sign or encrypt" does. When it succeeds the pane decrypts and shows the message in place.
 * **Cannot be decrypted** - the keys are unlocked and it still can't be opened (no key for this mailbox, not a recipient, damaged, unsupported): the reason,
 * and no button - unlocking again wouldn't change it.
 */
export default function EncryptedBody({ locked, reason, onUnlock, unlocking = false }: EncryptedBodyProps) {
    const theme = useResolvedTheme();
    const surface = useThemeSurface(theme);
    const Icon = locked ? HiOutlineLockClosed : HiOutlineExclamationTriangle;
    return (
        <div
            className="flex flex-col items-center gap-2 rounded-md border border-border px-4 py-8 text-center"
            style={{ backgroundColor: formatColour(surface.background) }}
        >
            <span
                aria-hidden="true"
                className={["inline-flex h-12 w-12 items-center justify-center rounded-full", locked ? "bg-primary/10 text-primary-dark" : "bg-warning/15 text-text"].join(" ")}
            >
                <Icon size={24} />
            </span>
            <p className="text-base font-semibold text-text">{locked ? "This message is encrypted" : "This message can’t be decrypted"}</p>
            {locked ? (
                <>
                    <p className="text-sm text-text-muted">Unlock your keys to read it</p>
                    <Button type="button" className="!w-auto mt-1" aria-label="Unlock to view this message" loading={unlocking} disabled={unlocking} onClick={onUnlock}>
                        Unlock
                    </Button>
                </>
            ) : (
                reason && (
                    <div className="mt-1 max-w-prose text-left">
                        <Alert>{reason}</Alert>
                    </div>
                )
            )}
        </div>
    );
}
