///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { HiChevronDown, HiChevronRight, HiOutlineFlag, HiOutlinePaperClip } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { formatMailAddress } from "@rapidmx/react-shared/mail/mailAddress.js";
import MailAddress from "./MailAddress.js";
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
    /** Turns each parent row into a checkbox row: select mode here ticks whole conversations, since a
     * conversation is what this list's rows are. A child row stays a plain "open this message" button - a
     * mixed conversation/message selection has no sensible bulk semantics (see `MailListToolbar`). */
    selectMode?: boolean;
    /** The `conversationId`s currently ticked. */
    selectedConversationIds?: Set<string>;
    onToggleSelected?: (conversation: ConversationSummary) => void;
    /**
     * Whether a conversation's own messages read newest first, matching the order sense the rows themselves
     * are in ("Newest on top"). `listConversationMessages()` always answers oldest first - the order a
     * thread is read in - so this reverses that copy for display rather than asking for it differently.
     */
    newestFirst?: boolean;
}

/** Every participant as `Name <address>`, for the tooltip and the accessible text of the "+N" a crowded row folds them into. */
function participantList(conversation: ConversationSummary): string {
    return conversation.participants.map((participant) => formatMailAddress(participant)).join(", ");
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
    selectMode,
    selectedConversationIds,
    onToggleSelected,
    newestFirst,
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
                const loaded = messagesById[id];
                // `listConversationMessages()` answers oldest first; the rows read in whichever sense the
                // list itself is arranged in. Copied before reversing - the fetched array is cached.
                const children = loaded && newestFirst ? [...loaded].reverse() : loaded;
                const panelId = `conversation-messages-${id}`;
                const ticked = selectedConversationIds?.has(id) ?? false;
                return (
                    <li key={id}>
                        <div
                            className={[
                                "flex items-stretch border-b border-border",
                                conversation.latestMessageUid === selectedUid || ticked
                                    ? "bg-primary/10"
                                    : "hover:bg-surface-alt",
                            ].join(" ")}
                        >
                            {selectMode && (
                                <span className="shrink-0 flex items-center pl-3">
                                    <input
                                        type="checkbox"
                                        checked={ticked}
                                        onChange={() => onToggleSelected?.(conversation)}
                                        aria-label={`Select conversation: ${conversation.subject || "(no subject)"}`}
                                        className="w-4 h-4 accent-primary"
                                    />
                                </span>
                            )}
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
                                    {/* The first participant in full - name and address - and the rest as a count, with everyone's
                                        address in its tooltip; the latest sender when the summary lists none. */}
                                    <MailAddress recipient={conversation.participants[0] ?? conversation.latestFrom} className="flex-1" />
                                    {conversation.participants.length > 1 && (
                                        <span className="text-xs text-text-muted shrink-0 font-normal" title={participantList(conversation)}>
                                            +{conversation.participants.length - 1}
                                            <span className="sr-only"> more: {participantList(conversation)}</span>
                                        </span>
                                    )}
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
                                                <MailAddress recipient={message.from} />
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
