///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Attachment, Folder, Message, listAttachments } from "@rapidmx/react-shared/mail/mailApi.js";
import { ConversationSummary, listConversationMessages } from "@rapidmx/react-shared/mail/conversationsApi.js";
import { Label } from "@rapidmx/react-shared/mail/labelsApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import MailAddress from "./MailAddress.js";
import MessageDetailPane from "./MessageDetailPane.js";
import { useMailShell } from "./layout/MailShell.js";
import { setReadState } from "../../mail/messageReadState.js";
import { ROW_FOCUS_CLASS, UnreadBar, UnreadLabel, dateClass, isUnread, senderClass } from "./unreadStyle.js";

/** One request's worth of the thread. The server's own default for `listConversationMessages()`. */
export const THREAD_PAGE_SIZE = 100;
/**
 * How many of a conversation's messages this pane will load. The server reads at most
 * `CONVERSATION_SCAN_LIMIT` (500) messages when it groups conversations, so a `ConversationSummary` never
 * describes more than this many anyway; the cap is here so a thread that somehow reports more can't turn
 * into an unbounded run of requests. Past it the pane says so and the rest stay readable from the list.
 */
export const THREAD_MESSAGE_LIMIT = 500;

export interface ConversationThreadPaneProps {
    conversation: ConversationSummary | null;
    /** The mailbox the conversation was listed from - `listConversationMessages()` is mailbox-scoped. */
    mailboxUid: string;
    /**
     * The message the reader opened: the thread is scrolled to it, it takes focus, and it is the *oldest*
     * message left expanded (see `expandedFrom()`). `null`, or a uid this thread doesn't hold, falls back
     * to the newest message - which is also what a parent row means by "open the conversation".
     */
    selectedUid: string | null;
    /** The mailbox's full folder list. A conversation spans folders (an Inbox message and the Sent Items
     * copy of its reply), so each message's own folder type is looked up against its own `folderUid`. */
    folders: Folder[];
    /** The mailbox's labels, passed through to every expanded message's own `MessageDetailPane`. */
    labels?: Label[];
    /**
     * A newer copy of one of the thread's messages - read, flagged, labelled, classified, recalled - for
     * the caller's own list to stay in step with what was done in here.
     *
     * `previous` is the copy this pane held before the change, where it has one: the conversation row this
     * thread came from is a *summary* (a message count, an unread count), so a list showing those rows has
     * no way to tell "this message has just been read" from "this already-read message was relabelled"
     * without it - which is what left a row reporting "2 unread" after both had been read.
     */
    onMessagePatched: (updated: Message, previous?: Message) => void;
    /** A message that left the folder being listed (archived, or a scheduled send sent back to Drafts). */
    onMessageRemoved: (updated: Message) => void;
    onLabelCreated?: (label: Label) => void;
    /** A folder created from a message's own Move to prompt, for the folder sidebar to pick up. */
    onFolderCreated?: (folder: Folder) => void;
    /** Registers the keyboard shortcuts (Reply, Reply all, Forward, Archive, Move to) of the message that was opened - see `MessageDetailPane`'s
     * `shortcuts`. The caller turns it off while it is doing something else with the keyboard (select mode). */
    shortcuts?: boolean;
}

/**
 * Every message from `selectedUid` through to the newest - the run the reader is reading. Anything older
 * stays collapsed to its one-line summary. Selecting the newest message therefore expands just that one.
 *
 * The pane lists newest first (see `loadThread()`), so that run is the opened message together with
 * everything *above* it, and the opened message is the set's **last** entry rather than its first.
 */
function expandedFrom(messages: Message[], selectedUid: string | null): Set<string> {
    const index = messages.findIndex((message) => message.uid === selectedUid);
    // `messages` is never empty here (the callers below check), so -1 means "not in this thread" and the
    // newest message - the first entry - is the anchor, exactly as a parent row's own click means.
    const anchor = index === -1 ? 0 : index;
    return new Set(messages.slice(0, anchor + 1).map((message) => message.uid));
}

