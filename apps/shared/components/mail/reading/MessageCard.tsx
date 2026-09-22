///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import ContactAvatar from "@rapidmx/react-shared/components/avatar/ContactAvatar.js";
import Skeleton from "@rapidmx/react-shared/components/feedback/Skeleton.js";
import type { MailAddressLike } from "@rapidmx/react-shared/mail/mailAddress.js";
import MailAddress from "../MailAddress.js";
import { UnreadBar, UnreadLabel } from "../unreadStyle.js";

/**
 * The pieces the reading pane is drawn from: a header card that carries the subject, and one card per message. Built from the app's own
 * tokens only (`bg-surface`, `text-text`, `border-border`), so they follow the theme, a branding palette and the Appearance colours; the
 * body area inside a card paints its own opaque surface (`MessageBody`), so a translucent card over a background photo stays legible.
 */

/** The header-style card at the top of the pane: the conversation's (or message's) subject, and what goes with it. */
export function SubjectCard({
    subject,
    meta,
    children,
}: {
    subject: string;
    /** A line under the subject, such as "3 messages". */
    meta?: React.ReactNode;
    children?: React.ReactNode;
}) {
    return (
        <header className="shrink-0 mx-2 mt-2 sm:mx-3 sm:mt-3 rounded-lg border border-border bg-surface backdrop-blur-sm shadow-sm px-4 py-2.5">
            <h1 className="text-base sm:text-lg font-bold tracking-tight line-clamp-2 break-words">{subject}</h1>
            {meta && <p className="text-xs sm:text-sm text-text-muted mt-0.5">{meta}</p>}
            {children}
        </header>
    );
}

/** One message's card: rounded, bordered, lifted a little, its content clipped to the corners. The accent bar of an unread message runs down its left edge. */
export function CardShell({
    unread = false,
    className = "",
    children,
}: {
    unread?: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div className={["relative rounded-lg border border-border bg-surface backdrop-blur-sm shadow-sm overflow-hidden", className].join(" ")}>
            <UnreadBar unread={unread} />
            {children}
        </div>
    );
}

/**
 * Headings carry the display typeface globally (`app.css`, unlayered - so no utility class can beat it); a sender line that happens to be a
 * heading is body text and keeps the body's, by inline style.
 */
export const BODY_FONT_STYLE: React.CSSProperties = { fontFamily: "var(--rr-font-family)" };

/** A sender's avatar in the card header. There are no photos in the data, so this is the initials disc every contact gets. */
export function SenderAvatar({ from }: { from: MailAddressLike }) {
    return <ContactAvatar displayName={from.displayName || from.name || from.address} size={40} />;
}

/**
 * A collapsed message: its card with the sender, the date and the first line of the body, all of it the one button that expands it.
 * Shares the header's look with an expanded card, so expanding does not change how the message begins.
 */
export function CollapsedCard({
    from,
    date,
    preview,
    unread,
    buttonProps,
    buttonRef,
    senderClassName,
    dateClassName,
}: {
    from: MailAddressLike;
    date: string;
    preview: React.ReactNode;
    unread: boolean;
    buttonProps: React.ButtonHTMLAttributes<HTMLButtonElement>;
    buttonRef: (node: HTMLButtonElement | null) => void;
    senderClassName: string;
    dateClassName: string;
}) {
    return (
        <CardShell unread={unread}>
            <h2 style={BODY_FONT_STYLE}>
                <button
                    type="button"
                    ref={buttonRef}
                    {...buttonProps}
                    className={[
                        "w-full text-left flex items-center gap-3 px-4 py-3",
                        unread ? "bg-primary/[0.07] hover:bg-primary/10" : "hover:bg-surface-alt",
                        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
                    ].join(" ")}
                >
                    <UnreadLabel unread={unread} />
                    <SenderAvatar from={from} />
                    <span className="flex-1 min-w-0">
                        {/* On a phone the date drops under the sender rather than squeezing the name to nothing. */}
                        <span className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
                            <MailAddress recipient={from} className={`${senderClassName} min-w-[13rem]! flex-1`} />
                            <span className={["text-xs shrink-0", dateClassName].join(" ")}>{date}</span>
                        </span>
                        <span className="block text-xs text-text-muted truncate font-normal">{preview}</span>
                    </span>
                </button>
            </h2>
        </CardShell>
    );
}

/** The card's place-holder while its message is still loading: an avatar, two header lines and a few lines of body. */
export function CardSkeleton() {
    return (
        <div aria-hidden="true" className="rounded-lg border border-border bg-surface shadow-sm overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3">
                <Skeleton width="w-10" height="h-10" className="rounded-full shrink-0" />
                <div className="flex-1 flex flex-col gap-2">
                    <Skeleton width="w-1/3" />
                    <Skeleton width="w-1/2" height="h-3" />
                </div>
                <Skeleton width="w-16" height="h-3" />
            </div>
            <div className="flex flex-col gap-2.5 px-4 pb-4">
                <Skeleton width="w-11/12" />
                <Skeleton width="w-4/5" />
                <Skeleton width="w-9/12" />
            </div>
        </div>
    );
}

/**
 * What the pane shows while it is getting ready - its code loading, a conversation's messages arriving: the subject card as soon as the
 * subject is known (`subject` is `undefined` when it is not, as on the mobile page before its message arrived) and a skeleton card per
 * message, so the frame of the pane is on screen at once and the messages only fill in. One live region for the whole thing.
 */
export function ReadingPaneSkeleton({ subject, messageCount = 1 }: { subject?: string; messageCount?: number }) {
    return (
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            {subject !== undefined ? (
                <SubjectCard subject={subject || "(no subject)"} meta={messageCount > 1 ? `${messageCount} messages` : undefined} />
            ) : (
                <div aria-hidden="true" className="shrink-0 mx-2 mt-2 sm:mx-3 sm:mt-3 rounded-lg border border-border bg-surface shadow-sm px-4 py-3">
                    <Skeleton width="w-2/3" height="h-6" />
                </div>
            )}
            <SkeletonCards messageCount={messageCount} />
        </div>
    );
}

/**
 * The skeleton cards themselves - up to three, one live region ("Loading the message") for all of them - in the place the message cards take,
 * so a pane that already shows its subject card (a thread whose messages are still coming) swaps them for the real ones without the header
 * card being drawn again.
 */
export function SkeletonCards({ messageCount = 1 }: { messageCount?: number }) {
    return (
        <div role="status" aria-busy="true" className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-3 flex flex-col gap-3">
            <span className="sr-only">Loading the message</span>
            {Array.from({ length: Math.min(3, Math.max(1, messageCount)) }, (_, index) => (
                <CardSkeleton key={index} />
            ))}
        </div>
    );
}
