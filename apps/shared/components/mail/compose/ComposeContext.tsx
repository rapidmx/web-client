///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DraftThreading } from "../../../../../lib/mail/mailApi.js";
import { ApiClient } from "../../../../../lib/util/api.js";
import { useApiClient } from "../../../../../lib/util/apiClientContext.js";
import useIsMobile from "../../../../../lib/util/useIsMobile.js";
import { ResumeCompose, registerComposeOpener } from "../../../mail/outbox/composeBridge.js";
import { markComposePhase } from "./composePerf.js";
import ComposeWindowPlaceholder from "./ComposeWindowPlaceholder.js";

/** The CSS variable (on `<html>`) that holds how far down the screen the open compose windows start, in px. */
export const COMPOSE_TOP_VAR = "--rr-compose-top";

type ComposeWindowComponent = typeof import("./ComposeWindow.js").default;

let loadedComposeWindow: ComposeWindowComponent | undefined;
let loadingComposeWindow: Promise<ComposeWindowComponent> | undefined;

/**
 * The compose window - with the rich-text editor (TipTap/ProseMirror), the recipient inputs and the send pipeline - is
 * the largest piece of the mail app and most page loads never open it, so it is a separate chunk, loaded here once. Not
 * `React.lazy()`: a chunk that failed to download (offline, a deploy that replaced it) must be retryable, and `lazy()` keeps
 * the rejection for good.
 */
function loadComposeWindow(): Promise<ComposeWindowComponent> {
    loadingComposeWindow ??= import("./ComposeWindow.js").then(
        (module) => (loadedComposeWindow = module.default),
        (err) => {
            loadingComposeWindow = undefined;
            throw err;
        },
    );
    return loadingComposeWindow;
}

/**
 * Starts downloading the compose window's code without opening one - on hover/focus of a Compose or Reply button and when
 * the browser is idle after the inbox has loaded - so that clicking it finds the chunk already in memory. Safe to call
 * any number of times, and never rejects: a failed download is retried by the click itself.
 */
export function prefetchComposeWindow(): void {
    loadComposeWindow().catch(() => undefined);
}

/** Test seam: forgets the loaded compose window chunk, as a fresh page load would. */
export function resetComposeWindowLoader(): void {
    loadedComposeWindow = undefined;
    loadingComposeWindow = undefined;
}

/** The compose window component once its chunk is in, else `undefined` (while loading, or `failed`), and a way to retry. */
function useComposeWindowComponent(wanted: boolean): { Component: ComposeWindowComponent | undefined; failed: boolean; retry: () => void } {
    const [loaded, setComponent] = useState<ComposeWindowComponent | undefined>();
    // Also read straight from the module: a prefetch that finished after this provider mounted has no state update to
    // announce it, and the first click must not flash the placeholder for a chunk that is already here.
    const Component = loaded ?? loadedComposeWindow;
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!wanted || Component) {
            return;
        }
        let cancelled = false;
        setFailed(false);
        loadComposeWindow().then(
            (component) => {
                if (!cancelled) {
                    setComponent(() => component);
                }
            },
            () => {
                if (!cancelled) {
                    setFailed(true);
                }
            },
        );
        return () => {
            cancelled = true;
        };
    }, [wanted, Component, attempt]);
    return { Component, failed, retry: () => setAttempt((n) => n + 1) };
}

export interface ComposeSession {
    id: string;
    /** The initial sending mailbox - absent means "the caller's own mailbox" (see `ComposeWindow`). */
    mailboxUid?: string;
    initialTo?: string;
    initialCc?: string;
    initialSubject?: string;
    /** Pre-built HTML (already includes its own quote-attribution wrapper — see `composeQuoting.ts`)
     * inserted below the resolved default signature. Absent for a fresh, non-reply/forward compose. Its presence
     * is what makes the window open with the caret at the top of the body instead of in To. */
    initialQuotedHtml?: string;
    /** See `OpenComposeInput.encrypt`'s own doc comment. */
    initialEncrypt?: boolean;
    /** See `OpenComposeInput.threading`'s own doc comment - handed to `createDraft()` by the window. */
    threading?: DraftThreading;
    /** Which of a signature's two "default" flags to resolve against — `"new"` (the default) uses
     * `isDefaultForNewMessages`, `"reply_forward"` uses `isDefaultForReplyForward`. */
    signatureContext: "new" | "reply_forward";
    /** See `OpenComposeInput.suppressSigning`'s own doc comment. */
    suppressSigning?: boolean;
    /** The window opened before its quoted original was known (see `OpenComposeInput.pending`): the body waits for it. */
    quotePending?: boolean;
    /** What `OpenComposeInput.pending` resolved with, once it has - see `ComposeLateInput`. */
    late?: ComposeLateInput;
    /** See `OpenComposeInput.resume`. */
    resume?: ResumeCompose;
    /** See `OpenComposeInput.inlineFor`. Absent once the window was opened without a host for it. */
    inlineFor?: string;
    minimized: boolean;
}

