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
import { LazyMessageDetailPane } from "../../shared/components/mail/LazyReadingPane.js";
import { ReadingPaneSkeleton } from "../../shared/components/mail/reading/MessageCard.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";

/**
 * Only reached on mobile (below the `md` breakpoint) — desktop's `apps/www/index.tsx` keeps its existing
 * inline reading pane and never navigates here; see that file's `handleSelect`.
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

    const attachments = useMessageAttachments(message);
    useMarkMessageRead(message, setMessage);

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
            labels={labels}
            onLabelsChanged={setMessage}
            onLabelCreated={(label) => setLabels((prev) => [...prev, label])}
        />
    );
}

export default routedPage("/messages/:uid", MessageDetailPage);
