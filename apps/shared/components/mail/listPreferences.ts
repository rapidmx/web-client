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
import {
    MAX_MESSAGE_LABEL_FILTER,
    MessageListFilter,
    MessageListSort,
    MessageSortOrder,
} from "@rapidmx/react-shared/mail/mailApi.js";
import { ConversationSummary } from "@rapidmx/react-shared/mail/conversationsApi.js";

const STORAGE_KEY_PREFIX = "rapidmx:mail-list-preferences:";

export interface MailListPreferences {
    sortBy: MessageListSort;
    sortOrder: MessageSortOrder;
    filter: MessageListFilter;
    /** Labels the list is narrowed to, applied *alongside* `filter` with OR semantics between them: a
     * message is listed when it carries any one of these. Empty means no label filter at all. Kept per
     * mailbox because a label uid only means anything inside its own mailbox. */
    labelUids: string[];
    /** Outlook's "Show as conversations" - the nested conversation list rather than the flat message list. */
    showAsConversations: boolean;
}

/** How many labels the list may be narrowed to at once. `@rapidmx/restapi` refuses a longer `?labelUids=`
 * with a 400, so a stored selection is trimmed to the cap rather than sent. */
export const MAX_LABEL_FILTER_UIDS = MAX_MESSAGE_LABEL_FILTER;

/**
 * What a mailbox nobody has configured yet opens on: newest received first, no label filter, and - like
 * Outlook's own out-of-the-box arrangement - the Focused half of the Inbox, shown as conversations.
 *
 * Neither of those last two is `listMessages()`'s own default (`all`, and the flat list): they are this
 * client's opinion about what a first-time reader should see, applied only where nothing has been stored
 * (see `getMailListPreferences()`, which keeps a stored `false`/`all` exactly as it was). `focused` also
 * only ever applies in an Inbox - every other folder falls back to `all` in `apps/www/index.tsx`, which is
 * what `MessageListFilter`'s own "Inbox-only concept" note requires.
 */
export const DEFAULT_MAIL_LIST_PREFERENCES: MailListPreferences = {
    sortBy: "date",
    sortOrder: "desc",
    filter: "focused",
    labelUids: [],
    showAsConversations: true,
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

/**
 * The sort keys a *conversation* row can't be ordered by, and the reason the Sort menu shows beside each of
 * them while the list is grouped into conversations.
 *
 * `GET /mail/messages/conversations` takes no `sortBy`/`sortOrder` at all - it returns one summary per
 * thread, newest activity first - so every key here is applied to the rows this client has actually fetched
 * (see `sortConversations()`). These two can't be applied even that far: a `ConversationSummary` describes
 * a thread, and a thread has neither a sent date nor an importance - those belong to one message of it.
 */
export const CONVERSATION_SORT_UNAVAILABLE: Partial<Record<MessageListSort, string>> = {
    sentDate: "A thread has no sent date",
    importance: "A thread has no importance",
};

/** The keys `sortConversations()` can actually order conversation rows by - `MAIL_LIST_SORTS` minus
 * `CONVERSATION_SORT_UNAVAILABLE`'s. */
export const CONVERSATION_SORTS: MessageListSort[] = MAIL_LIST_SORTS.map((entry) => entry.value).filter(
    (value) => !(value in CONVERSATION_SORT_UNAVAILABLE),
);

/** What the Sort menu says under its keys while conversations are shown - the honest scope of the ordering
 * below, since the endpoint pages by latest activity and only the rows already fetched can be reordered. */
export const CONVERSATION_SORT_NOTE =
    "Conversations are ordered within the rows loaded so far - the server pages them by latest activity.";

/** The name a conversation row is ordered by for "From": the latest message's sender, which is also the one
 * whose subject, preview and date the row shows. */
function latestSenderName(conversation: ConversationSummary): string {
    return conversation.latestFrom.displayName || conversation.latestFrom.address;
}

/** One conversation row against another on `sortBy`, ascending. */
function compareConversations(a: ConversationSummary, b: ConversationSummary, sortBy: MessageListSort): number {
    switch (sortBy) {
        case "from":
            return latestSenderName(a).localeCompare(latestSenderName(b), undefined, { sensitivity: "base" });
        case "subject":
            return a.subject.localeCompare(b.subject, undefined, { sensitivity: "base" });
        case "flagged":
            return Number(a.flagged) - Number(b.flagged);
        default:
            // `date` - the thread's latest activity, which is what the row itself shows.
            return Date.parse(a.latestDate) - Date.parse(b.latestDate);
    }
}

/**
 * Orders conversation rows by the arrangement the reader picked, as far as a `ConversationSummary` allows:
 * the endpoint itself takes no sort parameters, so this reorders the rows already fetched rather than the
 * folder (see `CONVERSATION_SORT_NOTE`, which says so on screen).
 *
 * A key the summaries carry no value for (see `CONVERSATION_SORT_UNAVAILABLE`, greyed out in the menu) is
 * left alone, so the rows keep the server's own latest-activity order rather than being shuffled into an
 * order that would mean nothing. Ties break newest first whichever direction is in force, so two rows the
 * key can't tell apart still read in a stable, familiar order.
 */
export function sortConversations(
    conversations: ConversationSummary[],
    sortBy: MessageListSort,
    sortOrder: MessageSortOrder,
): ConversationSummary[] {
    if (!CONVERSATION_SORTS.includes(sortBy)) {
        return conversations;
    }
    const direction = sortOrder === "asc" ? 1 : -1;
    return [...conversations].sort((a, b) => {
        const primary = direction * compareConversations(a, b, sortBy);
        return primary !== 0 ? primary : Date.parse(b.latestDate) - Date.parse(a.latestDate);
    });
}

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
        labelUids: Array.isArray(record.labelUids)
            ? record.labelUids.filter((uid): uid is string => typeof uid === "string").slice(0, MAX_LABEL_FILTER_UIDS)
            : [],
        // A stored `false` is a choice this reader made and is honoured; anything else (a record written
        // before this field existed, or a corrupted value) falls back to the default like every other
        // field here - which is what makes "Show as conversations" on by default only for a mailbox that
        // has never been arranged.
        showAsConversations:
            typeof record.showAsConversations === "boolean"
                ? record.showAsConversations
                : DEFAULT_MAIL_LIST_PREFERENCES.showAsConversations,
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
