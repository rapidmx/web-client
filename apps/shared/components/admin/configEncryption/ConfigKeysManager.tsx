///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useEffect, useRef, useState } from "react";
import {
    activateConfigKey,
    ConfigKeys,
    configKeysOfRefusal,
    getConfigKeys,
    rotateConfigKey,
} from "../../../../../lib/admin/configKeysApi.js";
import Button from "../../../../../lib/components/buttons/Button.js";
import Modal from "../../../../../lib/components/overlays/Modal.js";
import { ApiRequestError } from "../../../../../lib/util/api.js";
import Alert from "../ActionAlert.js";
import { actionErrorMessage } from "../elevation.js";
import { Badge, formatTime } from "../integrations/dnsProviderParts.js";
import { activeKidOf, ageText, isRunning } from "./keyringParts.js";

/** How often the progress of a rotation in progress is read again. The server's job looks at a rotation every 30 seconds, and the copies report every 30. */
export const POLL_MS = 10_000;

/** What an administrator asked for that the dialogs confirm. */
type Confirming = "compromised" | "activate";

function copiesText(count: number): string {
    return count === 1 ? "1 copy" : `${count} copies`;
}

/** The server copies a rotation is waiting for, one per line. */
function CopyList({ label, copies }: { label: string; copies: string[] }) {
    return (
        <ul aria-label={label} className="list-disc pl-5 text-sm mb-3">
            {copies.map((copy) => (
                <li key={copy}>
                    <code className="text-xs">{copy}</code>
                </li>
            ))}
        </ul>
    );
}

function Note({ children }: { children: ReactNode }) {
    return (
        <div role="note" className="text-sm rounded-sm py-3 px-3.5 mb-3 bg-warning text-warning-contrast">
            {children}
        </div>
    );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="bg-surface border border-border rounded-md p-6 mb-5">
            <h2 className="text-sm font-bold uppercase tracking-wide mb-3">{title}</h2>
            {children}
        </div>
    );
}

/**
 * The configuration keyring's console (spec 5.5, 10.5, 14): the keys with their age and how many saved values each encrypts, "Rotate configuration key" and
 * "Key compromised", a rotation's progress with the server copies it waits for, the warning once the wait has gone on too long and "Activate anyway", the plugin
 * secret settings' encryption, and the reminders to back up the keyring and, after a compromise, to replace the credentials at their providers.
 */
