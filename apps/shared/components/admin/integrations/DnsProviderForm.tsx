///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useState } from "react";
import { isUnreadableSecret } from "../../../../../lib/admin/integrationsApi.js";
import type {
    DnsProvider,
    DnsProviderInput,
    DnsProviderOptionSpec,
    DnsProviderOptionValue,
    DnsProviderType,
    DnsProviderTypeInfo,
} from "../../../../../lib/admin/dnsProvidersApi.js";
import Button from "../../../../../lib/components/buttons/Button.js";
import Alert from "../ActionAlert.js";
import { actionErrorMessage } from "../elevation.js";
import { Badge } from "./dnsProviderParts.js";
import SecretField, { INPUT_CLASS } from "./SecretField.js";

/** The entries of a list typed one per line (commas and spaces separate them too). */
function listOf(text: string): string[] {
    return text.split(/[\s,]+/).filter((entry) => entry !== "");
}

/** An option's value as the form holds it: a switch, or text (a list one entry per line). */
function toFormValue(option: DnsProviderOptionSpec, value: DnsProviderOptionValue | undefined): string | boolean {
    if (option.kind === "boolean") {
        return value === true;
    }
    return Array.isArray(value) ? value.join("\n") : value === undefined ? "" : String(value);
}

/** An option's value as the server takes it; `undefined` for one left empty, which the server fills with its default or refuses as required. */
function fromFormValue(option: DnsProviderOptionSpec, value: string | boolean): DnsProviderOptionValue | undefined {
    if (typeof value === "boolean") {
        return value;
    }
    if (option.kind === "string-list") {
        const list: string[] = listOf(value);
        return list.length > 0 ? list : undefined;
    }
    const text: string = value.trim();
    if (text === "") {
        return undefined;
    }
    return option.kind === "integer" ? Number(text) : text;
}

/** The form's values of `spec`'s options: `provider`'s, else each option's default. */
function initialOptions(spec: DnsProviderTypeInfo, provider?: DnsProvider): Record<string, string | boolean> {
    return Object.fromEntries(spec.options.map((option) => [option.key, toFormValue(option, provider?.options[option.key] ?? option.default)]));
}

export interface DnsProviderFormProps {
    /** The provider types, from `GET /system/dns-providers/types`: what the form is built from. */
    types: DnsProviderTypeInfo[];
    /** The config being edited; none to create one (then the type is chosen here; it never changes afterwards). */
    provider?: DnsProvider;
    submitLabel: string;
    /** Saves what the form holds; a rejection is shown (the server's validation is the authority). */
    onSave: (input: DnsProviderInput) => Promise<void>;
}

/**
 * A DNS provider config's form, generated from its type's description: one field per option (text, a list one entry per line, a number, a switch or a
 * choice), and the type's credentials, write-only - a saved one shows only as set, with Replace, and Remove where the type can do without it. Only what
 * is typed into a credential is sent; the rest of the config is sent whole.
 */
