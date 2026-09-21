///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";

/**
 * How an unread message looks in every list of mail (the message list, the conversation list and its child rows, the
 * thread pane's message headers, the folder badges), in one place so they can't drift apart. Modelled on Outlook:
 *
 * **Unread**: an accent bar down the row's left edge, a faint accent tint on the row, the sender and subject in bold and the
 * date in the accent colour - plus a visually-hidden "Unread" in the row's text, so it never relies on colour alone.
 *
 * **Read**: normal weight, the sender and preview muted.
 *
 * **Hover, selected and focused** are their own states and look nothing like unread: hover is a plain grey (an accent tint on
 * an unread row, so the row doesn't seem to lose its state), the open row has a stronger accent fill and an inset outline, and
 * keyboard focus is a solid outline drawn inside the row.
 *
 * All of it is built from the theme's own tokens (`primary`, `text`, `text-muted`, `surface-alt`), so it follows light and
 * dark mode and a branding stylesheet's palette.
 */

/** Whether a message is unread: `flags.read` isn't `true`. A message with no `read` flag at all counts as unread. */
export function isUnread(message: Pick<Message, "flags"> | undefined | null): boolean {
    return !!message && message.flags.read !== true;
}

/**
 * The classes of a row's outer element (`li`, or the row's wrapping `div`): the positioning the bar needs, and its one
 * background - the open row's accent fill and inset outline, else an unread row's faint tint (a little stronger on hover),
 * else a read row's plain grey hover. One element owns all of it so the states can't fight over the same property.
 */
export function rowClass(state: { unread: boolean; selected: boolean }, extra = ""): string {
    return [
        "relative border-b border-border",
        state.selected
            ? "bg-primary/20 ring-1 ring-inset ring-primary/50"
            : state.unread
              ? "bg-primary/[0.07] hover:bg-primary/10"
              : "hover:bg-surface-alt",
        extra,
    ]
        .filter(Boolean)
        .join(" ");
}

/** Keyboard focus on a row's button: a solid outline drawn inside the row, unlike anything unread/selected/hover does. */
export const ROW_FOCUS_CLASS = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary";

/** The sender line: bold and full-strength while unread, normal and muted once read. */
export function senderClass(unread: boolean): string {
    return unread ? "font-bold text-text" : "font-normal text-text-muted";
}

/** The subject line. */
export function subjectClass(unread: boolean): string {
    return unread ? "font-semibold text-text" : "font-normal text-text";
}

/** The date beside the sender: the accent colour while unread. */
export function dateClass(unread: boolean): string {
    return unread ? "font-semibold text-primary-dark" : "font-normal text-text-muted";
}

/** The accent bar down a row's left edge - only for an unread row. The row's outer element must be `relative`. */
export function UnreadBar({ unread }: { unread: boolean }) {
    return unread ? <span aria-hidden="true" data-unread-bar className="absolute inset-y-0 left-0 w-1 bg-primary" /> : null;
}

/** "Unread." in the row's text for assistive technology (and for anything that reads the DOM without styles). */
export function UnreadLabel({ unread }: { unread: boolean }) {
    return unread ? <span className="sr-only">Unread. </span> : null;
}
