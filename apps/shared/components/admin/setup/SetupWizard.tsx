///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { getRetentionPolicy } from "@rapidmx/react-shared/admin/retentionPolicyApi.js";
import { getMailboxPolicy } from "@rapidmx/react-shared/admin/mailboxPolicyApi.js";
import { createDomain, Domain, listDomains } from "@rapidmx/react-shared/admin/domainsApi.js";
import { completeSetup, getSetupStatus, saveSetupStep } from "@rapidmx/react-shared/admin/setupApi.js";
import { getBranding } from "@rapidmx/react-shared/branding/brandingApi.js";
import { EncryptionPolicy, getEncryptionPolicy } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { listMailboxes, Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import BrandingForm from "../settings/BrandingForm.js";
import DomainDnsSetup from "../settings/DomainDnsSetup.js";
import EncryptionPolicyForm, { isEncryptionEnabled } from "../settings/EncryptionPolicyForm.js";
import LoadedSettingsForm from "../settings/LoadedSettingsForm.js";
import MailboxCreateForm from "../settings/MailboxCreateForm.js";
import MailboxPolicyForm from "../settings/MailboxPolicyForm.js";
import PluginsManager from "../settings/PluginsManager.js";
import RetentionPolicyForm from "../settings/RetentionPolicyForm.js";
import EscrowSetupStep from "./EscrowSetupStep.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export const SETUP_STEPS = [
    { id: "plugins", title: "Plugins", intro: "Choose which protocols and features this server runs. The recommended plugins are already installed." },
    { id: "domain", title: "Domain", intro: "Add the domain this server receives mail for, then publish the DNS records below." },
    { id: "settings", title: "Server settings", intro: "Set the rules for encryption, how long mail is kept, and new mailboxes." },
    { id: "escrow", title: "Escrow", intro: "Decide whether encrypted mail can be recovered by a trusted group of holders." },
    { id: "branding", title: "Branding", intro: "Make the sign-in page and apps look like your organization." },
    { id: "mailboxes", title: "Mailboxes", intro: "Create the first mailboxes, starting with your own." },
] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number]["id"];

function isStepId(value: string | undefined): value is SetupStepId {
    return SETUP_STEPS.some((step) => step.id === value);
}

export interface SetupWizardProps {
    userUid: string;
}

/**
 * The first-run setup wizard. Each step saves as the administrator works through it; the wizard itself only records
 * which step they're on (so leaving and coming back resumes there) and, at the end, that setup is finished. Every step
 * except the domain can be passed over and configured later from the admin console.
 */
export default function SetupWizard({ userUid }: SetupWizardProps) {
    const [step, setStep] = useState<SetupStepId | null>(null);
    const [domains, setDomains] = useState<Domain[]>([]);
    const [encryption, setEncryption] = useState<EncryptionPolicy | null>(null);
    const [finishing, setFinishing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void Promise.all([getSetupStatus().catch(() => undefined), listDomains({ limit: 25 }).catch(() => [] as Domain[])]).then(([status, list]) => {
            setDomains(list);
            setStep(isStepId(status?.currentStep) ? status.currentStep : "plugins");
        });
    }, []);

    useEffect(() => {
        if (step === "escrow" || step === "settings") {
            getEncryptionPolicy()
                .then(setEncryption)
                .catch(() => setEncryption(null));
        }
    }, [step]);

    if (step === null) {
        return <p className="text-sm text-text-muted">Loading&hellip;</p>;
    }

    const index = SETUP_STEPS.findIndex((s) => s.id === step);
    const current = SETUP_STEPS[index];
    const last = index === SETUP_STEPS.length - 1;

    function goTo(next: SetupStepId) {
        setError(null);
        setStep(next);
        // Progress is a convenience for resuming - failing to record it shouldn't stop the administrator.
        void saveSetupStep(next).catch(() => undefined);
        window.scrollTo?.(0, 0);
    }

    async function finish() {
        setFinishing(true);
        setError(null);
        try {
            await completeSetup();
            window.location.href = "/admin";
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not finish setup.");
            setFinishing(false);
        }
    }

    const blocked = step === "domain" && domains.length === 0;

    return (
        <div className="flex flex-col gap-6">
            <div>
                <h1 className="text-xl font-bold uppercase tracking-wide mb-1">Set up your server</h1>
                <p className="text-sm text-text-muted">You can change any of these settings later from the admin console.</p>
            </div>

            <ol aria-label="Setup steps" className="flex flex-wrap gap-2">
                {SETUP_STEPS.map((s, i) => (
                    <li key={s.id}>
                        <button
                            type="button"
                            aria-current={s.id === step ? "step" : undefined}
                            // Steps after the domain need somewhere to put mail first.
                            disabled={i > 1 && domains.length === 0}
                            onClick={() => goTo(s.id)}
                            className={[
                                "text-sm py-1.5 px-3 rounded-pill border disabled:opacity-50",
                                s.id === step
                                    ? "bg-primary/10 border-primary text-primary-dark font-semibold"
                                    : i < index
                                      ? "border-border text-text"
                                      : "border-border text-text-muted",
                            ].join(" ")}
                        >
                            {i + 1}. {s.title}
                            {i < index && <span className="sr-only"> (done)</span>}
                        </button>
                    </li>
                ))}
            </ol>

            <section aria-labelledby="setup-step-title" className="flex flex-col gap-5">
                <div>
                    <h2 id="setup-step-title" className="text-lg font-bold">
                        Step {index + 1} of {SETUP_STEPS.length}: {current.title}
                    </h2>
                    <p className="text-sm text-text-muted">{current.intro}</p>
                </div>

                {step === "plugins" && <PluginsManager />}
                {step === "domain" && <DomainStep domains={domains} onCreated={(domain) => setDomains((prev) => [...prev, domain])} />}
                {step === "settings" && (
                    <div className="flex flex-col gap-10">
                        <LoadedSettingsForm load={getEncryptionPolicy} loadErrorMessage="Could not load the encryption policy.">
                            {(policy, onChange) => (
                                <EncryptionPolicyForm
                                    policy={policy}
                                    onChange={(updated) => {
                                        onChange(updated);
                                        setEncryption(updated);
                                    }}
                                />
                            )}
                        </LoadedSettingsForm>
                        <LoadedSettingsForm load={getRetentionPolicy} loadErrorMessage="Could not load the retention policy.">
                            {(policy, onChange) => <RetentionPolicyForm policy={policy} onChange={onChange} />}
                        </LoadedSettingsForm>
                        <LoadedSettingsForm load={getMailboxPolicy} loadErrorMessage="Could not load the mailbox policy.">
                            {(policy, onChange) => <MailboxPolicyForm policy={policy} onChange={onChange} />}
                        </LoadedSettingsForm>
                    </div>
                )}
                {step === "escrow" &&
                    (encryption && !isEncryptionEnabled(encryption) ? (
                        <p role="status" className="text-sm py-2 px-3 rounded-sm bg-surface-alt text-text">
                            End-to-end encryption is turned off, so escrow isn&rsquo;t needed. You can set it up later if you
                            turn encryption on.
                        </p>
                    ) : (
                        <EscrowSetupStep />
                    ))}
                {step === "branding" && (
                    <LoadedSettingsForm load={getBranding} loadErrorMessage="Could not load branding.">
                        {(branding, onChange) => <BrandingForm branding={branding} onChange={onChange} />}
                    </LoadedSettingsForm>
                )}
                {step === "mailboxes" && <MailboxesStep userUid={userUid} domain={domains.find((d) => d.verified)?.name ?? domains[0]?.name} />}
            </section>

            {error && <Alert>{error}</Alert>}

            <div className="flex items-center gap-3 border-t border-border pt-5">
                {index > 0 && (
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => goTo(SETUP_STEPS[index - 1].id)}>
                        Back
                    </Button>
                )}
                <div className="flex-1" />
                {blocked && <span className="text-sm text-text-muted">Add a domain to continue.</span>}
                {last ? (
                    <Button type="button" className="!w-auto" loading={finishing} disabled={finishing} onClick={() => void finish()}>
                        Finish setup
                    </Button>
                ) : (
                    <Button type="button" className="!w-auto" disabled={blocked} onClick={() => goTo(SETUP_STEPS[index + 1].id)}>
                        Continue
                    </Button>
                )}
            </div>
        </div>
    );
}

