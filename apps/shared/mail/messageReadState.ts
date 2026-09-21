///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Message, setMessageRead, setMessagesRead } from "@rapidmx/react-shared/mail/mailApi.js";
import type { CountTracker } from "./folderCounts.js";

/**
 * The one way a message's read state changes in the webmail, so that every place that shows it moves together: the row in
 * the list (and the conversation row's unread count), the folder badge, and the unread styling.
 *
 * It is **optimistic**: the row and the badge change the moment the user acts, the server is asked, and if it refuses the
 * change is taken back. What each place is handed to do that is a `ReadStateSink`.
 */
export interface ReadStateSink {
    /**
     * Shows a message wherever the caller lists it - the message list, the conversation list's child rows, the open thread.
     * `previous` is given with the optimistic copy (and with the revert of it) and is the copy being replaced, so a
     * conversation row can tell that its unread count went up or down; it is absent for the server's own copy, which
     * differs only in its `version`.
     */
    patch(updated: Message, previous?: Message): void;
    /** Applies the change to the folder badges: `MailShell`'s `trackMessageChange`. */
    track(previous: Message, next: Message): CountTracker;
}

function withRead(message: Message, read: boolean): Message {
    return { ...message, flags: { ...message.flags, read } };
}

/** Whether `message` is not yet in the state `read` asks for. A message with no `read` flag counts as unread. */
function needsChange(message: Message, read: boolean): boolean {
    return (message.flags.read === true) !== read;
}

/**
 * Marks one message read (`read: true`) or unread. Resolves the server's updated copy, or `undefined` when nothing needed
 * doing (it already was that way) or the server refused - in which case everything has already been put back as it was.
 * Never rejects: like the old mark-as-read, a failure must not get in the way of reading the message.
 */
export async function setReadState(message: Message, read: boolean, sink: ReadStateSink): Promise<Message | undefined> {
    if (!needsChange(message, read)) {
        return undefined;
    }
    const optimistic = withRead(message, read);
    sink.patch(optimistic, message);
    const tracker = sink.track(message, optimistic);
    try {
        const updated = await setMessageRead(message, read);
        sink.patch(updated);
        tracker.settle();
        return updated;
    } catch {
        sink.patch(message, optimistic);
        tracker.revert();
        return undefined;
    }
}

/**
 * The same for a whole selection, in one request. Resolves the updated messages, in request order. Unlike `setReadState()`
 * it rejects when the server refuses (after putting everything back), because a bulk update is not atomic - some of it may
 * have landed - and the caller's own handling reloads the list and says so (see `bulkUpdateMessages()`).
 */
export async function setReadStateMany(messages: Message[], read: boolean, sink: ReadStateSink): Promise<Message[]> {
    const changes = messages.filter((message) => needsChange(message, read)).map((message) => ({ message, optimistic: withRead(message, read) }));
    const trackers = changes.map(({ message, optimistic }) => {
        sink.patch(optimistic, message);
        return sink.track(message, optimistic);
    });
    try {
        const updated = await setMessagesRead(messages, read);
        for (const message of updated) {
            sink.patch(message);
        }
        trackers.forEach((tracker) => tracker.settle());
        return updated;
    } catch (err) {
        changes.forEach(({ message, optimistic }, index) => {
            sink.patch(message, optimistic);
            trackers[index].revert();
        });
        throw err;
    }
}
