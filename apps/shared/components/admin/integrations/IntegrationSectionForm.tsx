///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, ReactNode, useState } from "react";
import {
    IntegrationSectionName,
    IntegrationSectionView,
    IntegrationSettings,
    IntegrationSource,
    getIntegrations,
    isSecretMask,
    isUnreadableSecret,
    updateIntegrationSection,
} from "../../../../../lib/admin/integrationsApi.js";
import Button from "../../../../../lib/components/buttons/Button.js";
import { ApiRequestError } from "../../../../../lib/util/api.js";
import Alert from "../ActionAlert.js";
import { actionErrorMessage } from "../elevation.js";

/** A field put back to the deployment's value, pending the form's Save. */
const RESET: unique symbol = Symbol("reset");

/** How a section's form treats one of its fields. */
export interface SectionField {
    /** How the field's reset button names it ("Reset API key to the deployment default"). */
    name: string;
    /** The deployment's value, in words, for the line beneath the field. */
    describe: (value: any) => string;
    /** The form's value for a value of the view, saved here (`admin`) or the deployment's (the value itself when left out). */
    toForm?: (value: any, source: IntegrationSource) => unknown;
    /** The form's value as the server shows it, to compare with the saved and the deployment's values (the value itself when left out). */
    toWire?: (formValue: any) => unknown;
    /** What saving sends for the form's value, when it differs from `toWire()`'s. */
    toSend?: (formValue: any) => unknown;
    /** False when the form's value isn't the deployment's though `toWire()` shows it the same: a secret saved here masked like the deployment's.
     * Such a value is never taken as edited back to the deployment's (reset), which would drop the secret saved here. */
    canBeDeployment?: (formValue: any) => boolean;
}

/** A secret field: no value in the form (it is write-only, `SecretField`), "set" or "none" for the deployment's. */
export function secretSectionField(name: string): SectionField {
    return { name, describe: (value) => (isSecretMask(value) ? "set" : "none"), toForm: () => undefined };
}

/** What a section form's fields are drawn with. */
export interface SectionForm {
    /** The field's value in the form. */
    value(field: string): any;
    /** Changes the field; `undefined` takes back any change. */
    set(field: string, value: unknown): void;
    /** What is saved for a secret field now: nothing, a value saved here, or the deployment's. A pending reset shows the deployment's. */
    secret(field: string): "none" | "here" | "deployment";
    /** Whether the secret saved here for the field is one the server can't decrypt, so that it must be entered again. */
    unreadable(field: string): boolean;
    /** Whether the form holds a value of the administrator's for the field, rather than the deployment's. */
    setHere(field: string): boolean;
    /** The line beneath a field: the deployment's value and, for a field set here, the button that puts it back. */
    footer(field: string): ReactNode;
}

/** Whether two values are the same once sent (`undefined` counting as `null`, and a secret's `unreadable` flag, which is only the server's remark, not
 * counting at all). */
function same(a: unknown, b: unknown): boolean {
    const plain = (value: unknown): string => JSON.stringify(value ?? null, (key, inner) => (key === "unreadable" ? undefined : inner));
    return plain(a) === plain(b);
}

export interface IntegrationSectionFormProps {
    section: IntegrationSectionName;
    title: string;
    description: ReactNode;
    /** What a change affects, stated above the Save button. */
    consequence?: ReactNode;
    fields: Record<string, SectionField>;
    settings: IntegrationSettings;
    onChange: (settings: IntegrationSettings) => void;
    children: (form: SectionForm) => ReactNode;
}

/**
 * One Integrations section's form, following the policy pages: each field shows the deployment's value beneath it and, while the form holds a value
 * saved here, a "Reset to deployment default" that puts the field back in the form only - Save sends it, with the rest, as `null`. A field is never
 * saved as a copy of the deployment's value (it would stop following the deployment's configuration): edited back to it, it is reset too. Only what
 * changes is sent, with the version the settings were read at, so a change made over someone else's is refused rather than overwriting it. A save
 * the server refuses for want of a recently confirmed identity offers to confirm it again (`ActionAlert`).
 */
