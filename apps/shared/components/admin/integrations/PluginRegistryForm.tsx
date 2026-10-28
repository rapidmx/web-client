///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useRef } from "react";
import {
    IntegrationPluginNamespace,
    IntegrationSettings,
    IntegrationSource,
    isSecretMask,
    isUnreadableSecret,
    SecretMask,
} from "../../../../../lib/admin/integrationsApi.js";
import Button from "../../../../../lib/components/buttons/Button.js";
import IntegrationSectionForm, { secretSectionField, SectionField, SectionForm } from "./IntegrationSectionForm.js";
import SecretField, { INPUT_CLASS } from "./SecretField.js";

/** One namespace in the form. Its token is write-only: `saved` says whether one is saved and where, `token` is a new one typed. */
interface NamespaceDraft {
    /** Stable for the row's life, so its fields keep their state when another row is removed. */
    id: string;
    name: string;
    registry: string;
    /** The scope its saved token is saved under (as loaded): the server keeps a token by scope, so a renamed namespace has none. */
    savedName?: string;
    saved: "none" | "here" | "deployment";
    /** The saved token is one the server can't decrypt. */
    unreadable?: boolean;
    token?: string;
}

/** `name` as the server takes a scope (restapi `normalizePluginNamespaces()`): trimmed, with its `@`. */
function scopeOf(name: string): string {
    const scope: string = name.trim();
    return scope.startsWith("@") ? scope : `@${scope}`;
}

/** Where `draft`'s saved token is saved: none once the namespace is renamed, since the server keeps a token only under the scope it was saved for. */
function savedToken(draft: NamespaceDraft): NamespaceDraft["saved"] {
    return draft.saved !== "none" && draft.savedName !== undefined && scopeOf(draft.name) === scopeOf(draft.savedName) ? draft.saved : "none";
}

/** `drafts` as the server takes them: a token typed is sent, a saved one as the mask (kept) when `keep` says so, none left out. */
function namespacesOf(drafts: NamespaceDraft[], keep: (saved: NamespaceDraft["saved"]) => boolean): IntegrationPluginNamespace[] {
    return drafts.map((draft) => {
        const registry: string = draft.registry.trim();
        const token: string | SecretMask | undefined = draft.token ?? (keep(savedToken(draft)) ? { secret: true } : undefined);
        return { name: draft.name.trim(), ...(registry ? { registry } : {}), ...(token ? { token } : {}) };
    });
}

/** Whether two registry URLs are the same registry, credentials in them aside (restapi `sameRegistryUrl()`): a token goes only to its own registry. */
function sameRegistryUrl(a: string, b: string): boolean {
    const href = (value: string): string | undefined => {
        try {
            const url: URL = new URL(value.trim());
            url.username = "";
            url.password = "";
            return url.href;
        } catch {
            return undefined;
        }
    };
    const left: string | undefined = href(a);
    return left !== undefined && left === href(b);
}

const FIELDS: Record<string, SectionField> = {
    url: { name: "registry URL", describe: (url: string) => url },
    token: secretSectionField("registry token"),
    namespaces: {
        name: "plugin namespaces",
        describe: (namespaces: IntegrationPluginNamespace[]) => namespaces.map((namespace) => namespace.name).join(", ") || "none",
        toForm: (namespaces: IntegrationPluginNamespace[], source: IntegrationSource): NamespaceDraft[] =>
            namespaces.map((namespace, index) => ({
                id: `ns-${index}`,
                name: namespace.name,
                registry: namespace.registry ?? "",
                savedName: namespace.name,
                saved: !isSecretMask(namespace.token) ? "none" : source === "admin" ? "here" : "deployment",
                unreadable: source === "admin" && isUnreadableSecret(namespace.token),
            })),
        // Compared as the server shows the list: a saved token as the mask, wherever it is saved.
        toWire: (drafts: NamespaceDraft[]) => namespacesOf(drafts, (saved) => saved !== "none"),
        // Only a token saved here can be kept; the deployment's stay with the deployment's list.
        toSend: (drafts: NamespaceDraft[]) => namespacesOf(drafts, (saved) => saved === "here"),
        // A token saved here shows as the same mask as the deployment's but isn't it: a list keeping one is saved, never reset (which deletes it).
        canBeDeployment: (drafts: NamespaceDraft[]) => drafts.every((draft) => draft.token !== undefined || savedToken(draft) !== "here"),
    },
};

