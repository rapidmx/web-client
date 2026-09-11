///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { Folder, listFolders } from "@rapidmx/react-shared/mailApi.js";
import {
    MailFilterAction,
    MailFilterConditions,
    MailFilterRule,
    getMailFilterRule,
    updateMailFilterRule,
} from "@rapidmx/react-shared/mailFilterRulesApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import RuleBuilder, { RuleBuilderValue } from "../../../shared/components/rules/RuleBuilder.js";
import { MAIL_FILTER_CONDITION_FIELDS, buildMailFilterActionTypes } from "./_mailFilterRuleConfig.js";
import Alert from "../../../shared/components/feedback/Alert.js";
import Button from "../../../shared/components/buttons/Button.js";
import FormField from "../../../shared/components/forms/FormField.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export type MailFilterDetailPageProps = Omit<SettingsShellProps, "active"> & { params: { uid: string } };

export default function MailFilterDetailPage(props: MailFilterDetailPageProps) {
    return (
        <SettingsShell {...props} active="filters">
            <MailFilterDetailContent uid={props.params.uid} />
        </SettingsShell>
    );
}

function MailFilterDetailContent({ uid }: { uid: string }) {
    const { mailboxUid } = useSettingsShell();
    const [original, setOriginal] = useState<MailFilterRule | null>(null);
    const [name, setName] = useState("");
    const [rule, setRule] = useState<RuleBuilderValue<MailFilterConditions, MailFilterAction> | null>(null);
    const [folders, setFolders] = useState<Folder[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        // `SettingsShell` only ever renders its children once `mailboxUid` has resolved — same
        // established non-null pattern as `apps/www/settings/auto-reply/index.tsx`.
        listFolders(mailboxUid!).then(setFolders).catch(() => setFolders([]));
    }, [mailboxUid]);

    useEffect(() => {
        setLoading(true);
        setError(null);
        getMailFilterRule(uid)
            .then((loaded) => {
                setOriginal(loaded);
                if (loaded) {
                    setName(loaded.name);
                    setRule({
                        enabled: loaded.enabled,
                        sequence: loaded.sequence,
                        stopProcessingRules: loaded.stopProcessingRules,
                        conditions: loaded.conditions,
                        actions: loaded.actions,
                    });
                }
            })
            .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load this mail filter."))
            .finally(() => setLoading(false));
    }, [uid]);

    // Only ever invoked from the form below, which itself only renders once `original`/`rule` are
    // loaded (the early returns above cover every other state) — the non-null assertions reflect that
    // real invariant, matching `TransportRuleDetailContent.handleSubmit`'s identical pattern.
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
            const updated = await updateMailFilterRule({
                uid: original!.uid,
                version: original!.version,
                name: name.trim(),
                ...rule!,
            });
            setOriginal(updated);
            setSaved(true);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not save this mail filter.");
        } finally {
            setSaving(false);
        }
    }

    if (loading || folders === null) {
        return <p className="p-6 text-sm text-text-muted">Loading&hellip;</p>;
    }
    if (error && !original) {
        return (
            <div className="p-6">
                <Alert>{error}</Alert>
            </div>
        );
    }
    if (!original || !rule) {
        return (
            <div className="p-6">
                <Alert>Mail filter not found.</Alert>
            </div>
        );
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-3xl">
                <a href={`/settings/filters?mailboxUid=${encodeURIComponent(mailboxUid!)}`} className="text-sm text-primary-dark hover:underline">
                    &larr; All mail filters
                </a>
                <h1 className="text-lg font-bold tracking-tight mt-1 mb-5">{original.name}</h1>

                {error && <Alert>{error}</Alert>}
                {saved && !error && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

                <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                    <div className="bg-surface border border-border rounded-md p-6">
                        <FormField label="Name" htmlFor="name">
                            <input id="name" type="text" className={INPUT_CLASS} value={name} onChange={(e) => setName(e.target.value)} />
                        </FormField>
                    </div>

                    <RuleBuilder
                        value={rule}
                        onChange={setRule}
                        conditionFields={MAIL_FILTER_CONDITION_FIELDS}
                        actionTypes={buildMailFilterActionTypes(folders)}
                    />

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
