///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { MailboxAutoProvisionAliasOption, autoProvisionMailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { FrameTakeover } from "../../navigation/frameContext.js";

type Status = "checking" | "needs_selection" | "creating" | "unavailable" | "retryable";

/** What the "Retry" screen says: the server couldn't read its provisioning policy (503) ... */
const RETRY_POLICY_TEXT = "We couldn\u2019t check whether a mailbox can be set up for you. Please try again.";
/** ... or couldn't reach the identity service (auth-server) it looks the caller's username up in (502). */
const RETRY_IDENTITY_TEXT = "We couldn\u2019t reach the identity service to set up your mailbox. Please try again.";

/** The longest server message shown as the reason a mailbox isn't available - a real reason is a sentence. */
const MAX_REASON_LENGTH = 200;

/**
 * The reason to show under "No mailbox available": the server's own message, for a refusal it made on purpose - a
 * 4xx such as 404 "Automatic mailbox provisioning is not enabled." or 404 "No username is registered for this account."
 * Never for a 5xx (whose message is whatever went wrong inside the server) or a failure that never reached it (a network
 * error's message is browser jargon), and only its first line, capped in length. `null` when there's nothing safe to show.
 */
function unavailableReason(err: unknown): string | null {
    if (!(err instanceof ApiRequestError) || err.status < 400 || err.status >= 500) {
        return null;
    }
    const line = err.message.split(/\r?\n/)[0].trim();
    return line ? line.slice(0, MAX_REASON_LENGTH) : null;
}

/**
 * Rendered by each app's shell (Mail/Calendar/Contacts/Tasks) *instead of* the normal `AppShell`
 * chrome (icon rail, header, folder tree, ...) when the caller has no mailbox — a full-screen,
 * 404-style takeover, not a small message nested inside the rest of the client UI, since there's
 * nothing else in the app for a mailbox-less caller to do yet. Attempts self-service
 * auto-provisioning — see `BaseMailboxRoute.autoProvision()`'s own doc comment in `@rapidmx/restapi`
 * for the full contract — which is itself a no-op (a 404) unless an admin has both turned it on
 * (`mail:auto_provision:enabled`) and configured at least one domain (`mail:domains`). Safe to render
 * unconditionally in that place: a failure ends in one of two screens. A 502 (the identity service couldn't be
 * reached) or 503 (the server couldn't read its provisioning policy) is transient and offers "Retry". Anything
 * else is "No mailbox available - ask an administrator", now with the server's own reason above that advice when it
 * refused deliberately (a 4xx, e.g. "Automatic mailbox provisioning is not enabled.") so the caller and the
 * administrator they ask can tell why - see `unavailableReason()`.
 */
export default function MailboxProvisioning() {
    const [status, setStatus] = useState<Status>("checking");
    const [options, setOptions] = useState<MailboxAutoProvisionAliasOption[]>([]);
    const [selected, setSelected] = useState("");
    const [error, setError] = useState<string | null>(null);
    // Why the caller has no mailbox (see `unavailableReason()`), and what the retry screen says.
    const [reason, setReason] = useState<string | null>(null);
    const [retryText, setRetryText] = useState(RETRY_POLICY_TEXT);

    // Bumped by "Retry" to re-run the check below.
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        setStatus("checking");
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
            // A 503 means the server couldn't read its own provisioning policy right now, and a 502 that it couldn't
            // reach the identity service - neither says there's no mailbox to be had - so they get a retry instead of
            // the permanent "ask an administrator" message.
            .catch((err) => {
                if (err instanceof ApiRequestError && (err.status === 503 || err.status === 502)) {
                    setRetryText(err.status === 502 ? RETRY_IDENTITY_TEXT : RETRY_POLICY_TEXT);
                    setStatus("retryable");
                } else {
                    setReason(unavailableReason(err));
                    setStatus("unavailable");
                }
            });
    }, [attempt]);

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
    } else if (status === "retryable") {
        content = (
            <>
                <h1 className="text-lg font-bold uppercase tracking-wide">Couldn&rsquo;t check right now</h1>
                <p className="text-sm text-text-muted">{retryText}</p>
                <Button type="button" onClick={() => setAttempt((n) => n + 1)} className="!w-auto self-center">
                    Retry
                </Button>
            </>
        );
    } else {
        content = (
            <>
                <h1 className="text-lg font-bold uppercase tracking-wide">No mailbox available</h1>
                {reason && <p className="text-sm">{reason}</p>}
                <p className="text-sm text-text-muted">Ask an administrator to create one for you.</p>
            </>
        );
    }

    // Inside the client-side router's persistent frame this hides the frame's rail and header, as replacing the whole shell used to.
    return (
        <FrameTakeover>
            <div className="min-h-screen flex items-center justify-center p-8 bg-surface-alt">
                <div className="w-full max-w-md bg-surface border border-border rounded-md p-8 flex flex-col items-center gap-4 text-center">
                    <img src="/images/wordmark.png" height="128" alt="" />
                    {content}
                </div>
            </div>
        </FrameTakeover>
    );
}
