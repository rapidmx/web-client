///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { MailSignature, listMailSignatures } from "@rapidmx/react-shared/mailSignaturesApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Alert from "../../../shared/components/feedback/Alert.js";
import Button from "../../../shared/components/buttons/Button.js";

export type SettingsSignaturesPageProps = Omit<SettingsShellProps, "active">;

export default function SettingsSignaturesPage(props: SettingsSignaturesPageProps) {
    return (
        <SettingsShell {...props} active="signatures">
            <SignaturesContent />
        </SettingsShell>
    );
}

function SignaturesContent() {
    const { mailboxUid } = useSettingsShell();
    const [signatures, setSignatures] = useState<MailSignature[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // `SettingsShell` only ever renders its children once `mailboxUid` has resolved — same established
    // non-null pattern as `apps/www/settings/auto-reply/index.tsx`.
    useEffect(() => {
        listMailSignatures(mailboxUid!)
            .then(setSignatures)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load signatures."))
            .finally(() => setLoading(false));
    }, [mailboxUid]);

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-3xl">
                <div className="flex items-center justify-between mb-5">
                    <h1 className="text-lg font-bold tracking-tight">Signatures</h1>
                    <a href={`/settings/signatures/new?mailboxUid=${encodeURIComponent(mailboxUid!)}`}>
                        <Button type="button" className="!w-auto">
                            + New signature
                        </Button>
                    </a>
                </div>

                {error && <Alert>{error}</Alert>}

                {loading ? (
                    <p className="text-sm text-text-muted">Loading&hellip;</p>
                ) : signatures.length === 0 ? (
                    <p className="text-sm text-text-muted">No signatures yet.</p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {signatures.map((sig) => (
                            <li key={sig.uid} className="flex items-center justify-between border border-border rounded-md p-3">
                                <div>
                                    <div className="text-sm font-semibold">{sig.name}</div>
                                    {(sig.isDefaultForNewMessages || sig.isDefaultForReplyForward) && (
                                        <div className="text-xs text-text-muted mt-0.5">
                                            {[
                                                sig.isDefaultForNewMessages && "Default for new messages",
                                                sig.isDefaultForReplyForward && "Default for replies/forwards",
                                            ]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </div>
                                    )}
                                </div>
                                <a
                                    href={`/settings/signatures/${encodeURIComponent(sig.uid)}?mailboxUid=${encodeURIComponent(mailboxUid!)}`}
                                    className="text-primary-dark hover:underline font-medium text-sm"
                                >
                                    Edit
                                </a>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
