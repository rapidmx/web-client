///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { IntegrationSettings, SigningCaBackend } from "../../../../../lib/admin/integrationsApi.js";
import IntegrationSectionForm, { SectionField } from "./IntegrationSectionForm.js";
import { INPUT_CLASS } from "./SecretField.js";

const BACKENDS: Record<SigningCaBackend, string> = {
    rfc8823: "Automatically, from a public CA (RFC 8823)",
    manual: "Manually, by an administrator",
    none: "Not offered",
};

/** Text, "none" when unset. */
const describeText = (value: string | null): string => value ?? "none";

const FIELDS: Record<string, SectionField> = {
    backend: { name: "certificate issuing", describe: (backend: SigningCaBackend) => BACKENDS[backend] },
    directoryUrl: { name: "ACME directory URL", describe: describeText },
    contactEmail: {
        name: "contact email",
        describe: describeText,
        toForm: (value: string | null) => value ?? "",
        toWire: (text: string) => text.trim() || null,
    },
};

/** The S/MIME signing CA section: how people get the certificates that sign their mail. */
export default function SigningCaForm({ settings, onChange }: { settings: IntegrationSettings; onChange: (settings: IntegrationSettings) => void }) {
    const deploymentContact: string | null = settings.signingCa.defaults.contactEmail;
    return (
        <IntegrationSectionForm
            section="signingCa"
            title="S/MIME signing CA"
            description="How a signing certificate is issued when someone asks for one in their encryption settings."
            consequence="A change affects new enrollments only; certificates already being issued finish with the CA they started with."
            fields={FIELDS}
            settings={settings}
            onChange={onChange}
        >
            {(form) => (
                <>
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">How signing certificates are issued</span>
                        <select
                            aria-label="How signing certificates are issued"
                            className={INPUT_CLASS}
                            value={form.value("backend")}
                            onChange={(e) => form.set("backend", e.target.value)}
                        >
                            {Object.entries(BACKENDS).map(([backend, label]) => (
                                <option key={backend} value={backend}>
                                    {label}
                                </option>
                            ))}
                        </select>
                    </label>
                    {form.footer("backend")}
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">ACME directory URL</span>
                        <input
                            aria-label="ACME directory URL"
                            type="url"
                            className={INPUT_CLASS}
                            value={form.value("directoryUrl")}
                            onChange={(e) => form.set("directoryUrl", e.target.value)}
                        />
                        <span className="text-xs text-text-muted">
                            The CA's RFC 8823 ACME directory, https:// only. Used when certificates are issued automatically.
                        </span>
                    </label>
                    {form.footer("directoryUrl")}
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">Contact email</span>
                        <input
                            aria-label="Contact email"
                            type="email"
                            className={INPUT_CLASS}
                            value={form.value("contactEmail")}
                            onChange={(e) => form.set("contactEmail", e.target.value)}
                        />
                        <span className="text-xs text-text-muted">
                            Where the CA sends notices about this server's account.
                            {/* An address saved here can't be cleared to none: `null` is the deployment's value, and the server takes no empty one. */}
                            {deploymentContact && ` Left empty, the deployment's address (${deploymentContact}) is used.`}
                        </span>
                    </label>
                    {form.footer("contactEmail")}
                </>
            )}
        </IntegrationSectionForm>
    );
}
