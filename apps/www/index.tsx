///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { Message, MessageClassification, getMessage, listMessages } from "@rapidmx/react-shared/mailApi.js";
import { ConversationSummary, listConversations } from "@rapidmx/react-shared/conversationsApi.js";
import { search as searchMailbox } from "@rapidmx/react-shared/searchApi.js";
import { useMarkMessageRead, useMessageAttachments } from "@rapidmx/react-shared/mailDetailHooks.js";
import useIsMobile from "@rapidmx/react-shared/useIsMobile.js";
import MailShell, { MailShellProps, useMailShell } from "../shared/components/mail/layout/MailShell.js";
import MessageDetailPane from "../shared/components/mail/MessageDetailPane.js";
import ConversationList from "../shared/components/mail/ConversationList.js";
import ConversationThreadPane from "../shared/components/mail/ConversationThreadPane.js";
import Alert from "../shared/components/feedback/Alert.js";

type ViewMode = "date" | "conversation";

const MESSAGE_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

/** Resolves one page of search hits (of type "message") into full `Message` records for display. */
async function searchMessages(text: string, cursor?: string): Promise<{ messages: Message[]; nextCursor?: string }> {
    const page = await searchMailbox(text, { types: ["message"], cursor, limit: MESSAGE_PAGE_SIZE });
    const resolved = await Promise.all(
        page.results.map((hit) => getMessage(hit.entityUid).catch(() => null)),
    );
    // A search hit can briefly outlive the message it points to (index updates are eventually consistent,
    // and a message can be deleted after being indexed) - drop anything that no longer resolves rather than
    // rendering a broken entry.
    return { messages: resolved.filter((m): m is Message => m !== null), nextCursor: page.nextCursor };
}

export default function InboxPage(props: MailShellProps) {
    return (
        <MailShell {...props}>
            <InboxContent />
        </MailShell>
    );
}

