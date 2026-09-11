///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { MailboxAutoProvisionAliasOption, autoProvisionMailbox } from "@rapidmx/react-shared/mailApi.js";
import Alert from "../feedback/Alert.js";
import Button from "../buttons/Button.js";

type Status = "checking" | "needs_selection" | "creating" | "unavailable";

/**
 * Rendered by each app's shell (Mail/Calendar/Contacts/Tasks) *instead of* the normal `AppShell`
 * chrome (icon rail, header, folder tree, ...) when the caller has no mailbox — a full-screen,
 * 404-style takeover, not a small message nested inside the rest of the client UI, since there's
 * nothing else in the app for a mailbox-less caller to do yet. Attempts self-service
 * auto-provisioning — see `BaseMailboxRoute.autoProvision()`'s own doc comment in `@rapidmx/restapi`
 * for the full contract — which is itself a no-op (a 404) unless an admin has both turned it on
 * (`mail:auto_provision:enabled`) and configured at least one domain (`mail:domains`). Safe to render
 * unconditionally in that place: any failure (disabled, no registered username, the identity service
 * unreachable) just falls back to the same plain "no mailbox" message this replaces.
 */
export default function MailboxProvisioning() {
    const [status, setStatus] = useState<Status>("checking");
    const [options, setOptions] = useState<MailboxAutoProvisionAliasOption[]>([]);
    const [selected, setSelected] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        autoProvisionMailbox()
            .then((result) => {
                if (result.status === "needs_selection") {
                    // `autoProvision()` only ever returns this status with a non-empty cross product of
                    // the caller's aliases and this server's configured domains (both are checked
                    // non-empty before it's built) — no fallback needed for an empty list here.
                    setOptions(result.options);
                    setSelected(result.options[0].primarySmtpAddress);
                    setStatus("needs_selection");
                } else {
                    // "created" or "existing" — either way the caller now has a mailbox; a full reload is
                    // this framework's own convention for picking up new server-side state (no client
                    // router to instead re-fetch just the shell's own data in place).
                    window.location.reload();
                }
            })
            .catch(() => setStatus("unavailable"));
    }, []);

    async function handleConfirm() {
        // `selected` only ever takes a value from `options` itself (the initial default, or the
        // <select>'s own onChange, which can only report one of its own rendered <option> values), so
        // this is always found — no defensive fallback needed.
        const option = options.find((o) => o.primarySmtpAddress === selected)!;
        setStatus("creating");
        setError(null);
        try {
            await autoProvisionMailbox({ alias: option.alias, domain: option.domain });
            window.location.reload();
        } catch (err) {
            setError(err instanceof ApiRequestError ? err.message : "Could not create your mailbox.");
            setStatus("needs_selection");
        }
    }

    let content: React.ReactNode;
    if (status === "checking") {
        content = <p className="text-sm text-text-muted">Setting up your mailbox&hellip;</p>;
    } else if (status === "needs_selection" || status === "creating") {
        const creating = status === "creating";
        content = (
            <div className="w-full flex flex-col gap-3">
                <p className="text-sm text-text-muted text-center">Choose your mailbox address to get started:</p>
                {error && <Alert>{error}</Alert>}
                <select
                    aria-label="Mailbox address"
                    className="text-sm border border-border rounded-sm py-1.5 px-2 bg-surface"
                    value={selected}
                    onChange={(e) => setSelected(e.target.value)}
                    disabled={creating}
                >
                    {options.map((option) => (
                        <option key={option.primarySmtpAddress} value={option.primarySmtpAddress}>
                            {option.primarySmtpAddress}
                        </option>
                    ))}
                </select>
                <Button type="button" onClick={handleConfirm} loading={creating} disabled={creating} className="!w-auto self-center">
                    Continue
                </Button>
            </div>
        );
    } else {
        content = (
            <>
                <h1 className="text-lg font-bold uppercase tracking-wide">No mailbox available</h1>
                <p className="text-sm text-text-muted">Ask an administrator to create one for you.</p>
            </>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center p-8 bg-surface-alt">
            <div className="w-full max-w-md bg-surface border border-border rounded-md p-8 flex flex-col items-center gap-4 text-center">
                <img src="/images/wordmark.png" height="128" alt="" />
                {content}
            </div>
        </div>
    );
}
