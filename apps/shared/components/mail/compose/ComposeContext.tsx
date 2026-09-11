///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { PropsWithChildren, createContext, useContext, useMemo, useState } from "react";
import useIsMobile from "@rapidmx/react-shared/useIsMobile.js";
import ComposeWindow from "./ComposeWindow.js";

export interface ComposeSession {
    id: string;
    mailboxUid: string;
    initialTo?: string;
    initialCc?: string;
    initialSubject?: string;
    /** Pre-built HTML (already includes its own quote-attribution wrapper — see `composeQuoting.ts`)
     * inserted below the resolved default signature. Absent for a fresh, non-reply/forward compose. */
    initialQuotedHtml?: string;
    /** Which of a signature's two "default" flags to resolve against — `"new"` (the default) uses
     * `isDefaultForNewMessages`, `"reply_forward"` uses `isDefaultForReplyForward`. */
    signatureContext: "new" | "reply_forward";
    minimized: boolean;
}

export interface OpenComposeInput {
    mailboxUid: string;
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
export default function ComposeProvider({ children }: PropsWithChildren) {
    const [sessions, setSessions] = useState<ComposeSession[]>([]);
    const isMobile = useIsMobile();

    function openCompose({ mailboxUid, to, cc, subject, quotedHtml, signatureContext = "new" }: OpenComposeInput) {
        setSessions((prev) => [
            ...prev,
            {
                id: crypto.randomUUID(),
                mailboxUid,
                initialTo: to,
                initialCc: cc,
                initialSubject: subject,
                initialQuotedHtml: quotedHtml,
                signatureContext,
                minimized: false,
            },
        ]);
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
    // at most one non-minimized session is ever rendered: the most recently opened one. Minimized
    // sessions are small chips regardless of device, so every one of those still renders — an earlier
    // session becomes visible again (as its own chip, or full-screen if it's the new most-recent
    // non-minimized one) once whatever's currently "on top" is closed or minimized.
    const lastNonMinimizedId = isMobile ? [...sessions].reverse().find((s) => !s.minimized)?.id : undefined;
    const visibleSessions = isMobile ? sessions.filter((s) => s.minimized || s.id === lastNonMinimizedId) : sessions;

    return (
        <ComposeContext.Provider value={value}>
            {children}
            {visibleSessions.length > 0 && (
                <div className="fixed bottom-0 right-6 flex items-end gap-3 z-50">
                    {visibleSessions.map((session) => (
                        <ComposeWindow
                            key={session.id}
                            session={session}
                            onClose={() => closeCompose(session.id)}
                            onToggleMinimize={() => toggleMinimize(session.id)}
                        />
                    ))}
                </div>
            )}
        </ComposeContext.Provider>
    );
}