function InboxContent() {
    const { folderUid, mailboxUid, folders } = useMailShell();
    const isMobile = useIsMobile();
    const [viewMode, setViewMode] = useState<ViewMode>("date");
    const [messages, setMessages] = useState<Message[]>([]);
    const [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedUid, setSelectedUid] = useState<string | null>(null);
    const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
    const [classificationFilter, setClassificationFilter] = useState<MessageClassification | "all">("all");
    const [searchInput, setSearchInput] = useState("");
    const [searchQuery, setSearchQuery] = useState("");
    const isSearching = viewMode === "date" && searchQuery.length > 0;
    const pageRef = useRef(0);
    const cursorRef = useRef<string | undefined>(undefined);
    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    // Debounce the raw input into the query actually searched, so every keystroke doesn't fire a request.
    useEffect(() => {
        const handle = setTimeout(() => setSearchQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [searchInput]);

    // Conversations are computed mailbox-wide (see `conversationsApi.ts`), not scoped to the selected
    // folder — switching into "By conversation" mode replaces the per-folder list entirely, and the
    // folder-tree sidebar's own selection becomes purely informational until switching back to "By date".
    useEffect(() => {
        setSelectedUid(null);
        setSelectedConversationId(null);
        setClassificationFilter("all");
        pageRef.current = 0;
        cursorRef.current = undefined;
        setHasMore(false);

        if (viewMode === "conversation") {
            // `mailboxUid` is always set by this point — `MailShell` only ever resolves `folderUid`
            // (this component's own guard just below, gating everything before this effect can even
            // run with `viewMode === "conversation"`) after `mailboxUid` is already known.
            setLoading(true);
            setError(null);
            listConversations(mailboxUid!)
                .then(setConversations)
                .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load conversations."))
                .finally(() => setLoading(false));
            return;
        }

        if (!folderUid) {
            setMessages([]);
            setLoading(false);
            return;
        }
        setLoading(true);
        setError(null);

        if (isSearching) {
            searchMessages(searchQuery)
                .then(({ messages: results, nextCursor }) => {
                    setMessages(results);
                    setHasMore(!!nextCursor);
                    cursorRef.current = nextCursor;
                })
                .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Search failed."))
                .finally(() => setLoading(false));
            return;
        }

        listMessages(folderUid, { limit: MESSAGE_PAGE_SIZE })
            .then((results) => {
                setMessages(results);
                setHasMore(results.length === MESSAGE_PAGE_SIZE);
            })
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load messages."))
            .finally(() => setLoading(false));
    }, [viewMode, folderUid, mailboxUid, isSearching, searchQuery]);

    const loadMore = useCallback(async () => {
        if (loadingMore || !hasMore || loading || viewMode !== "date" || !folderUid) {
            return;
        }
        setLoadingMore(true);
        try {
            if (isSearching) {
                const { messages: more, nextCursor } = await searchMessages(searchQuery, cursorRef.current);
                setMessages((prev) => [...prev, ...more]);
                setHasMore(!!nextCursor);
                cursorRef.current = nextCursor;
            } else {
                const nextPage = pageRef.current + 1;
                const more = await listMessages(folderUid, { page: nextPage, limit: MESSAGE_PAGE_SIZE });
                setMessages((prev) => [...prev, ...more]);
                setHasMore(more.length === MESSAGE_PAGE_SIZE);
                pageRef.current = nextPage;
            }
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not load more messages.");
        } finally {
            setLoadingMore(false);
        }
    }, [loadingMore, hasMore, loading, viewMode, folderUid, isSearching, searchQuery]);

    // Always calls the latest `loadMore` closure so the effect below doesn't need `loadMore` itself in its
    // dependency array (it changes on every keystroke/page load, which would otherwise mean nothing here).
    const loadMoreRef = useRef(loadMore);
    loadMoreRef.current = loadMore;

    // `hasMore` is deliberately a dependency: the sentinel div only renders while `hasMore` is true (see
    // the JSX below), so this effect must re-run when it flips - otherwise a run that fires before the
    // first page of results has loaded (sentinel not in the DOM yet, `sentinelRef.current` still null)
    // would bail out once and never attach an observer to the sentinel that appears moments later.
    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || viewMode !== "date") {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting) {
                    void loadMoreRef.current();
                }
            },
            { root: scrollContainerRef.current, rootMargin: "200px" },
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [viewMode, folderUid, isSearching, searchQuery, hasMore]);

    const selected = messages.find((m) => m.uid === selectedUid) ?? null;
    const selectedConversation = conversations.find((c) => c.conversationId === selectedConversationId) ?? null;
    const attachments = useMessageAttachments(selected);
    useMarkMessageRead(selected, (updated) => setMessages((prev) => prev.map((m) => (m.uid === updated.uid ? updated : m))));
    // Search results can span every folder in the mailbox, not just the one selected in the sidebar - a
    // selected message's own folderUid is the only reliable source for its actual folder type once
    // searching (outside search, every message in `messages` already comes from `folderUid` itself, so
    // this falls back to the sidebar selection unchanged).
    const selectedFolderUid = isSearching ? (selected?.folderUid ?? folderUid) : folderUid;
    const isSentItems = folders.find((f) => f.uid === selectedFolderUid)?.type === "sent_items";
    const isOutbox = folders.find((f) => f.uid === selectedFolderUid)?.type === "outbox";
    const isInbox = folders.find((f) => f.uid === selectedFolderUid)?.type === "inbox";
    const draftsFolderUid = folders.find((f) => f.type === "drafts")?.uid;

    // Focused/Other is an Inbox-only concept (see `MessageDetailPane`'s own `isInbox` doc comment) — the
    // sub-tabs only ever render there, so a message with no `inferenceClassification` (the common case:
    // absent means Focused) or an explicit `"focused"` counts as Focused, everything else as Other.
    const visibleMessages =
        !isSearching && isInbox && classificationFilter !== "all"
            ? messages.filter((m) =>
                  classificationFilter === "other"
                      ? m.inferenceClassification === "other"
                      : m.inferenceClassification !== "other",
              )
            : messages;

    function handleSelect(message: Message) {
        if (isMobile) {
            window.location.href = `/messages/${encodeURIComponent(message.uid)}`;
            return;
        }
        setSelectedUid(message.uid);
    }

    function handleSelectConversation(conversation: ConversationSummary) {
        if (isMobile) {
            // No dedicated mobile thread route yet — the existing single-message detail route already
            // handles any message uid regardless of conversation grouping, so land on the most recent
            // message in the thread rather than building a second mobile detail page for this phase.
            // `messageUids` always has at least one entry — a `ConversationSummary` only ever exists
            // because it was grouped from real messages (see `BaseMessageRoute.conversations()`).
            const latestUid = conversation.messageUids[conversation.messageUids.length - 1];
            window.location.href = `/messages/${encodeURIComponent(latestUid)}`;
            return;
        }
        setSelectedConversationId(conversation.conversationId);
    }

    if (!folderUid) {
        // `MailShell` never renders this component at all until a mailbox is resolved (see its own
        // full-screen `MailboxProvisioning` takeover otherwise) — this is purely the brief gap before
        // that mailbox's own folder list has finished loading, not a "no mailbox" state. Distinct text
        // from the message list's own "Loading…" below — otherwise the two transient states become
        // indistinguishable to anything (a test, a user re-reading the screen) that catches this one.
        return <p className="p-8 text-sm text-text-muted">Loading your mailbox&hellip;</p>;
    }

    return (
        <div className="flex h-full min-h-0">
            <div ref={scrollContainerRef} className="w-full md:w-96 shrink-0 md:border-r border-border overflow-y-auto">
                <div className="flex border-b border-border text-sm">
                    <button
                        type="button"
                        onClick={() => setViewMode("date")}
                        className={[
                            "flex-1 py-2 font-semibold",
                            viewMode === "date" ? "text-primary-dark border-b-2 border-primary-dark" : "text-text-muted",
                        ].join(" ")}
                    >
                        By date
                    </button>
                    <button
                        type="button"
                        onClick={() => setViewMode("conversation")}
                        className={[
                            "flex-1 py-2 font-semibold",
                            viewMode === "conversation" ? "text-primary-dark border-b-2 border-primary-dark" : "text-text-muted",
                        ].join(" ")}
                    >
                        By conversation
                    </button>
                </div>
                {viewMode === "conversation" && (
                    <p className="p-3 text-xs text-text-muted border-b border-border">
                        Showing every conversation in this mailbox — the selected folder doesn&apos;t filter this view.
                    </p>
                )}
                {viewMode === "date" && (
                    <div className="p-2 border-b border-border">
                        <input
                            type="search"
                            value={searchInput}
                            onChange={(e) => setSearchInput(e.target.value)}
                            placeholder="Search all mail…"
                            aria-label="Search all mail"
                            className="w-full text-sm px-3 py-1.5 rounded-md border border-border bg-surface"
                        />
                    </div>
                )}
                {viewMode === "date" && isInbox && !isSearching && (
                    <div className="flex border-b border-border text-xs">
                        {(["all", "focused", "other"] as const).map((value) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setClassificationFilter(value)}
                                className={[
                                    "flex-1 py-1.5 font-semibold",
                                    classificationFilter === value
                                        ? "text-primary-dark border-b-2 border-primary-dark"
                                        : "text-text-muted",
                                ].join(" ")}
                            >
                                {value === "all" ? "All" : value === "focused" ? "Focused" : "Other"}
                            </button>
                        ))}
                    </div>
                )}

                {error && (
                    <div className="p-4">
                        <Alert>{error}</Alert>
                    </div>
                )}

                {loading ? (
                    <p className="p-4 text-sm text-text-muted">Loading&hellip;</p>
                ) : viewMode === "conversation" ? (
                    <ConversationList
                        conversations={conversations}
                        selectedId={selectedConversationId}
                        onSelect={handleSelectConversation}
                    />
                ) : visibleMessages.length === 0 ? (
                    <p className="p-4 text-sm text-text-muted">
                        {isSearching
                            ? `No messages match "${searchQuery}".`
                            : classificationFilter === "all"
                              ? "No messages in this folder."
                              : "No messages here."}
                    </p>
                ) : (
                    <>
                        <ul>
                            {visibleMessages.map((message) => (
                                <li key={message.uid}>
                                    <button
                                        type="button"
                                        onClick={() => handleSelect(message)}
                                        className={[
                                            "w-full text-left px-4 py-3 border-b border-border",
                                            message.uid === selectedUid ? "bg-primary/10" : "hover:bg-surface-alt",
                                            message.flags.read ? "" : "font-semibold",
                                        ].join(" ")}
                                    >
                                        <div className="flex items-center justify-between gap-2 text-sm">
                                            <span className="truncate">{message.from.displayName || message.from.address}</span>
                                            <span className="text-xs text-text-muted shrink-0">
                                                {new Date(message.receivedDate).toLocaleDateString()}
                                            </span>
                                        </div>
                                        <div className="text-sm truncate">{message.subject || "(no subject)"}</div>
                                        <div className="text-xs text-text-muted truncate font-normal">{message.bodyPreview}</div>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {hasMore && (
                            <div ref={sentinelRef} className="p-4 text-center text-xs text-text-muted">
                                {loadingMore ? "Loading more…" : ""}
                            </div>
                        )}
                    </>
                )}
            </div>
            <div className="hidden md:flex flex-1 min-w-0">
                {viewMode === "conversation" ? (
                    <ConversationThreadPane conversation={selectedConversation} folders={folders} />
                ) : (
                    <MessageDetailPane
                        message={selected}
                        attachments={attachments}
                        isSentItems={isSentItems}
                        onRecalled={(updated) => setMessages((prev) => prev.map((m) => (m.uid === updated.uid ? updated : m)))}
                        isOutbox={isOutbox}
                        isInbox={isInbox}
                        onClassified={(updated) => setMessages((prev) => prev.map((m) => (m.uid === updated.uid ? updated : m)))}
                        onReceiptHandled={(updated) => setMessages((prev) => prev.map((m) => (m.uid === updated.uid ? updated : m)))}
                        draftsFolderUid={draftsFolderUid}
                        onScheduledSendCanceled={(updated) => {
                            // The message moved out of the currently-viewed Outbox folder (into Drafts)
                            // — unlike a recall, which patches a message in place, this removes it from
                            // the list entirely, matching what a real folder switch would show.
                            setMessages((prev) => prev.filter((m) => m.uid !== updated.uid));
                            setSelectedUid(null);
                        }}
                    />
                )}
            </div>
        </div>
    );
}
