///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { useRouter } from "@rapidrest/react/client";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { createDomain, Domain, listDomains } from "@rapidmx/react-shared/admin/domainsApi.js";
import AdminShell, { AdminShellProps } from "../../../shared/components/admin/layout/AdminShell.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export default function NewDomainPage(props: Omit<AdminShellProps, "active">) {
    return (
        <AdminShell {...props} active="domains">
            <NewDomainForm />
        </AdminShell>
    );
}

function NewDomainForm() {
    const { navigate } = useRouter();
    const [name, setName] = useState("");
    const [aliasOf, setAliasOf] = useState("");
    // Only an existing, non-alias domain can be aliased (no chains) - see `Domain.aliasOf`'s own doc comment
    // on the `@rapidmx/restapi` side.
    const [primaryDomains, setPrimaryDomains] = useState<Domain[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        listDomains({ limit: 200 })
            .then((domains) => setPrimaryDomains(domains.filter((d) => !d.aliasOf)))
            .catch(() => setPrimaryDomains([]));
    }, []);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);

        if (!name.trim()) {
            setError("A domain name is required.");
            return;
        }

        setSaving(true);
        try {
            const domain = await createDomain({ name: name.trim(), aliasOf: aliasOf || undefined });
            void navigate(`/admin/domains/${encodeURIComponent(domain.uid)}`);
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create the domain.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="max-w-xl">
            <h1 className="text-xl font-bold uppercase tracking-wide mb-1">New domain</h1>
            <p className="text-sm text-text-muted mb-5">
                A new domain starts unverified. Once created, its detail page shows the DNS TXT record to publish
                to prove ownership before mail can be accepted on it.
            </p>

            {error && <Alert>{error}</Alert>}

            <form onSubmit={handleSubmit} className="bg-surface border border-border rounded-md p-6">
                <FormField label="Domain name" htmlFor="name">
                    <input
                        id="name"
                        type="text"
                        className={INPUT_CLASS}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="example.com"
                    />
                </FormField>

                <FormField label="Alias of" htmlFor="aliasOf">
                    <select id="aliasOf" className={INPUT_CLASS} value={aliasOf} onChange={(e) => setAliasOf(e.target.value)}>
                        <option value="">None - a regular domain with mailboxes of its own</option>
                        {primaryDomains.map((domain) => (
                            <option key={domain.uid} value={domain.name}>
                                {domain.name}
                            </option>
                        ))}
                    </select>
                    <p className="text-xs text-text-muted mt-1.5">
                        A pure alias receives (and may send as) mail for the same addresses as the domain it aliases, but
                        has no mailboxes of its own - it still needs its own DNS setup below.
                    </p>
                </FormField>

                <div className="flex gap-3 mt-2">
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Create domain
                    </Button>
                    <a href="/admin/domains">
                        <Button type="button" variant="secondary" className="!w-auto">
                            Cancel
                        </Button>
                    </a>
                </div>
            </form>
        </div>
    );
}
