///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { Contact, setContactFavorite, updateContact } from "../../../../lib/contacts/contactsApi.js";
import CopyIconButton from "../../../../lib/components/buttons/CopyIconButton.js";
import { useApiClient } from "../../../../lib/util/apiClientContext.js";
import { notifyApiError } from "../../notifications/apiErrors.js";
import FavoriteStarButton from "./FavoriteStarButton.js";
import Button from "../../../../lib/components/buttons/Button.js";
import Alert from "../../../../lib/components/feedback/Alert.js";
import ContactPhotoAvatar from "../../../../lib/components/avatar/ContactPhotoAvatar.js";
import ContactPhotoEditor from "./ContactPhotoEditor.js";
import KeyChangeReview from "./KeyChangeReview.js";
import { KEY_CHANGE_STALE_MESSAGE, formatDate, keyPinnedSince, revocationLabel } from "./contactKeys.js";
import { clearPinnedSignerCache } from "../mail/pinnedSigners.js";
import { type EndToEndFormat, isOpenPgpKey, keyFormat, OPENPGP_KEY_TYPE, type PublicKey, trustSigner } from "../../../../lib/crypto/keyvaultApi.js";
import { ApiRequestError } from "../../../../lib/util/api.js";

/** Groups a hex fingerprint into 4-character blocks (`ab12 cd34 ...`) for out-of-band verification -
 * the spec's own use case ("compare this over the phone") is materially easier with a grouped string
 * than one 64-character run. */
function formatFingerprint(fingerprint: string): string {
    return fingerprint.match(/.{1,4}/g)?.join(" ") ?? fingerprint;
}

/** A revoked key's reason: a superseded key was routinely replaced, a revoked one must not be trusted. */
function RevocationBadge({ label }: { label: "superseded" | "revoked" | undefined }) {
    if (!label) {
        return null;
    }
    return <span className={label === "superseded" ? "text-text-muted" : "text-danger"}> ({label})</span>;
}

export interface ContactDetailPaneProps {
    contact: Contact;
    onEdit: () => void;
    onDelete: () => void;
    /** Whether the reader may change this contact: `false` for one in a mailbox shared with them view-only, which gets no Edit or Delete. Default `true`. */
    canWrite?: boolean;
    /** Present only on the mobile detail route — renders a "back to contacts" link above the header. Absent
     * on the desktop inline pane, which never navigates away (selecting a different contact just swaps
     * `contact` in place). */
    backHref?: string;
    /** Called after one of the contact's key changes was accepted or kept, or turned out to be stale - the caller
     * re-reads the contact. */
    onKeysChanged?: () => void;
    /** Called with the contact after the star was toggled, so the caller shows the changed contact. */
    onChanged?: (contact: Contact) => void;
    /** `false` when the reader is known not to be able to change this contact (its key actions and the photo badge are hidden); `undefined`
     * when unknown (the key actions are hidden after a 403; a refused photo change is a pop-up). */
    canResolveKeys?: boolean;
}

/**
 * A contact's read-only detail view. Shared by the desktop inline pane (`apps/www/contacts/index.tsx`,
 * always visible alongside the contact list) and the mobile detail route
 * (`apps/www/contacts/[uid].tsx`, a full page on its own reached by tapping a contact row).
 */