/** What a reply or forward could only work out after its window was already open (see `OpenComposeInput.pending`). */
export interface ComposeLateInput {
    /** The quoted original - see `OpenComposeInput.quotedHtml`. */
    quotedHtml?: string;
    /** A better To than the one the window opened with - applied only if the To field is still exactly what it opened with. */
    to?: string;
    /** A better Cc, under the same rule as `to`. */
    cc?: string;
}

export interface OpenComposeInput {
    /** The sending mailbox to start with. Omit for a fresh message (defaults to the caller's own mailbox);
     * a reply/forward passes the original message's mailbox so a shared mailbox's mail replies from it.
     * Either way the user can change it via the compose window's From field. */
    mailboxUid?: string;
    /** Prefills the To field — e.g. Contacts' "Email" toolbar action, or Reply/Reply All/Forward. */
    to?: string;
    /** Prefills the Cc field and reveals the Cc/Bcc row — Reply All only. */
    cc?: string;
    /** Prefills the Subject field — Reply/Reply All/Forward. */
    subject?: string;
    /** See `ComposeSession.initialQuotedHtml`'s own doc comment. */
    quotedHtml?: string;
    /** See `ComposeSession.signatureContext`'s own doc comment. Defaults to `"new"` — every existing
     * caller (Contacts' "Email" action, the folder-sidebar "Compose" button) is a fresh compose. */
    signatureContext?: "new" | "reply_forward";
    /** `true` when the caller (`MessageDetailPane.tsx`'s Reply/Reply All) has already determined, via
     * `composeSecurity.ts`'s `isLikelyMailingList()`, that the message being replied to came from a
     * mailing list — a list that appends a footer after signing invalidates the signature (spec's own
     * "Mailing lists" note), so the new compose window defaults its Sign toggle off rather than on.
     * The user can still turn it back on manually; this only changes the *default*. */
    suppressSigning?: boolean;
    /** `true` for a reply to or forward of an encrypted message, whose quote may carry its decrypted content: the
     * compose window starts with "Encrypt this message" requested, so it is never autosaved as a plaintext draft and
     * can't be sent unencrypted without the user explicitly choosing to. */
    encrypt?: boolean;
    /** The thread this compose continues (`buildReplyThreading()` over the message being replied to or
     * forwarded), recorded on the draft by `createDraft()`. Without it the message is relayed with no
     * `In-Reply-To`/`References` at all and every mail system - the sender's own Sent Items included - files it
     * as a new conversation rather than part of the thread. Absent for a fresh compose, which starts one. */
    threading?: DraftThreading;
    /**
     * Something the window shouldn't wait for before appearing: a reply or forward opens at once from what is already in
     * memory (the message's own subject and sender), and this settles with what needed the network - the original's body
     * to quote, and for Reply All the recipients its headers name. The compose window shows meanwhile, its body area
     * waiting, and fills the body in when this resolves; `to`/`cc` replace the opened-with values only if the user hasn't
     * touched those fields. Must never reject (resolve `undefined` for "nothing more"); when set, `quotedHtml` is ignored
     * until it resolves.
     */
    pending?: Promise<ComposeLateInput | undefined>;
    /** Re-opens a message that was already composed - a failed send's "Open draft": the window continues that server draft, with every field
     * exactly as it was typed, instead of starting a new one. */
    resume?: ResumeCompose;
    /**
     * The uid of the message this reply or forward answers. When the reading pane is showing a thread that holds that message (see
     * `useInlineCompose()`), the compose window opens as a card above the thread instead of floating at the bottom right; the
     * user can still pop it out to the floating stack, and it goes there by itself when the thread is left. Ignored - the window
     * floats - when no pane is showing that message. Absent for a new message, which always floats.
     */
    inlineFor?: string;
}

