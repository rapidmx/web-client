///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { createMailSignature, listMailSignatures } from "@rapidmx/react-shared/mailSignaturesApi.js";
import { clearPreviousDefaults } from "../signatureDefaults.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../../shared/components/settings/layout/SettingsShell.js";
import RichTextEditor from "../../../../shared/components/mail/compose/RichTextEditor.js";
import Alert from "../../../../shared/components/feedback/Alert.js";
import Button from "../../../../shared/components/buttons/Button.js";
import FormField from "../../../../shared/components/forms/FormField.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export type NewSignaturePageProps = Omit<SettingsShellProps, "active">;

export default function NewSignaturePage(props: NewSignaturePageProps) {
    return (
        <SettingsShell {...props} active="signatures">
            <NewSignatureForm />
        </SettingsShell>
    );
}

/** Signatures aren't backed by a draft/attachment record the way Compose's own inline images are (see
 * `ComposeWindow.handleUploadImage()`) — inline images in a signature are out of scope for this phase
 * (`.claude/NOTES.md`'s Phase 12 entry), so this is a real, deliberate no-op, not a stub left unfinished. */
async function handleUploadImage(): Promise<string | null> {
    return null;
}

function NewSignatureForm() {
    const { mailboxUid } = useSettingsShell();
    const [name, setName] = useState("");
    const [contentHtml, setContentHtml] = useState("");
    const [isDefaultForNewMessages, setIsDefaultForNewMessages] = useState(false);
    const [isDefaultForReplyForward, setIsDefaultForReplyForward] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);

        if (!name.trim()) {
            setError("A name is required.");
            return;
        }

        setSaving(true);
        try {
            if (isDefaultForNewMessages || isDefaultForReplyForward) {
                const existing = await listMailSignatures(mailboxUid!, { limit: 100 });
                await clearPreviousDefaults(existing, undefined, isDefaultForNewMessages, isDefaultForReplyForward);
            }
            const created = await createMailSignature({
                mailboxUid: mailboxUid!,
                name: name.trim(),
                contentHtml,
                isDefaultForNewMessages,
                isDefaultForReplyForward,
            });
            window.location.href = `/settings/signatures/${encodeURIComponent(created.uid)}?mailboxUid=${encodeURIComponent(mailboxUid!)}`;
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create the signature.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-3xl">
                <h1 className="text-lg font-bold tracking-tight mb-5">New signature</h1>

                {error && <Alert>{error}</Alert>}

                <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                    <div className="bg-surface border border-border rounded-md p-6 flex flex-col gap-4">
                        <FormField label="Name" htmlFor="name">
                            <input
                                id="name"
                                type="text"
                                className={INPUT_CLASS}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Work signature"
                            />
                        </FormField>
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={isDefaultForNewMessages}
                                onChange={(e) => setIsDefaultForNewMessages(e.target.checked)}
                            />
                            Use for new messages
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={isDefaultForReplyForward}
                                onChange={(e) => setIsDefaultForReplyForward(e.target.checked)}
                            />
                            Use for replies and forwards
                        </label>
                    </div>

                    <div className="h-64">
                        <RichTextEditor value={contentHtml} onChange={setContentHtml} fill onUploadImage={handleUploadImage} />
                    </div>

                    <div className="flex gap-3">
                        <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                            Create signature
                        </Button>
                        <a href={`/settings/signatures?mailboxUid=${encodeURIComponent(mailboxUid!)}`}>
                            <Button type="button" variant="secondary" className="!w-auto">
                                Cancel
                            </Button>
                        </a>
                    </div>
                </form>
            </div>
        </div>
    );
}
