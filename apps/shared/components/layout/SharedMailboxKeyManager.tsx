///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useRef } from "react";
import { getUnlockedKeys, personallyUnlockedKeys, subscribeKeySession } from "../../../../lib/crypto/keySession.js";
import type { Mailbox } from "../../../../lib/mail/mailApi.js";
import type { ApiClient } from "../../../../lib/util/api.js";
import { useApiClient } from "../../../../lib/util/apiClientContext.js";
import { notify } from "../../notifications/store.js";

/** How often the shared mailboxes are looked after again while some own mailbox stays unlocked. */
export const SHARED_MAILBOX_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** The shared mailbox key code (pkijs and friends), loaded only once an own mailbox is unlocked. */
let loaded: Promise<typeof import("../../../../lib/crypto/sharedMailboxKeys.js")> | undefined;
const loadSharedKeys = () =>
    (loaded ??= import("../../../../lib/crypto/sharedMailboxKeys.js").catch((err) => {
        loaded = undefined;
        throw err;
    }));

/** The refused rotations already shown, per mailbox (the reason): each is shown once a session, not on every pass that retries it. */
const shownRefusals = new Map<string, string>();

/** Forgets which refused rotations were shown (tests). */
export function resetSharedMailboxKeyManager(): void {
    shownRefusals.clear();
}

export interface SharedMailboxKeyManagerProps {
    /** Every mailbox the user can open. */
    mailboxes: Mailbox[];
    userUid?: string;
}

/**
 * Looks after the zero-access keys of the user's shared mailboxes (`lib/crypto/sharedMailboxKeys.ts`) whenever a mailbox of their own is
 * unlocked, and every `SHARED_MAILBOX_CHECK_INTERVAL_MS` after that: opens each mailbox shared with them through their member key wraps (no
 * password), and - for a mailbox they own or manage - provisions, rotates and shares its key with members still waiting. Best effort and
 * silent (a pass that fails is tried again on the next), except for a rotation the server refuses, shown once as a warning. Renders nothing; mounted by `MailShell`.
 */
export default function SharedMailboxKeyManager({ mailboxes, userUid }: SharedMailboxKeyManagerProps) {
    const client = useApiClient();
    const latest = useRef({ mailboxes, userUid, client });
    latest.current = { mailboxes, userUid, client };
    const running = useRef(false);

    useEffect(() => {
        async function pass(): Promise<void> {
            if (running.current || personallyUnlockedKeys().length === 0) {
                return;
            }
            running.current = true;
            try {
                const { maintainSharedMailbox, unlockSharedMailbox } = await loadSharedKeys();
                const { mailboxes: current, userUid: me, client: apiClient } = latest.current;
                for (const mailbox of current) {
                    await look(mailbox, me, apiClient, unlockSharedMailbox, maintainSharedMailbox).catch(() => undefined);
                }
            } catch {
                // Nothing to do until the next pass.
            } finally {
                running.current = false;
            }
        }
        void pass();
        const unsubscribe = subscribeKeySession((event) => {
            if (event.state === "unlocked" && !getUnlockedKeys(event.mailboxUid)?.shared) {
                void pass();
            }
        });
        const interval = setInterval(() => void pass(), SHARED_MAILBOX_CHECK_INTERVAL_MS);
        return () => {
            unsubscribe();
            clearInterval(interval);
        };
    }, []);

    return null;
}

async function look(
    mailbox: Mailbox,
    me: string | undefined,
    client: ApiClient | undefined,
    unlockSharedMailbox: (uid: string, client?: ApiClient, refresh?: boolean) => Promise<string>,
    maintainSharedMailbox: (
        uid: string,
        address: string,
        client?: ApiClient,
    ) => Promise<{ provisioned: boolean; rotated: boolean; rotationRefused?: string }>,
): Promise<void> {
    const owned = !!mailbox.ownerUserUid && mailbox.ownerUserUid === me;
    if (!owned) {
        // Opened, or - once open - opened again when a rotation left it without the active key.
        await unlockSharedMailbox(mailbox.uid, client, true);
    }
    const unlocked = getUnlockedKeys(mailbox.uid);
    // An owner looks after their mailbox with its own keys; a member, with full access, whether or not it is open yet (a mailbox
    // without an owner may have no key to open).
    if (owned ? unlocked && !unlocked.shared : true) {
        const done = await maintainSharedMailbox(mailbox.uid, mailbox.primarySmtpAddress, client);
        // The server kept the current key (its vault can't take the new key's member wraps): say so once, members keep reading.
        if (done.rotationRefused && shownRefusals.get(mailbox.uid) !== done.rotationRefused) {
            shownRefusals.set(mailbox.uid, done.rotationRefused);
            notify({
                kind: "warning",
                title: `${mailbox.displayName || mailbox.primarySmtpAddress}: the zero-access key wasn't replaced`,
                message: "A member has left, but the server refused a new key for this shared mailbox. The current key stays active.",
                details: done.rotationRefused,
                dedupeKey: `shared-rotation-refused:${mailbox.uid}`,
            });
        } else if (!done.rotationRefused) {
            shownRefusals.delete(mailbox.uid);
        }
        // A key this member just made (a mailbox without an owner) goes into their session now, not on the next pass.
        if (!owned && (done.provisioned || done.rotated)) {
            await unlockSharedMailbox(mailbox.uid, client, true);
        }
    }
}