export interface ComposeContextValue {
    /** Opens a new compose window, stacked alongside any already open (Gmail allows several at once). */
    openCompose: (input: OpenComposeInput) => void;
    /**
     * The active account's `ApiClient` (see `useApiClient()`'s own doc comment), resolved once here rather
     * than by every compose component individually - `ComposeWindow` and everything it renders reach it
     * through this context's own value instead of each calling `useApiClient()` for itself. `useApiClient()`
     * remains independently callable (this is additive, not a replacement) - a future consumer that isn't a
     * descendant of `ComposeProvider` (or doesn't want to depend on it) can still read it directly.
     */
    client?: ApiClient;
}

const ComposeContext = createContext<ComposeContextValue>({ openCompose: () => undefined });

/** The part of a session a reading pane needs to draw its slot. */
export interface InlineComposeSession {
    id: string;
    /** The uid of the message the window answers. */
    inlineFor: string;
    /** The uid of the draft the window continues, when it was opened to edit one: the draft is then the card, not a message beside it. */
    draftUid?: string;
}

interface InlineComposeValue {
    /** The sessions currently drawn inline, in the order they were opened. */
    sessions: InlineComposeSession[];
    /** Announces the messages a reading pane holds; the returned function withdraws it. */
    register: (uids: string[]) => () => void;
    /** The element a session's window is rendered into, for a slot to hold. */
    containerFor: (id: string) => HTMLElement | undefined;
}

const InlineComposeContext = createContext<InlineComposeValue>({ sessions: [], register: () => () => undefined, containerFor: () => undefined });

/**
 * For a reading pane: announces that it is showing the messages `uids`, so a Reply or Forward of one of them opens its compose
 * window as a card in that pane (drawn with `InlineComposeSlot`) rather than a floating window, and returns the sessions to
 * draw a slot for. When the pane stops holding a message - it unmounts, or moves to another conversation - the window answering
 * it moves out to the floating stack, with everything typed into it.
 */
export function useInlineCompose(uids: string[]): InlineComposeSession[] {
    const { sessions, register } = useContext(InlineComposeContext);
    const key = uids.join(",");
    useEffect(() => register(uids), [key, register]);
    return useMemo(() => sessions.filter((session) => uids.includes(session.inlineFor)), [sessions, key]);
}

/**
 * The list item a reading pane holds an inline compose window in. The window itself is owned (and kept alive) by
 * `ComposeProvider`; this only moves the element it renders into into place. `onPlaced` is called once, as it arrives, for the pane
 * to bring it into view.
 */
export function InlineComposeSlot({ id, onPlaced }: { id: string; onPlaced?: (slot: HTMLLIElement) => void }) {
    const { containerFor } = useContext(InlineComposeContext);
    const slotRef = useRef<HTMLLIElement>(null);
    useLayoutEffect(() => {
        const slot = slotRef.current!;
        // Nothing to hold outside a `ComposeProvider`.
        const container = containerFor(id);
        if (container) {
            slot.appendChild(container);
        }
        onPlaced?.(slot);
    }, [id]);
    return <li ref={slotRef} data-inline-compose={id} />;
}

/** Opens the floating Compose window from anywhere inside `AppShell` (any of the four webmail apps). */
export function useCompose(): ComposeContextValue {
    return useContext(ComposeContext);
}

/**
 * Owns every currently-open Compose window and renders them stacked bottom-right, Gmail-style — see
 * `ComposeWindow`'s own doc comment for why this replaced the old dedicated `/compose` page. Mounted
 * once in `AppShell`, so every webmail app (Mail/Calendar/Contacts/Tasks) shares the same instance:
 * opening Compose from Contacts' "Email" action, for instance, overlays the window on top of whatever
 * app is currently showing, exactly like opening it from Mail's own sidebar button.
 */
