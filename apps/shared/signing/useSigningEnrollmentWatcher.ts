///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useEffect, useRef } from "react";
import type { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { getCurrentSignEnrollment } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { notify } from "../notifications/store.js";
import { readStoredSignEnrollment, storeSignEnrollment } from "./enrollmentStorage.js";
import { EnrollmentSnapshot, onEnrollmentEnded, watchCurrentEnrollment, watchEnrollment } from "./enrollmentTracker.js";
import { formatDate, isInstalling } from "./enrollmentView.js";

/** Where the pop-up's action leads: the page that shows the certificate. */
export const SIGNING_SETTINGS_HREF = "/settings/encryption";

/**
 * Tells the user, wherever they are in the app, when a signing certificate they asked for is issued or has failed. Lives in the persistent app
 * frame (`AppChrome`): for each mailbox the user owns it follows the enrollment this browser has a stored id for and - for one started on another
 * device - the one the server names as the mailbox's current enrollment when it is still pending (`GET .../sign-enrollment`; an older server
 * answers 404 and nothing is followed). Reading, backoff and visibility rules are the tracker's (`enrollmentTracker.ts`), shared with the
 * Settings > Encryption card, so an enrollment is asked about once. The pop-up is raised once per enrollment (`dedupeKey`) and only for one that
 * was seen pending - never for a certificate issued long ago.
 */
export function useSigningEnrollmentWatcher({ userUid, mailboxes, enabled }: { userUid?: string; mailboxes: Mailbox[]; enabled: boolean }): void {
    const mailboxesRef = useRef(mailboxes);
    mailboxesRef.current = mailboxes;
    // Keyed on the uids of the mailboxes the user owns: a refreshed list of the same mailboxes must not start over.
    const ownedKey = mailboxes
        .filter((mailbox) => mailbox.ownerUserUid === userUid)
        .map((mailbox) => mailbox.uid)
        .join("|");

    useEffect(() => {
        if (!enabled || !userUid || !ownedKey) {
            return;
        }
        let cancelled = false;
        const releases: (() => void)[] = [];
        for (const mailboxUid of ownedKey.split("|")) {
            const storedId = readStoredSignEnrollment(mailboxUid);
            if (storedId) {
                releases.push(watchEnrollment(mailboxUid, storedId));
                continue;
            }
            // Never throws or rejects: a lookup that cannot be made (an older server, offline, anything) is "nothing is pending", and the frame goes on.
            void (async () => {
                try {
                    const current = await getCurrentSignEnrollment(mailboxUid);
                    if (!cancelled && current?.status === "pending") {
                        storeSignEnrollment(mailboxUid, current.enrollmentId);
                        releases.push(watchCurrentEnrollment(mailboxUid, current));
                    }
                } catch {
                    // Nothing to follow.
                }
            })();
        }
        const stopListening = onEnrollmentEnded((snapshot) => announce(snapshot, mailboxesRef.current));
        return () => {
            cancelled = true;
            stopListening();
            releases.forEach((release) => release());
        };
    }, [enabled, userUid, ownedKey]);
}

/** The pop-up for an enrollment that just ended - issued or failed (the tracker announces nothing else, and always with its answer). */
function announce(snapshot: EnrollmentSnapshot, mailboxes: Mailbox[]): void {
    const address = mailboxes.find((mailbox) => mailbox.uid === snapshot.mailboxUid)?.primarySmtpAddress;
    const result = snapshot.result!;
    if (result.status === "issued") {
        notify({
            kind: "success",
            title: "Digital signature certificate issued",
            message: isInstalling(result)
                ? `The certificate for ${address ?? "your mailbox"} is issued and is being installed - mail is signed once it is (a few minutes).`
                : `${address ? `Mail from ${address}` : "Your mail"} is now signed${result.notAfter ? ` (valid until ${formatDate(result.notAfter)})` : ""}.`,
            actions: [{ label: "View", href: SIGNING_SETTINGS_HREF }],
            dedupeKey: `sign-enrollment:${snapshot.enrollmentId}`,
        });
    } else {
        notify({
            kind: "error",
            title: "Digital signature certificate could not be issued",
            message: result.error ?? "The certificate authority did not issue a certificate.",
            actions: [{ label: result.retryable === false ? "Details" : "Try again", href: SIGNING_SETTINGS_HREF }],
            dedupeKey: `sign-enrollment:${snapshot.enrollmentId}`,
        });
    }
}
