///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ReactElement, useState } from "react";
import {
    Folder,
    Message,
    MessageReportKind,
    MessageReportResult,
    getMessageRawContent,
    moveMessage,
    reportMessage,
    setMessageFlagged,
} from "@rapidmx/react-shared/mail/mailApi.js";
import {
    SenderListsChange,
    addBlockedSender,
    addSafeSender,
    checkSenderEntry,
    removeBlockedSender,
    removeSafeSender,
} from "@rapidmx/react-shared/mail/senderListsApi.js";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import type { CountTracker } from "../../../mail/folderCounts.js";
import { resolveFolderOfType } from "../../../mail/folderOfType.js";
import { setReadStateMany } from "../../../mail/messageReadState.js";
import { usePermanentDelete } from "../../../mail/usePermanentDelete.js";
import { reportFolderName, reportNotice, reportNoun, reportTitle, senderListsHref } from "../../../mail/reportNotices.js";
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
    /** Every address the reader owns (their mailboxes' primary addresses and aliases), lowercase: a sender among them is never blocked. */
    ownAddresses?: readonly string[];
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
    /** Not junk: to the Inbox, and the spam filter is told the message is legitimate. */
    notJunk: () => Promise<void>;
    /** Not junk, and the sender is added to the mailbox's Safe Senders (needs full access to the mailbox). */
    notJunkAndTrust: () => Promise<void>;
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

/** Whether `err` is a `404`: for a route, what a server that predates it answers (a message or mailbox that is gone answers the same, and the fallback then fails the same way). */
function isNotFound(err: unknown): boolean {
    return err instanceof ApiRequestError && err.status === 404;
}

/**
 * What a message card's Report junk, Report phishing, Not junk, Delete, Mark as read/unread, Flag, Block and Never block do.
 *
 * - **Report junk, phishing and Not junk** ask the SERVER to do it (`reportMessage()`): it moves the message, teaches its spam filter and audits the report,
 * and the card then does what a move did (the folder badges, the search index, taking the message out of its list). A server that predates the route answers
 * `404`, and the card then makes the move itself (`moveMessage()`), as it used to, so a new client still works.
 * - **Block** adds the sender to the message's OWN mailbox's Blocked Senders (`addBlockedSender()`) and moves the message to Junk Email; **Never block** adds it to
 * Safe Senders, which takes it off the blocked list. On a server without the lists (`404`) both fall back to mail filter rules (`senderBlocking.ts`).
 * - The rest go over the same requests the mail page's selection bar and keyboard shortcuts make - a move is a move into the message's OWN mailbox's Junk Email or
 * Deleted Items folder (`resolveFolderOfType()`), a read or flag change goes through the same optimistic path - so a card opened from a shared mailbox, or from a
 * search over several, acts in the mailbox the message is in.
 *
 * A failure is a pop-up that says what could not be done (`notifyApiError()`), as the selection bar's are. Nothing here rejects.
 */
