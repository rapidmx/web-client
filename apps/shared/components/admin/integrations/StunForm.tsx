///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { IntegrationSettings } from "../../../../../lib/admin/integrationsApi.js";
import IntegrationSectionForm, { SectionField } from "./IntegrationSectionForm.js";
import { INPUT_CLASS } from "./SecretField.js";

/** The lines of `text` that hold something, trimmed. */
export function lines(text: string): string[] {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
}

const FIELDS: Record<string, SectionField> = {
    urls: {
        name: "STUN servers",
        describe: (urls: string[] | null) => (urls ? urls.join(", ") : "the meet plugin's built-in list"),
        toForm: (urls: string[] | null) => (urls ?? []).join("\n"),
        // An emptied box is no list (the server refuses an empty one): the deployment's value.
        toWire: (text: string) => {
            const urls: string[] = lines(text);
            return urls.length > 0 ? urls : null;
        },
    },
};

/** The STUN section: the servers video meetings use to find a way between participants' networks. */
export default function StunForm({ settings, onChange }: { settings: IntegrationSettings; onChange: (settings: IntegrationSettings) => void }) {
    return (
        <IntegrationSectionForm
            section="stun"
            title="STUN servers"
            description={<>The STUN servers video meetings hand to participants&rsquo; browsers. TURN servers stay in the Meet plugin&rsquo;s settings.</>}
            consequence="Meetings started after saving use the new list."
            fields={FIELDS}
            settings={settings}
            onChange={onChange}
        >
            {(form) => (
                <>
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">STUN servers</span>
                        <textarea
                            aria-label="STUN servers"
                            rows={4}
                            spellCheck={false}
                            className={`${INPUT_CLASS} font-mono`}
                            placeholder="stun:stun.example.com:3478"
                            value={form.value("urls")}
                            onChange={(e) => form.set("urls", e.target.value)}
                        />
                        <span className="text-xs text-text-muted">One per line, 1 to 10 of them, each a stun: or stuns: address.</span>
                    </label>
                    {form.footer("urls")}
                </>
            )}
        </IntegrationSectionForm>
    );
}