export default function ConfigKeysManager() {
    const [keys, setKeys] = useState<ConfigKeys | null>(null);
    // `true` where the server has no key route (an older server).
    const [missing, setMissing] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    // The failure of a read after the first, which leaves what is shown as it was.
    const [refreshError, setRefreshError] = useState<string | null>(null);
    // The copies that were waiting when "Activate anyway" was opened: the dialog names what the administrator was shown, not what a later read says.
    const [staleCopies, setStaleCopies] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // What the server's refusal of a stale request taught: the progress shown is the rotation's, not the one the administrator expected.
    const [notice, setNotice] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<Confirming | null>(null);
    // Counts every finished read, so a failed poll is tried again too.
    const [reads, setReads] = useState(0);
    const latest = useRef(0);
    // Whether a read has been answered: a missing route then means an older pod answered, not that the server has none.
    const loaded = useRef(false);

    // Reads the keyring's state; an answer to an older request is dropped. The failure of the first read replaces the page; a later one is noted above it.
    function load(): Promise<void> {
        const id = ++latest.current;
        return getConfigKeys()
            .then(
                (answer) => {
                    if (id === latest.current) {
                        loaded.current = true;
                        setKeys(answer);
                        setLoadError(null);
                        setRefreshError(null);
                    }
                },
                (err) => {
                    if (id !== latest.current) {
                        return;
                    }
                    if (loaded.current) {
                        setRefreshError(actionErrorMessage(err, "The server did not answer."));
                    } else if (err instanceof ApiRequestError && err.status === 404) {
                        setMissing(true);
                    } else {
                        setLoadError(actionErrorMessage(err, "Could not load the configuration keys."));
                    }
                }
            )
            .then(() => setReads((count) => count + 1));
    }

    useEffect(() => {
        void load();
        // A read still on its way when the page is left must not set state.
        return () => void latest.current++;
    }, []);

    const rotation = keys?.rotation;
    const running = isRunning(rotation);
    // While a rotation runs the copies and the server's job move it along, so the page follows.
    useEffect(() => {
        if (!running) {
            return;
        }
        const timer = setTimeout(() => void load(), POLL_MS);
        return () => clearTimeout(timer);
    }, [running, reads]);

    if (missing) {
        return (
            <p className="text-sm text-text-muted">
                This server doesn&rsquo;t offer configuration encryption yet. Upgrade it to manage its keys here.
            </p>
        );
    }
    if (!keys) {
        return loadError ? (
            <>
                <Alert>{loadError}</Alert>
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => void load()}>
                    Try again
                </Button>
            </>
        ) : (
            <p className="text-sm text-text-muted">Loading&hellip;</p>
        );
    }

    async function run(action: () => Promise<ConfigKeys>, fallback: string, refused: string) {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const answer = await action();
            // Drops a read that was on its way before this change.
            latest.current++;
            loaded.current = true;
            setKeys(answer);
            setRefreshError(null);
            setConfirming(null);
        } catch (err) {
            // A 409 carries the rotation as it is: the request was for a state it is no longer in.
            const current = configKeysOfRefusal(err);
            if (current) {
                latest.current++;
                loaded.current = true;
                setKeys(current);
                setRefreshError(null);
                setConfirming(null);
                setNotice(refused);
            } else {
                setError(actionErrorMessage(err, fallback));
            }
        } finally {
            setBusy(false);
        }
    }

    // The refusal a dialog shows belongs to it, so it goes with it rather than moving to the card.
    function closeDialog() {
        if (!busy) {
            setConfirming(null);
            setError(null);
        }
    }

    function openDialog(which: Confirming) {
        setError(null);
        setStaleCopies(waiting);
        setConfirming(which);
    }

    const now = Date.now();
    const newKid = rotation?.kid;
    const waiting = rotation?.waitingFor ?? [];
    const counted = keys.keys.some((key) => key.envelopes !== undefined);
    const earlier = keys.keys.filter((key) => key.kid !== newKid).reduce((sum, key) => sum + (key.envelopes ?? 0), 0);
    const onNew = keys.keys.filter((key) => key.kid === newKid).reduce((sum, key) => sum + (key.envelopes ?? 0), 0);
    const unreadable = keys.reencryption?.unreadable ?? [];
    const activeKid = activeKidOf(keys);
    // A compromised rotation that failed: starting again from the plain button would drop the compromise.
    const failedCompromised = rotation?.phase === "failed" && rotation.compromised;

    let step: ReactNode;
    switch (rotation?.phase) {
        case "adding":
            step = <p className="text-sm mb-3">Adding the new key to the keyring.</p>;
            break;
        case "activating":
            step =
                waiting.length > 0 ? (
                    <>
                        <p className="text-sm mb-2">{`Waiting for ${copiesText(waiting.length)} to load the new key`}</p>
                        <CopyList label="Copies that haven't loaded the new key" copies={waiting} />
                        <p className="text-sm text-text-muted mb-3">
                            Nothing breaks while it waits: the current key keeps encrypting, and the new one is used as
                            soon as every copy has it.
                        </p>
                    </>
                ) : (
                    <p className="text-sm mb-3">Activating the new key.</p>
                );
            break;
        case "reencrypting":
            step = (
                <>
                    <p className="text-sm mb-2">Re-encrypting saved values with the new key.</p>
                    {counted && (
                        <p className="text-sm text-text-muted mb-3">
                            {`${earlier === 1 ? "1 value is" : `${earlier} values are`} still on an earlier key; ${onNew} ${onNew === 1 ? "is" : "are"} on the new one.`}
                        </p>
                    )}
                    {waiting.length > 0 && (
                        <>
                            <p className="text-sm mb-2">{`Waiting for ${copiesText(waiting.length)} to start using the new key`}</p>
                            <CopyList label="Copies that don't yet use the new key" copies={waiting} />
                            {rotation?.activationForced && (
                                <p className="text-sm text-text-muted mb-3">
                                    The key was activated before every copy had loaded it, so values are re-encrypted
                                    only once these copies have loaded it or are replaced.
                                </p>
                            )}
                        </>
                    )}
                </>
            );
            break;
        case "retiring":
            step = <p className="text-sm mb-3">Removing the old key from the keyring.</p>;
            break;
        case "failed":
            step = <p className="text-sm mb-3">The last rotation failed.</p>;
            break;
        case "done":
            step = (
                <p className="text-sm mb-3">
                    {rotation.finishedAt
                        ? `The last rotation finished ${formatTime(rotation.finishedAt)}.`
                        : "The last rotation has finished."}
                </p>
            );
            break;
        default:
            step = <p className="text-sm mb-3">No rotation is in progress.</p>;
    }

    return (
        <>
            <p className="text-sm text-text-muted mb-5 max-w-2xl">
                The credentials, API keys and tokens saved in this console, and the secret settings of plugins, are
                encrypted with these keys, so a copy of the database alone shows none of them. A key is only ever
                replaced by an administrator, here.
            </p>

            <Card title="Keys">
                {refreshError && (
                    <Alert>
                        Couldn&rsquo;t refresh the progress; what is shown may be out of date, and it is tried again
                        every few seconds. {refreshError}
                    </Alert>
                )}
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse mb-3">
                        <thead>
                            <tr>
                                {["Key", "Created", "Age", "Values"].map((h) => (
                                    <th
                                        key={h}
                                        className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                    >
                                        {h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {keys.keys.map((key) => (
                                <tr key={key.kid}>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        <code className="text-xs">{key.kid}</code>
                                        {key.kid === activeKid && <Badge>Active</Badge>}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {new Date(key.createdAt).toLocaleDateString()}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {ageText(key.createdAt, now)}
                                    </td>
                                    <td className="py-2.5 px-2.5 border-b border-border">
                                        {key.envelopes ?? "Not counted yet"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {keys.countedAt && (
                    <p className="text-xs text-text-muted">Values were last counted {formatTime(keys.countedAt)}.</p>
                )}
            </Card>

            <Card title="Rotation">
                {!keys.available && (
                    <Alert>
                        Keys can&rsquo;t be rotated on this server: its keyring isn&rsquo;t kept where the server can
                        change it, or its copies can&rsquo;t be coordinated. See the deployment&rsquo;s configuration
                        encryption settings.
                    </Alert>
                )}
                {step}
                {running && (
                    <p className="text-sm text-text-muted mb-3">
                        {`Started ${formatTime(rotation.requestedAt)}${rotation.compromised ? ", reported as a key compromise" : ""}.`}
                    </p>
                )}
                {rotation?.warning && <Note>{rotation.warning}</Note>}
                {rotation?.lastError && <Alert>{rotation.lastError}</Alert>}
                {rotation?.compromised && (
                    <Note>
                        Because the keyring may have been exposed, replace the credentials saved here at their providers
                        (DNS provider tokens, the Giphy key, registry tokens, plugin secrets), then enter the new ones.
                        A keyring exposed together with a copy of the database has exposed the saved values themselves;
                        rotating the key doesn&rsquo;t undo that.
                    </Note>
                )}
                {failedCompromised && (
                    <Note>
                        The failed rotation was reported as a key compromise. Starting again with &ldquo;Rotate
                        configuration key&rdquo; doesn&rsquo;t carry that over: use &ldquo;Key compromised: rotate
                        now&rdquo; to keep it.
                    </Note>
                )}
                {rotation?.phase === "done" && (
                    <Note>
                        Back up the keyring again now. A copy taken before this rotation doesn&rsquo;t have the new key,
                        so it can&rsquo;t read the values saved after it.
                    </Note>
                )}
                {notice && (
                    <p role="status" className="text-sm text-text-muted mb-3">
                        {notice}
                    </p>
                )}
                {error && confirming === null && <Alert>{error}</Alert>}
                <div className="flex flex-wrap items-center gap-3">
                    {!running && (
                        <Button
                            type="button"
                            className="!w-auto"
                            disabled={busy || !keys.available}
                            onClick={() =>
                                void run(
                                    () => rotateConfigKey(),
                                    "Could not start the rotation.",
                                    "A rotation was already in progress; its progress is shown."
                                )
                            }
                        >
                            Rotate configuration key
                        </Button>
                    )}
                    {(!running || !rotation.compromised) && (
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto !border-danger !text-danger hover:!border-danger hover:!text-danger"
                            disabled={busy || !keys.available}
                            onClick={() => openDialog("compromised")}
                        >
                            Key compromised: rotate now
                        </Button>
                    )}
                    {rotation?.phase === "activating" && newKid && (
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto"
                            disabled={busy}
                            onClick={() => openDialog("activate")}
                        >
                            Activate anyway
                        </Button>
                    )}
                </div>
                <p className="text-xs text-text-muted mt-4">
                    A database backup can&rsquo;t be read without the keyring: back up the keyring with it (the Secret
                    ending in <code>-config-keyring</code>, or its OpenBao entry), and keep each keyring backup as long
                    as the database backups it serves.
                </p>
            </Card>

            {unreadable.length > 0 && (
                <Card title="Values that can't be read">
                    <p className="text-sm mb-2">
                        These saved values couldn&rsquo;t be decrypted with any key in the keyring (a database restored
                        with an older keyring, for example). Enter each again where it is set.
                    </p>
                    <p className="text-sm text-text-muted mb-2">
                        {keys.reencryption?.finishedAt
                            ? `This list was made by the re-encryption pass that finished ${formatTime(keys.reencryption.finishedAt)}; only a later pass updates it, so a value entered again stays listed until then.`
                            : "This list was made by the last re-encryption pass; only a later pass updates it, so a value entered again stays listed until then."}
                    </p>
                    <ul className="list-disc pl-5 text-sm">
                        {unreadable.map((item) => (
                            <li
                                key={`${item.record}/${item.uid}/${item.field}`}
                            >{`${item.record} ${item.uid}, ${item.field} (key ${item.kid})`}</li>
                        ))}
                    </ul>
                </Card>
            )}

            <Card title="Plugin secret settings">
                {keys.pluginSecrets?.encryptedAt ? (
                    <p className="text-sm">{`Encrypted since ${formatTime(keys.pluginSecrets.encryptedAt)}.`}</p>
                ) : (
                    <>
                        <p className="text-sm mb-2">
                            Not encrypted yet. Secret settings of plugins are saved as plain text until every server pod
                            runs this release and the first encryption run has finished.
                        </p>
                        {keys.pluginSecrets?.reason && (
                            <p className="text-sm text-text-muted">{keys.pluginSecrets.reason}</p>
                        )}
                    </>
                )}
            </Card>

            <Modal open={confirming === "compromised"} onClose={closeDialog} title="Key compromised">
                <p className="text-sm mb-3">
                    {running
                        ? "The rotation in progress is marked as a key compromise: the old key is removed as soon as every saved value has moved to the new one, with no waiting."
                        : "A new key is created and every saved value is re-encrypted with it, and the old key is removed as soon as nothing uses it."}
                </p>
                <p className="text-sm mb-3">
                    If the keyring was exposed together with a copy of the database, the saved values were exposed too:
                    afterwards, replace the credentials at their providers and enter the new ones here.
                </p>
                {error && <Alert>{error}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={busy} onClick={closeDialog}>
                        Back
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto"
                        loading={busy}
                        disabled={busy}
                        onClick={() =>
                            void run(
                                () => rotateConfigKey({ compromised: true }),
                                "Could not start the rotation.",
                                "A rotation was already in progress and is already marked as a key compromise; its progress is shown."
                            )
                        }
                    >
                        Rotate now
                    </Button>
                </div>
            </Modal>

            <Modal open={confirming === "activate"} onClose={closeDialog} title="Activate the new key anyway">
                {staleCopies.length > 0 ? (
                    <>
                        <p className="text-sm mb-2">
                            The new key encrypts from now on, before every server copy has loaded it. These copies still
                            encrypt with the old key, which every copy can read, but they can&rsquo;t read values saved
                            with the new key until they are replaced:
                        </p>
                        <CopyList label="Copies that will not be able to read new values" copies={staleCopies} />
                        <p className="text-sm mb-3">
                            Saved values are re-encrypted only once those copies are gone or have loaded the key. Do
                            this only if they are being replaced.
                        </p>
                    </>
                ) : (
                    <p className="text-sm mb-3">
                        No copy is waiting for the new key now; it is activated on its own within a moment, so there is
                        nothing to force.
                    </p>
                )}
                {error && <Alert>{error}</Alert>}
                <div className="flex gap-3 justify-end mt-5">
                    <Button type="button" variant="secondary" className="!w-auto" disabled={busy} onClick={closeDialog}>
                        Back
                    </Button>
                    <Button
                        type="button"
                        className="!w-auto"
                        loading={busy}
                        disabled={busy || !newKid}
                        onClick={() =>
                            void run(
                                () => activateConfigKey(newKid!),
                                "Could not activate the new key.",
                                "The new key is no longer waiting to be activated; the rotation's progress is shown."
                            )
                        }
                    >
                        Activate anyway
                    </Button>
                </div>
            </Modal>
        </>
    );
}