export default function ComposeProvider({ children, userUid, trusted }: PropsWithChildren<{ userUid?: string; trusted?: boolean }>) {
    const [sessions, setSessions] = useState<ComposeSession[]>([]);
    // The sessions as of the last render, for `openCompose()` to read at the click.
    const sessionsRef = useRef(sessions);
    sessionsRef.current = sessions;
    const client = useApiClient();
    const isMobile = useIsMobile();
    const { Component: ComposeWindow, failed, retry: retryLoad } = useComposeWindowComponent(sessions.length > 0);

    // Every session's window is rendered (through a portal) into an element of its own that is *moved* between the floating stack
    // and a reading pane's slot, never re-created: a window that changed parents in the React tree would remount and lose what was typed.
    const containersRef = useRef(new Map<string, HTMLElement>());
    // The messages the reading panes currently showing a thread hold, one entry per pane (a ref too, for `openCompose()` to read at the click).
    const hostsRef = useRef(new Map<symbol, string[]>());
    const [hostedUids, setHostedUids] = useState<string[]>([]);
    // The inline sessions that were popped out or whose pane went away: floating for good, even if a pane shows their message again.
    const [parked, setParked] = useState<Set<string>>(new Set());
    const register = useCallback((uids: string[]) => {
        const token = Symbol();
        hostsRef.current.set(token, uids);
        setHostedUids([...hostsRef.current.values()].flat());
        return () => {
            hostsRef.current.delete(token);
            setHostedUids([...hostsRef.current.values()].flat());
        };
    }, []);
    const hosted = new Set(hostedUids);
    const isInline = (session: ComposeSession) => !!session.inlineFor && !parked.has(session.id) && hosted.has(session.inlineFor);
    const inlineKey = sessions.filter(isInline).map((session) => `${session.id}:${session.inlineFor}`).join("|");
    const inlineSessions = useMemo<InlineComposeSession[]>(
        () => sessions.filter(isInline).map((session) => ({ id: session.id, inlineFor: session.inlineFor!, draftUid: session.resume?.draft.uid })),
        [inlineKey],
    );
    const inlineValue = useMemo<InlineComposeValue>(
        () => ({ sessions: inlineSessions, register, containerFor: (id) => containersRef.current.get(id) }),
        [inlineSessions, register],
    );
    const floatingSessions = sessions.filter((session) => !inlineSessions.some((inline) => inline.id === session.id));

    // A session whose message is no longer in any pane (the reader went to another conversation) is parked in the stack.
    useEffect(() => {
        const orphans = sessions.filter((session) => session.inlineFor && !parked.has(session.id) && !hosted.has(session.inlineFor));
        if (orphans.length > 0) {
            setParked((prev) => new Set([...prev, ...orphans.map((session) => session.id)]));
        }
    }, [sessions, hostedUids, parked]);

    // The elements of closed sessions go away with them.
    useEffect(() => {
        const open = new Set(sessions.map((session) => session.id));
        for (const [id, element] of containersRef.current) {
            if (!open.has(id)) {
                element.remove();
                containersRef.current.delete(id);
            }
        }
    }, [sessions]);
    useEffect(
        () => () => {
            for (const element of containersRef.current.values()) {
                element.remove();
            }
            containersRef.current.clear();
        },
        [],
    );

    // The top edge of the floating compose windows, published as `--rr-compose-top` so the pop-up stack (`NotificationCenter`) can keep clear of them.
    const windowsRef = useRef<HTMLDivElement>(null);
    const hasSessions = floatingSessions.length > 0;
    useEffect(() => {
        const element = windowsRef.current;
        if (!element) {
            return;
        }
        const publish = () => document.documentElement.style.setProperty(COMPOSE_TOP_VAR, `${Math.round(element.getBoundingClientRect().top)}px`);
        publish();
        const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(publish);
        observer?.observe(element);
        window.addEventListener("resize", publish);
        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", publish);
            document.documentElement.style.removeProperty(COMPOSE_TOP_VAR);
        };
    }, [hasSessions]);

    function openCompose({
        mailboxUid,
        to,
        cc,
        subject,
        quotedHtml,
        signatureContext = "new",
        suppressSigning,
        encrypt,
        threading,
        pending,
        resume,
        inlineFor,
    }: OpenComposeInput) {
        // A draft already being edited has its window: it is brought back to the pane that was holding it rather than opened a second time.
        const editing = resume && sessionsRef.current.find((session) => session.resume?.draft.uid === resume.draft.uid);
        if (editing) {
            setParked((prev) => {
                if (!prev.has(editing.id)) {
                    return prev;
                }
                const next = new Set(prev);
                next.delete(editing.id);
                return next;
            });
            return;
        }
        const id = crypto.randomUUID();
        markComposePhase(id, "click");
        // The window's own element, attached to the page from the start (it is moved to its slot or the stack as soon as that is drawn).
        const container = document.createElement("div");
        container.className = "contents";
        document.body.appendChild(container);
        containersRef.current.set(id, container);
        setSessions((prev) => [
            ...prev,
            {
                id,
                mailboxUid,
                initialTo: to,
                initialCc: cc,
                initialSubject: subject,
                initialQuotedHtml: quotedHtml,
                initialEncrypt: encrypt,
                threading,
                signatureContext,
                suppressSigning,
                quotePending: !!pending,
                resume,
                // Only a pane that is showing the message can hold the window.
                inlineFor: inlineFor && [...hostsRef.current.values()].some((uids) => uids.includes(inlineFor)) ? inlineFor : undefined,
                minimized: false,
            },
        ]);
        // A window closed before this settles is simply not in the list any more - nothing to update.
        void pending
            ?.catch(() => undefined)
            .then((late) =>
                setSessions((prev) =>
                    prev.map((s) =>
                        s.id === id ? { ...s, quotePending: false, late, initialQuotedHtml: late?.quotedHtml ?? s.initialQuotedHtml } : s,
                    ),
                ),
            );
    }

    function closeCompose(id: string) {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        setParked((prev) => {
            if (!prev.has(id)) {
                return prev;
            }
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    }

    function popOut(id: string) {
        setParked((prev) => new Set(prev).add(id));
    }

    function toggleMinimize(id: string) {
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, minimized: !s.minimized } : s)));
    }

    const value = useMemo<ComposeContextValue>(() => ({ openCompose, client }), [client]);
    // Code with no React context - a failed send's "Open draft" pop-up - opens windows through this.
    useEffect(() => registerComposeOpener((input) => value.openCompose(input)), [value]);

    // On mobile, a non-minimized floating `ComposeWindow` renders full-screen (see that component's own doc
    // comment) — Gmail-style stacking of several full-screen overlays at once makes no sense there, so
    // at most one non-minimized session is ever shown: the most recently opened one. Minimized
    // sessions are small chips regardless of device, so every one of those still shows — an earlier
    // session becomes visible again (as its own chip, or full-screen if it's the new most-recent
    // non-minimized one) once whatever's currently "on top" is closed or minimized. The others stay
    // mounted, just hidden: unmounting them would throw away everything typed into them. An inline card
    // is part of the reading pane and is never hidden.
    const lastNonMinimizedId = isMobile ? [...floatingSessions].reverse().find((s) => !s.minimized)?.id : undefined;

    // Puts every floating session's element in the stack (an inline one is put in its slot by `InlineComposeSlot`), and hides those
    // the mobile rule above hides.
    useLayoutEffect(() => {
        for (const session of sessions) {
            const element = containersRef.current.get(session.id)!;
            const floating = floatingSessions.some((s) => s.id === session.id);
            const hidden = floating && isMobile && !session.minimized && session.id !== lastNonMinimizedId;
            element.hidden = hidden;
            element.className = hidden ? "hidden" : "contents";
            if (floating && element.parentElement !== windowsRef.current) {
                windowsRef.current!.appendChild(element);
            }
        }
    });

    return (
        <ComposeContext.Provider value={value}>
            <InlineComposeContext.Provider value={inlineValue}>
                {children}
                {sessions.map((session) => {
                    const inline = inlineSessions.some((s) => s.id === session.id);
                    return createPortal(
                        ComposeWindow ? (
                            <ComposeWindow
                                session={session}
                                userUid={userUid}
                                trusted={trusted}
                                inline={inline}
                                onPopOut={() => popOut(session.id)}
                                onClose={() => closeCompose(session.id)}
                                onToggleMinimize={() => toggleMinimize(session.id)}
                            />
                        ) : (
                            <ComposeWindowPlaceholder
                                session={session}
                                failed={failed}
                                inline={inline}
                                onPopOut={() => popOut(session.id)}
                                onRetry={retryLoad}
                                onClose={() => closeCompose(session.id)}
                                onToggleMinimize={() => toggleMinimize(session.id)}
                            />
                        ),
                        containersRef.current.get(session.id)!,
                        session.id,
                    );
                })}
                {hasSessions && <div ref={windowsRef} className="fixed bottom-0 right-6 flex items-end gap-3 z-50" />}
            </InlineComposeContext.Provider>
        </ComposeContext.Provider>
    );
}
