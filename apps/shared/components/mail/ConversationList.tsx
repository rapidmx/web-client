///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { ConversationSummary } from "@rapidmx/react-shared/conversationsApi.js";

export interface ConversationListProps {
    conversations: ConversationSummary[];
    selectedId: string | null;
    onSelect: (conversation: ConversationSummary) => void;
}

/** The "By conversation" counterpart to the per-message list `apps/www/index.tsx` renders inline for
 * "By date" — conversations are mailbox-wide (see `conversationsApi.ts`), so there's no per-folder
 * empty/loading state to distinguish here beyond what the page itself already handles. */
export default function ConversationList({ conversations, selectedId, onSelect }: ConversationListProps) {
    if (conversations.length === 0) {
        return <p className="p-4 text-sm text-text-muted">No conversations in this mailbox.</p>;
    }

    return (
        <ul>
            {conversations.map((conversation) => {
                const unread = conversation.unreadCount > 0;
                return (
                    <li key={conversation.conversationId}>
                        <button
                            type="button"
                            onClick={() => onSelect(conversation)}
                            className={[
                                "w-full text-left px-4 py-3 border-b border-border",
                                conversation.conversationId === selectedId ? "bg-primary/10" : "hover:bg-surface-alt",
                                unread ? "font-semibold" : "",
                            ].join(" ")}
                        >
                            <div className="flex items-center justify-between gap-2 text-sm">
                                <span className="truncate">
                                    {conversation.participants.map((p) => p.displayName || p.address).join(", ")}
                                </span>
                                <span className="text-xs text-text-muted shrink-0">
                                    {new Date(conversation.latestDate).toLocaleDateString()}
                                </span>
                            </div>
                            <div className="text-sm truncate">{conversation.subject || "(no subject)"}</div>
                            <div className="flex items-center gap-2 mt-1 text-xs text-text-muted font-normal">
                                {conversation.messageCount > 1 && <span>{conversation.messageCount} messages</span>}
                                {unread && (
                                    <span className="py-0.5 px-2 rounded-pill bg-primary/10 text-primary-dark font-semibold">
                                        {conversation.unreadCount} unread
                                    </span>
                                )}
                                {conversation.hasAttachments && <span aria-label="Has attachments">&#128206;</span>}
                            </div>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
