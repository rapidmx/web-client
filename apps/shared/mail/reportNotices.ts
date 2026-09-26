///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { MessageReportKind, MessageReportResult } from "@rapidmx/react-shared/mail/mailApi.js";

/** Where a notification's "Manage blocked senders" goes: the Blocked and safe senders page of the mailbox. */
export function senderListsHref(mailboxUid: string): string {
    return `/settings/blocked-senders?mailboxUid=${encodeURIComponent(mailboxUid)}`;
}

/** What a pop-up says about reporting `kind`: the title, and the folder the message goes to. */
const KINDS: Record<MessageReportKind, { title: string; noun: string; folder: string }> = {
    junk: { title: "Reported as junk", noun: "junk", folder: "Junk Email" },
    phishing: { title: "Reported as phishing", noun: "phishing", folder: "Junk Email" },
    not_junk: { title: "Marked as not junk", noun: "not junk", folder: "the Inbox" },
};

/** The noun of `kind` for a failure's title ("Couldn't report this message as phishing"). */
export function reportNoun(kind: MessageReportKind): string {
    return KINDS[kind].noun;
}

/** The title of a pop-up for a report of `kind`. */
export function reportTitle(kind: MessageReportKind): string {
    return KINDS[kind].title;
}

/** The name of the folder a report of `kind` files the message in. */
export function reportFolderName(kind: MessageReportKind): string {
    return KINDS[kind].folder;
}

/** What a pop-up for a report says. `hint` is the small muted line: only for the two things a reader may want to know about (the filter could not be
 * taught, or the message is encrypted so it was not), never for the ones that are simply how the server is set up. */
export interface ReportNotice {
    title: string;
    message: string;
    hint?: string;
}

/**
 * The words for what the server did with a report (`reportMessage()`'s answer): where the message went, whether the spam filter learned from it, and - for
 * a report of phishing - that the server recorded it. `subject` names the message. `alwaysTrust` says the reader asked for the sender to be trusted.
 */
export function reportNotice(result: MessageReportResult, subject: string, alwaysTrust: boolean): ReportNotice {
    const kind = KINDS[result.kind];
    const where = result.moved ? `was moved to ${kind.folder}` : `is already in ${kind.folder}`;
    const learned = result.learned ? " and used to train the spam filter" : "";
    const parts = [`“${subject}” ${where}${learned}.`];
    if (result.kind === "phishing") {
        parts.push("The report was recorded in the audit log.");
    }
    if (result.safeSender) {
        parts.push(`Mail from ${result.safeSender} that passes authentication is no longer sent to Junk Email.`);
    } else if (alwaysTrust) {
        parts.push("The message names no address that could be trusted.");
    }
    const hint =
        result.learnSkipped === "failed"
            ? "The spam filter could not be trained from this report."
            : result.learnSkipped === "encrypted"
              ? "Not used to train the spam filter: the message is encrypted."
              : undefined;
    return { title: kind.title, message: parts.join(" "), hint };
}
