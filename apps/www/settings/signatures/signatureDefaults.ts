///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailSignature, updateMailSignature } from "@rapidmx/react-shared/mailSignaturesApi.js";

/**
 * `MailSignature.isDefaultForNewMessages`/`isDefaultForReplyForward` are each meant to hold on at most
 * one signature per mailbox — enforced by convention, not a database constraint (see
 * `mailSignaturesApi.ts`'s own doc comment, quoting restapi's). Before saving a signature with one of
 * these flags newly turned on, this turns the flag off on whichever *other* signature in `signatures`
 * currently has it — the "the composing client toggles the previous default off" responsibility that
 * convention assigns to a caller like the New/Edit signature forms.
 */
export async function clearPreviousDefaults(
    signatures: MailSignature[],
    savingUid: string | undefined,
    isDefaultForNewMessages: boolean,
    isDefaultForReplyForward: boolean,
): Promise<void> {
    for (const signature of signatures) {
        if (signature.uid === savingUid) {
            continue;
        }
        const patch: { isDefaultForNewMessages?: boolean; isDefaultForReplyForward?: boolean } = {};
        if (isDefaultForNewMessages && signature.isDefaultForNewMessages) {
            patch.isDefaultForNewMessages = false;
        }
        if (isDefaultForReplyForward && signature.isDefaultForReplyForward) {
            patch.isDefaultForReplyForward = false;
        }
        if (Object.keys(patch).length > 0) {
            await updateMailSignature({ uid: signature.uid, version: signature.version, ...patch });
        }
    }
}
