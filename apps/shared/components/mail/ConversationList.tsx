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
import { EncryptedPreview, conversationLooksEncrypted } from "./reading/EncryptedPreview.js";
import { ConversationSummary, listConversationMessages } from "@rapidmx/react-shared/mail/conversationsApi.js";
import { ROW_FOCUS_CLASS, UnreadBar, UnreadLabel, dateClass, isUnread, rowClass, senderClass, subjectClass } from "./unreadStyle.js";
import SwipeRow from "./SwipeRow.js";
import InviteRowChip from "./invite/InviteRowChip.js";

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
    /** Called with one of a conversation's own messages carrying the answer the reader just gave to its meeting request (from that row's RSVP chip), so the caller can keep it. An answer given from the conversation's own (parent) row is kept by this list itself. */
    onMeetingResponded?: (updated: Message) => void;
    /** Turns each parent row into a checkbox row: select mode here ticks whole conversations, since a
     * conversation is what this list's rows are. A child row stays a plain "open this message" button - a
     * mixed conversation/message selection has no sensible bulk semantics (see `MailListToolbar`). */
    selectMode?: boolean;
    /** The `conversationId`s currently ticked. */
    selectedConversationIds?: Set<string>;
    onToggleSelected?: (conversation: ConversationSummary) => void;
    /**
     * What swiping a parent row does on a phone: right to left archives the conversation (resolving whether it went through), left
     * to right asks where to move it. Absent, or `enabled: false` (a desktop), rows don't follow a finger.
     */
    swipe?: {
        enabled: boolean;
        onArchive: (conversation: ConversationSummary) => Promise<boolean>;
        onMove: (conversation: ConversationSummary) => void;
    };
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
    onMeetingResponded,
    selectMode,
    selectedConversationIds,
    onToggleSelected,
    swipe,
    newestFirst,
}: ConversationListProps) {
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [messagesById, setMessagesById] = useState<Record<string, Message[]>>({});
    const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
    const [errorsById, setErrorsById] = useState<Record<string, string>>({});
    // The answers given from a row's RSVP chip, by message uid: a row draws them at once, whichever row (the conversation's, or one of its messages) they were given from.
    const [answers, setAnswers] = useState<Record<string, Message["meetingResponse"]>>({});

    function answered(updated: Message) {
        setAnswers((prev) => ({ ...prev, [updated.uid]: updated.meetingResponse }));
    }

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
        // `overflow-x-clip`: the panels a swiped row drags along stand outside its edges (see `SwipeRow`).
        <ul className={swipe?.enabled ? "overflow-x-clip" : undefined}>
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
                        <SwipeRow
                            as="div"
                            enabled={!!swipe?.enabled && !selectMode}
                            onArchive={() => swipe!.onArchive(conversation)}
                            onMove={() => swipe!.onMove(conversation)}
                            data-message-uid={conversation.latestMessageUid}
                            data-unread={unread ? "true" : undefined}
                            className={rowClass({ unread, selected: conversation.latestMessageUid === selectedUid || ticked }, "flex items-stretch")}
                        >
                            <UnreadBar unread={unread} />
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
                                className={["shrink-0 px-2 text-text-muted hover:text-text", ROW_FOCUS_CLASS].join(" ")}
                            >
                                {isExpanded ? (
                                    <HiChevronDown size={16} aria-hidden="true" />
                                ) : (
                                    <HiChevronRight size={16} aria-hidden="true" />
                                )}
                            </button>
                            {/* The open button and, for a meeting request, its RSVP chip: a button can't hold a button, so the chip is the button's sibling. */}
                            <div className="flex-1 min-w-0 flex flex-col">
                                <button
                                    type="button"
                                    data-row-open
                                    onClick={() => onOpenMessage(conversation, conversation.latestMessageUid)}
                                    className={["w-full text-left pr-4 py-3", ROW_FOCUS_CLASS].join(" ")}
                                >
                                    <UnreadLabel unread={unread} />
                                    <div className="flex items-center justify-between gap-2 text-sm">
                                        {/* The first participant in full - name and address - and the rest as a count, with everyone's
                                            address in its tooltip; the latest sender when the summary lists none. */}
                                        <MailAddress
                                            recipient={conversation.participants[0] ?? conversation.latestFrom}
                                            className={["flex-1", senderClass(unread)].join(" ")}
                                        />
                                        {conversation.participants.length > 1 && (
                                            <span className="text-xs text-text-muted shrink-0 font-normal" title={participantList(conversation)}>
                                                +{conversation.participants.length - 1}
                                                <span className="sr-only"> more: {participantList(conversation)}</span>
                                            </span>
                                        )}
                                        <span className={["text-xs shrink-0", dateClass(unread)].join(" ")}>
                                            {new Date(conversation.latestDate).toLocaleDateString()}
                                        </span>
                                    </div>
                                    <div className={["text-sm truncate", subjectClass(unread)].join(" ")}>{conversation.subject || "(no subject)"}</div>
                                    <div className="text-xs text-text-muted truncate font-normal">
                                        {/* An encrypted latest message has no preview (the server never had its plaintext): say so, with a lock, not nothing. */}
                                        {conversationLooksEncrypted(conversation) ? <EncryptedPreview /> : conversation.latestPreview}
                                    </div>
                                    <div className="flex items-center gap-2 mt-1 text-xs text-text-muted font-normal">
                                        {conversation.messageCount > 1 && <span>{conversation.messageCount} messages</span>}
                                        {/* A one-message conversation's unread state is already the row's own
                                            bolding - counting it "1 unread" on every such row is just noise. */}
                                        {unread && conversation.messageCount > 1 && (
                                            <span className="py-0.5 px-2 rounded-pill bg-primary/15 text-primary-dark font-bold">
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
                                <InviteRowChip
                                    message={
                                        {
                                            uid: conversation.latestMessageUid,
                                            meetingMethod: conversation.latestMeetingMethod ?? undefined,
                                            meetingResponse:
                                                answers[conversation.latestMessageUid] ??
                                                messageOverrides?.[conversation.latestMessageUid]?.meetingResponse ??
                                                conversation.latestMeetingResponse ??
                                                undefined,
                                        } as Message
                                    }
                                    onResponded={answered}
                                    className="mr-4"
                                />
                            </div>
                        </SwipeRow>
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
                                const messageUnread = isUnread(message);
                                return (
                                    <li
                                        key={message.uid}
                                        data-message-uid={message.uid}
                                        data-unread={messageUnread ? "true" : undefined}
                                        className={rowClass({ unread: messageUnread, selected: message.uid === selectedUid })}
                                    >
                                        <UnreadBar unread={messageUnread} />
                                        <button
                                            type="button"
                                            data-row-open
                                            onClick={() => onOpenMessage(conversation, message.uid)}
                                            className={["w-full text-left pl-8 pr-4 py-2", ROW_FOCUS_CLASS].join(" ")}
                                        >
                                            <UnreadLabel unread={messageUnread} />
                                            <div className="flex items-center justify-between gap-2 text-sm">
                                                <MailAddress recipient={message.from} className={senderClass(messageUnread)} />
                                                <span className={["text-xs shrink-0", dateClass(messageUnread)].join(" ")}>
                                                    {new Date(message.receivedDate).toLocaleDateString()}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 text-xs text-text-muted font-normal">
                                                <span className="truncate">{message.bodyPreview || (message.encrypted ? <EncryptedPreview /> : null)}</span>
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
                                        <InviteRowChip
                                            message={{ ...message, meetingResponse: answers[message.uid] ?? message.meetingResponse }}
                                            onResponded={(updated) => {
                                                answered(updated);
                                                onMeetingResponded?.(updated);
                                            }}
                                            className="ml-8 mr-4"
                                        />
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