export default function IntegrationSectionForm({
    section,
    title,
    description,
    consequence,
    fields,
    settings,
    onChange,
    children,
}: IntegrationSectionFormProps) {
    const view = settings[section] as IntegrationSectionView<any>;
    const [edits, setEdits] = useState<Record<string, unknown>>({});
    // Bumped by a save, so the fields start over (a credential being replaced is shown as saved again).
    const [formKey, setFormKey] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const toForm = (field: string, value: unknown, source: IntegrationSource): unknown => (fields[field].toForm ? fields[field].toForm(value, source) : value);
    /** The field's change as the server would show it, the deployment's value for a reset. */
    const wire = (field: string, edit: unknown): unknown => (edit === RESET ? view.defaults[field] : fields[field].toWire ? fields[field].toWire(edit) : edit);
    /** Whether the field's change puts it back to the deployment's value: a reset, a value left empty (`null`, which the server takes as unset), or the
     * deployment's own. */
    const isDeployment = (field: string, edit: unknown): boolean =>
        edit === RESET ||
        wire(field, edit) === null ||
        (same(wire(field, edit), view.defaults[field]) && (fields[field].canBeDeployment?.(edit) ?? true));

    const form: SectionForm = {
        value: (field) =>
            field in edits
                ? edits[field] === RESET
                    ? toForm(field, view.defaults[field], "deployment")
                    : edits[field]
                : toForm(field, view.values[field], view.source[field]),
        set: (field, value) =>
            setEdits((current) => {
                const next = { ...current };
                if (value === undefined) {
                    delete next[field];
                } else {
                    next[field] = value;
                }
                return next;
            }),
        secret: (field) => {
            const reset = edits[field] === RESET;
            const shown = reset ? view.defaults[field] : view.values[field];
            const source: IntegrationSource = reset ? "deployment" : view.source[field];
            return !isSecretMask(shown) ? "none" : source === "admin" ? "here" : "deployment";
        },
        unreadable: (field) => edits[field] !== RESET && view.source[field] === "admin" && isUnreadableSecret(view.values[field]),
        setHere: (field) =>
            field in edits
                ? !isDeployment(field, edits[field])
                : // A registry elsewhere than the deployment's shows its token as none set here (restapi's view): nothing to reset.
                  view.source[field] === "admin" && view.values[field] !== null,
        footer: (field) => (
            <div className="flex flex-wrap items-center gap-x-3 text-xs text-text-muted -mt-1">
                <span>Deployment default: {fields[field].describe(view.defaults[field])}</span>
                {form.setHere(field) && (
                    <Button
                        type="button"
                        variant="text"
                        className="text-xs"
                        aria-label={`Reset ${fields[field].name} to the deployment default`}
                        onClick={() => form.set(field, RESET)}
                    >
                        Reset to deployment default
                    </Button>
                )}
            </div>
        ),
    };

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        setSaved(false);
        const patch: Record<string, unknown> = {};
        for (const [field, edit] of Object.entries(edits)) {
            const value: unknown = wire(field, edit);
            const admin: boolean = view.source[field] === "admin";
            if (isDeployment(field, edit)) {
                // Back to the deployment's value: nothing to send unless one is saved here.
                if (admin) {
                    patch[field] = null;
                }
            } else if (!admin || !same(value, view.values[field])) {
                patch[field] = fields[field].toSend ? fields[field].toSend(edit) : value;
            }
        }
        if (Object.keys(patch).length === 0) {
            setEdits({});
            setSaved(true);
            return;
        }
        setSaving(true);
        try {
            onChange(await updateIntegrationSection(section, { ...patch, version: settings.version }));
            setEdits({});
            setFormKey((key) => key + 1);
            setSaved(true);
        } catch (err) {
            setError(await refusalMessage(err));
        } finally {
            setSaving(false);
        }
    }

    /** What a failed save says. A change refused for a newer version loads the settings again (keeping the entries, which are compared with them when
     * saving), so that the next Save is made against the version now saved rather than failing the same way until the page is reloaded. */
    async function refusalMessage(err: unknown): Promise<string> {
        if (err instanceof ApiRequestError && err.status === 409) {
            try {
                const latest: IntegrationSettings = await getIntegrations();
                if (latest.version !== settings.version) {
                    onChange(latest);
                    return "The integration settings were changed by someone else. They are shown as saved now, with your entries kept: check them and save again.";
                }
            } catch {
                // Not loaded: the server's own message stands.
            }
        }
        return actionErrorMessage(err, `Could not save the ${title} settings.`);
    }

    return (
        <div className="max-w-xl">
            <h2 className="text-lg font-bold uppercase tracking-wide mb-1">{title}</h2>
            <div className="text-sm text-text-muted mb-5">{description}</div>

            {error && <Alert>{error}</Alert>}
            {saved && !error && <div className="mb-4 text-sm text-success font-medium">Saved.</div>}

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <React.Fragment key={formKey}>{children(form)}</React.Fragment>
                {consequence && <p className="text-xs text-text-muted">{consequence}</p>}
                <div>
                    <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                        Save
                    </Button>
                </div>
            </form>
        </div>
    );
}