function DomainStep({ domains, onCreated }: { domains: Domain[]; onCreated: (domain: Domain) => void }) {
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError(null);
        if (!name.trim()) {
            setError("A domain name is required.");
            return;
        }
        setSaving(true);
        try {
            onCreated(await createDomain({ name: name.trim() }));
            setName("");
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not add the domain.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="flex flex-col gap-5 max-w-3xl">
            {domains.map((domain) => (
                <div key={domain.uid} className="flex flex-col gap-3">
                    <h3 className="text-base font-bold">{domain.name}</h3>
                    <DomainDnsSetup uid={domain.uid} />
                </div>
            ))}
            {error && <Alert>{error}</Alert>}
            <form onSubmit={handleSubmit} className="bg-surface border border-border rounded-md p-6">
                <FormField label={domains.length === 0 ? "Domain name" : "Add another domain"} htmlFor="setupDomainName">
                    <input
                        id="setupDomainName"
                        type="text"
                        className={INPUT_CLASS}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="example.com"
                    />
                </FormField>
                <Button type="submit" loading={saving} disabled={saving} className="!w-auto">
                    Add domain
                </Button>
            </form>
        </div>
    );
}

function MailboxesStep({ userUid, domain }: { userUid: string; domain?: string }) {
    const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
    const [formKey, setFormKey] = useState(0);

    useEffect(() => {
        listMailboxes({ limit: 100 })
            .then(setMailboxes)
            .catch(() => undefined);
    }, []);

    const hasOwn = mailboxes.some((mailbox) => mailbox.ownerUserUid === userUid);

    return (
        <div className="flex flex-col gap-5 max-w-xl">
            {mailboxes.length > 0 && (
                <div>
                    <h3 className="text-sm font-bold uppercase tracking-wide mb-2">Mailboxes created</h3>
                    <ul className="text-sm flex flex-col gap-1">
                        {mailboxes.map((mailbox) => (
                            <li key={mailbox.uid}>
                                {mailbox.displayName} &lt;{mailbox.primarySmtpAddress}&gt;
                                {mailbox.ownerUserUid === userUid && <span className="text-text-muted"> (yours)</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <h3 className="text-base font-bold">{hasOwn ? "Add another mailbox" : "Your mailbox"}</h3>
            <MailboxCreateForm
                key={formKey}
                submitLabel="Create mailbox"
                defaults={hasOwn ? { domain } : { localPart: "admin", domain, displayName: "Administrator", ownerUserUid: userUid }}
                onCreated={(mailbox) => {
                    setMailboxes((prev) => [...prev, mailbox]);
                    setFormKey((k) => k + 1);
                }}
            />
        </div>
    );
}
