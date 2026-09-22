///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect } from "react";
import type { IconType } from "react-icons";
import {
    HiOutlineBell,
    HiOutlineCheckCircle,
    HiOutlineEnvelope,
    HiOutlineExclamationCircle,
    HiOutlineExclamationTriangle,
    HiOutlineInformationCircle,
    HiOutlineXMark,
} from "react-icons/hi2";
import CopyButton from "@rapidmx/react-shared/components/buttons/CopyButton.js";
import { NotificationAction, NotificationKind, NotificationView, dismiss, setAllPaused, setPaused } from "./store.js";
import { useNotifications } from "./useNotifications.js";
import { useSystemErrorNotifications } from "./systemErrors.js";

const KIND_STYLE: Record<NotificationKind, { border: string; icon: string; Icon: IconType; label: string }> = {
    mail: { border: "border-l-primary", icon: "text-primary-dark", Icon: HiOutlineEnvelope, label: "New message" },
    calendar: { border: "border-l-primary", icon: "text-primary-dark", Icon: HiOutlineBell, label: "Reminder" },
    info: { border: "border-l-primary", icon: "text-primary-dark", Icon: HiOutlineInformationCircle, label: "Information" },
    success: { border: "border-l-success", icon: "text-success", Icon: HiOutlineCheckCircle, label: "Success" },
    warning: { border: "border-l-warning", icon: "text-warning", Icon: HiOutlineExclamationTriangle, label: "Warning" },
    error: { border: "border-l-danger", icon: "text-danger", Icon: HiOutlineExclamationCircle, label: "Error" },
};

const ACTION_CLASS =
    "rounded-sm px-2.5 py-1 text-xs font-semibold text-primary-dark hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-primary";

/** Stops every clock while the tab is out of view: nobody could have read what is on screen, and it is still there when they come back. */
function usePauseWhileHidden(): void {
    useEffect(() => {
        const update = () => setAllPaused(document.visibilityState === "hidden");
        update();
        document.addEventListener("visibilitychange", update);
        return () => {
            document.removeEventListener("visibilitychange", update);
            setAllPaused(false);
        };
    }, []);
}

function ActionButton({ action, id }: { action: NotificationAction; id: string }) {
    function run() {
        action.onClick?.();
        if (!action.keepOpen) {
            dismiss(id);
        }
    }
    return action.href ? (
        <a href={action.href} onClick={run} className={ACTION_CLASS}>
            {action.label}
        </a>
    ) : (
        <button type="button" onClick={run} className={ACTION_CLASS}>
            {action.label}
        </button>
    );
}

/** The expandable, copyable technical lines behind a notification. */
function Details({ lines }: { lines: string[] }) {
    return (
        <details className="mt-1.5">
            <summary className="cursor-pointer text-xs font-semibold text-text-muted">Technical details</summary>
            <ul
                aria-label="Technical details"
                className="mt-1.5 max-h-40 overflow-auto rounded-sm border border-border bg-surface-alt p-2 font-mono text-xs text-text select-text"
            >
                {lines.map((line, index) => (
                    <li key={index} className="whitespace-pre-wrap break-words">
                        {line}
                    </li>
                ))}
            </ul>
            <div className="mt-1.5">
                <CopyButton value={lines.join("\n")} label="Copy technical details" />
            </div>
        </details>
    );
}

