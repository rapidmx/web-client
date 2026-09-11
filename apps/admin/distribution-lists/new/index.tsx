///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { createDistributionList } from "@rapidmx/react-shared/distributionListsApi.js";
import AdminShell, { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import Alert from "../../../shared/components/feedback/Alert.js";
import Button from "../../../shared/components/buttons/Button.js";
import FormField from "../../../shared/components/forms/FormField.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export default function NewDistributionListPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="distributionLists">
            <NewDistributionListForm />
        </AdminShell>
    );
}

function NewDistributionListForm() {
    const [primarySmtpAddress, setPrimarySmtpAddress] = useState("");
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);

        if (!primarySmtpAddress.trim()) {
            setError("A primary SMTP address is required.");
            return;
        }
        if (!name.trim()) {
            setError("A name is required.");
            return;
        }

        setSaving(true);
        try {
            const list = await createDistributionList({
                primarySmtpAddress: primarySmtpAddress.trim(),
                name: name.trim(),
                description: description.trim() || undefined,
            });
            window.location.href = `/admin/distribution-lists/${encodeURIComponent(list.uid)}`;
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create the distribution list.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="max-w-xl">
            <h1 className="text-xl font-bold uppercase tracking-wide mb-1">New distribution list</h1>
            <p className="text-sm text-text-muted mb-5">
                Members can be added once the list is created.
            </p>

            {error && <Alert>{error}</Alert>}

            <form onSubmit={handleSubmit} className="bg-surface border border-border rounded-md p-6">
                <FormField label="Primary SMTP address" htmlFor="primarySmtpAddress">
                    <input
                        id="primarySmtpAddress"
                        type="email"
                        className={INPUT_CLASS}
                        value={primarySmtpAddress}
                        onChange={(e) => setPrimarySmtpAddress(e.target.value)}
                        placeholder="team@example.com"
                    />
                </FormField>

                <FormField label="Name" htmlFor="name">
                    <input
                        id="name"
                        type="text"
                        className={INPUT_CLASS}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Team"
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

                <div className="flex gap-3 mt-2">
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Create distribution list
                    </Button>
                    <a href="/admin/distribution-lists">
                        <Button type="button" variant="secondary" className="!w-auto">
                            Cancel
                        </Button>
                    </a>
                </div>
            </form>
        </div>
    );
}
