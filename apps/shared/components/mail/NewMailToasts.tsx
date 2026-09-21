///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState } from "react";
import { HiOutlineXMark } from "react-icons/hi2";
import type { NewMailNotice } from "../../mail/newMailNotifications.js";
import { TOAST_DURATION_MS } from "../../mail/useNewMailNotifications.js";

export interface NewMailToastsProps {
    /** The pop-ups to show, oldest first. */
    toasts: NewMailNotice[];
    onDismiss: (uid: string) => void;
    /** Show the "Turn on desktop notifications" offer in the first pop-up. */
    offerDesktop: boolean;
    onEnableDesktop: () => void;
    onDeclineDesktop: () => void;
}

/** Whether the tab is out of view - a pop-up's clock stops meanwhile, so it is still there when the reader comes back. */
function useTabHidden(): boolean {
    const [hidden, setHidden] = useState(false);
    useEffect(() => {
        const update = () => setHidden(document.visibilityState === "hidden");
        update();
        document.addEventListener("visibilitychange", update);
        return () => document.removeEventListener("visibilitychange", update);
    }, []);
    return hidden;
}

interface ToastItemProps {
    toast: NewMailNotice;
    tabHidden: boolean;
    onDismiss: (uid: string) => void;
    offer?: { onEnable: () => void; onDecline: () => void };
}

/** One pop-up. Its 8 seconds only run while it is neither hovered nor holding keyboard focus, and the tab is in view. */
function ToastItem({ toast, tabHidden, onDismiss, offer }: ToastItemProps) {
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const remainingRef = useRef(TOAST_DURATION_MS);
    const paused = tabHidden || hovered || focused;

    useEffect(() => {
        if (paused) {
            return;
        }
        const startedAt = Date.now();
        const timer = setTimeout(() => onDismiss(toast.uid), remainingRef.current);
        return () => {
            clearTimeout(timer);
            remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
        };
    }, [paused, toast.uid, onDismiss]);

    const sender = toast.senderName || toast.senderAddress;
    return (
        <div
            data-testid="new-mail-toast"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={(event) => {
                // Focus moving between this pop-up's own controls is not leaving it.
                if (!event.currentTarget.contains(event.relatedTarget)) {
                    setFocused(false);
                }
            }}
            className="rr-toast-in pointer-events-auto relative rounded-md border border-border border-l-4 border-l-primary bg-surface text-text shadow-modal"
        >
            <a
                href={toast.href}
                onClick={() => onDismiss(toast.uid)}
                className="block rounded-md p-3 pr-10 hover:bg-surface-alt focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
            >
                <span className="block text-xs font-semibold uppercase tracking-wide text-primary-dark">New message</span>
                <span className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-sm">
                    <span className="truncate font-bold">{sender}</span>
                    {toast.senderName && <span className="truncate text-xs text-text-muted">&lt;{toast.senderAddress}&gt;</span>}
                </span>
                <span className="block truncate text-sm font-semibold">{toast.subject}</span>
                {toast.preview && <span className="mt-0.5 block text-xs text-text-muted [overflow-wrap:anywhere]">{toast.preview}</span>}
            </a>
            <button
                type="button"
                onClick={() => onDismiss(toast.uid)}
                aria-label={`Dismiss notification: ${toast.subject}`}
                className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text focus-visible:outline-2 focus-visible:outline-primary"
            >
                <HiOutlineXMark size={16} aria-hidden="true" />
            </button>
            {offer && (
                <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs text-text-muted">
                    <span className="basis-full">Get a desktop notification when mail arrives while this tab is in the background.</span>
                    <button
                        type="button"
                        onClick={offer.onEnable}
                        className="rounded-sm bg-primary px-2.5 py-1 text-xs font-semibold text-text-on-primary hover:bg-primary-dark"
                    >
                        Turn on desktop notifications
                    </button>
                    <button type="button" onClick={offer.onDecline} className="rounded-sm px-2 py-1 text-xs font-medium hover:bg-surface-alt hover:text-text">
                        Not now
                    </button>
                </div>
            )}
        </div>
    );
}

/**
 * The new-mail pop-ups, stacked at the top right (`fixed`, above everything). The container is always rendered - a live region
 * has to exist before its content changes to be announced - and is a polite `status` region, so an arrival is read out without
 * interrupting. Each pop-up shows the sender's name and address, the subject and a short preview, as text; clicking it opens the
 * message; it has a dismiss button and goes by itself after a few seconds (see `ToastItem`). Motion is CSS-only and switched off
 * by `prefers-reduced-motion` (`.rr-toast-in` in `app.css`).
 */
export default function NewMailToasts({ toasts, onDismiss, offerDesktop, onEnableDesktop, onDeclineDesktop }: NewMailToastsProps) {
    const tabHidden = useTabHidden();
    return (
        <div
            role="status"
            aria-live="polite"
            aria-label="New mail"
            data-testid="new-mail-toasts"
            className="pointer-events-none fixed right-4 top-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2"
        >
            {toasts.map((toast, index) => (
                <ToastItem
                    key={toast.uid}
                    toast={toast}
                    tabHidden={tabHidden}
                    onDismiss={onDismiss}
                    offer={offerDesktop && index === 0 ? { onEnable: onEnableDesktop, onDecline: onDeclineDesktop } : undefined}
                />
            ))}
        </div>
    );
}