/** One pop-up. Its clock (kept by the store) stops while it is hovered or holds the keyboard focus; Escape dismisses it. */
function NotificationItem({ notification }: { notification: NotificationView }) {
    const { id, kind, title, subtitle, message, preview, hint, details, actions, href, count } = notification;
    const style = KIND_STYLE[kind];
    const body = (
        <>
            {kind === "mail" && <span className="block text-xs font-semibold uppercase tracking-wide text-primary-dark">{style.label}</span>}
            <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
                <span className={["truncate font-bold", kind === "error" ? "text-danger" : ""].join(" ")}>{title}</span>
                {count > 1 && (
                    <span className="shrink-0 rounded-pill bg-surface-alt px-1.5 text-xs font-semibold text-text-muted">
                        <span aria-hidden="true">&times;{count}</span>
                        <span className="sr-only"> ({count} times)</span>
                    </span>
                )}
                {subtitle && <span className="truncate text-xs text-text-muted">{subtitle}</span>}
            </span>
            {message && <span className={["mt-0.5 block text-sm [overflow-wrap:anywhere]", kind === "mail" ? "truncate font-semibold" : ""].join(" ")}>{message}</span>}
            {preview && <span className="mt-0.5 block text-xs text-text-muted [overflow-wrap:anywhere]">{preview}</span>}
        </>
    );
    return (
        <div
            data-testid="notification"
            role={kind === "error" ? "alert" : "status"}
            data-kind={kind}
            data-notification-id={id}
            onMouseEnter={() => setPaused(id, true)}
            onMouseLeave={() => setPaused(id, false)}
            onFocus={() => setPaused(id, true)}
            onBlur={(event) => {
                // Focus moving between this pop-up's own controls is not leaving it.
                if (!event.currentTarget.contains(event.relatedTarget)) {
                    setPaused(id, false);
                }
            }}
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    dismiss(id);
                }
            }}
            className={`rr-toast-in pointer-events-auto relative rounded-md border border-border border-l-4 ${style.border} bg-surface text-text shadow-lg`}
        >
            <div className="flex items-start gap-2 p-3 pr-10">
                {kind !== "mail" && <style.Icon size={18} aria-hidden="true" className={`mt-0.5 shrink-0 ${style.icon}`} />}
                <div className="min-w-0 flex-1">
                    {href ? (
                        <a
                            href={href}
                            onClick={() => dismiss(id)}
                            className="-m-1 block rounded-md p-1 hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-primary"
                        >
                            {body}
                        </a>
                    ) : (
                        body
                    )}
                    {hint && <p className="mt-1.5 text-xs text-text-muted">{hint}</p>}
                    {details.length > 0 && <Details lines={details} />}
                    {actions.length > 0 && (
                        <div className="-ml-2.5 mt-1.5 flex flex-wrap items-center gap-1">
                            {actions.map((action, index) => (
                                <ActionButton key={index} action={action} id={id} />
                            ))}
                        </div>
                    )}
                </div>
            </div>
            <button
                type="button"
                onClick={() => dismiss(id)}
                aria-label={`Dismiss notification: ${title}`}
                className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface-alt hover:text-text focus-visible:outline-2 focus-visible:outline-primary"
            >
                <HiOutlineXMark size={16} aria-hidden="true" />
            </button>
        </div>
    );
}

/**
 * The pop-up stack, and the one place the app's notifications (see `store.ts`) are drawn. Mounted once, in the persistent app frame, so
 * it survives page changes and covers every app.
 *
 * **Where it sits.** Top right, *below* the header row: the stack is anchored to a zero-height `sticky` line placed right after the
 * frame's header, so it starts under the header (and so under the account menu button, whatever height a branded header has) and, as
 * the page scrolls, sticks just below the header (`--rr-header-h`, published by the title bar / `FrameBrandingHeader` - see `headerOffset.ts`;
 * never less than 2.5 rem, which clears a full-screen compose sheet's own title bar on a phone).
 * On a desktop the compose windows are anchored at the bottom right, the far end of the screen from this; it never covers the account menu,
 * the header's actions or a compose window's title bar and Send button unless the window is stretched over most of the screen height.
 * It sits above the compose sheet (z-index 60 against 50), so a pop-up is never hidden behind it. Its height is capped and scrolls.
 *
 * **Live regions.** Two always-mounted containers with `aria-live` (a live region has to exist before its content changes to be announced):
 * errors in an assertive one, everything else in a polite one, and each pop-up carries the matching role - `alert` for an error, `status`
 * for the rest - so it is announced accordingly, and the empty containers add no `alert`/`status` of their own to the page.
 * `prefers-reduced-motion` switches the entrance animation off (`.rr-toast-in`).
 */
export default function NotificationCenter() {
    const { visible, queued } = useNotifications();
    usePauseWhileHidden();
    useSystemErrorNotifications();
    const errors = visible.filter((notification) => notification.kind === "error");
    const others = visible.filter((notification) => notification.kind !== "error");
    return (
        <div data-testid="notification-anchor" className="sticky top-[max(var(--rr-header-h,0px),2.5rem)] z-[60] h-0 w-full">
            <div
                data-testid="notification-stack"
                // Never taller than the room above the open compose windows (`ComposeProvider` publishes their top edge as `--rr-compose-top`), so
                // a stack of pop-ups scrolls inside its own box rather than covering a compose window's title bar and buttons.
                // (The padding is room for the pop-ups' shadow, which the scroll box would otherwise cut off in a visible edge.)
                className="pointer-events-none absolute right-0 -top-1 flex max-h-[max(8rem,calc(var(--rr-compose-top,100vh)-max(var(--rr-header-h,0px),2.5rem)-2rem))] w-[25rem] max-w-[calc(100vw-0.5rem)] flex-col overflow-y-auto p-4"
            >
                <div data-testid="notification-errors" aria-live="assertive" className="flex flex-col gap-2 [&:not(:empty)]:mb-2">
                    {errors.map((notification) => (
                        <NotificationItem key={notification.id} notification={notification} />
                    ))}
                </div>
                <div data-testid="notification-others" aria-live="polite" className="flex flex-col gap-2">
                    {others.map((notification) => (
                        <NotificationItem key={notification.id} notification={notification} />
                    ))}
                    {queued > 0 && (
                        <p className="rr-solid pointer-events-auto self-end rounded-pill bg-surface px-2.5 py-0.5 text-xs text-text-muted shadow-md">
                            {queued} more waiting
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
