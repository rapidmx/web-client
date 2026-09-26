///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { routedPage } from "../_routedPage.js";
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Message, getMessage } from "@rapidmx/react-shared/mail/mailApi.js";
import { Label, listLabels } from "@rapidmx/react-shared/mail/labelsApi.js";
import { useMessageAttachments } from "@rapidmx/react-shared/mail/mailDetailHooks.js";
import { useMarkMessageRead } from "../../shared/mail/useMarkMessageRead.js";
import MailShell, { MailShellProps, useMailShell } from "../../shared/components/mail/layout/MailShell.js";
import { LazyConversationThreadPane, LazyMessageDetailPane } from "../../shared/components/mail/LazyReadingPane.js";
import { useLocationSearch } from "../../shared/navigation/AppRouter.js";
import { ReadingPaneSkeleton } from "../../shared/components/mail/reading/MessageCard.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";

/**
 * Only reached on mobile (below the `md` breakpoint) — desktop's `apps/www/index.tsx` keeps its existing
 * inline reading pane and never navigates here; see that file's `handleSelect`. A row of the conversation list
 * comes with `?conversation=<id>` (`handleOpenConversation`), and then this page is the whole thread, opened at this
 * message, as the desktop's reading pane is; without it (a flat list, a link to a message) it is that one message.
 */
function MessageDetailPage(props: MailShellProps & { params: { uid: string } }) {
    return (
        <MailShell {...props}>
            <MessageDetailContent uid={props.params.uid} />
        </MailShell>
    );
}

function MessageDetailContent({ uid }: { uid: string }) {
    const { mailboxFolders, mailboxUid, onFolderCreated } = useMailShell();
    const [message, setMessage] = useState<Message | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [labels, setLabels] = useState<Label[]>([]);
    const conversationId: string | null = new URLSearchParams(useLocationSearch()).get("conversation");

    useEffect(() => {
        setLoading(true);
        setError(null);
        getMessage(uid)
            .then(setMessage)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this message."))
            .finally(() => setLoading(false));
    }, [uid]);

    // See `apps/www/index.tsx`'s identical effect's own doc comment - a failure here just hides the
    // Labels control rather than blocking the rest of the page. Keyed on the message's own mailbox, not the
    // shell's ambient one: this route is reached from aggregate/search rows too, where they can differ.
    const messageMailboxUid = message?.mailboxUid;
    useEffect(() => {
        if (!messageMailboxUid) {
            return;
        }
        let cancelled = false;
        listLabels(messageMailboxUid, { limit: 200 })
            .then((result) => {
                if (!cancelled) {
                    setLabels(result);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [messageMailboxUid]);

    // A thread loads, marks read and fetches the attachments of each message it opens itself.
    const attachments = useMessageAttachments(conversationId ? null : message);
    useMarkMessageRead(conversationId ? null : message, setMessage);

    if (loading) {
        // The pane's own frame - a header card and a message card - rather than a line of text: what is coming is known, only not yet its contents.
        return <ReadingPaneSkeleton />;
    }
    if (error || !message) {
        return <Alert>{error ?? "Message not found."}</Alert>;
    }

    // Looked up by the message's own mailboxUid, not the shell's ambient `mailboxUid` - the mobile detail
    // route reaches here from an aggregate ("All Inboxes" etc.) list row too, where there's no single
    // selected mailbox to fall back to.
    const folders = mailboxFolders.find((mf) => mf.mailbox.uid === message.mailboxUid)?.folders ?? [];
    const backHref = `/?mailboxUid=${encodeURIComponent(message.mailboxUid)}&folderUid=${encodeURIComponent(message.folderUid)}`;
    const isSentItems = folders.find((f) => f.uid === message.folderUid)?.type === "sent_items";
    const isOutbox = folders.find((f) => f.uid === message.folderUid)?.type === "outbox";
    const draftsFolderUid = folders.find((f) => f.type === "drafts")?.uid;
    if (conversationId) {
        return (
            // The thread's own height, as the single message's: it scrolls inside the page rather than growing it.
            <div className="flex flex-col h-full min-h-0">
                <a href={backHref} className="text-sm text-primary-dark hover:underline block px-4 pt-3">
                    &larr; Back to messages
                </a>
                <LazyConversationThreadPane
                    conversation={{ conversationId, subject: message.subject, messageCount: 1 }}
                    selectedUid={message.uid}
                    mailboxUid={message.mailboxUid}
                    folders={folders}
                    labels={labels}
                    shortcuts
                    onMessagePatched={() => undefined}
                    onMessageRemoved={() => undefined}
                    onLabelCreated={(label) => setLabels((prev) => [...prev, label])}
                    onFolderCreated={onFolderCreated}
                />
            </div>
        );
    }
    return (
        <LazyMessageDetailPane
            shortcuts
            message={message}
            attachments={attachments}
            backHref={backHref}
            isSentItems={isSentItems}
            onRecalled={setMessage}
            isOutbox={isOutbox}
            onReceiptHandled={setMessage}
            draftsFolderUid={draftsFolderUid}
            folders={folders}
            onMoved={setMessage}
            onFolderCreated={onFolderCreated}
            onScheduledSendCanceled={setMessage}
            onArchived={setMessage}
            onChanged={setMessage}
            labels={labels}
            onLabelsChanged={setMessage}
            onLabelCreated={(label) => setLabels((prev) => [...prev, label])}
        />
    );
}

export default routedPage("/messages/:uid", MessageDetailPage);