export default function ContactDetailPane({ contact, onEdit, onDelete, canWrite = true, backHref, onKeysChanged, onChanged, canResolveKeys }: ContactDetailPaneProps) {
    const client = useApiClient();
    // The outcome of the last key decision, kept per contact so selecting another contact doesn't carry it over.
    const [keyNotice, setKeyNotice] = useState<{ contactUid: string; text: string } | null>(null);
    const notice = keyNotice?.contactUid === contact.uid ? keyNotice.text : null;
    const keyConflicts = contact.keyConflicts ?? [];
    const previousKeys = contact.previousKeys ?? [];

    // Not while a picture is being changed: that goes against the version the star would replace.
    const [photoBusy, setPhotoBusy] = useState(false);
    // Delete asks first - it also drops the pinned signing keys this contact vouches with - and the question belongs to the contact it was asked about.
    const [confirmingDeleteUid, setConfirmingDeleteUid] = useState<string | null>(null);
    const confirmingDelete = confirmingDeleteUid === contact.uid;

    async function handleToggleFavorite() {
        try {
            const changed = await setContactFavorite(contact, !contact.favorite, client);
            onChanged?.(changed);
        } catch (err) {
            notifyApiError(err, "Couldn't update this contact");
        }
    }

    // Pinned signing keys vouch for signatures, so the pinned-signer cache is dropped along with re-reading the contact.
    function refresh(text: string) {
        setKeyNotice({ contactUid: contact.uid, text });
        clearPinnedSignerCache();
        onKeysChanged?.();
    }

    return (
        <div role="region" aria-label="Contact details" className="max-w-xl flex flex-col gap-5">
            {backHref && (
                <a href={backHref} className="text-sm text-primary-dark hover:underline">
                    &larr; Back to contacts
                </a>
            )}
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                    {canResolveKeys === false ? (
                        <ContactPhotoAvatar displayName={contact.displayName} size={48} contact={contact} email={contact.emails[0]?.address} />
                    ) : (
                        <ContactPhotoEditor
                            contact={contact}
                            displayName={contact.displayName}
                            size={48}
                            badgeSize="sm"
                            email={contact.emails[0]?.address}
                            onChanged={(changed) => onChanged?.(changed)}
                            onBusyChange={setPhotoBusy}
                        />
                    )}
                    <div>
                        <h1 className="text-xl font-bold tracking-tight">
                            {contact.displayName}
                            <FavoriteStarButton favorite={!!contact.favorite} disabled={photoBusy} onToggle={() => void handleToggleFavorite()} className="ml-1 align-middle" />
                        </h1>
                        {contact.jobTitle && contact.company && (
                            <p className="text-sm text-text-muted mt-0.5">
                                {contact.jobTitle} at {contact.company}
                            </p>
                        )}
                    </div>
                </div>
                {canWrite && (
                    <div className="flex flex-wrap justify-end gap-2 shrink-0">
                        {confirmingDelete ? (
                            <>
                                <span role="alert" className="self-center text-sm">
                                    Delete this contact?
                                </span>
                                <Button type="button" variant="secondary" className="!w-auto text-danger" onClick={onDelete}>
                                    Yes, delete
                                </Button>
                                <Button type="button" variant="secondary" className="!w-auto" onClick={() => setConfirmingDeleteUid(null)}>
                                    Keep
                                </Button>
                            </>
                        ) : (
                            <>
                                <Button type="button" variant="secondary" className="!w-auto" onClick={onEdit}>
                                    Edit
                                </Button>
                                <Button type="button" variant="secondary" className="!w-auto text-danger" onClick={() => setConfirmingDeleteUid(contact.uid)}>
                                    Delete
                                </Button>
                            </>
                        )}
                    </div>
                )}
            </div>

            <div className="bg-surface border border-border rounded-md p-6 flex flex-col gap-4 text-sm">
                {contact.emails.length > 0 && (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Email</div>
                        {contact.emails.map((e, i) => (
                            <div key={i}>
                                {e.address}
                                <CopyIconButton value={e.address} label="Copy email address" className="mx-0.5" /> <span className="text-text-muted">({e.type})</span>
                            </div>
                        ))}
                    </div>
                )}
                {contact.phones.length > 0 && (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Phone</div>
                        {contact.phones.map((p, i) => (
                            <div key={i}>
                                {p.phoneNumber} <span className="text-text-muted">({p.type})</span>
                            </div>
                        ))}
                    </div>
                )}
                {contact.addresses.length > 0 && (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Address</div>
                        {contact.addresses.map((a, i) => (
                            <div key={i}>{[a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(", ")}</div>
                        ))}
                    </div>
                )}
                {contact.categories && contact.categories.length > 0 && (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Categories</div>
                        <div>{contact.categories.join(", ")}</div>
                    </div>
                )}
                {contact.notes && (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Notes</div>
                        <div>{contact.notes}</div>
                    </div>
                )}
                {(contact.keys && contact.keys.length > 0) ||
                contact.encryptPreference ||
                keyConflicts.length > 0 ||
                previousKeys.length > 0 ? (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Encryption</div>
                        {notice && (
                            <p role="status" className="mb-2 py-2 px-3 rounded-sm bg-surface-alt text-text">
                                {notice}
                            </p>
                        )}
                        {keyConflicts.map((conflict) => {
                            // Each format's key is pinned on its own: an OpenPGP key's conflict is with the pinned OpenPGP key.
                            const openPgp = isOpenPgpKey(conflict.observedKey);
                            const pinned = contact.keys?.find((key) => key.useType === conflict.useType && keyFormat(key) === keyFormat(conflict.observedKey));
                            const kind = openPgp ? "OpenPGP" : conflict.useType === "sign" ? "signing" : "encryption";
                            return (
                                <section
                                    key={`${conflict.useType}:${keyFormat(conflict.observedKey)}`}
                                    aria-label={`${openPgp ? "OpenPGP" : conflict.useType === "sign" ? "Signing" : "Encryption"} key change`}
                                    className="mb-3 py-3 px-3 rounded-sm bg-warning/15 text-text flex flex-col gap-2"
                                >
                                    <h2 className="font-semibold">
                                        A different {kind} key was seen for {contact.displayName}
                                    </h2>
                                    <p>The current key stays in use until you decide what to do with the new one.</p>
                                    <KeyChangeReview
                                        mailboxUid={contact.mailboxUid}
                                        address={contact.emails[0]?.address}
                                        useType={conflict.useType}
                                        {...(openPgp ? { keyType: "openpgp" as const } : {})}
                                        ownerName={contact.displayName}
                                        current={pinned && { fingerprint: pinned.fingerprint, since: keyPinnedSince(contact, pinned) }}
                                        proposed={{
                                            fingerprint: conflict.observedKey.fingerprint,
                                            observedAt: conflict.observedAt,
                                            source: conflict.source,
                                        }}
                                        canReject
                                        canResolve={canResolveKeys}
                                        onResolved={(action) =>
                                            refresh(
                                                action === "accept"
                                                    ? `The new ${kind} key is now trusted for ${contact.displayName}.`
                                                    : `You kept the current ${kind} key for ${contact.displayName}.`,
                                            )
                                        }
                                        onPinnedKeyChanged={() => refresh(KEY_CHANGE_STALE_MESSAGE)}
                                    />
                                </section>
                            );
                        })}
                        {contact.encryptPreference && (
                            <div className="mb-1">
                                {contact.encryptPreference.preferEncrypt === "mutual"
                                    ? "This contact also encrypts to you — messages to them can be encrypted."
                                    : "This contact has not indicated a mutual encryption preference."}
                            </div>
                        )}
                        {canWrite && contact.keys?.some((key) => isOpenPgpKey(key)) && (
                            <PreferredFormatControl contact={contact} onChanged={onChanged} />
                        )}
                        {contact.keys?.map((key) => (
                            <div key={key.fingerprint} className="font-mono text-xs py-0.5">
                                {keyLabel(key)} key: {formatFingerprint(key.fingerprint)}
                                <RevocationBadge label={revocationLabel(key)} />
                            </div>
                        ))}
                        {previousKeys.length > 0 && (
                            <div className="mt-3">
                                <div className="text-text-muted text-xs font-bold mb-1">Key history</div>
                                <ul aria-label="Key history">
                                    {previousKeys.map((key) => (
                                        <li key={`${key.useType}:${key.fingerprint}:${key.replacedAt}`} className="text-xs py-0.5">
                                            <span className="font-mono">
                                                {keyLabel(key)} key: {formatFingerprint(key.fingerprint)}
                                            </span>
                                            <RevocationBadge label={revocationLabel(key)} />
                                            <span className="text-text-muted">
                                                {" "}
                                                &middot;{" "}
                                                {key.replacement === "automatic" ? "Renewed automatically" : "Replaced by you"} on{" "}
                                                {formatDate(key.replacedAt)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                ) : null}
                {canWrite && contact.emails[0]?.address && !contact.keys?.some((key) => isOpenPgpKey(key)) && (
                    <OpenPgpKeyImport contact={contact} onImported={() => refresh("The OpenPGP key is now trusted for this contact.")} />
                )}
            </div>
        </div>
    );
}

const FORMAT_NAMES: Record<EndToEndFormat, string> = { smime: "S/MIME", openpgp: "OpenPGP" };

/** What "Automatic" picks for `contact` and why (restapi *Choosing the format*, after the user's own choice): what the address
 * advertises, else what it was last seen using, else S/MIME. */
function automaticFormat(contact: Contact): string {
    const advertised = contact.encryptPreference?.preferFormat;
    if (advertised) {
        return `${FORMAT_NAMES[advertised]}, which they asked for`;
    }
    const observed = contact.observedFormat?.format;
    return observed ? `${FORMAT_NAMES[observed]}, which they used last` : "S/MIME when they have a certificate";
}

/**
 * "Preferred format" for a contact who has an OpenPGP key: which format mail to them is encrypted in when they can receive both.
 * Automatic follows what they advertise or last used; S/MIME or OpenPGP overrides that - e.g. for someone who reads OpenPGP mail
 * but still has an S/MIME certificate from a former employer.
 */
function PreferredFormatControl({ contact, onChanged }: { contact: Contact; onChanged?: (contact: Contact) => void }) {
    const client = useApiClient();
    const [saving, setSaving] = useState(false);
    async function save(value: string) {
        setSaving(true);
        try {
            const changed = await updateContact(
                { uid: contact.uid, version: contact.version, preferredFormat: value === "smime" || value === "openpgp" ? value : null },
                client,
            );
            onChanged?.(changed);
        } catch (err) {
            notifyApiError(err, "Couldn't update this contact");
        } finally {
            setSaving(false);
        }
    }
    return (
        <label className="flex flex-wrap items-center gap-2 text-sm my-1">
            <span>Preferred format</span>
            <select
                className="border border-border rounded-sm py-1 px-2 bg-surface text-sm"
                value={contact.preferredFormat ?? "auto"}
                disabled={saving}
                onChange={(e) => void save(e.target.value)}
            >
                <option value="auto">Automatic ({automaticFormat(contact)})</option>
                <option value="smime">S/MIME</option>
                <option value="openpgp">OpenPGP</option>
            </select>
        </label>
    );
}

/** What a pinned key is called: an OpenPGP certificate by its format (it signs and encrypts), an S/MIME one by its use. */
function keyLabel(key: Pick<PublicKey, "useType" | "type">): string {
    return isOpenPgpKey(key) ? "OpenPGP" : key.useType === "sign" ? "Signing" : "Encryption";
}

/**
 * "Add OpenPGP key": pins an OpenPGP public key the user pasted (from the contact's website, a key they sent, a key server they
 * trust) for the contact's first address - `trustSigner()` with `type: "openpgp"`, which restapi checks names that address. For an
 * OpenPGP user whose domain publishes no Web Key Directory, this is how RapidMX can encrypt to them.
 */
function OpenPgpKeyImport({ contact, onImported }: { contact: Contact; onImported: () => void }) {
    const client = useApiClient();
    const [open, setOpen] = useState(false);
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    if (!open) {
        return (
            <div>
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => setOpen(true)}>
                    Add OpenPGP key&hellip;
                </Button>
            </div>
        );
    }
    async function handleImport(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await trustSigner(contact.mailboxUid, { address: contact.emails[0].address, certificate: text.trim(), type: OPENPGP_KEY_TYPE }, client);
            clearPinnedSignerCache();
            setOpen(false);
            setText("");
            onImported();
        } catch (err) {
            setError(
                err instanceof ApiRequestError && err.status === 400
                    ? `That isn't an OpenPGP public key for ${contact.emails[0].address} that can be used now.`
                    : err instanceof ApiRequestError && err.status === 409
                      ? "A different OpenPGP key is already trusted for this contact."
                      : "Couldn't add the key. Try again.",
            );
        } finally {
            setBusy(false);
        }
    }
    return (
        <form onSubmit={(e) => void handleImport(e)} className="flex flex-col gap-2">
            <label className="text-sm font-semibold" htmlFor={`openpgp-key-${contact.uid}`}>
                OpenPGP public key for {contact.emails[0].address}
            </label>
            <textarea
                id={`openpgp-key-${contact.uid}`}
                className="w-full text-xs font-mono border border-border rounded-sm py-1.5 px-2 bg-surface min-h-[8rem]"
                placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
            />
            {error && <Alert>{error}</Alert>}
            <div className="flex gap-2">
                <Button type="submit" className="!w-auto" loading={busy} disabled={busy || !text.trim()}>
                    Add key
                </Button>
                <Button type="button" variant="secondary" className="!w-auto" onClick={() => setOpen(false)} disabled={busy}>
                    Cancel
                </Button>
            </div>
        </form>
    );
}
