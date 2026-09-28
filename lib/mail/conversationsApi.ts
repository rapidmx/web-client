///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Typed wrapper over `@rapidmx/restapi`'s conversation endpoints (`BaseMessageRoute.conversations()` and
 * `conversationMessages()`) — the parent rows of a nested, Outlook-style conversation list, and the child rows
 * one expands into. Conversations are RFC 5322 References/In-Reply-To threads (`Message.conversationId`),
 * computed fresh on every call — a `ConversationSummary` is never itself persisted.
 */

import { ApiClient, withClient } from "../util/api.js";
import { Message, MessageListFilter, Recipient } from "./mailApi.js";

export interface ConversationSummary {
    conversationId: string;
    /** The most recent message's subject line. */
    subject: string;
    /** Every message in this conversation, oldest to newest. */
    messageUids: string[];
    /** Every folder (deduped) this conversation has a message in — a conversation can span folders,
     * e.g. an Inbox message and the Sent Items copy of its reply. */
    folderUids: string[];
    messageCount: number;
    unreadCount: number;
    /** The most recent message's `receivedDate` — what the list is sorted by (newest first). */
    latestDate: string;
    /** Every distinct participant (deduped by address) across every message in the conversation. */
    participants: Recipient[];
    hasAttachments: boolean;
    /** `true` if any message in the conversation is flagged. */
    flagged: boolean;
    /** The most recent message's `uid` — what a collapsed conversation row stands for, so it can be opened
     * without expanding the conversation first. */
    latestMessageUid: string;
    /** The most recent message's sender. */
    latestFrom: Recipient;
    /** The most recent message's `bodyPreview` — the snippet a collapsed row shows. */
    latestPreview: string;
    /** The most recent message's folder. */
    latestFolderUid: string;
    /** The iTIP `METHOD` of the calendar file the most recent message carries (`Message.meetingMethod`) - `"REQUEST"`, `"REPLY"`,
     * `"CANCEL"`, `"PUBLISH"`, `"COUNTER"` or `""`. Absent, or `null` from the server's SQL, when it carries none. Lets a collapsed row mark a
     * meeting request without opening the conversation. */
    latestMeetingMethod?: string | null;
    /** What the reader answered that meeting request with (`Message.meetingResponse`). Absent, or `null`, when unanswered. */
    latestMeetingResponse?: "accepted" | "tentative" | "declined" | null;
}

/**
 * How many of a mailbox's *messages* the server reads, newest first, to build these groups — restapi's
 * `mail:conversations:scan_limit` default, and also the cap and default for `limit` below. A conversation whose
 * older messages fall outside that window reports only the part inside it.
 */
export const CONVERSATION_SCAN_LIMIT = 500;

export interface ConversationListParams {
    /** Restricts both the scan and the grouping to one folder — a per-folder conversation view. Without it a
     * conversation spans every folder in the mailbox. */
    folderUid?: string;
    /** The same named filters `listMessages()` takes, applied to the *messages* before they are grouped: so
     * `unread` yields each conversation's unread messages, and only the conversations that have any. */
    filter?: MessageListFilter;
    /** The label filter `listMessages()` takes (`Label.uid`s; a message matching ANY of them), applied at the
     * same point as `filter` and ANDed with it — so a conversation appears if any of its messages carries any
     * of these labels, and reports only those messages. At most `MAX_MESSAGE_LABEL_FILTER` of them. */
    labelUids?: string[];
    /** Zero-based. */
    page?: number;
    /** Capped at `CONVERSATION_SCAN_LIMIT`, which is also the default. */
    limit?: number;
}

/** `?mailboxUid=` plus whichever optional params were actually set, each URL-encoded. */
function conversationQuery(mailboxUid: string, params: Record<string, string | number | undefined>): string {
    const query = new URLSearchParams({ mailboxUid });
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
            query.set(key, String(value));
        }
    }
    return query.toString();
}

/** Lists a mailbox's conversations, newest activity first. Computed mailbox-wide unless `folderUid` narrows
 * them — folder scope is a filter here, not part of the endpoint. */
export function listConversations(
    mailboxUid: string,
    params: ConversationListParams = {},
    client?: ApiClient,
): Promise<ConversationSummary[]> {
    const { labelUids, ...rest } = params;
    // One comma-separated value, as `messageListQuery()` sends it; an empty selection sends no parameter.
    return withClient(
        client,
        `/mail/messages/conversations?${conversationQuery(mailboxUid, { ...rest, labelUids: labelUids?.length ? labelUids.join(",") : undefined })}`,
    );
}

/** Paging for `listConversationMessages()`. The server defaults `limit` to 100 and caps it at 500. */
export interface ConversationMessagesParams {
    page?: number;
    limit?: number;
}

/**
 * One conversation's messages, oldest first, across every folder in the mailbox — the expanded children of a
 * conversation row, in one request rather than one per `messageUids` entry.
 *
 * `conversationId` is the summary's own `conversationId`, which for a message belonging to no thread is that
 * message's `uid`; the server resolves either.
 */
export function listConversationMessages(
    mailboxUid: string,
    conversationId: string,
    params: ConversationMessagesParams = {},
    client?: ApiClient,
): Promise<Message[]> {
    return withClient(
        client,
        `/mail/messages/conversations/${encodeURIComponent(conversationId)}?${conversationQuery(mailboxUid, { ...params })}`,
    );
}
