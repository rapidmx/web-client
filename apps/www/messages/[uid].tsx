///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { Message, getMessage } from "@rapidmx/react-shared/mailApi.js";
import { useMarkMessageRead, useMessageAttachments } from "@rapidmx/react-shared/mailDetailHooks.js";
import MailShell, { MailShellProps, useMailShell } from "../../shared/components/mail/layout/MailShell.js";
import MessageDetailPane from "../../shared/components/mail/MessageDetailPane.js";
import Alert from "../../shared/components/feedback/Alert.js";

/**
 * Only reached on mobile (below the `md` breakpoint) — desktop's `apps/www/index.tsx` keeps its existing
 * inline reading pane and never navigates here; see that file's `handleSelect`.
 */
export default function MessageDetailPage(props: MailShellProps & { params: { uid: string } }) {
    return (
        <MailShell {...props}>
            <MessageDetailContent uid={props.params.uid} />
        </MailShell>
    );
}

function MessageDetailContent({ uid }: { uid: string }) {
    const { folders } = useMailShell();
    const [message, setMessage] = useState<Message | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        getMessage(uid)
            .then(setMessage)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this message."))
            .finally(() => setLoading(false));
    }, [uid]);

    const attachments = useMessageAttachments(message);
    useMarkMessageRead(message, setMessage);

    if (loading) {
        return <p className="p-8 text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error || !message) {
        return <Alert>{error ?? "Message not found."}</Alert>;
    }

    const backHref = `/?mailboxUid=${encodeURIComponent(message.mailboxUid)}&folderUid=${encodeURIComponent(message.folderUid)}`;
    const isSentItems = folders.find((f) => f.uid === message.folderUid)?.type === "sent_items";
    const isOutbox = folders.find((f) => f.uid === message.folderUid)?.type === "outbox";
    const isInbox = folders.find((f) => f.uid === message.folderUid)?.type === "inbox";
    const draftsFolderUid = folders.find((f) => f.type === "drafts")?.uid;
    return (
        <MessageDetailPane
            message={message}
            attachments={attachments}
            backHref={backHref}
            isSentItems={isSentItems}
            onRecalled={setMessage}
            isOutbox={isOutbox}
            isInbox={isInbox}
            onClassified={setMessage}
            onReceiptHandled={setMessage}
            draftsFolderUid={draftsFolderUid}
            onScheduledSendCanceled={setMessage}
        />
    );
}