/**
 * The element a message of this thread actually scrolls inside. The pane is not itself the scroll
 * container in the mail shell - `MailShell`'s own `<main>` is - so an adjustment has to be applied where
 * the scrolling really happens, which is whichever ancestor is both scrollable and overflowing.
 */
function scrollingAncestor(node: HTMLElement): HTMLElement {
    for (let el = node.parentElement; el; el = el.parentElement) {
        const overflowY = getComputedStyle(el).overflowY;
        if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
            return el;
        }
    }
    // Nothing between the row and the root scrolls, so the page itself does - which in standards mode is
    // `documentElement`, the same element `document.scrollingElement` names there.
    return document.documentElement;
}

/**
 * The thread's messages, **newest first**, in pages of `THREAD_PAGE_SIZE` up to `THREAD_MESSAGE_LIMIT`.
 *
 * `listConversationMessages()` pages oldest first and has no order of its own to ask for, so the pages are
 * collected in that order - which is also the order the `THREAD_MESSAGE_LIMIT` cap has to apply in, since it
 * is the oldest messages that are dropped when a thread is too long to load - and reversed once at the end.
 * The pane reads newest first always, whatever the *list* is sorted by: it is the reading order for mail,
 * and it means the message a conversation row stands for is the entry at the top.
 */
async function loadThread(mailboxUid: string, conversationId: string): Promise<{ messages: Message[]; truncated: boolean }> {
    const messages: Message[] = [];
    let more = true;
    while (more && messages.length < THREAD_MESSAGE_LIMIT) {
        const page = await listConversationMessages(mailboxUid, conversationId, {
            page: messages.length / THREAD_PAGE_SIZE,
            limit: THREAD_PAGE_SIZE,
        });
        messages.push(...page);
        // A short page is the last one; a full page means asking for another.
        more = page.length === THREAD_PAGE_SIZE;
    }
    messages.reverse();
    return { messages, truncated: more };
}

/**
 * The reading pane for the conversation list: the whole thread, **newest at the top**, opened at the message
 * the reader picked. Every message from that one through to the newest is expanded - which in this order is
 * the opened message and the entries above it - and the older ones, below it, are collapsed to a one-line
 * summary (sender, date, preview) that expands on click or Enter. So opening the newest message shows just
 * the top entry expanded, and opening 5 of 10 expands 10 down to 5.
 *
 * Newest first regardless of how the *list* is sorted: the list's own order arranges rows to pick from,
 * while this is one conversation being read, and the entry a conversation row stands for - its latest
 * message - is the one that should be at the top of the pane every time it is opened.
 *
 * Each *expanded* message is a `MessageDetailPane` of its own rather than a reimplementation of it, so the
 * signature and verification badges, the verification-seal and decryption behaviour, the labels chips and
 * menu, the attachments and Reply/Reply All/Forward/Archive all behave exactly as they do in the
 * single-message pane, and each acts on the message it belongs to. A collapsed message mounts none of
 * that - mounting a body iframe per message up front would be wasteful in a long thread.
 */
