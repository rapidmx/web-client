///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { Contact } from "@rapidmx/react-shared/contacts/contactsApi.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import ContactAvatar from "@rapidmx/react-shared/components/avatar/ContactAvatar.js";
import KeyChangeReview from "./KeyChangeReview.js";
import { KEY_CHANGE_STALE_MESSAGE, formatDate, keyPinnedSince, revocationLabel } from "./contactKeys.js";
import { clearPinnedSignerCache } from "../mail/pinnedSigners.js";

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
    /** Present only on the mobile detail route — renders a "back to contacts" link above the header. Absent
     * on the desktop inline pane, which never navigates away (selecting a different contact just swaps
     * `contact` in place). */
    backHref?: string;
    /** Called after one of the contact's key changes was accepted or kept, or turned out to be stale - the caller
     * re-reads the contact. */
    onKeysChanged?: () => void;
    /** `false` when the reader is known not to be able to change this contact's keys (the actions are hidden); `undefined`
     * when unknown (they're hidden after a 403). */
    canResolveKeys?: boolean;
}

/**
 * A contact's read-only detail view. Shared by the desktop inline pane (`apps/www/contacts/index.tsx`,
 * always visible alongside the contact list) and the mobile detail route
 * (`apps/www/contacts/[uid].tsx`, a full page on its own reached by tapping a contact row).
 */
export default function ContactDetailPane({ contact, onEdit, onDelete, backHref, onKeysChanged, canResolveKeys }: ContactDetailPaneProps) {
    // The outcome of the last key decision, kept per contact so selecting another contact doesn't carry it over.
    const [keyNotice, setKeyNotice] = useState<{ contactUid: string; text: string } | null>(null);
    const notice = keyNotice?.contactUid === contact.uid ? keyNotice.text : null;
    const keyConflicts = contact.keyConflicts ?? [];
    const previousKeys = contact.previousKeys ?? [];

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
                    <ContactAvatar displayName={contact.displayName} size={48} />
                    <div>
                        <h1 className="text-xl font-bold tracking-tight">{contact.displayName}</h1>
                        {contact.jobTitle && contact.company && (
                            <p className="text-sm text-text-muted mt-0.5">
                                {contact.jobTitle} at {contact.company}
                            </p>
                        )}
                    </div>
                </div>
                <div className="flex gap-2 shrink-0">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={onEdit}>
                        Edit
                    </Button>
                    <Button type="button" variant="secondary" className="!w-auto text-danger" onClick={onDelete}>
                        Delete
                    </Button>
                </div>
            </div>

            <div className="bg-surface border border-border rounded-md p-6 flex flex-col gap-4 text-sm">
                {contact.emails.length > 0 && (
                    <div>
                        <div className="text-text-muted text-xs font-bold uppercase tracking-wide mb-1">Email</div>
                        {contact.emails.map((e, i) => (
                            <div key={i}>
                                {e.address} <span className="text-text-muted">({e.type})</span>
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
                            const pinned = contact.keys?.find((key) => key.useType === conflict.useType);
                            const kind = conflict.useType === "sign" ? "signing" : "encryption";
                            return (
                                <section
                                    key={conflict.useType}
                                    aria-label={`${conflict.useType === "sign" ? "Signing" : "Encryption"} key change`}
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
                        {contact.keys?.map((key) => (
                            <div key={key.fingerprint} className="font-mono text-xs py-0.5">
                                {key.useType === "sign" ? "Signing" : "Encryption"} key: {formatFingerprint(key.fingerprint)}
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
                                                {key.useType === "sign" ? "Signing" : "Encryption"} key: {formatFingerprint(key.fingerprint)}
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
            </div>
        </div>
    );
}
