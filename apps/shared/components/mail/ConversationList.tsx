///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { HiChevronDown, HiChevronRight, HiOutlineFlag, HiOutlinePaperClip } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { ConversationSummary, listConversationMessages } from "@rapidmx/react-shared/mail/conversationsApi.js";

export interface ConversationListProps {
    conversations: ConversationSummary[];
    /** The mailbox the conversations were listed from - `listConversationMessages()` is mailbox-scoped. */
    mailboxUid: string;
    /** The message currently open in the reading pane, so the row standing for it can be marked. */
    selectedUid: string | null;
    /**
     * Opens a conversation in the reading pane, positioned at one of its messages: the one a child row
     * stands for, or the conversation's own `latestMessageUid` for a parent row. The conversation goes
     * with the uid because the pane shows the whole thread, not just that message.
     */
    onOpenMessage: (conversation: ConversationSummary, uid: string) => void;
    /** Newer copies of messages this list already fetched - the reading pane marks the message it opens as
     * read, which this list would otherwise keep showing as unread until the thread is collapsed and
     * expanded again. */
    messageOverrides?: Record<string, Message>;
}

function participantNames(conversation: ConversationSummary): string {
    return conversation.participants.map((participant) => participant.displayName || participant.address).join(", ");
}

/**
 * The nested, Outlook-style conversation list: one parent row per conversation - its participants, subject,
 * message count, unread count, flag/attachment hints and the latest message's preview - expanding via its
 * own chevron into the conversation's individual messages as child rows, fetched on first expand with
 * `listConversationMessages()` (one request for the whole thread, across folders, oldest first).
 *
 * Opening a row opens the whole conversation in `ConversationThreadPane`, positioned at the message the row
 * stands for: the latest one for a parent row, that one for a child row.
 *
 * The chevron is a button of its own beside the row's own button rather than inside it (a button can't
 * nest inside a button), so expanding and opening are separately reachable by keyboard and each carries
 * its own name.
 */
export default function ConversationList({
    conversations,
    mailboxUid,
    selectedUid,
    onOpenMessage,
    messageOverrides,
}: ConversationListProps) {
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [messagesById, setMessagesById] = useState<Record<string, Message[]>>({});
    const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
    const [errorsById, setErrorsById] = useState<Record<string, string>>({});

    function toggle(conversation: ConversationSummary) {
        const id = conversation.conversationId;
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
        if (expanded.has(id) || messagesById[id] || loadingIds.has(id)) {
            return;
        }
        setLoadingIds((prev) => new Set(prev).add(id));
        setErrorsById((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
        listConversationMessages(mailboxUid, id)
            .then((loaded) => setMessagesById((prev) => ({ ...prev, [id]: loaded })))
            .catch((err) =>
                setErrorsById((prev) => ({
                    ...prev,
                    [id]: err instanceof ApiRequestError ? err.message : "Could not load this conversation's messages.",
                }))
            )
            .finally(() =>
                setLoadingIds((prev) => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                })
            );
    }

    if (conversations.length === 0) {
        return <p className="p-4 text-sm text-text-muted">No conversations in this folder.</p>;
    }

    return (
        <ul>
            {conversations.map((conversation) => {
                const id = conversation.conversationId;
                const isExpanded = expanded.has(id);
                const unread = conversation.unreadCount > 0;
                const children = messagesById[id];
                const panelId = `conversation-messages-${id}`;
                return (
                    <li key={id}>
                        <div
                            className={[
                                "flex items-stretch border-b border-border",
                                conversation.latestMessageUid === selectedUid
                                    ? "bg-primary/10"
                                    : "hover:bg-surface-alt",
                            ].join(" ")}
                        >
                            <button
                                type="button"
                                onClick={() => toggle(conversation)}
                                aria-expanded={isExpanded}
                                aria-controls={panelId}
                                aria-label={`${isExpanded ? "Collapse" : "Expand"} conversation: ${conversation.subject || "(no subject)"}`}
                                className="shrink-0 px-2 text-text-muted hover:text-text"
                            >
                                {isExpanded ? (
                                    <HiChevronDown size={16} aria-hidden="true" />
                                ) : (
                                    <HiChevronRight size={16} aria-hidden="true" />
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={() => onOpenMessage(conversation, conversation.latestMessageUid)}
                                className={["flex-1 min-w-0 text-left pr-4 py-3", unread ? "font-semibold" : ""].join(
                                    " "
                                )}
                            >
                                <div className="flex items-center justify-between gap-2 text-sm">
                                    <span className="truncate">{participantNames(conversation)}</span>
                                    <span className="text-xs text-text-muted shrink-0">
                                        {new Date(conversation.latestDate).toLocaleDateString()}
                                    </span>
                                </div>
                                <div className="text-sm truncate">{conversation.subject || "(no subject)"}</div>
                                <div className="text-xs text-text-muted truncate font-normal">
                                    {conversation.latestPreview}
                                </div>
                                <div className="flex items-center gap-2 mt-1 text-xs text-text-muted font-normal">
                                    {conversation.messageCount > 1 && <span>{conversation.messageCount} messages</span>}
                                    {/* A one-message conversation's unread state is already the row's own
                                        bolding - counting it "1 unread" on every such row is just noise. */}
                                    {unread && conversation.messageCount > 1 && (
                                        <span className="py-0.5 px-2 rounded-pill bg-primary/10 text-primary-dark font-semibold">
                                            {conversation.unreadCount} unread
                                        </span>
                                    )}
                                    {conversation.hasAttachments && (
                                        <HiOutlinePaperClip size={13} aria-label="Has attachments" />
                                    )}
                                    {conversation.flagged && (
                                        <HiOutlineFlag size={13} aria-label="Flagged" className="text-danger" />
                                    )}
                                </div>
                            </button>
                        </div>
                        <ul id={panelId} hidden={!isExpanded}>
                            {errorsById[id] && (
                                <li role="alert" className="pl-8 pr-4 py-2 text-xs text-danger border-b border-border">
                                    {errorsById[id]}
                                </li>
                            )}
                            {loadingIds.has(id) && (
                                <li className="pl-8 pr-4 py-2 text-xs text-text-muted border-b border-border">
                                    Loading messages&hellip;
                                </li>
                            )}
                            {children?.map((fetched) => {
                                const message = messageOverrides?.[fetched.uid] ?? fetched;
                                return (
                                    <li key={message.uid}>
                                        <button
                                            type="button"
                                            onClick={() => onOpenMessage(conversation, message.uid)}
                                            className={[
                                                "w-full text-left pl-8 pr-4 py-2 border-b border-border",
                                                message.uid === selectedUid ? "bg-primary/10" : "hover:bg-surface-alt",
                                                message.flags.read ? "" : "font-semibold",
                                            ].join(" ")}
                                        >
                                            <div className="flex items-center justify-between gap-2 text-sm">
                                                <span className="truncate">
                                                    {message.from.displayName || message.from.address}
                                                </span>
                                                <span className="text-xs text-text-muted shrink-0">
                                                    {new Date(message.receivedDate).toLocaleDateString()}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 text-xs text-text-muted font-normal">
                                                <span className="truncate">{message.bodyPreview}</span>
                                                {message.hasAttachments && (
                                                    <HiOutlinePaperClip size={12} aria-label="Has attachments" />
                                                )}
                                                {message.flags.flagged && (
                                                    <HiOutlineFlag
                                                        size={12}
                                                        aria-label="Flagged"
                                                        className="text-danger"
                                                    />
                                                )}
                                            </div>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </li>
                );
            })}
        </ul>
    );
}
