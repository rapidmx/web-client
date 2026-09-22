///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { routedPage } from "../../../_routedPage.js";
import { useNavigate } from "../../../../shared/navigation/AppRouter.js";
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { Folder, listFolders } from "@rapidmx/react-shared/mail/mailApi.js";
import {
    MailFilterAction,
    MailFilterConditions,
    createMailFilterRule,
} from "@rapidmx/react-shared/mail/mailFilterRulesApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../../shared/components/settings/layout/SettingsShell.js";
import RuleBuilder, { hasConditions, RuleBuilderValue } from "../../../../shared/components/rules/RuleBuilder.js";
import { MAIL_FILTER_CONDITION_FIELDS, buildMailFilterActionTypes } from "../_mailFilterRuleConfig.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import { notifyApiError } from "../../../../shared/notifications/apiErrors.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export type NewMailFilterPageProps = Omit<SettingsShellProps, "active">;

function NewMailFilterPage(props: NewMailFilterPageProps) {
    return (
        <SettingsShell {...props} active="filters">
            <NewMailFilterForm />
        </SettingsShell>
    );
}

function NewMailFilterForm() {
    const navigate = useNavigate();
    const { mailboxUid } = useSettingsShell();
    const [folders, setFolders] = useState<Folder[] | null>(null);
    const [folderError, setFolderError] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [rule, setRule] = useState<RuleBuilderValue<MailFilterConditions, MailFilterAction>>({
        enabled: true,
        sequence: 0,
        stopProcessingRules: false,
        conditions: {},
        actions: [],
    });
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [showValidation, setShowValidation] = useState(false);

    // `SettingsShell` only ever renders its children once `mailboxUid` has resolved — same established
    // non-null pattern as `apps/www/settings/auto-reply/index.tsx`.
    useEffect(() => {
        listFolders(mailboxUid!)
            .then(setFolders)
            .catch((err) => setFolderError(err instanceof ApiRequestError ? err.message : "Could not load this mailbox's folders."));
    }, [mailboxUid]);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);

        if (!name.trim()) {
            setError("A name is required.");
            return;
        }
        if (!hasConditions(rule.conditions)) {
            setShowValidation(true);
            setError("Add at least one condition. A filter without conditions would apply to every message.");
            return;
        }

        setSaving(true);
        try {
            const created = await createMailFilterRule({ mailboxUid: mailboxUid!, name: name.trim(), ...rule });
            navigate(`/settings/filters/${encodeURIComponent(created.uid)}?mailboxUid=${encodeURIComponent(mailboxUid!)}`);
        } catch (err) {
            // A pop-up: `error` above is only the form's own validation.
            notifyApiError(err, "Couldn't create the mail filter");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-6">
            <div className="max-w-3xl">
                <h1 className="text-lg font-bold tracking-tight mb-1">New mail filter</h1>
                <p className="text-sm text-text-muted mb-5">
                    Applied in order once a message is verdicted safe to deliver, before it reaches your Inbox.
                </p>

                {error && <Alert>{error}</Alert>}
                {folderError && <Alert>{folderError}</Alert>}

                {folders === null ? (
                    <p className="text-sm text-text-muted">Loading&hellip;</p>
                ) : (
                    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                        <div className="bg-surface border border-border rounded-md p-6">
                            <FormField label="Name" htmlFor="name">
                                <input
                                    id="name"
                                    type="text"
                                    className={INPUT_CLASS}
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder="File newsletters"
                                />
                            </FormField>
                        </div>

                        <RuleBuilder
                            value={rule}
                            onChange={setRule}
                            conditionFields={MAIL_FILTER_CONDITION_FIELDS}
                            actionTypes={buildMailFilterActionTypes(folders)}
                            showValidation={showValidation}
                        />

                        <div className="flex gap-3">
                            <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                                Create filter
                            </Button>
                            <a href={`/settings/filters?mailboxUid=${encodeURIComponent(mailboxUid!)}`}>
                                <Button type="button" variant="secondary" className="!w-auto">
                                    Cancel
                                </Button>
                            </a>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}

export default routedPage("/settings/filters/new", NewMailFilterPage);
