///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ReactElement, useState } from "react";
import { Folder, Message, getMessageRawContent, moveMessage, setMessageFlagged } from "@rapidmx/react-shared/mail/mailApi.js";
import type { CountTracker } from "../../../mail/folderCounts.js";
import { resolveFolderOfType } from "../../../mail/folderOfType.js";
import { setReadStateMany } from "../../../mail/messageReadState.js";
import { usePermanentDelete } from "../../../mail/usePermanentDelete.js";
import { blockSender, neverBlockSender, normalizeAddresses, removeSenderRule } from "../../../mail/senderBlocking.js";
import { notifyApiError } from "../../../notifications/apiErrors.js";
import { notify } from "../../../notifications/store.js";
import { moveLocalEntity } from "../../../search/localIndexRpcClient.js";
import { displaySubject } from "./EncryptedPreview.js";
import { headerFromAddress } from "./messageExport.js";

export interface MessageActionsParams {
    /** The message the card shows, and the newest copy of it known (a version another action of the card has since raised). */
    message: Message;
    newest: () => Message;
    /** Records a newer copy, so the next action builds on its `version`. */
    remember: (updated: Message) => void;
    /** Every folder of the message's mailbox - `resolveFolderOfType()` finds Junk Email, Deleted Items and the Inbox among them. */
    folders: Folder[] | undefined;
    inJunk: boolean;
    /** The message is in its mailbox's Deleted Items: Delete is then the permanent one (asked first, see `usePermanentDelete()`). */
    inDeletedItems: boolean;
    trackMessageChange: (previous: Message, next: Message | null) => CountTracker;
    /** The message left the folder it was in (Delete, Report junk, Block): the caller takes it out of its list, or the thread. */
    onMoved?: (updated: Message) => void;
    /** A newer copy of the message that is still where it was (read, flagged), with the copy it replaces. */
    onChanged?: (updated: Message, previous?: Message) => void;
    onFolderCreated?: (folder: Folder) => void;
}

export interface MessageActions {
    /** An action is on the wire: the card's other actions wait for it. */
    busy: boolean;
    /** The permanent-delete confirmation - render it once (it is a portal). */
    dialog: ReactElement;
    reportJunk: () => Promise<void>;
    reportPhishing: () => Promise<void>;
    deleteMessage: () => Promise<void>;
    toggleRead: () => Promise<void>;
    toggleFlag: () => Promise<void>;
    blockSender: () => Promise<void>;
    neverBlockSender: () => Promise<void>;
}

/** Where a notification's "View rules" goes: the filters page of the mailbox. */
export function rulesHref(mailboxUid: string): string {
    return `/settings/filters?mailboxUid=${encodeURIComponent(mailboxUid)}`;
}

const PHISHING_NOTE = "This report was not sent to anyone: RapidMX has no way to pass phishing reports on yet, so it only filed the message.";

/**
 * What a message card's Report junk, Report phishing, Delete, Mark as read/unread, Flag, Block and Never block do, over the same
 * requests the mail page's selection bar and keyboard shortcuts make - a move is a move into the message's OWN mailbox's Junk Email or
 * Deleted Items folder (`resolveFolderOfType()`), a read or flag change goes through the same optimistic path - so a card opened from
 * a shared mailbox, or from a search over several, acts in the mailbox the message is in.
 *
 * A failure is a pop-up that says what could not be done (`notifyApiError()`), as the selection bar's are. Nothing here rejects.
 */
