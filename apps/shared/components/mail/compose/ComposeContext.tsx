///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren, createContext, useContext, useEffect, useMemo, useState } from "react";
import { DraftThreading } from "@rapidmx/react-shared/mail/mailApi.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import { markComposePhase } from "./composePerf.js";
import ComposeWindowPlaceholder from "./ComposeWindowPlaceholder.js";

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
}

export interface ComposeContextValue {
    /** Opens a new compose window, stacked alongside any already open (Gmail allows several at once). */
    openCompose: (input: OpenComposeInput) => void;
}

const ComposeContext = createContext<ComposeContextValue>({ openCompose: () => undefined });

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
    const isMobile = useIsMobile();
    const { Component: ComposeWindow, failed, retry: retryLoad } = useComposeWindowComponent(sessions.length > 0);

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
    }: OpenComposeInput) {
        const id = crypto.randomUUID();
        markComposePhase(id, "click");
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
    }

    function toggleMinimize(id: string) {
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, minimized: !s.minimized } : s)));
    }

    const value = useMemo<ComposeContextValue>(() => ({ openCompose }), []);

    // On mobile, a non-minimized `ComposeWindow` renders full-screen (see that component's own doc
    // comment) — Gmail-style stacking of several full-screen overlays at once makes no sense there, so
    // at most one non-minimized session is ever shown: the most recently opened one. Minimized
    // sessions are small chips regardless of device, so every one of those still shows — an earlier
    // session becomes visible again (as its own chip, or full-screen if it's the new most-recent
    // non-minimized one) once whatever's currently "on top" is closed or minimized. The others stay
    // mounted, just hidden: unmounting them would throw away everything typed into them.
    const lastNonMinimizedId = isMobile ? [...sessions].reverse().find((s) => !s.minimized)?.id : undefined;

    return (
        <ComposeContext.Provider value={value}>
            {children}
            {sessions.length > 0 && (
                <div className="fixed bottom-0 right-6 flex items-end gap-3 z-50">
                    {sessions.map((session) => {
                        const hidden = isMobile && !session.minimized && session.id !== lastNonMinimizedId;
                        return (
                            <div key={session.id} hidden={hidden} className={hidden ? "hidden" : "contents"}>
                                {ComposeWindow ? (
                                    <ComposeWindow
                                        session={session}
                                        userUid={userUid}
                                        trusted={trusted}
                                        onClose={() => closeCompose(session.id)}
                                        onToggleMinimize={() => toggleMinimize(session.id)}
                                    />
                                ) : (
                                    <ComposeWindowPlaceholder
                                        session={session}
                                        failed={failed}
                                        onRetry={retryLoad}
                                        onClose={() => closeCompose(session.id)}
                                        onToggleMinimize={() => toggleMinimize(session.id)}
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </ComposeContext.Provider>
    );
}
