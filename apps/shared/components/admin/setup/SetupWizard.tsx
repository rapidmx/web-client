///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useRef, useState } from "react";
import { HiCheck } from "react-icons/hi2";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { getRetentionPolicy } from "@rapidmx/react-shared/admin/retentionPolicyApi.js";
import { getMailboxPolicy } from "@rapidmx/react-shared/admin/mailboxPolicyApi.js";
import { createDomain, Domain, listDomains } from "@rapidmx/react-shared/admin/domainsApi.js";
import { completeSetup, getSetupStatus, saveSetupStep, SetupStatus } from "@rapidmx/react-shared/admin/setupApi.js";
import { getBranding } from "@rapidmx/react-shared/branding/brandingApi.js";
import { EncryptionPolicy, getEncryptionPolicy } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { listMailboxes, Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
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

/** The bordered panel the wizard's forms sit in. */
const CARD_CLASS = "bg-surface border border-border rounded-md p-6";

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

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof ApiRequestError ? err.message : fallback;
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
    const [status, setStatus] = useState<SetupStatus | undefined>();
    const [domains, setDomains] = useState<Domain[]>([]);
    const [domainsError, setDomainsError] = useState<string | null>(null);
    const [encryption, setEncryption] = useState<EncryptionPolicy | null>(null);
    const [finishing, setFinishing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Which of the settings step's forms have edits that haven't been saved. */
    const [unsaved, setUnsaved] = useState<Record<string, boolean>>({});
    /** The step the administrator asked to go to while the settings step had unsaved edits. */
    const [leavingTo, setLeavingTo] = useState<SetupStepId | null>(null);
    const [progressFailed, setProgressFailed] = useState(false);
    /** Step saves run one at a time, and only the latest step still waiting is saved. */
    const progress = useRef<{ running: Promise<void> | null; next: SetupStepId | null }>({ running: null, next: null });

    function loadDomains(): Promise<void> {
        return listDomains({ limit: 25 })
            .then((list) => {
                setDomains(list);
                setDomainsError(null);
            })
            .catch((err) => setDomainsError(errorMessage(err, "Could not load your domains.")));
    }

    useEffect(() => {
        void Promise.all([getSetupStatus().catch(() => undefined), loadDomains()]).then(([loaded]) => {
            setStatus(loaded);
            setStep(isStepId(loaded?.currentStep) ? loaded.currentStep : "plugins");
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

    /** Records the step the administrator is on. Progress is a convenience for resuming, so a failure is only noted. */
    function saveProgress(next: SetupStepId) {
        const queue = progress.current;
        queue.next = next;
        if (queue.running) {
            return;
        }
        queue.running = (async () => {
            while (queue.next) {
                const target: SetupStepId = queue.next;
                queue.next = null;
                try {
                    await saveSetupStep(target);
                    setProgressFailed(false);
                } catch (err) {
                    console.warn("Could not save setup progress", err);
                    setProgressFailed(true);
                }
            }
            queue.running = null;
        })();
    }

    function goTo(next: SetupStepId) {
        setError(null);
        setLeavingTo(null);
        setUnsaved({});
        setStep(next);
        saveProgress(next);
        window.scrollTo?.(0, 0);
    }

    /** Goes to `next`, first asking whether to discard any unsaved server settings. */
    function requestGoTo(next: SetupStepId) {
        // Going to the step already shown would clear the unsaved-edit tracking while the forms keep their edits.
        if (next === step) {
            return;
        }
        if (step === "settings" && Object.values(unsaved).some(Boolean)) {
            setLeavingTo(next);
            return;
        }
        goTo(next);
    }

    const trackUnsaved = (form: string) => (dirty: boolean) => setUnsaved((prev) => ({ ...prev, [form]: dirty }));

    async function finish() {
        setFinishing(true);
        setError(null);
        try {
            // Let a step still being recorded land first, so it can't arrive after setup is marked finished.
            await progress.current.running;
            await completeSetup();
            window.location.href = "/admin";
        } catch (err) {
            setError(errorMessage(err, "Could not finish setup."));
            setFinishing(false);
        }
    }

    const noDomain: boolean = domains.length === 0;
    const blocked = (step === "domain" || last) && noDomain;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-xl font-bold uppercase tracking-wide mb-1">Set up your server</h1>
                    <p className="text-sm text-text-muted">You can change any of these settings later from the admin console.</p>
                </div>
                {status && !status.required && (
                    <a href="/admin" className="text-sm text-primary-dark font-medium hover:underline whitespace-nowrap">
                        Exit setup
                    </a>
                )}
            </div>

            {domainsError && (
                <Alert>
                    <span className="flex flex-wrap items-center gap-2">
                        {domainsError}
                        <Button type="button" variant="text" onClick={() => void loadDomains()}>
                            Retry
                        </Button>
                    </span>
                </Alert>
            )}

            <ol aria-label="Setup steps" className="flex flex-wrap gap-2">
                {SETUP_STEPS.map((s, i) => (
                    <li key={s.id}>
                        <button
                            type="button"
                            aria-current={s.id === step ? "step" : undefined}
                            // Steps after the domain need somewhere to put mail first.
                            disabled={i > 1 && noDomain}
                            onClick={() => requestGoTo(s.id)}
                            className={[
                                "inline-flex items-center gap-1.5 text-sm py-1.5 px-3 rounded-pill border transition-colors",
                                "disabled:opacity-50 disabled:cursor-not-allowed",
                                s.id === step
                                    ? "bg-primary/10 border-primary text-primary-dark font-semibold"
                                    : i < index
                                      ? "bg-surface border-border text-text hover:not-disabled:border-primary"
                                      : "bg-surface border-border text-text-muted hover:not-disabled:border-primary hover:not-disabled:text-text",
                            ].join(" ")}
                        >
                            {i < index && <HiCheck aria-hidden="true" className="w-4 h-4 text-success" />}
                            {i + 1}. {s.title}
                            {i < index && <span className="sr-only"> (done)</span>}
                        </button>
                    </li>
                ))}
            </ol>

            <section aria-labelledby="setup-step-title" className="flex flex-col gap-5">
                <div className="flex flex-col gap-1">
                    <h2 id="setup-step-title" className="flex flex-col gap-0.5">
                        <span className="text-xs font-bold uppercase tracking-wide text-text-muted">
                            Step {index + 1} of {SETUP_STEPS.length}
                            <span className="sr-only">:</span>
                        </span>{" "}
                        <span className="text-lg font-bold uppercase tracking-wide">{current.title}</span>
                    </h2>
                    <p className="text-sm text-text-muted max-w-3xl">{current.intro}</p>
                </div>

                {step === "plugins" && (
                    <div>
                        <PluginsManager embedded />
                    </div>
                )}
                {step === "domain" && <DomainStep domains={domains} onCreated={(domain) => setDomains((prev) => [...prev, domain])} />}
                {step === "settings" && (
                    <div className="flex flex-col gap-6 max-w-3xl">
                        <div className={CARD_CLASS}>
                            <LoadedSettingsForm load={getEncryptionPolicy} loadErrorMessage="Could not load the encryption policy.">
                                {(policy, onChange) => (
                                    <EncryptionPolicyForm
                                        embedded
                                        policy={policy}
                                        onDirtyChange={trackUnsaved("encryption")}
                                        onChange={(updated) => {
                                            onChange(updated);
                                            setEncryption(updated);
                                        }}
                                    />
                                )}
                            </LoadedSettingsForm>
                        </div>
                        <div className={CARD_CLASS}>
                            <LoadedSettingsForm load={getRetentionPolicy} loadErrorMessage="Could not load the retention policy.">
                                {(policy, onChange) => (
                                    <RetentionPolicyForm embedded policy={policy} onChange={onChange} onDirtyChange={trackUnsaved("retention")} />
                                )}
                            </LoadedSettingsForm>
                        </div>
                        <div className={CARD_CLASS}>
                            <LoadedSettingsForm load={getMailboxPolicy} loadErrorMessage="Could not load the mailbox policy.">
                                {(policy, onChange) => (
                                    <MailboxPolicyForm embedded policy={policy} onChange={onChange} onDirtyChange={trackUnsaved("mailbox")} />
                                )}
                            </LoadedSettingsForm>
                        </div>
                    </div>
                )}
                {step === "escrow" &&
                    (encryption && !isEncryptionEnabled(encryption) ? (
                        <p role="status" className="text-sm py-2 px-3 rounded-sm bg-surface-alt text-text max-w-3xl">
                            End-to-end encryption is turned off, so escrow isn&rsquo;t needed. You can set it up later if you
                            turn encryption on.
                        </p>
                    ) : (
                        <EscrowSetupStep adminUid={userUid} />
                    ))}
                {step === "branding" && (
                    <div className={`${CARD_CLASS} max-w-3xl`}>
                        <LoadedSettingsForm load={getBranding} loadErrorMessage="Could not load branding.">
                            {(branding, onChange) => <BrandingForm embedded branding={branding} onChange={onChange} />}
                        </LoadedSettingsForm>
                    </div>
                )}
                {step === "mailboxes" && <MailboxesStep userUid={userUid} domain={domains.find((d) => d.verified)?.name ?? domains[0]?.name} />}
            </section>

            {error && <Alert>{error}</Alert>}

            <div className="flex items-center gap-3 border-t border-border pt-5">
                {index > 0 && (
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => requestGoTo(SETUP_STEPS[index - 1].id)}>
                        Back
                    </Button>
                )}
                <div className="flex-1" />
                {progressFailed && <span className="text-xs text-text-muted">Your place in setup couldn&rsquo;t be saved.</span>}
                {blocked && <span className="text-sm text-text-muted">{last ? "Add a domain before finishing setup." : "Add a domain to continue."}</span>}
                {last ? (
                    <Button type="button" className="!w-auto" loading={finishing} disabled={finishing || blocked} onClick={() => void finish()}>
                        Finish setup
                    </Button>
                ) : (
                    <Button type="button" className="!w-auto" disabled={blocked} onClick={() => requestGoTo(SETUP_STEPS[index + 1].id)}>
                        Continue
                    </Button>
                )}
            </div>

            {leavingTo && (
                <Modal open onClose={() => setLeavingTo(null)} title="Discard unsaved changes?">
                    <p className="text-sm mb-4">Some server settings on this step have changes that haven&rsquo;t been saved.</p>
                    <div className="flex gap-2 justify-end">
                        <Button type="button" variant="secondary" className="!w-auto" onClick={() => setLeavingTo(null)}>
                            Keep editing
                        </Button>
                        <Button type="button" className="!w-auto" onClick={() => goTo(leavingTo)}>
                            Discard changes
                        </Button>
                    </div>
                </Modal>
            )}
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
            setError(errorMessage(err, "Could not add the domain."));
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
            <form onSubmit={handleSubmit} className={CARD_CLASS}>
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
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [formKey, setFormKey] = useState(0);

    useEffect(() => {
        listMailboxes({ limit: 100 })
            .then((list) =>
                // Keep any mailbox created here while the list was loading.
                setMailboxes((prev) => [...list, ...prev.filter((mine) => !list.some((mailbox) => mailbox.uid === mine.uid))]),
            )
            .catch((err) =>
                setError(
                    `${errorMessage(err, "Could not load the existing mailboxes.")} Check the Mailboxes page before creating your own, so you don't create it twice.`,
                ),
            )
            .finally(() => setLoaded(true));
    }, []);

    const hasOwn = mailboxes.some((mailbox) => mailbox.ownerUserUid === userUid);

    return (
        <div className="flex flex-col gap-5 max-w-xl">
            {error && <Alert>{error}</Alert>}
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
            {!loaded ? (
                <p className="text-sm text-text-muted">Loading&hellip;</p>
            ) : (
                <>
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
                </>
            )}
        </div>
    );
}