/** The plugin namespaces: each a scope, optionally its own registry, and a write-only token. */
function NamespacesEditor({ form }: { form: SectionForm }) {
    const nextId = useRef(0);
    const drafts: NamespaceDraft[] = form.value("namespaces");
    const change = (next: NamespaceDraft[]) => form.set("namespaces", next);
    const update = (id: string, patch: Partial<NamespaceDraft>) => change(drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));

    return (
        <div className="flex flex-col gap-2 text-sm">
            <span className="font-semibold">Plugin namespaces</span>
            <span className="text-xs text-text-muted">The npm scopes the plugin catalog searches. Plugins in them may be installed.</span>
            {drafts.length === 0 && <p className="text-xs text-text-muted">No namespaces: the plugin catalog searches none.</p>}
            {drafts.map((draft, index) => {
                const n = index + 1;
                return (
                    <fieldset key={draft.id} className="border border-border rounded-sm p-3 flex flex-col gap-2">
                        <legend className="sr-only">Namespace {n}</legend>
                        <input
                            aria-label={`Scope of namespace ${n}`}
                            className={INPUT_CLASS}
                            placeholder="@acme"
                            value={draft.name}
                            onChange={(e) => update(draft.id, { name: e.target.value })}
                        />
                        <input
                            aria-label={`Registry of namespace ${n}`}
                            type="url"
                            className={INPUT_CLASS}
                            placeholder="Its own registry, if not the one above (https://...)"
                            value={draft.registry}
                            onChange={(e) => update(draft.id, { registry: e.target.value })}
                        />
                        <SecretField
                            id={`namespace-token-${draft.id}`}
                            label={`Token of namespace ${n}`}
                            name={`token of namespace ${n}`}
                            saved={savedToken(draft)}
                            unreadable={draft.unreadable && savedToken(draft) === "here"}
                            value={draft.token}
                            onChange={(token) => update(draft.id, { token })}
                        />
                        {draft.saved !== "none" && savedToken(draft) === "none" && (
                            <span className="text-xs text-text-muted">
                                The token saved for {draft.savedName} doesn&rsquo;t follow a new scope: enter it again, or leave it empty for none.
                            </span>
                        )}
                        <Button
                            type="button"
                            variant="text"
                            className="!w-auto self-start text-xs"
                            aria-label={`Remove namespace ${n}`}
                            onClick={() => change(drafts.filter((other) => other.id !== draft.id))}
                        >
                            Remove
                        </Button>
                    </fieldset>
                );
            })}
            <Button
                type="button"
                variant="secondary"
                className="!w-auto self-start"
                onClick={() => change([...drafts, { id: `new-${nextId.current++}`, name: "", registry: "", saved: "none" }])}
            >
                Add namespace
            </Button>
        </div>
    );
}

/** The plugin registry section: where plugins are found and installed from, its token, and the namespaces searched. */
export default function PluginRegistryForm({ settings, onChange }: { settings: IntegrationSettings; onChange: (settings: IntegrationSettings) => void }) {
    const view = settings.pluginRegistry;
    // The deployment's registry token, and its namespaces' tokens for its registry, are only ever sent to its registry (restapi
    // `buildIntegrationsConfigLayer()`): with another URL in the form, saved or about to be, none of them is used.
    const deploymentRegistryTokens: boolean =
        isSecretMask(view.defaults.token) || view.defaults.namespaces.some((namespace) => !namespace.registry && isSecretMask(namespace.token));
    /** Whether the form's registry gets none of those tokens and none of its own is set or typed. */
    const noTokenUsed = (form: SectionForm): boolean =>
        deploymentRegistryTokens &&
        form.secret("token") !== "here" &&
        form.value("token") === undefined &&
        !sameRegistryUrl(form.value("url"), view.defaults.url);
    const deploymentTokens: boolean = view.source.namespaces === "deployment" && view.values.namespaces.some((namespace) => isSecretMask(namespace.token));
    return (
        <IntegrationSectionForm
            section="pluginRegistry"
            title="Plugin registry"
            description="The npm registry plugins are found and installed from."
            consequence="A change affects the next plugin install or update only; installed plugins are not touched."
            fields={FIELDS}
            settings={settings}
            onChange={onChange}
        >
            {(form) => (
                <>
                    <label className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">Registry URL</span>
                        <input
                            aria-label="Registry URL"
                            type="url"
                            className={INPUT_CLASS}
                            value={form.value("url")}
                            onChange={(e) => form.set("url", e.target.value)}
                        />
                    </label>
                    {form.footer("url")}
                    <div className="flex flex-col gap-1.5 text-sm">
                        <span className="font-semibold">Registry token</span>
                        <SecretField
                            id="plugin-registry-token"
                            label="Registry token"
                            name="registry token"
                            saved={form.secret("token")}
                            unreadable={form.unreadable("token")}
                            value={form.value("token")}
                            onChange={(value) => form.set("token", value)}
                        />
                        {noTokenUsed(form) && (
                            <span className="text-xs text-text-muted">
                                The deployment&rsquo;s tokens for its registry are only sent to the deployment&rsquo;s registry, so none is used with this one
                                unless it is set here.
                            </span>
                        )}
                    </div>
                    {form.footer("token")}
                    <NamespacesEditor form={form} />
                    {deploymentTokens && (
                        <p className="text-xs text-text-muted">
                            These are the deployment&rsquo;s namespaces. A changed list saved here replaces them, and the tokens the deployment sets for them
                            aren&rsquo;t copied: enter them again.
                        </p>
                    )}
                    {form.footer("namespaces")}
                </>
            )}
        </IntegrationSectionForm>
    );
}
