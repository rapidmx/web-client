///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { FormEvent, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { createEscrowScope, EscrowScope, listEscrowScopes } from "@rapidmx/react-shared/admin/escrowScopesApi.js";
import { generateEscrowKeyPair, GeneratedEscrowKeys } from "@rapidmx/react-shared/crypto/escrowKeys.js";
import { toDatetimeLocal } from "@rapidmx/react-shared/util/dateInput.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import EscrowScopeKeyAndHoldersFields, {
    emptyEscrowScopeKeyAndHoldersValue,
    EscrowScopeKeyAndHoldersValue,
} from "../escrowScopes/EscrowScopeKeyAndHoldersFields.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

type Mode = "none" | "generate" | "existing";

/** Offers `text` to the browser as a file download. */
export function downloadTextFile(filename: string, text: string, type: string = "application/x-pem-file"): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function fileSafe(name: string): string {
    return name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "escrow";
}

/**
 * The setup wizard's escrow step. Escrow lets a separate group of holders recover a mailbox's encrypted mail (for
 * example for legal discovery) using a key this server never has. It's optional, and the administrator can either
 * generate the key pair here (downloading the private key, which never leaves the browser), paste in an existing
 * certificate, or go without escrow.
 */
export default function EscrowSetupStep() {
    const [scopes, setScopes] = useState<EscrowScope[] | null>(null);
    const [mode, setMode] = useState<Mode>("none");
    const [name, setName] = useState("Escrow");
    const [validYears, setValidYears] = useState(5);
    const [generated, setGenerated] = useState<GeneratedEscrowKeys | null>(null);
    const [savedPrivateKey, setSavedPrivateKey] = useState(false);
    const [keyAndHolders, setKeyAndHolders] = useState<EscrowScopeKeyAndHoldersValue>(emptyEscrowScopeKeyAndHoldersValue());
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        listEscrowScopes({ limit: 100 })
            .then(setScopes)
            .catch(() => setScopes([]));
    }, []);

    function chooseMode(next: Mode) {
        setMode(next);
        setError(null);
        setGenerated(null);
        setSavedPrivateKey(false);
        setKeyAndHolders(emptyEscrowScopeKeyAndHoldersValue());
    }

    async function generate() {
        if (!name.trim()) {
            setError("Give the escrow scope a name first.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const keys = await generateEscrowKeyPair({ name: name.trim(), validDays: validYears * 365 });
            setGenerated(keys);
            setKeyAndHolders({
                ...emptyEscrowScopeKeyAndHoldersValue(),
                publicKey: keys.publicKey.publicKey,
                keyType: keys.publicKey.type,
                fingerprint: keys.publicKey.fingerprint,
                notBefore: toDatetimeLocal(new Date(keys.publicKey.notBefore).toISOString()),
                notAfter: toDatetimeLocal(new Date(keys.publicKey.notAfter).toISOString()),
            });
        } catch {
            setError("This browser couldn't generate the escrow keys.");
        } finally {
            setBusy(false);
        }
    }

    async function create(e: FormEvent) {
        e.preventDefault();
        setError(null);
        if (!name.trim()) {
            setError("A name is required.");
            return;
        }
        if (!keyAndHolders.publicKey.trim() || !keyAndHolders.keyType.trim() || !keyAndHolders.fingerprint.trim()) {
            setError("The public key, its type, and its fingerprint are all required.");
            return;
        }
        if (keyAndHolders.holderUserUids.length === 0) {
            setError("At least one holder is required.");
            return;
        }
        if (keyAndHolders.requiredHolders < 1 || keyAndHolders.requiredHolders > keyAndHolders.holderUserUids.length) {
            setError("Required holders must be between 1 and the number of holders.");
            return;
        }
        setBusy(true);
        try {
            const created = await createEscrowScope({
                name: name.trim(),
                publicKey: {
                    publicKey: keyAndHolders.publicKey.trim(),
                    type: keyAndHolders.keyType.trim(),
                    fingerprint: keyAndHolders.fingerprint.trim(),
                    notBefore: new Date(keyAndHolders.notBefore).getTime(),
                    notAfter: new Date(keyAndHolders.notAfter).getTime(),
                },
                holderUserUids: keyAndHolders.holderUserUids,
                requiredHolders: keyAndHolders.requiredHolders,
                notifySubjectOnAccess: keyAndHolders.notifySubjectOnAccess,
            });
            setScopes((prev) => [...(prev ?? []), created]);
            chooseMode("none");
            setName("Escrow");
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create the escrow scope.");
        } finally {
            setBusy(false);
        }
    }

    const scopeForm = (
        <form onSubmit={create} className="flex flex-col gap-5">
            <EscrowScopeKeyAndHoldersFields value={keyAndHolders} onChange={setKeyAndHolders} disabled={mode === "generate" && busy} />
            <div>
                <Button type="submit" loading={busy} disabled={busy} className="!w-auto">
                    Create escrow scope
                </Button>
            </div>
        </form>
    );

    return (
        <div className="flex flex-col gap-5 max-w-3xl">
            <div>
                <h2 className="text-lg font-bold uppercase tracking-wide mb-1">Escrow</h2>
                <p className="text-sm text-text-muted">
                    Escrow lets a group of trusted holders - for example your legal or compliance team - recover a
                    mailbox&rsquo;s encrypted mail when they all agree to. It&rsquo;s optional. Without it, mail that
                    someone encrypts can&rsquo;t be recovered if they lose their keys, by anyone.
                </p>
            </div>

            {scopes && scopes.length > 0 && (
                <div role="status" className="text-sm py-2 px-3 rounded-sm bg-surface-alt text-text">
                    Escrow scopes set up: {scopes.map((scope) => scope.name).join(", ")}.
                </div>
            )}

            {error && <Alert>{error}</Alert>}

            <fieldset className="flex flex-col gap-2 text-sm">
                <legend className="font-semibold mb-1">How do you want to set up escrow?</legend>
                <label className="flex items-center gap-2">
                    <input type="radio" name="escrow-mode" checked={mode === "generate"} onChange={() => chooseMode("generate")} />
                    Generate new escrow keys in this browser
                </label>
                <label className="flex items-center gap-2">
                    <input type="radio" name="escrow-mode" checked={mode === "existing"} onChange={() => chooseMode("existing")} />
                    Use a certificate I already have
                </label>
                <label className="flex items-center gap-2">
                    <input type="radio" name="escrow-mode" checked={mode === "none"} onChange={() => chooseMode("none")} />
                    {scopes && scopes.length > 0 ? "Don't add another escrow scope" : "Don't use escrow"}
                </label>
            </fieldset>

            {mode !== "none" && (
                <div className="bg-surface border border-border rounded-md p-6">
                    <FormField label="Escrow scope name" htmlFor="escrowName">
                        <input
                            id="escrowName"
                            type="text"
                            className={INPUT_CLASS}
                            value={name}
                            disabled={!!generated}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </FormField>
                    {mode === "generate" && !generated && (
                        <>
                            <FormField label="Keys valid for" htmlFor="escrowValidYears">
                                <select
                                    id="escrowValidYears"
                                    className={INPUT_CLASS}
                                    value={validYears}
                                    onChange={(e) => setValidYears(Number(e.target.value))}
                                >
                                    {[1, 2, 5, 10].map((years) => (
                                        <option key={years} value={years}>
                                            {years} {years === 1 ? "year" : "years"}
                                        </option>
                                    ))}
                                </select>
                            </FormField>
                            <Button type="button" className="!w-auto" loading={busy} disabled={busy} onClick={() => void generate()}>
                                Generate keys
                            </Button>
                        </>
                    )}
                    {mode === "generate" && generated && (
                        <div className="flex flex-col gap-3 text-sm">
                            <Alert>
                                Download the private key now and give it to your escrow holders. It isn&rsquo;t stored
                                anywhere else - if it&rsquo;s lost, no escrowed mail can ever be recovered.
                            </Alert>
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    type="button"
                                    className="!w-auto"
                                    onClick={() => downloadTextFile(`${fileSafe(name)}-private-key.pem`, generated.privateKeyPem)}
                                >
                                    Download private key
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    className="!w-auto"
                                    onClick={() => downloadTextFile(`${fileSafe(name)}-certificate.pem`, generated.certificatePem)}
                                >
                                    Download certificate
                                </Button>
                            </div>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={savedPrivateKey} onChange={(e) => setSavedPrivateKey(e.target.checked)} />
                                I&rsquo;ve saved the private key somewhere safe
                            </label>
                        </div>
                    )}
                </div>
            )}

            {mode === "existing" && scopeForm}
            {mode === "generate" && generated && savedPrivateKey && scopeForm}
        </div>
    );
}
