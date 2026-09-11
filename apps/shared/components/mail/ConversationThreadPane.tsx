///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { Attachment, Folder, Message, getMessage, listAttachments, setMessageRead } from "@rapidmx/react-shared/mailApi.js";
import { ConversationSummary } from "@rapidmx/react-shared/conversationsApi.js";
import MessageDetailPane from "./MessageDetailPane.js";
import Alert from "../feedback/Alert.js";

export interface ConversationThreadPaneProps {
    conversation: ConversationSummary | null;
    /** The mailbox's full folder list — a conversation can span folders (e.g. an Inbox message and the
     * Sent Items copy of its reply), so each message's own recall eligibility is looked up individually
     * against its own `folderUid` rather than assuming one folder for the whole thread. */
    folders: Folder[];
}

/**
 * The merged, Gmail-style reading pane for "By conversation" mode — every message in the conversation
 * fetched and stacked oldest-to-newest, all but the most recent collapsed to a one-line summary
 * (sender + subject) until clicked. Reuses `MessageDetailPane` for each *expanded* message's own
 * header/attachments/body-iframe rendering rather than re-implementing it; a collapsed row is its own
 * lightweight summary, since mounting a full `MessageDetailPane` (and its iframe) for every message in
 * a long thread up front would be wasteful.
 */
export default function ConversationThreadPane({ conversation, folders }: ConversationThreadPaneProps) {
    const [messages, setMessages] = useState<Record<string, Message>>({});
    const [attachmentsByUid, setAttachmentsByUid] = useState<Record<string, Attachment[]>>({});
    const [expandedUids, setExpandedUids] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!conversation) {
            setMessages({});
            setExpandedUids(new Set());
            return;
        }
        setLoading(true);
        setError(null);
        Promise.all(conversation.messageUids.map((uid) => getMessage(uid)))
            .then((loaded) => {
                setMessages(Object.fromEntries(loaded.map((m) => [m.uid, m])));
                // `messageUids` always has at least one entry — a `ConversationSummary` only ever
                // exists because it was grouped from real messages (see
                // `BaseMessageRoute.conversations()`).
                const latestUid = conversation.messageUids[conversation.messageUids.length - 1];
                setExpandedUids(new Set([latestUid]));
            })
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this conversation."))
            .finally(() => setLoading(false));
    }, [conversation?.conversationId]);

    // Lazily loads attachments and marks-as-read only for messages the reader has actually expanded —
    // mirrors `mailDetailHooks.ts`'s `useMessageAttachments`/`useMarkMessageRead`, reimplemented here
    // (rather than called in a loop, which the rules of hooks don't allow) since a thread can expand
    // more than one message at once, unlike the single-selected-message case those hooks were built for.
    useEffect(() => {
        for (const uid of expandedUids) {
            const message = messages[uid];
            if (!message) continue;
            if (message.hasAttachments && !attachmentsByUid[uid]) {
                listAttachments(message.folderUid, uid)
                    .then((loaded) => setAttachmentsByUid((prev) => ({ ...prev, [uid]: loaded })))
                    .catch(() => {
                        // Best-effort, same as the mark-as-read catch below — `attachmentsByUid[uid] ??
                        // []` already renders no attachments while this stays unset, so there is nothing
                        // further to do on failure.
                    });
            }
            if (!message.flags.read) {
                setMessageRead(message, true)
                    .then((updated) => setMessages((prev) => ({ ...prev, [uid]: updated })))
                    .catch(() => {
                        // Best-effort — matches `useMarkMessageRead`'s own doc comment.
                    });
            }
        }
    }, [expandedUids, messages]);

    function toggleExpanded(uid: string) {
        setExpandedUids((prev) => {
            const next = new Set(prev);
            if (next.has(uid)) {
                next.delete(uid);
            } else {
                next.add(uid);
            }
            return next;
        });
    }

    if (!conversation) {
        return <p className="p-8 text-sm text-text-muted">Select a conversation to read it.</p>;
    }
    if (loading) {
        return <p className="p-8 text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error) {
        return (
            <div className="p-4 flex-1">
                <Alert>{error}</Alert>
            </div>
        );
    }

    return (
        <div className="flex-1 min-w-0 flex flex-col overflow-y-auto">
            <div className="border-b border-border p-4">
                <h1 className="text-lg font-bold tracking-tight">{conversation.subject || "(no subject)"}</h1>
                <p className="text-sm text-text-muted mt-1">
                    {conversation.messageCount} message{conversation.messageCount === 1 ? "" : "s"}
                </p>
            </div>
            {conversation.messageUids.map((uid) => {
                const message = messages[uid];
                if (!message) {
                    return null;
                }
                const expanded = expandedUids.has(uid);
                if (!expanded) {
                    return (
                        <button
                            key={uid}
                            type="button"
                            onClick={() => toggleExpanded(uid)}
                            className={[
                                "w-full text-left px-4 py-3 border-b border-border hover:bg-surface-alt",
                                message.flags.read ? "" : "font-semibold",
                            ].join(" ")}
                        >
                            <div className="flex items-center justify-between gap-2 text-sm">
                                <span className="truncate">{message.from.displayName || message.from.address}</span>
                                <span className="text-xs text-text-muted shrink-0">
                                    {new Date(message.receivedDate).toLocaleString()}
                                </span>
                            </div>
                            <div className="text-xs text-text-muted truncate font-normal">{message.bodyPreview}</div>
                        </button>
                    );
                }
                return (
                    <div key={uid} className="border-b border-border">
                        <button
                            type="button"
                            onClick={() => toggleExpanded(uid)}
                            className="w-full text-left px-4 pt-2 text-xs text-text-muted hover:text-text"
                        >
                            Collapse
                        </button>
                        <MessageDetailPane
                            message={message}
                            attachments={attachmentsByUid[uid] ?? []}
                            isSentItems={folders.find((f) => f.uid === message.folderUid)?.type === "sent_items"}
                            onRecalled={(updated) => setMessages((prev) => ({ ...prev, [uid]: updated }))}
                            isOutbox={folders.find((f) => f.uid === message.folderUid)?.type === "outbox"}
                            draftsFolderUid={folders.find((f) => f.type === "drafts")?.uid}
                            // Unlike `apps/www/index.tsx`'s list-removal behavior, this patches the
                            // message in place (same as `onRecalled` above) rather than removing it from
                            // the conversation — `conversation.messageUids` is owned by the parent, not
                            // this component, so there's no membership list here to remove it from.
                            onScheduledSendCanceled={(updated) => setMessages((prev) => ({ ...prev, [uid]: updated }))}
                            isInbox={folders.find((f) => f.uid === message.folderUid)?.type === "inbox"}
                            onClassified={(updated) => setMessages((prev) => ({ ...prev, [uid]: updated }))}
                            onReceiptHandled={(updated) => setMessages((prev) => ({ ...prev, [uid]: updated }))}
                        />
                    </div>
                );
            })}
        </div>
    );
}
