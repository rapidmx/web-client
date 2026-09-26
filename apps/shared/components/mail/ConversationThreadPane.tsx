///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Attachment, Folder, Message, listAttachments } from "@rapidmx/react-shared/mail/mailApi.js";
import { ConversationSummary, listConversationMessages } from "@rapidmx/react-shared/mail/conversationsApi.js";
import { Label } from "@rapidmx/react-shared/mail/labelsApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import MessageDetailPane from "./MessageDetailPane.js";
import { EncryptedPreview, displaySubject } from "./reading/EncryptedPreview.js";
import { CollapsedCard, SkeletonCards, SubjectCard } from "./reading/MessageCard.js";
import PendingMessageCard from "./reading/PendingMessageCard.js";
import { useMailShell } from "./layout/MailShell.js";
import { setReadState } from "../../mail/messageReadState.js";
import { adoptedOutgoing, belongsToThread, settleOutgoing, useOutgoingReplies } from "../../mail/outbox/outgoingReplies.js";
import { dateClass, isUnread, senderClass } from "./unreadStyle.js";

/** One request's worth of the thread. The server's own default for `listConversationMessages()`. */
export const THREAD_PAGE_SIZE = 100;
/**
 * How many of a conversation's messages this pane will load. The server reads at most
 * `CONVERSATION_SCAN_LIMIT` (500) messages when it groups conversations, so a `ConversationSummary` never
 * describes more than this many anyway; the cap is here so a thread that somehow reports more can't turn
 * into an unbounded run of requests. Past it the pane says so and the rest stay readable from the list.
 */
export const THREAD_MESSAGE_LIMIT = 500;

/** What the pane needs to know of a conversation up front: the thread itself is loaded by `conversationId`. The subject and
 * count fill the header while it loads, so a caller that only has a message (the mobile route) gives its subject and a count of 1. */
export type ConversationThreadHead = Pick<ConversationSummary, "conversationId" | "subject" | "messageCount">;

export interface ConversationThreadPaneProps {
    conversation: ConversationThreadHead | null;
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
 * `next` - the thread as it was just read again - for the pane to show in place of `previous`. A message the pane holds a newer copy of (one that
 * was read, flagged or labelled here a moment ago, whose change the read may have started before) keeps that copy, and a read that changed
 * nothing gives back `previous` itself, so the pane is not drawn again.
 */
function mergeThread(previous: Message[], next: Message[]): Message[] {
    const held = new Map(previous.map((message) => [message.uid, message]));
    const merged = next.map((message) => {
        const own = held.get(message.uid);
        return own && own.version > message.version ? own : message;
    });
    const unchanged = merged.length === previous.length && merged.every((message, index) => message.uid === previous[index].uid && message.version === previous[index].version);
    return unchanged ? previous : merged;
}

/** Whether the browser is showing a focus ring on `element` - it was focused from the keyboard (or by a key press's handler), not by a click. */
function hasFocusRing(element: HTMLElement): boolean {
    try {
        return element.matches(":focus-visible");
    } catch {
        return false;
    }
}

/**
 * The reading pane for the conversation list: the conversation's subject in a card of its own, pinned at the top, and under it the whole thread as
 * a stack of message cards (each exactly as tall as its message; the list scrolls as a whole), **newest at the top**, opened at the message
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
    const { trackMessageChange, live } = useMailShell();
    // The replies and forwards this tab has sent, drawn at the top of the thread they continue until the server's own copy is in it.
    const outgoing = useOutgoingReplies();
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
    const headerRefs = useRef<Record<string, HTMLElement | null>>({});
    /** Where the toggled message's header sat in the viewport before it expanded, so the run below can put
     * it back there - expanding a message above the one being read must not shove that one off-screen. */
    const anchorRef = useRef<{ uid: string; top: number } | null>(null);
    /** The message whose header button had the focus when it was toggled: expanding or collapsing swaps that button for the other state's, so the
     * focus is put back on the new one. */
    const refocusRef = useRef<string | null>(null);
    /** The pending cards that have already been scrolled to, so that only a message that has just been sent takes the view and the focus. */
    const announcedRef = useRef<Set<string>>(new Set());
    /** Messages that left the thread here (archived, moved, a scheduled send taken back): a read of the thread again still lists them, since a conversation spans folders. */
    const removedRef = useRef<Set<string>>(new Set());
    /** The last live update this pane has answered - one already in the shell's hands when the pane opened is not news. */
    const seenLiveRef = useRef(live);

    const conversationId = conversation?.conversationId;

