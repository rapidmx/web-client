///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import {
    createTransportRule,
    TransportRuleAction,
    TransportRuleConditions,
} from "@rapidmx/react-shared/transportRulesApi.js";
import AdminShell, { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import RuleBuilder, { RuleBuilderValue } from "../../../shared/components/rules/RuleBuilder.js";
import { TRANSPORT_RULE_ACTION_TYPES, TRANSPORT_RULE_CONDITION_FIELDS } from "../_transportRuleConfig.js";
import Alert from "../../../shared/components/feedback/Alert.js";
import Button from "../../../shared/components/buttons/Button.js";
import FormField from "../../../shared/components/forms/FormField.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export default function NewTransportRulePage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="transportRules">
            <NewTransportRuleForm />
        </AdminShell>
    );
}

function NewTransportRuleForm() {
    const [name, setName] = useState("");
    const [rule, setRule] = useState<RuleBuilderValue<TransportRuleConditions, TransportRuleAction>>({
        enabled: true,
        sequence: 0,
        stopProcessingRules: false,
        conditions: {},
        actions: [],
    });
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
            const created = await createTransportRule({ name: name.trim(), ...rule });
            window.location.href = `/admin/transport-rules/${encodeURIComponent(created.uid)}`;
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create the transport rule.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="max-w-3xl">
            <h1 className="text-xl font-bold uppercase tracking-wide mb-1">New transport rule</h1>
            <p className="text-sm text-text-muted mb-5">
                Evaluated once per SMTP transaction, before any message is resolved to an individual mailbox.
            </p>

            {error && <Alert>{error}</Alert>}

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                <div className="bg-surface border border-border rounded-md p-6">
                    <FormField label="Name" htmlFor="name">
                        <input
                            id="name"
                            type="text"
                            className={INPUT_CLASS}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Flag external senders"
                        />
                    </FormField>
                </div>

                <RuleBuilder
                    value={rule}
                    onChange={setRule}
                    conditionFields={TRANSPORT_RULE_CONDITION_FIELDS}
                    actionTypes={TRANSPORT_RULE_ACTION_TYPES}
                />

                <div className="flex gap-3">
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Create transport rule
                    </Button>
                    <a href="/admin/transport-rules">
                        <Button type="button" variant="secondary" className="!w-auto">
                            Cancel
                        </Button>
                    </a>
                </div>
            </form>
        </div>
    );
}
