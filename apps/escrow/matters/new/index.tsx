///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { useRouter } from "@rapidrest/react/client";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { toDatetimeLocal } from "@rapidmx/react-shared/util/dateInput.js";
import { createMatter } from "@rapidmx/react-shared/admin/mattersApi.js";
import EscrowShell, { EscrowShellProps } from "../../../shared/components/escrow/layout/EscrowShell.js";
import StringListField from "../../../shared/components/forms/StringListField.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export default function NewMatterPage(props: Omit<EscrowShellProps, "active">) {
    return (
        <EscrowShell {...props} active="matters">
            <NewMatterForm />
        </EscrowShell>
    );
}

function NewMatterForm() {
    const { navigate } = useRouter();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    // No dropdown here: `EscrowScope` (BaseEscrowScopeRoute) is trusted-admin-only end to end, so this
    // app has no holder-readable "list the scopes I hold" endpoint to populate one from — a holder is
    // told their own escrowScopeId out of band by whichever admin granted them the role. Same
    // "server fills a gap, or here, deliberately doesn't paper over one restapi itself doesn't expose"
    // posture as `BaseEscrowInfoRoute`'s own doc comment on the mailbox-owner side of this feature.
    const [escrowScopeId, setEscrowScopeId] = useState("");
    const [custodianMailboxUids, setCustodianMailboxUids] = useState<string[]>([]);
    // Defaults to the last 24 hours rather than "now" for both ends - a `dateRangeStart === dateRangeEnd`
    // default would always fail this form's own "start must be before end" check the instant it's opened,
    // forcing every holder to touch both fields even when they'd otherwise leave one at its default.
    const [dateRangeStart, setDateRangeStart] = useState(toDatetimeLocal(new Date(Date.now() - 24 * 60 * 60_000).toISOString()));
    const [dateRangeEnd, setDateRangeEnd] = useState(toDatetimeLocal(new Date().toISOString()));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);

        if (!name.trim()) {
            setError("A name is required.");
            return;
        }
        if (!escrowScopeId.trim()) {
            setError("An escrow scope uid is required.");
            return;
        }
        if (custodianMailboxUids.length === 0) {
            setError("At least one custodian mailbox is required.");
            return;
        }
        if (new Date(dateRangeStart).getTime() >= new Date(dateRangeEnd).getTime()) {
            setError("The date range start must be before its end.");
            return;
        }

        setSaving(true);
        try {
            const created = await createMatter({
                name: name.trim(),
                description: description.trim() || undefined,
                escrowScopeId: escrowScopeId.trim(),
                custodianMailboxUids,
                dateRangeStart: new Date(dateRangeStart).toISOString(),
                dateRangeEnd: new Date(dateRangeEnd).toISOString(),
            });
            void navigate(`/escrow/matters/${encodeURIComponent(created.uid)}`);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create the matter.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="max-w-3xl">
            <h1 className="text-xl font-bold uppercase tracking-wide mb-1">New matter</h1>
            <p className="text-sm text-text-muted mb-5">
                You must already be a holder of the escrow scope you name below — this server checks that at
                creation time, the same as every other action in this console.
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
                            placeholder="Smith v. Acme"
                        />
                    </FormField>

                    <FormField label="Description (optional)" htmlFor="description">
                        <input
                            id="description"
                            type="text"
                            className={INPUT_CLASS}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                        />
                    </FormField>

                    <FormField label="Escrow scope uid" htmlFor="escrowScopeId">
                        <input
                            id="escrowScopeId"
                            type="text"
                            className={INPUT_CLASS}
                            value={escrowScopeId}
                            onChange={(e) => setEscrowScopeId(e.target.value)}
                        />
                    </FormField>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                        <FormField label="Date range start" htmlFor="dateRangeStart">
                            <input
                                id="dateRangeStart"
                                type="datetime-local"
                                className={INPUT_CLASS}
                                value={dateRangeStart}
                                onChange={(e) => setDateRangeStart(e.target.value)}
                            />
                        </FormField>

                        <FormField label="Date range end" htmlFor="dateRangeEnd">
                            <input
                                id="dateRangeEnd"
                                type="datetime-local"
                                className={INPUT_CLASS}
                                value={dateRangeEnd}
                                onChange={(e) => setDateRangeEnd(e.target.value)}
                            />
                        </FormField>
                    </div>
                </div>

                <div className="bg-surface border border-border rounded-md p-6">
                    <StringListField
                        label="Custodian mailbox uids"
                        id="custodianMailboxUids"
                        values={custodianMailboxUids}
                        onChange={setCustodianMailboxUids}
                        placeholder="Mailbox uid to add"
                        emptyMessage="No custodian mailboxes added yet."
                    />
                </div>

                <div className="flex gap-3">
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Create matter
                    </Button>
                    <a href="/escrow">
                        <Button type="button" variant="secondary" className="!w-auto">
                            Cancel
                        </Button>
                    </a>
                </div>
            </form>
        </div>
    );
}