export function useMessageActions(params: MessageActionsParams): MessageActions {
    const { message, newest, remember, folders, inJunk, inDeletedItems, trackMessageChange, onMoved, onChanged, onFolderCreated } = params;
    const [busy, setBusy] = useState(false);
    const permanent = usePermanentDelete();

    /** Runs one action with the card's other actions held meanwhile. */
    async function exclusive(action: () => Promise<void>): Promise<void> {
        setBusy(true);
        try {
            await action();
        } finally {
            setBusy(false);
        }
    }

    function folderOf(type: Folder["type"], name: string): Promise<string> {
        return resolveFolderOfType(message.mailboxUid, type, name, folders, onFolderCreated);
    }

    /** Moves the message into its mailbox's folder of `type`, and tells the folder badges and the local search index. */
    async function moveToType(type: Folder["type"], name: string): Promise<Message> {
        const before = newest();
        const updated = await moveMessage(before, await folderOf(type, name));
        remember(updated);
        void moveLocalEntity(updated.mailboxUid, updated.uid, updated.folderUid);
        trackMessageChange(before, updated).settle();
        return updated;
    }

    async function report(kind: "junk" | "phishing"): Promise<void> {
        const noun = kind === "junk" ? "junk" : "phishing";
        await exclusive(async () => {
            let updated: Message;
            try {
                updated = await moveToType("junk", "Junk Email");
            } catch (err) {
                notifyApiError(err, `Couldn't report this message as ${noun}`);
                return;
            }
            onMoved?.(updated);
            notify({
                kind: "success",
                title: `Reported as ${noun}`,
                message: `“${displaySubject(message.subject) || "(no subject)"}” was moved to Junk Email.${kind === "phishing" ? ` ${PHISHING_NOTE}` : ""}`,
            });
        });
    }

    async function deleteMessage(): Promise<void> {
        await exclusive(async () => {
            if (inDeletedItems) {
                // Nowhere further to move it: asks first, deletes for good and tells the badges, the search index and the reader itself.
                const outcome = await permanent.requestPermanentDelete([message]);
                if (outcome && outcome.deleted.length > 0) {
                    onMoved?.(message);
                }
                return;
            }
            try {
                // Awaited on its own line: an optional call with no callee never evaluates its arguments, so with no `onMoved` nothing would be moved.
                const updated = await moveToType("deleted_items", "Deleted Items");
                onMoved?.(updated);
            } catch (err) {
                notifyApiError(err, "Couldn't delete this message");
            }
        });
    }

    async function toggleRead(): Promise<void> {
        await exclusive(async () => {
            const before = newest();
            try {
                await setReadStateMany([before], before.flags.read !== true, {
                    patch: (updated, previous) => {
                        remember(updated);
                        onChanged?.(updated, previous);
                    },
                    track: trackMessageChange,
                });
            } catch (err) {
                notifyApiError(err, "Couldn't update the message");
            }
        });
    }

    async function toggleFlag(): Promise<void> {
        await exclusive(async () => {
            const before = newest();
            try {
                const updated = await setMessageFlagged(before, before.flags.flagged !== true);
                remember(updated);
                onChanged?.(updated, before);
            } catch (err) {
                notifyApiError(err, "Couldn't update the message");
            }
        });
    }

    /** The addresses a rule for this sender has to name: the one the message is filed under and, when it differs (mail from a list or a bulk sender
     * usually has an envelope sender of its own), the one in its From header, which is what a mail filter reads. */
    async function senderAddresses(): Promise<string[]> {
        const raw = await getMessageRawContent(message.uid).catch(() => undefined);
        return normalizeAddresses([message.from.address, raw === undefined ? undefined : headerFromAddress(raw)]);
    }

    async function block(): Promise<void> {
        await exclusive(async () => {
            const address = message.from.address;
            let result: Awaited<ReturnType<typeof blockSender>>;
            try {
                const [junkUid, inboxUid, addresses] = await Promise.all([folderOf("junk", "Junk Email"), folderOf("inbox", "Inbox"), senderAddresses()]);
                result = await blockSender(message.mailboxUid, addresses, junkUid, inboxUid);
            } catch (err) {
                notifyApiError(err, "Couldn't block this sender");
                return;
            }
            let moved: Message | undefined;
            if (!inJunk) {
                try {
                    moved = await moveToType("junk", "Junk Email");
                } catch (err) {
                    notifyApiError(err, "Couldn't move this message to Junk Email");
                }
            }
            if (moved) {
                onMoved?.(moved);
            }
            const where = inJunk ? "This message is already in Junk Email." : moved ? "This message was moved there." : "This message is still where it was.";
            notify({
                kind: result.outcome === "existing" ? "info" : "success",
                title: result.outcome === "existing" ? `${address} is already blocked` : `Blocked ${address}`,
                message: `New mail from this address goes to Junk Email. ${where}`,
                hint: "The filter blocks any sender address that contains this one.",
                actions: [
                    ...(result.outcome === "created"
                        ? [
                              {
                                  label: "Undo",
                                  onClick: () => {
                                      removeSenderRule(result.rule).then(
                                          () => notify({ kind: "info", title: `Unblocked ${address}`, message: "The block was removed. This message stays where it is." }),
                                          (err) => notifyApiError(err, "Couldn't undo the block"),
                                      );
                                  },
                              },
                          ]
                        : []),
                    { label: "View rules", href: rulesHref(message.mailboxUid) },
                ],
            });
        });
    }

    async function neverBlock(): Promise<void> {
        await exclusive(async () => {
            const address = message.from.address;
            let result: Awaited<ReturnType<typeof neverBlockSender>>;
            try {
                const [junkUid, inboxUid, addresses] = await Promise.all([folderOf("junk", "Junk Email"), folderOf("inbox", "Inbox"), senderAddresses()]);
                result = await neverBlockSender(message.mailboxUid, addresses, junkUid, inboxUid);
            } catch (err) {
                notifyApiError(err, "Couldn't stop blocking this sender");
                return;
            }
            const unblocked = result.removed.length > 0 ? "The block on this sender was removed. " : "";
            notify({
                kind: result.outcome === "existing" && !unblocked ? "info" : "success",
                title: result.outcome === "existing" && !unblocked ? `${address} is already never blocked` : `Never blocking ${address}`,
                message: `${unblocked}New mail from this address stays in your Inbox, ahead of your other filters. Mail the spam filter judges to be junk still goes to Junk Email.`,
                actions: [{ label: "View rules", href: rulesHref(message.mailboxUid) }],
            });
        });
    }

    return {
        busy: busy || permanent.busy,
        dialog: permanent.dialog,
        reportJunk: () => report("junk"),
        reportPhishing: () => report("phishing"),
        deleteMessage,
        toggleRead,
        toggleFlag,
        blockSender: block,
        neverBlockSender: neverBlock,
    };
}
