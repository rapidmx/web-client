///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The mail list's own per-mailbox view preferences - what the Sort and Filter menus and the "Show as
 * conversations" toggle are currently set to - persisted in `localStorage` so reopening the app lands on
 * the arrangement the reader left it in, the way Outlook remembers its own per-folder arrangement.
 *
 * Per device, not synced to the server: this is the same posture `localIndexSizePreference.ts` and
 * react-shared's `idleTimeout.ts` already take, and there is no server-side "mail view settings" record to
 * write to. Keyed by mailbox because a shared mailbox someone triages ("unread only, oldest on top") is a
 * genuinely different working set from their own inbox.
 *
 * Every read falls back to `DEFAULT_MAIL_LIST_PREFERENCES` for a never-configured mailbox, a corrupted or
 * partially-unknown stored value, or a `localStorage` access that throws (private-browsing/storage-blocked
 * contexts) - and every write swallows its own failure, so a blocked store only means the preference
 * doesn't survive a reload.
 */
import { MessageListFilter, MessageListSort, MessageSortOrder } from "@rapidmx/react-shared/mail/mailApi.js";

const STORAGE_KEY_PREFIX = "rapidmx:mail-list-preferences:";

export interface MailListPreferences {
    sortBy: MessageListSort;
    sortOrder: MessageSortOrder;
    filter: MessageListFilter;
    /** Outlook's "Show as conversations" - the nested conversation list rather than the flat message list. */
    showAsConversations: boolean;
}

/** `listMessages()`'s own defaults, spelled out: newest received first, nothing filtered out, flat list. */
export const DEFAULT_MAIL_LIST_PREFERENCES: MailListPreferences = {
    sortBy: "date",
    sortOrder: "desc",
    filter: "all",
    showAsConversations: false,
};

/** Every sort key the server accepts, with the label the Sort menu shows for it - the order here is the
 * order the menu lists them in. */
export const MAIL_LIST_SORTS: { value: MessageListSort; label: string }[] = [
    { value: "date", label: "Date" },
    { value: "sentDate", label: "Date sent" },
    { value: "from", label: "From" },
    { value: "subject", label: "Subject" },
    { value: "importance", label: "Importance" },
    { value: "flagged", label: "Flag status" },
];

/** Every named filter the server accepts, minus the Focused/Other pair (which the menu groups separately,
 * and only offers in an Inbox - see `MessageListFilter`'s own doc comment). */
export const MAIL_LIST_FILTERS: { value: MessageListFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "unread", label: "Unread" },
    { value: "read", label: "Read" },
    { value: "flagged", label: "Flagged" },
    { value: "hasAttachments", label: "Has attachments" },
];

/** The Focused Inbox half of the filter vocabulary, which the list also surfaces as its own tab row. */
export const MAIL_LIST_CLASSIFICATION_FILTERS: { value: MessageListFilter; label: string }[] = [
    { value: "focused", label: "Focused" },
    { value: "other", label: "Other" },
];

/** What "ascending"/"descending" actually mean for each sort key, since "Newest on top" and "A to Z" are
 * the same `desc`/`asc` pair wearing different words - mirrors Outlook's own per-field order labels. */
export const SORT_ORDER_LABELS: Record<MessageListSort, { desc: string; asc: string }> = {
    date: { desc: "Newest on top", asc: "Oldest on top" },
    sentDate: { desc: "Newest on top", asc: "Oldest on top" },
    from: { asc: "A to Z", desc: "Z to A" },
    subject: { asc: "A to Z", desc: "Z to A" },
    importance: { desc: "Highest on top", asc: "Lowest on top" },
    flagged: { desc: "Flagged on top", asc: "Unflagged on top" },
};

/** The direction the server itself would pick for a key if none were sent (see `MessageSortOrder`) - what
 * this list switches to when the reader picks a different field, so changing "Date" to "Subject" reads A-Z
 * rather than inheriting Date's newest-first as a surprising Z-A. */
export function defaultSortOrder(sortBy: MessageListSort): MessageSortOrder {
    return sortBy === "from" || sortBy === "subject" ? "asc" : "desc";
}

function isKnown<T extends string>(value: unknown, known: readonly { value: T }[]): value is T {
    return known.some((entry) => entry.value === value);
}

/** Reads one mailbox's stored preferences, merging them over the defaults field by field so an unknown or
 * missing field falls back on its own rather than discarding the whole record. */
export function getMailListPreferences(mailboxUid: string): MailListPreferences {
    let stored: unknown;
    try {
        const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${mailboxUid}`);
        stored = raw === null ? null : JSON.parse(raw);
    } catch {
        return DEFAULT_MAIL_LIST_PREFERENCES;
    }
    if (!stored || typeof stored !== "object") {
        return DEFAULT_MAIL_LIST_PREFERENCES;
    }
    const record = stored as Record<string, unknown>;
    const sortBy = isKnown(record.sortBy, MAIL_LIST_SORTS) ? record.sortBy : DEFAULT_MAIL_LIST_PREFERENCES.sortBy;
    const filter =
        isKnown(record.filter, MAIL_LIST_FILTERS) || isKnown(record.filter, MAIL_LIST_CLASSIFICATION_FILTERS)
            ? record.filter
            : DEFAULT_MAIL_LIST_PREFERENCES.filter;
    return {
        sortBy,
        sortOrder: record.sortOrder === "asc" || record.sortOrder === "desc" ? record.sortOrder : defaultSortOrder(sortBy),
        filter,
        showAsConversations: record.showAsConversations === true,
    };
}

/** Persists one mailbox's preferences. Best-effort - see this module's own doc comment. */
export function setMailListPreferences(mailboxUid: string, preferences: MailListPreferences): void {
    try {
        localStorage.setItem(`${STORAGE_KEY_PREFIX}${mailboxUid}`, JSON.stringify(preferences));
    } catch {
        // Best-effort - see this module's own doc comment.
    }
}
