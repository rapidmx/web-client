///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { MessageClassification } from "@rapidmx/react-shared/mailApi.js";
import {
    FocusedInboxOverride,
    createFocusedInboxOverride,
    deleteFocusedInboxOverride,
    listFocusedInboxOverrides,
} from "@rapidmx/react-shared/focusedInboxOverridesApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Alert from "../../../shared/components/feedback/Alert.js";
import Button from "../../../shared/components/buttons/Button.js";

export type SettingsFocusedInboxPageProps = Omit<SettingsShellProps, "active">;

export default function SettingsFocusedInboxPage(props: SettingsFocusedInboxPageProps) {
    return (
        <SettingsShell {...props} active="focused-inbox">
            <FocusedInboxContent />
        </SettingsShell>
    );
}

function FocusedInboxContent() {
    const { mailboxUid } = useSettingsShell();
    const [overrides, setOverrides] = useState<FocusedInboxOverride[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [newSender, setNewSender] = useState("");
    const [newClassifyAs, setNewClassifyAs] = useState<MessageClassification>("other");

    function reload() {
        setLoading(true);
        setError(null);
        // `SettingsShell` only ever renders its children once `mailboxUid` has resolved — same
        // established non-null pattern as `apps/www/settings/filters/index.tsx`.
        listFocusedInboxOverrides(mailboxUid!)
            .then(setOverrides)
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load your Focused Inbox rules."))
            .finally(() => setLoading(false));
    }

    useEffect(reload, [mailboxUid]);

    async function handleAdd(e: FormEvent) {
        e.preventDefault();
        const senderAddress = newSender.trim();
        if (!senderAddress) {
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await createFocusedInboxOverride({ mailboxUid: mailboxUid!, senderAddress, classifyAs: newClassifyAs });
            setNewSender("");
            reload();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not add this rule.");
        } finally {
            setSaving(false);
        }
    }

    async function handleRemove(override: FocusedInboxOverride) {
        setSaving(true);
        setError(null);
        try {
            await deleteFocusedInboxOverride(override.uid, override.version);
            reload();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not remove this rule.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-xl">
                <h1 className="text-lg font-bold tracking-tight mb-1">Focused Inbox</h1>
                <p className="text-sm text-text-muted mb-4">
                    Mail from a sender listed here always goes to the matching half of your Inbox, overriding
                    the automatic Focused/Other classification. Add one directly, or use &ldquo;Always for this
                    sender&rdquo; when moving a message.
                </p>

                {error && <Alert>{error}</Alert>}

                {loading ? (
                    <p className="text-sm text-text-muted">Loading&hellip;</p>
                ) : (
                    <ul className="flex flex-col gap-2 mb-4">
                        {overrides.length === 0 && <li className="text-sm text-text-muted">No rules yet.</li>}
                        {overrides.map((override) => (
                            <li
                                key={override.uid}
                                className="flex items-center justify-between gap-3 py-2 px-3 border border-border rounded-sm"
                            >
                                <div>
                                    <div className="text-sm font-medium">{override.senderAddress}</div>
                                    <div className="text-xs text-text-muted">
                                        Always {override.classifyAs === "other" ? "Other" : "Focused"}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => handleRemove(override)}
                                    disabled={saving}
                                    className="text-sm text-danger hover:underline disabled:opacity-55"
                                >
                                    Remove
                                </button>
                            </li>
                        ))}
                    </ul>
                )}

                <form onSubmit={handleAdd} className="flex gap-2">
                    <input
                        type="text"
                        aria-label="Sender address"
                        value={newSender}
                        onChange={(e) => setNewSender(e.target.value)}
                        placeholder="sender@example.com"
                        className="flex-1 text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary"
                    />
                    <select
                        aria-label="Classify as"
                        value={newClassifyAs}
                        onChange={(e) => setNewClassifyAs(e.target.value as MessageClassification)}
                        className="text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary"
                    >
                        <option value="other">Other</option>
                        <option value="focused">Focused</option>
                    </select>
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Add
                    </Button>
                </form>
            </div>
        </div>
    );
}
