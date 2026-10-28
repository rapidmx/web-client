///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";
import { ConfigKeyRotationPhase, ConfigKeys, getConfigKeys } from "../../../../../lib/admin/configKeysApi.js";
import { ApiRequestError } from "../../../../../lib/util/api.js";
import Alert from "../ActionAlert.js";
import { activeKidOf, ageText, isRunning } from "../configEncryption/keyringParts.js";
import Badge from "./Badge.js";
import { formatDateTime, NO_VALUE } from "./format.js";
import type { DiagnosticsResource } from "./useDiagnosticsResource.js";

/**
 * Reads the configuration keyring's state with the configuration keys client: the same answer the Configuration Encryption page shows, so Diagnostics needs no
 * route of its own. A server without the route (404) answers `null`, which the card words, so that it doesn't fail the page.
 */
export async function loadKeyring(): Promise<ConfigKeys | null> {
    try {
        return await getConfigKeys();
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
            return null;
        }
        throw err;
    }
}

/** Where a running rotation is, in words. */
const PHASES: Record<ConfigKeyRotationPhase, string> = {
    adding: "adding the new key",
    activating: "waiting for the server copies to load the new key",
    reencrypting: "re-encrypting the saved values",
    retiring: "removing the old key",
    done: "done",
    failed: "failed",
};

const HEADINGS = ["Key ID", "Created", "Age", "Values encrypted", "State"];

export interface KeyringCardProps {
    keyring: DiagnosticsResource<ConfigKeys | null>;
    /** The time the ages are counted to. Defaults to now. For a test. */
    now?: number;
}

function Note({ role = "note", children }: { role?: "note" | "alert"; children: ReactNode }) {
    return (
        <div role={role} className="mt-3 rounded-sm bg-warning px-3.5 py-3 text-sm text-warning-contrast">
            {children}
        </div>
    );
}

/**
 * The configuration keyring (spec 5.6, 14): each key by its id, when it was made, its age and how many saved values it encrypts, which one encrypts now, and a
 * rotation that is running or failed. Never any key material: the server doesn't send it. Managing the keys is the Configuration Encryption page's.
 */
export default function KeyringCard({ keyring, now = Date.now() }: KeyringCardProps) {
    const { data, error, loading } = keyring;
    return (
        <section aria-labelledby="diagnostics-keyring-heading" className="rounded-md border border-border bg-surface p-4">
            <h2 id="diagnostics-keyring-heading" className="mb-1 text-base font-bold uppercase tracking-wide">
                Configuration keyring
            </h2>
            <p className="mb-3 text-xs text-text-muted">
                The keys that encrypt the credentials, API keys and tokens saved in the console. Only each key&rsquo;s id, age and how many values it
                encrypts are shown.
            </p>
            {error && <Alert>{error}</Alert>}
            {!data && loading && <p className="text-sm text-text-muted">Loading&hellip;</p>}
            {data === null && <p className="text-sm text-text-muted">This server doesn&rsquo;t offer configuration encryption yet.</p>}
            {data && <Keys keys={data} now={now} />}
        </section>
    );
}

function Keys({ keys, now }: { keys: ConfigKeys; now: number }) {
    const list = keys.keys ?? [];
    const activeKid = activeKidOf({ ...keys, keys: list });
    const rotation = keys.rotation;
    const reencryption = keys.reencryption;
    const unreadable = reencryption?.unreadable?.length ?? 0;
    return (
        <>
            {list.length === 0 ? (
                <p className="text-sm text-text-muted">The keyring holds no keys.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-sm">
                        <thead>
                            <tr>
                                {HEADINGS.map((heading) => (
                                    <th key={heading} className="border-b border-border px-2.5 py-2 text-left text-xs uppercase tracking-wide text-text-muted">
                                        {heading}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {list.map((key) => (
                                <tr key={key.kid}>
                                    <td className="break-all border-b border-border px-2.5 py-2 font-mono">{key.kid}</td>
                                    <td className="border-b border-border px-2.5 py-2">{formatDateTime(key.createdAt)}</td>
                                    <td className="border-b border-border px-2.5 py-2">{ageText(key.createdAt, now)}</td>
                                    <td className="border-b border-border px-2.5 py-2 tabular-nums">{key.envelopes ?? "Not counted yet"}</td>
                                    <td className="border-b border-border px-2.5 py-2">
                                        {key.kid === activeKid ? (
                                            <Badge tone="success">Active</Badge>
                                        ) : isRunning(rotation) && key.kid === rotation.kid ? (
                                            <Badge>Waiting to be activated</Badge>
                                        ) : (
                                            NO_VALUE
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <p className="mt-2 text-xs text-text-muted">
                {keys.countedAt ? `Values were last counted ${formatDateTime(keys.countedAt)}.` : "Values have not been counted yet."}
            </p>
            {isRunning(rotation) && (
                <Note>
                    A key rotation is in progress: {PHASES[rotation.phase] ?? rotation.phase}. Follow it on the{" "}
                    <a href="/admin/configuration-encryption" className="underline">
                        Configuration Encryption
                    </a>{" "}
                    page.
                </Note>
            )}
            {rotation?.phase === "failed" && <Note>The last key rotation failed: {rotation.lastError ?? "no reason was recorded."}</Note>}
            {unreadable > 0 && (
                <Note role="alert">
                    {reencryption?.finishedAt ? `The re-encryption pass that finished ${formatDateTime(reencryption.finishedAt)}` : "The last re-encryption pass"} could not read{" "}
                    {unreadable === 1 ? "1 saved value" : `${unreadable} saved values`} with the keys in this keyring. Restore the keyring they were saved with, or enter them again;
                    only a later pass updates this, so a value entered again stays counted until then.
                </Note>
            )}
        </>
    );
}
