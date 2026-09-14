///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { toDatetimeLocal } from "@rapidmx/react-shared/util/dateInput.js";
import FormField from "@rapidmx/react-shared/components/forms/FormField.js";
import StringListField from "../../forms/StringListField.js";

const INPUT_CLASS =
    "w-full text-sm py-2.5 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** The part of an `EscrowScope` shared by the "new" and "[uid]" pages — everything except `name`/
 * `description`, which stay plain inline `FormField`s on each page (same split `distribution-lists`
 * already uses: simple top-level fields inline, the more involved sub-structure factored out). An admin
 * pastes in the fields of an already-issued certificate here; nothing in this app generates a keypair —
 * see `EscrowScopePublicKey`'s own doc comment in `escrowScopesApi.ts`. */
export interface EscrowScopeKeyAndHoldersValue {
    publicKey: string;
    keyType: string;
    fingerprint: string;
    /** `<input type="datetime-local">` value — see `toDatetimeLocal()`. */
    notBefore: string;
    notAfter: string;
    holderUserUids: string[];
    requiredHolders: number;
    notifySubjectOnAccess: boolean;
}

export interface EscrowScopeKeyAndHoldersFieldsProps {
    value: EscrowScopeKeyAndHoldersValue;
    onChange: (value: EscrowScopeKeyAndHoldersValue) => void;
    disabled?: boolean;
    /** Shows the public key fields without letting them be edited, e.g. for keys generated in the browser. */
    keyReadOnly?: boolean;
}

/** Builds an all-zeroes starting point for the "new" page — `notBefore`/`notAfter` default to "now" so an
 * admin pasting in a cert's own dates only has to touch what actually differs. */
export function emptyEscrowScopeKeyAndHoldersValue(): EscrowScopeKeyAndHoldersValue {
    const now = toDatetimeLocal(new Date().toISOString());
    return {
        publicKey: "",
        keyType: "x509",
        fingerprint: "",
        notBefore: now,
        notAfter: now,
        holderUserUids: [],
        requiredHolders: 1,
        notifySubjectOnAccess: false,
    };
}

/** The message shown when an administrator tries to make themselves a holder: whoever configures a scope must not
 * also be able to approve access under it (separation of duties - the server refuses it too). Holders who were
 * already on the scope (`existingHolderUserUids`) aren't treated as newly added. */
export function selfAsHolderError(
    holderUserUids: string[],
    adminUid: string | undefined,
    existingHolderUserUids: string[] = [],
): string | null {
    if (!adminUid || !holderUserUids.includes(adminUid) || existingHolderUserUids.includes(adminUid)) {
        return null;
    }
    return "You can't add yourself as a holder of an escrow scope you configure. Ask another administrator to add you, or choose different holders.";
}

export default function EscrowScopeKeyAndHoldersFields({ value, onChange, disabled, keyReadOnly }: EscrowScopeKeyAndHoldersFieldsProps) {
    function set<K extends keyof EscrowScopeKeyAndHoldersValue>(key: K, next: EscrowScopeKeyAndHoldersValue[K]) {
        onChange({ ...value, [key]: next });
    }

    return (
        <>
            <div className="bg-surface border border-border rounded-md p-6">
                <h2 className="text-base font-bold uppercase tracking-wide mb-1">Public key</h2>
                <p className="text-sm text-text-muted mb-4">
                    The fields of an already-issued certificate — this server never generates or holds the
                    corresponding private key.
                </p>

                <FormField label="Public key (base64)" htmlFor="publicKey">
                    <textarea
                        id="publicKey"
                        className={`${INPUT_CLASS} font-mono text-xs`}
                        rows={4}
                        value={value.publicKey}
                        disabled={disabled}
                        readOnly={keyReadOnly}
                        onChange={(e) => set("publicKey", e.target.value)}
                    />
                </FormField>

                <FormField label="Key type" htmlFor="keyType">
                    <input
                        id="keyType"
                        type="text"
                        className={INPUT_CLASS}
                        value={value.keyType}
                        disabled={disabled}
                        readOnly={keyReadOnly}
                        onChange={(e) => set("keyType", e.target.value)}
                        placeholder="x509"
                    />
                </FormField>

                <FormField label="Fingerprint (hex SHA-256)" htmlFor="fingerprint">
                    <input
                        id="fingerprint"
                        type="text"
                        className={`${INPUT_CLASS} font-mono`}
                        value={value.fingerprint}
                        disabled={disabled}
                        readOnly={keyReadOnly}
                        onChange={(e) => set("fingerprint", e.target.value)}
                    />
                </FormField>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                    <FormField label="Not before" htmlFor="notBefore">
                        <input
                            id="notBefore"
                            type="datetime-local"
                            className={INPUT_CLASS}
                            value={value.notBefore}
                            disabled={disabled}
                            readOnly={keyReadOnly}
                            onChange={(e) => set("notBefore", e.target.value)}
                        />
                    </FormField>

                    <FormField label="Not after" htmlFor="notAfter">
                        <input
                            id="notAfter"
                            type="datetime-local"
                            className={INPUT_CLASS}
                            value={value.notAfter}
                            disabled={disabled}
                            readOnly={keyReadOnly}
                            onChange={(e) => set("notAfter", e.target.value)}
                        />
                    </FormField>
                </div>
            </div>

            <div className="bg-surface border border-border rounded-md p-6">
                <h2 className="text-base font-bold uppercase tracking-wide mb-1">Holders &amp; dual control</h2>
                <p className="text-sm text-text-muted mb-4">
                    Every uid below is granted the eDiscovery/compliance holder role for this scope — a
                    deliberately separate role from server administration. At least one holder is required.
                </p>

                <StringListField
                    label="Holder user uids"
                    id="holderUserUids"
                    values={value.holderUserUids}
                    onChange={(holderUserUids) => set("holderUserUids", holderUserUids)}
                    placeholder="User uid to add"
                    emptyMessage="No holders added yet."
                    disabled={disabled}
                />

                <FormField label="Required holders (M-of-N dual control)" htmlFor="requiredHolders">
                    {/* Deliberately no HTML `min`/`max` attributes: the true bound (1..holderUserUids.length)
                        moves as holders are added/removed, and jsdom (like a real browser) blocks native
                        form submission outright once a number input's value falls outside `min`/`max` —
                        which would silently swallow the Save/Create click with no error shown at all while
                        a holder is being removed. The page's own submit-time check (and restapi's own
                        `validateEscrowScope()` server-side) enforce the real bound instead. */}
                    <input
                        id="requiredHolders"
                        type="number"
                        className={INPUT_CLASS}
                        value={value.requiredHolders}
                        disabled={disabled}
                        onChange={(e) => set("requiredHolders", Number(e.target.value) || 1)}
                    />
                </FormField>

                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={value.notifySubjectOnAccess}
                        disabled={disabled}
                        onChange={(e) => set("notifySubjectOnAccess", e.target.checked)}
                    />
                    Notify subject on access
                </label>
            </div>
        </>
    );
}