export default function DnsProviderForm({ types, provider, submitLabel, onSave }: DnsProviderFormProps) {
    const [type, setType] = useState<DnsProviderType>(provider?.type ?? types[0].type);
    const spec: DnsProviderTypeInfo = types.find((candidate) => candidate.type === type)!;
    const [name, setName] = useState(provider?.name ?? "");
    const [zones, setZones] = useState((provider?.zones ?? []).join("\n"));
    const [options, setOptions] = useState(() => initialOptions(spec, provider));
    // A new value typed (string), or `null` for a saved credential to remove; a field left alone has no entry.
    const [credentials, setCredentials] = useState<Record<string, string | null>>({});
    const [enabled, setEnabled] = useState(provider?.enabled ?? true);
    const [allowTakeover, setAllowTakeover] = useState(provider?.allowTakeover ?? false);
    // Bumped by a save, so the credentials start over as saved.
    const [savedCount, setSavedCount] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    function changeType(next: DnsProviderType) {
        setType(next);
        setOptions(initialOptions(types.find((candidate) => candidate.type === next)!));
        setCredentials({});
    }

    function setCredential(key: string, value: string | null | undefined) {
        setCredentials((current) => {
            const next = { ...current };
            if (value === undefined) {
                delete next[key];
            } else {
                next[key] = value;
            }
            return next;
        });
    }

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setSaved(false);
        const trimmedName: string = name.trim();
        if (!trimmedName) {
            setError("A name is required.");
            return;
        }
        const zoneList: string[] = listOf(zones);
        if (zoneList.length === 0) {
            setError("Enter at least one zone.");
            return;
        }
        const values: Record<string, DnsProviderOptionValue> = {};
        for (const option of spec.options) {
            const value = fromFormValue(option, options[option.key]);
            if (value !== undefined) {
                values[option.key] = value;
            }
        }
        const input: DnsProviderInput = {
            name: trimmedName,
            ...(provider ? {} : { type }),
            zones: zoneList,
            options: values,
            ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
            enabled,
            allowTakeover,
        };
        setSaving(true);
        try {
            await onSave(input);
            setCredentials({});
            setSavedCount((count) => count + 1);
            setSaved(true);
        } catch (err) {
            setError(actionErrorMessage(err, "Could not save the DNS provider."));
        } finally {
            setSaving(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-xl">
            {error && <Alert>{error}</Alert>}
            {saved && !error && <div className="text-sm text-success font-medium">Saved.</div>}

            {!provider && (
                <label className="flex flex-col gap-1.5 text-sm">
                    <span className="font-semibold">
                        Type
                        {!spec.tested && <Badge>Not yet live-tested</Badge>}
                    </span>
                    <select aria-label="Type" className={INPUT_CLASS} value={type} onChange={(e) => changeType(e.target.value as DnsProviderType)}>
                        {types.map((candidate) => (
                            <option key={candidate.type} value={candidate.type}>
                                {candidate.label}
                            </option>
                        ))}
                    </select>
                </label>
            )}
            {spec.notes.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-text-muted">
                    {spec.notes.map((note) => (
                        <li key={note}>{note}</li>
                    ))}
                </ul>
            )}

            <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-semibold">Name</span>
                <input aria-label="Name" className={INPUT_CLASS} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-semibold">Zones</span>
                <textarea aria-label="Zones" rows={3} spellCheck={false} className={INPUT_CLASS} value={zones} onChange={(e) => setZones(e.target.value)} />
                <span className="text-xs text-text-muted">
                    The zones this provider may publish into, one per line, such as example.com. A domain can be assigned to it only when it is one of them or
                    under one.
                </span>
            </label>

            {spec.options.map((option) => (
                <OptionField
                    key={`${type}-${option.key}`}
                    option={option}
                    value={options[option.key]}
                    onChange={(value) => setOptions({ ...options, [option.key]: value })}
                />
            ))}

            <fieldset key={savedCount} className="flex flex-col gap-3">
                <legend className="text-sm font-semibold mb-1">Credentials</legend>
                <p className="text-xs text-text-muted -mt-2">Saved encrypted, and never shown again.</p>
                {spec.secretFields.map((field) => {
                    const isSaved: boolean = !!provider?.credentials[field.key];
                    const removing: boolean = credentials[field.key] === null;
                    return (
                        <div key={`${type}-${field.key}`} className="flex flex-col gap-1.5 text-sm">
                            <span className="font-semibold">
                                {field.label}
                                {!field.required && <span className="font-normal text-text-muted"> (optional)</span>}
                            </span>
                            {removing ? (
                                <div className="flex items-center gap-3">
                                    <span>Removed when you save.</span>
                                    <Button
                                        type="button"
                                        variant="text"
                                        className="text-xs"
                                        aria-label={`Undo removing ${field.label}`}
                                        onClick={() => setCredential(field.key, undefined)}
                                    >
                                        Undo
                                    </Button>
                                </div>
                            ) : (
                                <SecretField
                                    id={`credential-${field.key}`}
                                    label={field.label}
                                    name={field.label}
                                    saved={isSaved ? "here" : "none"}
                                    unreadable={isUnreadableSecret(provider?.credentials[field.key])}
                                    value={credentials[field.key] ?? undefined}
                                    onChange={(value) => setCredential(field.key, value)}
                                    multiLine={field.multiLine}
                                />
                            )}
                            {isSaved && !field.required && !removing && (
                                <Button
                                    type="button"
                                    variant="text"
                                    className="!w-auto self-start text-xs"
                                    aria-label={`Remove ${field.label}`}
                                    onClick={() => setCredential(field.key, null)}
                                >
                                    Remove
                                </Button>
                            )}
                            <span className="text-xs text-text-muted">{field.description}</span>
                        </div>
                    );
                })}
            </fieldset>

            <label className="flex items-start gap-2 text-sm">
                <input
                    type="checkbox"
                    className="mt-1"
                    aria-label="Publish through this provider"
                    checked={enabled}
                    onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>
                    <span className="font-semibold block">Publish through this provider</span>
                    <span className="text-xs text-text-muted">Off, its external-dns instance is stopped; the records it published stay as they are.</span>
                </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
                <input
                    type="checkbox"
                    className="mt-1"
                    aria-label="Allow taking over existing records"
                    checked={allowTakeover}
                    onChange={(e) => setAllowTakeover(e.target.checked)}
                />
                <span>
                    <span className="font-semibold block">Allow taking over existing records</span>
                    <span className="text-xs text-text-muted">
                        Lets this provider replace records that something else created at the names it publishes, such as an MX record added by hand. Without
                        it, such records show as conflicts, with a Take over action on their domain. A domain&rsquo;s root TXT records (SPF) are never taken
                        over this way.
                    </span>
                </span>
            </label>

            <div>
                <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                    {submitLabel}
                </Button>
            </div>
        </form>
    );
}

