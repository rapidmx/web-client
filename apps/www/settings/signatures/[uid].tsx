///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { MailSignature, getMailSignature, listMailSignatures, updateMailSignature } from "@rapidmx/react-shared/mailSignaturesApi.js";
import { clearPreviousDefaults } from "./signatureDefaults.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import RichTextEditor from "../../../shared/components/mail/compose/RichTextEditor.js";
import Alert from "../../../shared/components/feedback/Alert.js";
import Button from "../../../shared/components/buttons/Button.js";
import FormField from "../../../shared/components/forms/FormField.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** Signatures aren't backed by a draft/attachment record the way Compose's own inline images are — see
 * `settings/signatures/new/index.tsx`'s identical stub for the full reasoning. */
async function handleUploadImage(): Promise<string | null> {
    return null;
}

export type SignatureDetailPageProps = Omit<SettingsShellProps, "active"> & { params: { uid: string } };

export default function SignatureDetailPage(props: SignatureDetailPageProps) {
    return (
        <SettingsShell {...props} active="signatures">
            <SignatureDetailContent uid={props.params.uid} />
        </SettingsShell>
    );
}

function SignatureDetailContent({ uid }: { uid: string }) {
    const { mailboxUid } = useSettingsShell();
    const [original, setOriginal] = useState<MailSignature | null>(null);
    const [name, setName] = useState("");
    const [contentHtml, setContentHtml] = useState("");
    const [isDefaultForNewMessages, setIsDefaultForNewMessages] = useState(false);
    const [isDefaultForReplyForward, setIsDefaultForReplyForward] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        setLoading(true);
        setError(null);
        getMailSignature(uid)
            .then((loaded) => {
                setOriginal(loaded);
                if (loaded) {
                    setName(loaded.name);
                    setContentHtml(loaded.contentHtml);
                    setIsDefaultForNewMessages(loaded.isDefaultForNewMessages);
                    setIsDefaultForReplyForward(loaded.isDefaultForReplyForward);
                }
            })
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this signature."))
            .finally(() => setLoading(false));
    }, [uid]);

    // Only ever invoked from the form below, which itself only renders once `original` is loaded (the
    // early returns above cover every other state) — the non-null assertions reflect that real
    // invariant, matching `MailFilterDetailContent.handleSubmit`'s identical pattern.
    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);

        if (!name.trim()) {
            setError("A name is required.");
            return;
        }

        setSaving(true);
        setSaved(false);
        try {
            if (isDefaultForNewMessages || isDefaultForReplyForward) {
                const existing = await listMailSignatures(mailboxUid!, { limit: 100 });
                await clearPreviousDefaults(existing, original!.uid, isDefaultForNewMessages, isDefaultForReplyForward);
            }
            const updated = await updateMailSignature({
                uid: original!.uid,
                version: original!.version,
                name: name.trim(),
                contentHtml,
                isDefaultForNewMessages,
                isDefaultForReplyForward,
            });
            setOriginal(updated);
            setSaved(true);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save this signature.");
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return <p className="p-6 text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error && !original) {
        return (
            <div className="p-6">
                <Alert>{error}</Alert>
            </div>
        );
    }
    if (!original) {
        return (
            <div className="p-6">
                <Alert>Signature not found.</Alert>
            </div>
        );
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-3xl">
                <a
                    href={`/settings/signatures?mailboxUid=${encodeURIComponent(mailboxUid!)}`}
                    className="text-sm text-primary-dark hover:underline"
                >
                    &larr; All signatures
                </a>
                <h1 className="text-lg font-bold tracking-tight mt-1 mb-5">{original.name}</h1>

                {error && <Alert>{error}</Alert>}
                {saved && !error && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

                <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                    <div className="bg-surface border border-border rounded-md p-6 flex flex-col gap-4">
                        <FormField label="Name" htmlFor="name">
                            <input id="name" type="text" className={INPUT_CLASS} value={name} onChange={(e) => setName(e.target.value)} />
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

                    <div>
                        <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                            Save changes
                        </Button>
                    </div>
                </form>
            </div>
        </div>
    );
}
