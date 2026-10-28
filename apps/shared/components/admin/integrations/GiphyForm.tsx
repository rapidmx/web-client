///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { IntegrationSettings } from "../../../../../lib/admin/integrationsApi.js";
import IntegrationSectionForm, { secretSectionField, SectionField } from "./IntegrationSectionForm.js";
import SecretField from "./SecretField.js";

const FIELDS: Record<string, SectionField> = {
    enabled: { name: "GIF search", describe: (value) => (value ? "on" : "off") },
    apiKey: secretSectionField("API key"),
};

/** The Giphy section: whether GIF search is offered, and the API key it uses. */
export default function GiphyForm({ settings, onChange }: { settings: IntegrationSettings; onChange: (settings: IntegrationSettings) => void }) {
    return (
        <IntegrationSectionForm
            section="giphy"
            title="Giphy"
            description="GIF search in the message editor, through Giphy's API."
            fields={FIELDS}
            settings={settings}
            onChange={onChange}
        >
            {(form) => (
                <>
                    <label className="flex items-start gap-2 text-sm">
                        <input
                            type="checkbox"
                            className="mt-1"
                            aria-label="Use Giphy for GIF search"
                            checked={form.value("enabled")}
                            onChange={(e) => form.set("enabled", e.target.checked)}
                        />
                        <span>
                            <span className="font-semibold block">Use Giphy for GIF search</span>
                            <span className="text-xs text-text-muted">Off, the editor offers no GIF search and the key is not used.</span>
                        </span>
                    </label>
                    {form.footer("enabled")}
                    <div className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">API key</span>
                        <SecretField
                            id="giphy-api-key"
                            label="API key"
                            name="API key"
                            saved={form.secret("apiKey")}
                            unreadable={form.unreadable("apiKey")}
                            value={form.value("apiKey")}
                            onChange={(value) => form.set("apiKey", value)}
                        />
                    </div>
                    {form.footer("apiKey")}
                </>
            )}
        </IntegrationSectionForm>
    );
}