export default function ConversationThreadPane({
    conversation,
    mailboxUid,
    selectedUid,
    folders,
    labels,
    onMessagePatched,
    onMessageRemoved,
    onLabelCreated,
    onFolderCreated,
    shortcuts,
}: ConversationThreadPaneProps) {
    const { trackMessageChange } = useMailShell();
    const [messages, setMessages] = useState<Message[]>([]);
    const [attachmentsByUid, setAttachmentsByUid] = useState<Record<string, Attachment[]>>({});
    const [expandedUids, setExpandedUids] = useState<Set<string>>(new Set());
    const [truncated, setTruncated] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** The message to scroll to and focus once it has rendered, or `null` once that has happened. */
    const [pendingFocusUid, setPendingFocusUid] = useState<string | null>(null);

    // Bumped on every conversation switch - an in-flight load/attachments/mark-read response carrying an
    // older generation belongs to a superseded conversation and is dropped rather than applied.
    const generationRef = useRef(0);
    const markReadRequestedRef = useRef<Set<string>>(new Set());
    const attachmentsRequestedRef = useRef<Set<string>>(new Set());
    /** The `conversationId:selectedUid` the expansion run below has already been applied for, so patching
     * a message (which changes `messages`) doesn't re-expand what the reader has since collapsed. */
    const appliedSelectionRef = useRef<string | null>(null);
    /** Which conversation the messages currently in state belong to. A render with a new conversation and
     * the previous one's messages still in state happens before the load effect has cleared them, and the
     * expansion run below must sit that render out rather than anchor on a message from another thread. */
    const loadedIdRef = useRef<string | null>(null);
    const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});
    const headerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    /** Where the toggled message's header sat in the viewport before it expanded, so the run below can put
     * it back there - expanding a message above the one being read must not shove that one off-screen. */
    const anchorRef = useRef<{ uid: string; top: number } | null>(null);

    const conversationId = conversation?.conversationId;

    useEffect(() => {
        const generation = ++generationRef.current;
        markReadRequestedRef.current = new Set();
        attachmentsRequestedRef.current = new Set();
        appliedSelectionRef.current = null;
        loadedIdRef.current = null;
        setMessages([]);
        setAttachmentsByUid({});
        setExpandedUids(new Set());
        setTruncated(false);
        setError(null);
        // The message the previous conversation was to be scrolled to went with it; leaving it set would
        // point the run below at a row that is no longer rendered.
        setPendingFocusUid(null);
        if (!conversationId) {
            setLoading(false);
            return;
        }
        setLoading(true);
        loadThread(mailboxUid, conversationId)
            .then((loaded) => {
                if (generation !== generationRef.current) return;
                loadedIdRef.current = conversationId;
                setMessages(loaded.messages);
                setTruncated(loaded.truncated);
            })
            .catch((err) => {
                if (generation !== generationRef.current) return;
                setError(err instanceof ApiRequestError ? err.message : "Could not load this conversation.");
            })
            .finally(() => {
                if (generation === generationRef.current) setLoading(false);
            });
    }, [conversationId, mailboxUid]);

    // Opening the thread, and opening a different message of the same thread, both set the run of expanded
    // messages and ask for that message to be scrolled to. `messages` is a dependency because the thread's
    // messages arrive after the click that selected one of them; the ref guard keeps a later change to
    // `messages` (a patched copy) from re-running it.
    useEffect(() => {
        if (messages.length === 0 || loadedIdRef.current !== conversationId) return;
        const key = `${conversationId}:${selectedUid}`;
        if (appliedSelectionRef.current === key) return;
        appliedSelectionRef.current = key;
        const expanded = expandedFrom(messages, selectedUid);
        setExpandedUids(expanded);
        // The oldest expanded message is the one that was opened - `expandedFrom()`'s own anchor - which in
        // this newest-first order is the *last* of the run, not the first.
        setPendingFocusUid([...expanded][expanded.size - 1]);
    }, [conversationId, selectedUid, messages]);

    useLayoutEffect(() => {
        if (!pendingFocusUid) return;
        // The row is always rendered by now: this runs after the DOM update that added the message it
        // names, and that message came out of `messages` in the first place.
        //
        // Scrolled inside the thread's own list and nowhere else. `scrollIntoView()` scrolls *every*
        // scrollable ancestor, the window included, which with a run of full-height messages expanded
        // took the app header and the folder rail off the screen - so the adjustment goes on whichever
        // ancestor actually scrolls, exactly as the toggle below already does it. When that is the page
        // itself, nothing inside the pane scrolls and the row is already in view, so it is left alone.
        const row = rowRefs.current[pendingFocusUid]!;
        const scroller = scrollingAncestor(row);
        if (scroller !== document.documentElement) {
            const rect = row.getBoundingClientRect();
            const top = rect.top - scroller.getBoundingClientRect().top;
            // "nearest": the least that brings it into view, and nothing at all when it is already there.
            if (top < 0 || top + rect.height > scroller.clientHeight) {
                scroller.scrollTop += top;
            }
        }
        // `preventScroll` so focusing doesn't scroll it somewhere else again.
        headerRefs.current[pendingFocusUid]!.focus({ preventScroll: true });
        setPendingFocusUid(null);
    }, [pendingFocusUid, expandedUids]);

    // Keeps the message whose header was just clicked where it was on screen. Expanding one above the
    // message being read otherwise pushes everything below it down by however tall the new body is.
    useLayoutEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor) return;
        anchorRef.current = null;
        // The row is still there: the anchor was taken from a rendered row, and toggling never removes one.
        const row = rowRefs.current[anchor.uid]!;
        scrollingAncestor(row).scrollTop += row.getBoundingClientRect().top - anchor.top;
    }, [expandedUids]);

    // Attachments and mark-as-read, for expanded messages only - mirrors `mailDetailHooks.ts`'s
    // `useMessageAttachments`/`useMarkMessageRead`, reimplemented here (rather than called in a loop, which
    // the rules of hooks don't allow) because a thread expands several messages at once.
    useEffect(() => {
        const generation = generationRef.current;
        for (const message of messages) {
            const uid = message.uid;
            if (!expandedUids.has(uid)) continue;
            if (message.hasAttachments && !attachmentsRequestedRef.current.has(uid)) {
                attachmentsRequestedRef.current.add(uid);
                listAttachments(message.folderUid, uid)
                    .then((loaded) => {
                        if (generation === generationRef.current) {
                            setAttachmentsByUid((prev) => ({ ...prev, [uid]: loaded }));
                        }
                    })
                    .catch(() => {
                        // Best-effort, as in `useMessageAttachments`: no attachments render meanwhile, and
                        // forgetting the request lets a later re-expand retry it.
                        attachmentsRequestedRef.current.delete(uid);
                    });
            }
            if (!markReadRequestedRef.current.has(uid)) {
                // Asked once per opened conversation and per expanding of the message: a failure is not retried from here, because
                // undoing the optimistic change changes `messages`, which would run this effect again and ask again, for ever. A message
                // that is already read is asked about too (there is nothing to send), so marking it unread while it is open - the
                // keyboard's Ctrl+U - doesn't make this run again and read it straight back.
                markReadRequestedRef.current.add(uid);
                if (message.flags.read === true) {
                    continue;
                }
                // `message` is this render's copy, so the request carries its current `version`. The row, the conversation row's
                // unread count and the folder badge all change at once; `previous` is what tells the list's conversation row
                // that its count moved (see `setReadState()`).
                void setReadState(message, true, {
                    patch: (updated, previous) => {
                        if (generation === generationRef.current) {
                            patchMessage(updated, previous);
                        }
                    },
                    track: trackMessageChange,
                });
            }
        }
    }, [expandedUids, messages]);

    /** A newer copy of one of the thread's messages, kept here and handed to the list - with the copy it
     * replaces where the caller was given one, so a conversation row can tell what actually changed. */
    function patchMessage(updated: Message, previous?: Message) {
        setMessages((prev) => prev.map((message) => (message.uid === updated.uid ? updated : message)));
        onMessagePatched(updated, previous);
    }

    /** A message that left the folder being listed - it leaves the thread too, as it left the list. */
    function removeMessage(updated: Message) {
        setMessages((prev) => prev.filter((message) => message.uid !== updated.uid));
        onMessageRemoved(updated);
    }

    function toggleExpanded(uid: string) {
        // Opening a message again asks to mark it read again - that is how one whose request failed is retried.
        markReadRequestedRef.current.delete(uid);
        // The row this button lives in has rendered, so its ref is set.
        anchorRef.current = { uid, top: rowRefs.current[uid]!.getBoundingClientRect().top };
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

    // The keyboard acts on the message that was opened - or the newest, when the opened one isn't in this thread - never on all the expanded
    // ones at once (each is a `MessageDetailPane`, and two of them must not both answer Ctrl+R).
    const keyboardUid = messages.some((message) => message.uid === selectedUid) ? selectedUid : messages[0]?.uid;

    function folderTypeOf(message: Message): string | undefined {
        return folders.find((folder) => folder.uid === message.folderUid)?.type;
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
        // The pane is the window's height, not the thread's: a full-height flex column whose heading is
        // fixed and whose list of messages is the one scrolling, growing child (`min-h-0`, or the list
        // would stretch the column past the pane instead of scrolling inside it). That is what gives an
        // expanded message's own `min-h-full` row - and therefore its body iframe, which can't measure
        // itself - a real height to resolve against at any window size.
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="shrink-0 border-b border-border p-4">
                <h1 className="text-lg font-bold tracking-tight">{conversation.subject || "(no subject)"}</h1>
                <p className="text-sm text-text-muted mt-1">
                    {messages.length} message{messages.length === 1 ? "" : "s"}
                </p>
                {truncated && (
                    <p className="text-xs text-text-muted mt-1">
                        Only the oldest {THREAD_MESSAGE_LIMIT} messages of this conversation are shown here. The rest
                        are still in the message list.
                    </p>
                )}
            </div>
            <ul className="flex-1 min-h-0 overflow-y-auto">
                {messages.map((message) => {
                    const uid = message.uid;
                    const expanded = expandedUids.has(uid);
                    const bodyId = `thread-message-${uid}`;
                    const messageUnread = isUnread(message);
                    return (
                        <li
                            key={uid}
                            ref={(node) => {
                                rowRefs.current[uid] = node;
                            }}
                            // An expanded message is as tall as the list it scrolls in - `min-h-full`
                            // against the `<ul>`'s own resolved height - so its `MessageDetailPane` below
                            // has a full pane of height to fill and its body reaches the bottom of the
                            // window whatever that window's size is. `min-` rather than `h-`: a message
                            // whose header alone is taller than the pane still gets the room it needs.
                            data-unread={messageUnread ? "true" : undefined}
                            className={["relative border-b border-border", expanded ? "flex flex-col min-h-full" : ""].join(" ")}
                        >
                            <UnreadBar unread={messageUnread} />
                            <h2 className="shrink-0">
                                <button
                                    type="button"
                                    ref={(node) => {
                                        headerRefs.current[uid] = node;
                                    }}
                                    onClick={() => toggleExpanded(uid)}
                                    aria-expanded={expanded}
                                    aria-controls={bodyId}
                                    className={[
                                        "w-full text-left px-4 py-3",
                                        messageUnread ? "bg-primary/[0.07] hover:bg-primary/10" : "hover:bg-surface-alt",
                                        ROW_FOCUS_CLASS,
                                    ].join(" ")}
                                >
                                    <UnreadLabel unread={messageUnread} />
                                    <span className="flex items-center justify-between gap-2 text-sm">
                                        <MailAddress recipient={message.from} className={senderClass(messageUnread)} />
                                        <span className={["text-xs shrink-0", dateClass(messageUnread)].join(" ")}>
                                            {new Date(message.receivedDate).toLocaleString()}
                                        </span>
                                    </span>
                                    {!expanded && (
                                        <span className="block text-xs text-text-muted truncate font-normal">
                                            {message.bodyPreview}
                                        </span>
                                    )}
                                </button>
                            </h2>
                            <div id={bodyId} hidden={!expanded} className={expanded ? "flex-1 min-h-0 flex" : undefined}>
                                {expanded && (
                                    <MessageDetailPane
                                        inThread
                                        shortcuts={!!shortcuts && uid === keyboardUid}
                                        message={message}
                                        attachments={attachmentsByUid[uid] ?? []}
                                        isSentItems={folderTypeOf(message) === "sent_items"}
                                        isOutbox={folderTypeOf(message) === "outbox"}
                                        draftsFolderUid={folders.find((folder) => folder.type === "drafts")?.uid}
                                        folders={folders}
                                        onMoved={removeMessage}
                                        onFolderCreated={onFolderCreated}
                                        onRecalled={patchMessage}
                                        onReceiptHandled={patchMessage}
                                        onScheduledSendCanceled={removeMessage}
                                        onArchived={removeMessage}
                                        labels={labels}
                                        onLabelsChanged={patchMessage}
                                        onLabelCreated={onLabelCreated}
                                    />
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
