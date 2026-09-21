///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Folder, Mailbox, Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { formatMailAddress, splitMailAddress } from "@rapidmx/react-shared/mail/mailAddress.js";

/**
 * What decides whether a new message is announced, what the announcement says, and the two settings behind it (both per
 * browser, in `localStorage`): whether new-mail pop-ups are on at all, and what the user told the "turn on desktop
 * notifications" offer.
 *
 * The announcement is built only from what the push event carries - the whole `Message`, including `bodyPreview` - and only
 * ever as text: React escapes it on screen and the Notifications API takes plain strings, so nothing here is HTML.
 */

/** `localStorage` key of the pop-ups switch. Absent means on; `"off"` means the user turned them off. */
export const NEW_MAIL_POPUPS_KEY = "rapidmx-new-mail-popups";

/** `localStorage` key of the answer to the desktop-notifications offer: `"later"` (not now) or `"asked"` (they were asked). */
export const DESKTOP_OFFER_KEY = "rapidmx-desktop-notifications-offer";

/** How much of the body an announcement quotes. */
export const PREVIEW_MAX_LENGTH = 140;

/** A message received longer ago than this is not "new": mail imported or migrated in bulk arrives as `create` events too. */
export const MAX_NEW_AGE_MS = 6 * 60 * 60 * 1000;

/** The subject the server stores for an encrypted message (the real one is inside the ciphertext). */
const ENCRYPTED_SUBJECT_PLACEHOLDER = "[...]";

function readStorage(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStorage(key: string, value: string | null): void {
    try {
        if (value === null) {
            localStorage.removeItem(key);
        } else {
            localStorage.setItem(key, value);
        }
    } catch {
        // Storage blocked or full: the choice lasts until the page is reloaded, no longer.
    }
}

/** Whether new-mail pop-ups are on (the default). */
export function getNewMailPopupsEnabled(): boolean {
    return readStorage(NEW_MAIL_POPUPS_KEY) !== "off";
}

export function setNewMailPopupsEnabled(enabled: boolean): void {
    writeStorage(NEW_MAIL_POPUPS_KEY, enabled ? null : "off");
}

/** Whether the "turn on desktop notifications" offer has been put away with "Not now" (or answered). */
export function getDesktopOfferDismissed(): boolean {
    return readStorage(DESKTOP_OFFER_KEY) !== null;
}

export function setDesktopOfferDismissed(dismissed: boolean): void {
    writeStorage(DESKTOP_OFFER_KEY, dismissed ? "later" : null);
}

/** The browser's notification permission, or `"unsupported"` where there is no Notifications API. */
export type DesktopPermission = NotificationPermission | "unsupported";

export function desktopPermission(): DesktopPermission {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Asks the browser for permission - call it from a click. Resolves the answer; never rejects. */
export async function requestDesktopPermission(): Promise<DesktopPermission> {
    if (typeof Notification === "undefined") {
        return "unsupported";
    }
    try {
        return await Notification.requestPermission();
    } catch {
        return desktopPermission();
    }
}

/** What an announcement shows. */
export interface NewMailNotice {
    /** The message's uid: the announcement's identity (and the desktop notification's `tag`). */
    uid: string;
    mailboxUid: string;
    folderUid: string;
    /** The sender's display name, `""` when there is none. */
    senderName: string;
    /** The sender's address - always shown, so a name can't stand in for who really sent it. */
    senderAddress: string;
    subject: string;
    /** About `PREVIEW_MAX_LENGTH` characters of the body as plain text; `Encrypted message` for an encrypted one. */
    preview: string;
    /** Where opening it goes. */
    href: string;
}

/** Control characters, and the invisible or bidirectional-override characters that can make text read as something else, as code point ranges. */
const UNWANTED_RANGES: [number, number][] = [
    [0x0000, 0x001f],
    [0x007f, 0x009f],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
];
const hex = (code: number) => "\\u" + code.toString(16).padStart(4, "0");
const UNWANTED = new RegExp("[" + UNWANTED_RANGES.map(([from, to]) => hex(from) + "-" + hex(to)).join("") + "]+", "g");

/** `text` with those characters replaced by spaces, whitespace folded, and cut to `max` characters (with an ellipsis). */
export function cleanPreview(text: string, max: number = PREVIEW_MAX_LENGTH): string {
    const cleaned = text.replace(UNWANTED, " ").replace(/\s+/g, " ").trim();
    return cleaned.length > max ? cleaned.slice(0, max - 1).trimEnd() + String.fromCharCode(0x2026) : cleaned;
}

/** The text of an announcement of `message`. */
export function noticeFor(message: Message): NewMailNotice {
    const { name, address } = splitMailAddress(message.from);
    const encrypted = message.encrypted === true;
    const rawSubject = cleanPreview(message.subject ?? "", 200);
    const subject =
        !rawSubject || rawSubject === ENCRYPTED_SUBJECT_PLACEHOLDER ? (encrypted ? "(encrypted subject)" : "(no subject)") : rawSubject;
    return {
        uid: message.uid,
        mailboxUid: message.mailboxUid,
        folderUid: message.folderUid,
        // `splitMailAddress()` has already taken control and bidirectional-override characters out of both.
        senderName: name ?? "",
        senderAddress: address,
        subject,
        preview: encrypted ? "Encrypted message" : cleanPreview(message.bodyPreview ?? ""),
        href: `/messages/${encodeURIComponent(message.uid)}`,
    };
}

/** Every address that is this user's own, lowercased - a message from one of them is not new mail worth announcing. */
export function ownAddressesOf(mailboxes: Mailbox[]): Set<string> {
    const own = new Set<string>();
    for (const mailbox of mailboxes) {
        for (const address of [mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])]) {
            if (address) {
                own.add(address.trim().toLowerCase());
            }
        }
    }
    return own;
}

/**
 * Whether the arrival of `message` is worth announcing: unread mail in an Inbox (not Drafts, Sent Items, Outbox, Deleted Items,
 * Junk Email or quarantine, which are other folders), that Focused Inbox did not put under Other, that its own user did not
 * send, and that is not old (a bulk import).
 */
export function shouldAnnounce(
    message: Message,
    context: { folders: Folder[]; ownAddresses: Set<string>; now?: number },
): boolean {
    if (context.folders.find((folder) => folder.uid === message.folderUid)?.type !== "inbox") {
        return false;
    }
    if (message.flags.read === true || message.inferenceClassification === "other") {
        return false;
    }
    if (context.ownAddresses.has((message.from?.address ?? "").trim().toLowerCase())) {
        return false;
    }
    const received = Date.parse(message.receivedDate);
    return Number.isNaN(received) || (context.now ?? Date.now()) - received < MAX_NEW_AGE_MS;
}

/** `Name <address>`, or the address alone - the desktop notification's title. */
export function noticeSender(notice: Pick<NewMailNotice, "senderName" | "senderAddress">): string {
    return formatMailAddress({ address: notice.senderAddress, displayName: notice.senderName || undefined });
}