export function useMessageActions(params: MessageActionsParams): MessageActions {
    const { message, newest, remember, folders, inJunk, inDeletedItems, ownAddresses = [], trackMessageChange, onMoved, onChanged, onFolderCreated } = params;
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

    /** The card's part of a message having left its folder for `updated`'s: the folder badges and the local search index. */
    function relocated(before: Message, updated: Message): void {
        remember(updated);
        void moveLocalEntity(updated.mailboxUid, updated.uid, updated.folderUid);
        trackMessageChange(before, updated).settle();
    }

    /** Moves the message into its mailbox's folder of `type`, and tells the folder badges and the local search index. */
    async function moveToType(type: Folder["type"], name: string): Promise<Message> {
        const before = newest();
        const updated = await moveMessage(before, await folderOf(type, name));
        relocated(before, updated);
        return updated;
    }

    const subjectOf = () => displaySubject(message.subject) || "(no subject)";

    /** What the server did with a report, as the card shows it: the message is out of its list (when it moved) and a pop-up says what happened. */
    function reported(result: MessageReportResult, alwaysTrust: boolean): void {
        const before = newest();
        if (result.folderUid !== before.folderUid) {
            // The answer names no new `version`; the message is out of the card's list now, so nothing builds on this copy.
            const updated: Message = { ...before, folderUid: result.folderUid };
            relocated(before, updated);
            onMoved?.(updated);
        }
        const notice = reportNotice(result, subjectOf(), alwaysTrust);
        const safeSender = result.safeSender;
        notify({
            kind: "success",
            title: notice.title,
            message: notice.message,
            hint: notice.hint,
            actions: safeSender
                ? [
                      {
                          label: "Undo",
                          onClick: () => {
                              removeSafeSender(message.mailboxUid, safeSender).then(
                                  () => notify({ kind: "info", title: `${safeSender} is no longer a safe sender`, message: "This message stays in the Inbox." }),
                                  (err) => notifyApiError(err, "Couldn't undo trusting this sender"),
                              );
                          },
                      },
                      { label: "Manage safe senders", href: senderListsHref(message.mailboxUid) },
                  ]
                : undefined,
        });
    }

    /** What a server that has no report route leaves: the move alone, in the message's own mailbox, and nothing learned. */
    async function reportByMoving(kind: MessageReportKind, alwaysTrust: boolean): Promise<void> {
        const toInbox = kind === "not_junk";
        let updated: Message;
        try {
            updated = await moveToType(toInbox ? "inbox" : "junk", toInbox ? "Inbox" : "Junk Email");
        } catch (err) {
            notifyApiError(err, `Couldn't report this message as ${reportNoun(kind)}`);
            return;
        }
        onMoved?.(updated);
        notify({
            kind: "success",
            title: reportTitle(kind),
            message: `“${subjectOf()}” was moved to ${reportFolderName(kind)}.${alwaysTrust ? " This server cannot keep a list of safe senders, so its sender was not added to one." : ""}`,
        });
    }

    async function report(kind: MessageReportKind, alwaysTrustSender = false): Promise<void> {
        await exclusive(async () => {
            let result: MessageReportResult;
            try {
                result = await reportMessage(message.uid, kind, { alwaysTrustSender });
            } catch (err) {
                if (isNotFound(err)) {
                    await reportByMoving(kind, alwaysTrustSender);
                } else {
                    notifyApiError(err, `Couldn't report this message as ${reportNoun(kind)}`);
                }
                return;
            }
            reported(result, alwaysTrustSender);
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

    /** The sender of this message as a list entry needs it: the address in its From header - what the reader sees, and what the mail server matches a list
     * against (with the envelope sender) - or, without one, the address the message is filed under. `all` is both, for the filter rules of a server without lists. */
    async function senders(): Promise<{ listed: string | undefined; all: string[] }> {
        const raw = await getMessageRawContent(message.uid).catch(() => undefined);
        const header = raw === undefined ? undefined : headerFromAddress(raw);
        return { listed: normalizeAddresses([header, message.from.address])[0], all: normalizeAddresses([message.from.address, header]) };
    }

    /** Whether `address` can go on a list (a plain address the mail server accepts); a pop-up says so when it cannot. */
    function listable(address: string | undefined, title: string): address is string {
        const checked = address === undefined ? undefined : checkSenderEntry(address);
        if (address !== undefined && checked?.ok && checked.kind === "address") {
            return true;
        }
        notify({ kind: "error", title, message: "This message has no sender address that can be put on a list." });
        return false;
    }

    /** Files the message in its mailbox's Junk Email when it is not there yet, and says where it ended up. */
    async function moveToJunkUnlessThere(): Promise<string> {
        if (inJunk) {
            return "This message is already in Junk Email.";
        }
        try {
            const moved = await moveToType("junk", "Junk Email");
            onMoved?.(moved);
            return "This message was moved there.";
        } catch (err) {
            notifyApiError(err, "Couldn't move this message to Junk Email");
            return "This message is still where it was.";
        }
    }

    /** Block, on a server without sender lists: the mailbox's mail filter rules. */
    async function blockWithRules(addresses: string[], address: string): Promise<void> {
        let result: Awaited<ReturnType<typeof blockSender>>;
        try {
            const [junkUid, inboxUid] = await Promise.all([folderOf("junk", "Junk Email"), folderOf("inbox", "Inbox")]);
            result = await blockSender(message.mailboxUid, addresses, junkUid, inboxUid);
        } catch (err) {
            notifyApiError(err, "Couldn't block this sender");
            return;
        }
        const where = await moveToJunkUnlessThere();
        notify({
            kind: result.outcome === "existing" ? "info" : "success",
            title: result.outcome === "existing" ? `${address} is already blocked` : `Blocked ${address}`,
            message: `New mail from this address goes to Junk Email. ${where}`,
            hint: "This server has no list of blocked senders, so the block is a filter rule that matches any sender address containing this one.",
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
    }

    async function block(): Promise<void> {
        await exclusive(async () => {
            const { listed, all } = await senders();
            if (!listable(listed, "Couldn't block this sender")) {
                return;
            }
            if (ownAddresses.includes(listed)) {
                notify({ kind: "info", title: "That is your own address", message: `${listed} is one of your addresses, so it is not blocked.` });
                return;
            }
            let added: SenderListsChange;
            try {
                added = await addBlockedSender(message.mailboxUid, listed);
            } catch (err) {
                if (isNotFound(err)) {
                    await blockWithRules(all, message.from.address);
                } else {
                    notifyApiError(err, "Couldn't block this sender");
                }
                return;
            }
            const where = await moveToJunkUnlessThere();
            notify({
                kind: added.changed ? "success" : "info",
                title: added.changed ? `Blocked ${listed}` : `${listed} is already blocked`,
                message: `New mail from this address goes to Junk Email. ${where}`,
                actions: [
                    ...(added.changed
                        ? [
                              {
                                  label: "Undo",
                                  onClick: () => {
                                      removeBlockedSender(message.mailboxUid, listed).then(
                                          () => notify({ kind: "info", title: `Unblocked ${listed}`, message: "The block was removed. This message stays where it is." }),
                                          (err) => notifyApiError(err, "Couldn't undo the block"),
                                      );
                                  },
                              },
                          ]
                        : []),
                    { label: "Manage blocked senders", href: senderListsHref(message.mailboxUid) },
                ],
            });
        });
    }

    /** Never block, on a server without sender lists: the rule that keeps the sender's mail in the Inbox. */
    async function neverBlockWithRules(addresses: string[], address: string): Promise<void> {
        let result: Awaited<ReturnType<typeof neverBlockSender>>;
        try {
            const [junkUid, inboxUid] = await Promise.all([folderOf("junk", "Junk Email"), folderOf("inbox", "Inbox")]);
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
    }

    async function neverBlock(): Promise<void> {
        await exclusive(async () => {
            const { listed, all } = await senders();
            if (!listable(listed, "Couldn't stop blocking this sender")) {
                return;
            }
            let added: SenderListsChange;
            try {
                added = await addSafeSender(message.mailboxUid, listed);
            } catch (err) {
                if (isNotFound(err)) {
                    await neverBlockWithRules(all, message.from.address);
                } else {
                    notifyApiError(err, "Couldn't stop blocking this sender");
                }
                return;
            }
            notify({
                kind: added.changed ? "success" : "info",
                title: added.changed ? `Never blocking ${listed}` : `${listed} is already a safe sender`,
                message:
                    "Any block on this address is removed. Mail from it that passes authentication is delivered to your Inbox instead of Junk Email; " +
                    "mail that fails authentication, carries a virus or is quarantined by policy is still kept out.",
                actions: [
                    ...(added.changed
                        ? [
                              {
                                  label: "Undo",
                                  onClick: () => {
                                      removeSafeSender(message.mailboxUid, listed).then(
                                          () => notify({ kind: "info", title: `${listed} is no longer a safe sender`, message: "Its mail is filtered as usual again." }),
                                          (err) => notifyApiError(err, "Couldn't undo the change"),
                                      );
                                  },
                              },
                          ]
                        : []),
                    { label: "Manage safe senders", href: senderListsHref(message.mailboxUid) },
                ],
            });
        });
    }

    return {
        busy: busy || permanent.busy,
        dialog: permanent.dialog,
        reportJunk: () => report("junk"),
        reportPhishing: () => report("phishing"),
        notJunk: () => report("not_junk"),
        notJunkAndTrust: () => report("not_junk", true),
        deleteMessage,
        toggleRead,
        toggleFlag,
        blockSender: block,
        neverBlockSender: neverBlock,
    };
}