    useEffect(() => {
        const generation = ++generationRef.current;
        markReadRequestedRef.current = new Set();
        attachmentsRequestedRef.current = new Set();
        announcedRef.current = new Set();
        removedRef.current = new Set();
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
                // A message sent from here whose Sent Items copy is already in the thread is drawn as that copy, not as a pending card.
                settleOutgoing(mailboxUid, loaded.messages);
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
        // A key press (j, k, the arrows) that opened this thread left the focus on its list row on purpose, so Enter goes on to open the
        // message's page; taking the focus here would make Enter toggle this header instead. A click leaves no focus ring, and hands
        // the focus to the thread as before.
        const active = document.activeElement;
        if (!(active instanceof HTMLElement && active.hasAttribute("data-row-open") && hasFocusRing(active))) {
            // `preventScroll` so focusing doesn't scroll it somewhere else again.
            // (A card's header button is drawn by the message pane, which registers it; a stand-in pane that doesn't has none to focus.)
            headerRefs.current[pendingFocusUid]?.focus({ preventScroll: true });
        }
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
        // The button the reader had focused is gone (a collapsed card and an expanded one each draw their own): keep them where they were.
        if (refocusRef.current === anchor.uid) {
            headerRefs.current[anchor.uid]?.focus({ preventScroll: true });
        }
        refocusRef.current = null;
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

    /**
     * Reads the thread again, quietly: what is on screen stays until the answer is here (a read that fails changes nothing), a message that arrived
     * is added at the top, and the reader's expanded and collapsed cards are left as they are. A message this tab sent - which the server has
     * now filed in Sent Items under the same `uid` - takes the place of its pending card, expanded as that card was, with the focus if the
     * card had it. A thread that has not finished its first load is not read again: that load is the fresh read.
     */
    function refreshThread() {
        const id = loadedIdRef.current;
        if (!id) {
            return;
        }
        const generation = generationRef.current;
        loadThread(mailboxUid, id).then(
            (loaded) => {
                if (generation !== generationRef.current) return;
                const current = loaded.messages.filter((message) => !removedRef.current.has(message.uid));
                const adopted = adoptedOutgoing(mailboxUid, current);
                const refocus = adopted.find((uid) => document.activeElement === headerRefs.current[uid]);
                // Drawn first, and only then is the pending card forgotten: there is never a frame with neither it nor the real message.
                flushSync(() => {
                    setMessages((previous) => mergeThread(previous, current));
                    setTruncated(loaded.truncated);
                    if (adopted.length > 0) {
                        setExpandedUids((previous) => new Set([...previous, ...adopted]));
                    }
                    if (refocus) {
                        setPendingFocusUid(refocus);
                    }
                });
                settleOutgoing(mailboxUid, current);
            },
            // Quietly: the next live update reads it again, and what is shown is still right.
            () => undefined,
        );
    }

    // Another message of this conversation may have arrived - a recipient's reply, one sent from another tab or device, or this tab's own reply
    // filed in Sent Items - whenever the shell announces a live update that touched one of this mailbox's folders (or does not say which).
    useEffect(() => {
        if (live === seenLiveRef.current) return;
        seenLiveRef.current = live;
        if (live.folderUids === null || folders.some((folder) => live.folderUids!.has(folder.uid))) {
            refreshThread();
        }
    }, [live]);

    // The server has relayed a message this tab sent: its Sent Items copy is read for at once, without waiting for the live update that follows.
    const sentKey = outgoing
        .filter((reply) => reply.state === "sent" && reply.mailboxUid === mailboxUid)
        .map((reply) => reply.uid)
        .join(",");
    useEffect(() => {
        if (sentKey) {
            refreshThread();
        }
    }, [sentKey]);

    // The messages sent from here that continue this thread and whose real copy it does not hold yet, newest first (the pane's order). A message
    // that replies to nothing here - a new message, or a reply to another conversation - is not in this list, and never is.
    const pendingCards = outgoing
        .filter((reply) => reply.mailboxUid === mailboxUid && !messages.some((message) => message.uid === reply.uid) && belongsToThread(reply, messages))
        .reverse();
    // A message that has just been sent is scrolled into view and takes the focus - the compose window it was sent from has just closed, and the focus
    // with it - once. A failed one, or one that was already there when the thread was opened, is left where it is.
    const pendingKey = pendingCards.map((reply) => reply.uid).join(",");
    useEffect(() => {
        const fresh = pendingCards.filter((reply) => reply.state === "sending" && !announcedRef.current.has(reply.uid));
        if (fresh.length === 0) return;
        for (const reply of fresh) {
            announcedRef.current.add(reply.uid);
        }
        setPendingFocusUid(fresh[0].uid);
    }, [pendingKey]);

    /** A newer copy of one of the thread's messages, kept here and handed to the list - with the copy it
     * replaces where the caller was given one, so a conversation row can tell what actually changed. */
    function patchMessage(updated: Message, previous?: Message) {
        setMessages((prev) => prev.map((message) => (message.uid === updated.uid ? updated : message)));
        onMessagePatched(updated, previous);
    }

    /** A message that left the folder being listed - it leaves the thread too, as it left the list. */
    function removeMessage(updated: Message) {
        removedRef.current.add(updated.uid);
        setMessages((prev) => prev.filter((message) => message.uid !== updated.uid));
        onMessageRemoved(updated);
    }

    function toggleExpanded(uid: string) {
        // Opening a message again asks to mark it read again - that is how one whose request failed is retried.
        markReadRequestedRef.current.delete(uid);
        // The row this button lives in has rendered, so its ref is set.
        anchorRef.current = { uid, top: rowRefs.current[uid]!.getBoundingClientRect().top };
        refocusRef.current = document.activeElement === headerRefs.current[uid] ? uid : null;
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
    const subject = displaySubject(conversation.subject) || "(no subject)";
    // The newest message that is open carries the Reply / Forward buttons at the foot of its card.
    const footerUid = messages.find((message) => expandedUids.has(message.uid))?.uid;

    return (
        // The pane is the window's height, not the thread's: a full-height flex column whose header card is fixed and whose list of
        // message cards is the one scrolling, growing child (`min-h-0`, or the list would stretch the column past the pane instead of
        // scrolling inside it). Each card is exactly as tall as its message.
        // The subject card is the same element while the messages load and once they are here (the subject and the count are known from the
        // list's row), so nothing shifts or is drawn again when they arrive: a skeleton card per message (up to three) stands where they will be.
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <SubjectCard
                subject={subject}
                meta={
                    loading
                        ? conversation.messageCount > 1
                            ? `${conversation.messageCount} messages`
                            : undefined
                        : error
                          ? undefined
                          : `${messages.length + pendingCards.length} message${messages.length + pendingCards.length === 1 ? "" : "s"}`
                }
            >
                {truncated && !loading && !error && (
                    <p className="text-xs text-text-muted mt-1">
                        Only the oldest {THREAD_MESSAGE_LIMIT} messages of this conversation are shown here. The rest
                        are still in the message list.
                    </p>
                )}
            </SubjectCard>
            {loading ? (
                <SkeletonCards messageCount={conversation.messageCount} />
            ) : error ? (
                <div className="p-2 sm:p-3">
                    <Alert>{error}</Alert>
                </div>
            ) : (
            <ul className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-3 flex flex-col gap-3">
                {pendingCards.map((reply) => (
                    <li
                        key={reply.uid}
                        ref={(node) => {
                            rowRefs.current[reply.uid] = node;
                        }}
                        data-outgoing="true"
                    >
                        <PendingMessageCard
                            reply={reply}
                            headerRef={(node) => {
                                headerRefs.current[reply.uid] = node;
                            }}
                        />
                    </li>
                ))}
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
                            data-unread={messageUnread ? "true" : undefined}
                        >
                            {expanded ? (
                                <MessageDetailPane
                                    inThread
                                    threadSubject={subject}
                                    threadHeader={{
                                        bodyId,
                                        unread: messageUnread,
                                        onToggle: () => toggleExpanded(uid),
                                        buttonRef: (node) => {
                                            headerRefs.current[uid] = node;
                                        },
                                    }}
                                    footer={uid === footerUid}
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
                                    onChanged={patchMessage}
                                    labels={labels}
                                    onLabelsChanged={patchMessage}
                                    onLabelCreated={onLabelCreated}
                                />
                            ) : (
                                <>
                                    <CollapsedCard
                                        from={message.from}
                                        date={new Date(message.receivedDate).toLocaleString()}
                                        preview={message.bodyPreview || (message.encrypted ? <EncryptedPreview /> : "")}
                                        unread={messageUnread}
                                        senderClassName={senderClass(messageUnread)}
                                        dateClassName={dateClass(messageUnread)}
                                        buttonRef={(node) => {
                                            headerRefs.current[uid] = node;
                                        }}
                                        buttonProps={{
                                            onClick: () => toggleExpanded(uid),
                                            "aria-expanded": false,
                                            "aria-controls": bodyId,
                                        }}
                                    />
                                    <div id={bodyId} hidden />
                                </>
                            )}
                        </li>
                    );
                })}
            </ul>
            )}
        </div>
    );
}
