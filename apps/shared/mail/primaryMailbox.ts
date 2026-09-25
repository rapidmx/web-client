///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Which of the caller's mailboxes is "theirs", and the order every list of them is shown in - the one definition the mail, calendar,
 * contacts, tasks and settings shells, the compose window's From picker and the account menu all use, so a shared mailbox that happens
 * to sort first (or that the server lists first) is never the one an app opens on or a picker defaults to.
 *
 * An **own** mailbox is one whose `ownerUserUid` is the signed-in user.
 *
 * A **shared** mailbox is any other one the caller merely has access to: an ownerless (shared/organization) mailbox, or a delegate grant on
 * somebody else's (`isSharedWithMe()`).
 *
 * The **primary** mailbox is the caller's own mailbox - the earliest created, when they own several - else the first mailbox that isn't
 * shared, else the first one there is.
 *
 * `orderMailboxes()` puts the primary mailbox first, then the caller's other mailboxes, then the shared ones, each group alphabetical.
 */
import { isSharedWithMe, type Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";

/** Whether `mailbox` is the signed-in user's own. */
export function isOwnMailbox(mailbox: Mailbox, userUid: string | undefined): boolean {
    return !!userUid && mailbox.ownerUserUid === userUid;
}

/** Whether `mailbox` is one the caller only has access to (an ownerless one, or somebody else's shared with them). */
export function isSharedMailbox(mailbox: Mailbox, userUid: string | undefined): boolean {
    if (isOwnMailbox(mailbox, userUid)) {
        return false;
    }
    // The server says how the caller reaches a mailbox (`accessRole`); an older one doesn't, and then a mailbox that isn't the known
    // caller's own is somebody else's.
    return mailbox.accessRole ? isSharedWithMe(mailbox) : !!userUid || isSharedWithMe(mailbox);
}

function createdAt(mailbox: Mailbox): number {
    const time = Date.parse(mailbox.dateCreated);
    return Number.isNaN(time) ? Infinity : time;
}

/** The caller's own mailboxes, earliest created first (the given order among ones created together). */
export function ownMailboxes(mailboxes: readonly Mailbox[], userUid: string | undefined): Mailbox[] {
    return mailboxes.filter((mailbox) => isOwnMailbox(mailbox, userUid)).sort((a, b) => createdAt(a) - createdAt(b));
}

/** The mailbox to open and to default pickers to: see the rules at the top of this file. `undefined` only for no mailboxes at all. */
export function primaryMailbox(mailboxes: readonly Mailbox[], userUid: string | undefined): Mailbox | undefined {
    return ownMailboxes(mailboxes, userUid)[0] ?? mailboxes.find((mailbox) => !isSharedMailbox(mailbox, userUid)) ?? mailboxes[0];
}

/** `primaryMailbox()`'s uid. */
export function primaryMailboxUid(mailboxes: readonly Mailbox[], userUid: string | undefined): string | undefined {
    return primaryMailbox(mailboxes, userUid)?.uid;
}

/** `mailboxes` in display order: the primary mailbox, then the caller's other mailboxes, then the shared ones - each group by name. Never
 * changes the list it is given. */
export function orderMailboxes(mailboxes: readonly Mailbox[], userUid: string | undefined): Mailbox[] {
    const primary = primaryMailbox(mailboxes, userUid);
    const rank = (mailbox: Mailbox) => (mailbox === primary ? 0 : isSharedMailbox(mailbox, userUid) ? 2 : 1);
    // Tolerates a mailbox that says nothing of its name or address (an older server's, or a test fixture's).
    const name = (mailbox: Mailbox) => mailbox.displayName ?? "";
    const address = (mailbox: Mailbox) => mailbox.primarySmtpAddress ?? "";
    return [...mailboxes].sort(
        (a, b) =>
            rank(a) - rank(b) ||
            name(a).localeCompare(name(b), undefined, { sensitivity: "base" }) ||
            address(a).localeCompare(address(b)),
    );
}
