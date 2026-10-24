///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { getEncryptionPolicy } from "../../../../lib/crypto/keyvaultApi.js";
import { getMailbox, type Mailbox, updateMailbox } from "../../../../lib/mail/mailApi.js";
import { ApiRequestError } from "../../../../lib/util/api.js";
import { useApiClient } from "../../../../lib/util/apiClientContext.js";
import { notifyApiError } from "../../notifications/apiErrors.js";
import PolicyLockedNotice from "./PolicyLockedNotice.js";
import ZeroAccessTypes from "./ZeroAccessTypes.js";

/** The data types this client can protect with zero-access encryption - each joins as its protection is implemented end to end. */
export const ZERO_ACCESS_SUPPORTED_TYPES = ["mail", "calendar", "contacts", "tasks"] as const;

/** Why zero-access encryption can't be changed here, when it can't - mirrors restapi's `ZeroAccessStatus` reasons that the user can't fix
 * by ticking the box. */
type Blocker = "disabled_by_admin" | "unsupported";

export interface ZeroAccessSettingProps {
    mailbox: Mailbox;
    /** The caller owns the mailbox and isn't impersonating: only then can the setting be changed (restapi drops anybody else's value). */
    canManage: boolean;
}

/**
 * "Enable zero-access encryption" for one mailbox (restapi `specs/search.md` §3): unencrypted mail is encrypted to the
 * mailbox's zero-access key as it arrives and the server keeps no readable copy. On by default. Shown disabled, with the
 * reason, when the administrator has turned "Allow zero-access encryption" off for the server, or when the server doesn't
 * support it. A shared mailbox is covered too: its members read it through member key wraps (`sharedMailboxKeys.ts`).
 */
export default function ZeroAccessSetting({ mailbox, canManage }: ZeroAccessSettingProps) {
    const client = useApiClient();
    const [enabled, setEnabled] = useState(mailbox.zeroAccessEnabled !== false);
    const [blocker, setBlocker] = useState<Blocker | null | undefined>(undefined);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const policy = await getEncryptionPolicy(client).catch(() => undefined);
            let next: Blocker | null = null;
            if (policy?.allowZeroAccess === undefined) {
                next = "unsupported";
            } else if (!policy.allowZeroAccess) {
                next = "disabled_by_admin";
            }
            if (!cancelled) {
                setBlocker(next);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [mailbox.uid, client]);

    async function save(next: boolean) {
        setSaving(true);
        const previous = enabled;
        setEnabled(next);
        try {
            const write = (version: number) => updateMailbox({ uid: mailbox.uid, version, zeroAccessEnabled: next }, client);
            try {
                await write(mailbox.version);
            } catch (err) {
                // Enrolling a key (which happens on unlock) moves the mailbox's version on, so the copy this page was given may be
                // behind: read it again and retry once.
                if (!(err instanceof ApiRequestError && err.status === 409)) {
                    throw err;
                }
                await write((await getMailbox(mailbox.uid, {}, client)).version);
            }
        } catch (err) {
            setEnabled(previous);
            notifyApiError(err, "Couldn't save the zero-access encryption setting");
        } finally {
            setSaving(false);
        }
    }

    const locked = blocker !== null;
    return (
        <div>
            <h2 className="text-sm font-semibold mb-2">Zero-access encryption</h2>
            <label className="flex items-start gap-2 text-sm">
                <input
                    type="checkbox"
                    className="mt-1"
                    checked={!locked && enabled}
                    disabled={!canManage || locked || saving}
                    onChange={(e) => void save(e.target.checked)}
                />
                <span>
                    <span className="font-semibold block">Enable zero-access encryption</span>
                    <span className="text-xs text-text-muted">
                        Mail that arrives unencrypted is encrypted the moment it is received, and the server keeps no copy it can read -
                        nobody else, administrators included, can read it. You unlock it with your encryption password, and search
                        of message contents happens on your device. Outlook and phone mail apps need your exported keys to read it.
                        Turning this off only affects mail that arrives afterwards.
                    </span>
                </span>
            </label>
            {!locked && enabled && <ZeroAccessTypes mailbox={mailbox} types={ZERO_ACCESS_SUPPORTED_TYPES} canManage={canManage} />}
            {blocker === "disabled_by_admin" && (
                <PolicyLockedNotice>
                    Your administrator has turned off zero-access encryption for this server, so new mail is stored without it. Mail
                    already encrypted stays encrypted.
                </PolicyLockedNotice>
            )}
            {blocker === "unsupported" && <PolicyLockedNotice>This server doesn&rsquo;t offer zero-access encryption.</PolicyLockedNotice>}
            {!mailbox.ownerUserUid && !locked && (
                <PolicyLockedNotice>
                    This shared mailbox has no owner: it is protected for its members, whose apps share its key with each other.
                </PolicyLockedNotice>
            )}
            {!canManage && !locked && mailbox.ownerUserUid && (
                <PolicyLockedNotice>Only this mailbox&rsquo;s owner, signed in as themselves, can change this.</PolicyLockedNotice>
            )}
        </div>
    );
}