/** One option of the provider type, drawn by its kind. */
function OptionField({ option, value, onChange }: { option: DnsProviderOptionSpec; value: string | boolean; onChange: (value: string | boolean) => void }) {
    const hint = <span className="text-xs text-text-muted">{option.description}</span>;
    if (option.kind === "boolean") {
        return (
            <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" aria-label={option.label} checked={value as boolean} onChange={(e) => onChange(e.target.checked)} />
                <span>
                    <span className="font-semibold block">{option.label}</span>
                    {hint}
                </span>
            </label>
        );
    }
    let control: React.ReactNode;
    if (option.kind === "enum") {
        control = (
            <select aria-label={option.label} className={INPUT_CLASS} value={value as string} onChange={(e) => onChange(e.target.value)}>
                {option.default === undefined && <option value="">Not set</option>}
                {option.values!.map((choice) => (
                    <option key={choice} value={choice}>
                        {choice}
                    </option>
                ))}
            </select>
        );
    } else if (option.kind === "string-list") {
        control = (
            <textarea
                aria-label={option.label}
                rows={3}
                spellCheck={false}
                className={`${INPUT_CLASS} font-mono`}
                value={value as string}
                onChange={(e) => onChange(e.target.value)}
            />
        );
    } else {
        control = (
            <input
                aria-label={option.label}
                type={option.kind === "integer" ? "number" : "text"}
                min={option.min}
                max={option.max}
                className={INPUT_CLASS}
                value={value as string}
                onChange={(e) => onChange(e.target.value)}
            />
        );
    }
    return (
        <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-semibold">
                {option.label}
                {!option.required && <span className="font-normal text-text-muted"> (optional)</span>}
            </span>
            {control}
            {hint}
            {option.kind === "string-list" && <span className="text-xs text-text-muted">One per line.</span>}
        </label>
    );
}
