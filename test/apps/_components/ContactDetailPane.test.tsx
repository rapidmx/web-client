// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The bulk of this component's rendering logic (every optional field, Edit/Delete callbacks) is already
// exercised end-to-end via `test/apps/contacts/index.test.tsx` (ContactsContent renders this component,
// unmocked, for the desktop selected-contact pane). This file only covers what that one doesn't: the
// `backHref` prop, which only the mobile detail route (`apps/www/contacts/[uid].tsx`) ever passes - plus key rotation
// continuity: recorded key changes with accept/keep, key history and revocation labels.
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinnedKeyChangedError, type PublicKey } from "../../../lib/crypto/keyvaultApi.js";
import { ApiRequestError } from "../../../lib/util/api.js";
import ContactDetailPane from "../../../apps/shared/components/contacts/ContactDetailPane.js";
import { KEY_CHANGE_FORBIDDEN_MESSAGE, KEY_CHANGE_STALE_MESSAGE } from "../../../apps/shared/components/contacts/contactKeys.js";
import type { Contact } from "../../../lib/contacts/contactsApi.js";
import { prepareContactPhoto } from "../../../lib/contacts/preparePhoto.js";
import { jsonResponse, mockFetch } from "../testUtils.js";

// Making a picture small enough is `preparePhoto.test.ts`'s business (jsdom cannot decode or draw one): here the pane is handed the file as it was chosen.
vi.mock("../../../lib/contacts/preparePhoto.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/contacts/preparePhoto.js")>()),
    prepareContactPhoto: vi.fn(async (file: File) => file),
}));

const { resolveKeyConflict, clearPinnedSignerCache, trustSigner } = vi.hoisted(() => ({ resolveKeyConflict: vi.fn(), clearPinnedSignerCache: vi.fn(), trustSigner: vi.fn() }));
vi.mock("../../../lib/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/crypto/keyvaultApi.js")>()),
    resolveKeyConflict,
    trustSigner,
}));
vi.mock("../../../apps/shared/components/mail/pinnedSigners.js", () => ({ clearPinnedSignerCache }));
const { updateContact, notifyApiError } = vi.hoisted(() => ({ updateContact: vi.fn(), notifyApiError: vi.fn() }));
vi.mock("../../../lib/contacts/contactsApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/contacts/contactsApi.js")>()),
    updateContact,
}));
vi.mock("../../../apps/shared/notifications/apiErrors.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../apps/shared/notifications/apiErrors.js")>()),
    notifyApiError,
}));

afterEach(() => {
    resolveKeyConflict.mockReset();
    trustSigner.mockReset();
    clearPinnedSignerCache.mockReset();
});

function key(useType: "sign" | "encrypt", fingerprint: string, extra: Partial<PublicKey> = {}): PublicKey {
    return { publicKey: "p", type: "x509", useType, fingerprint, notBefore: Date.UTC(2025, 0, 1), notAfter: Date.UTC(2027, 0, 1), ...extra };
}

function contactFixture(overrides: Partial<Contact> = {}): Contact {
    return {
        uid: "c1",
        version: 0,
        dateCreated: "",
        dateModified: "",
        mailboxUid: "mb1",
        folderUid: "f1",
        displayName: "Jane Doe",
        emails: [],
        phones: [],
        addresses: [],
        ...overrides,
    };
}

describe("ContactDetailPane", () => {
    it("renders no back link when backHref is absent", () => {
        render(<ContactDetailPane contact={contactFixture()} onEdit={vi.fn()} onDelete={vi.fn()} />);
        expect(screen.queryByRole("link", { name: /Back to contacts/ })).not.toBeInTheDocument();
    });

    it("renders a back link to the given href when backHref is present", () => {
        render(<ContactDetailPane contact={contactFixture()} onEdit={vi.fn()} onDelete={vi.fn()} backHref="/contacts" />);
        expect(screen.getByRole("link", { name: /Back to contacts/ })).toHaveAttribute("href", "/contacts");
    });

    it("calls onEdit and onDelete from their respective buttons", async () => {
        const onEdit = vi.fn();
        const onDelete = vi.fn();
        const user = userEvent.setup();
        render(<ContactDetailPane contact={contactFixture()} onEdit={onEdit} onDelete={onDelete} />);

        await user.click(screen.getByRole("button", { name: "Edit" }));
        expect(onEdit).toHaveBeenCalledTimes(1);

        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(screen.getByText("Delete this contact?")).toBeInTheDocument();
        expect(onDelete).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Keep" }));
        expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
        expect(onDelete).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Delete" }));
        await user.click(screen.getByRole("button", { name: "Yes, delete" }));
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("asks again for the next contact, not carrying one's question over to another", async () => {
        const user = userEvent.setup();
        const { rerender } = render(<ContactDetailPane contact={contactFixture()} onEdit={vi.fn()} onDelete={vi.fn()} />);
        await user.click(screen.getByRole("button", { name: "Delete" }));

        rerender(<ContactDetailPane contact={contactFixture({ uid: "other" })} onEdit={vi.fn()} onDelete={vi.fn()} />);
        expect(screen.queryByText("Delete this contact?")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    });

    it("offers no Edit or Delete for a contact the reader may only read", () => {
        render(<ContactDetailPane contact={contactFixture()} onEdit={vi.fn()} onDelete={vi.fn()} canWrite={false} />);
        expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    });

    it("falls back to the raw string when a fingerprint doesn't match the grouping pattern (defensive - real fingerprints always do)", () => {
        const contact = contactFixture({
            keys: [{ publicKey: "x", type: "x509", useType: "encrypt", fingerprint: "", notBefore: 1, notAfter: 2 }],
        });
        render(<ContactDetailPane contact={contact} onEdit={vi.fn()} onDelete={vi.fn()} />);
        expect(screen.getByText(/Encryption key:/)).toBeInTheDocument();
    });
});

describe("ContactDetailPane: key rotation continuity", () => {
    const FIRST_SEEN = Date.UTC(2025, 2, 4);
    const OBSERVED = Date.UTC(2026, 1, 3);
    const REPLACED = Date.UTC(2025, 8, 9);

    function conflicted(overrides: Partial<Contact> = {}) {
        return contactFixture({
            emails: [{ address: "jane@example.com", type: "work" }],
            keys: [key("sign", "aaaa1111"), key("encrypt", "eeee2222")],
            keyConflicts: [
                { useType: "sign", observedKey: key("sign", "bbbb3333"), observedAt: OBSERVED, source: "header" },
                { useType: "encrypt", observedKey: key("encrypt", "ffff4444"), observedAt: OBSERVED, source: "discovery" },
            ],
            ...({ keysFirstSeen: FIRST_SEEN } as Partial<Contact>),
            ...overrides,
        });
    }

    it("shows each recorded key change with both fingerprints, dates and source, without the old no-action copy", () => {
        render(<ContactDetailPane contact={conflicted()} onEdit={vi.fn()} onDelete={vi.fn()} />);

        const signing = within(screen.getByRole("region", { name: "Signing key change" }));
        expect(signing.getByRole("heading", { name: "A different signing key was seen for Jane Doe" })).toBeInTheDocument();
        expect(signing.getByText("aaaa 1111")).toBeInTheDocument();
        expect(signing.getByText(`First seen ${new Date(FIRST_SEEN).toLocaleDateString()}`)).toBeInTheDocument();
        expect(signing.getByText("bbbb 3333")).toBeInTheDocument();
        expect(signing.getByText(`First seen ${new Date(OBSERVED).toLocaleDateString()}, from an incoming message`)).toBeInTheDocument();
        expect(signing.getByRole("button", { name: "Accept new key" })).toBeInTheDocument();
        expect(signing.getByRole("button", { name: "Keep current key" })).toBeInTheDocument();

        const encryption = within(screen.getByRole("region", { name: "Encryption key change" }));
        expect(encryption.getByText("eeee 2222")).toBeInTheDocument();
        expect(encryption.getByText(`First seen ${new Date(OBSERVED).toLocaleDateString()}, by key discovery`)).toBeInTheDocument();

        expect(screen.queryByText(/no automatic way to accept or reject/)).not.toBeInTheDocument();
    });

    it("dates the current key from its newest replacement, falling back to its notBefore", () => {
        const { unmount } = render(
            <ContactDetailPane
                contact={conflicted({
                    previousKeys: [{ ...key("sign", "0000"), replacedAt: REPLACED, replacement: "automatic" }],
                })}
                onEdit={vi.fn()}
                onDelete={vi.fn()}
            />,
        );
        expect(within(screen.getByRole("region", { name: "Signing key change" })).getByText(`First seen ${new Date(REPLACED).toLocaleDateString()}`)).toBeInTheDocument();
        unmount();

        const noFirstSeen = contactFixture({
            emails: [{ address: "jane@example.com", type: "work" }],
            keys: [key("sign", "aaaa1111")],
            keyConflicts: [{ useType: "sign", observedKey: key("sign", "bbbb3333"), observedAt: OBSERVED, source: "header" }],
        });
        render(<ContactDetailPane contact={noFirstSeen} onEdit={vi.fn()} onDelete={vi.fn()} />);
        expect(screen.getByText(`First seen ${new Date(Date.UTC(2025, 0, 1)).toLocaleDateString()}`)).toBeInTheDocument();
    });

    it("hides the actions without a pinned key of that use, without an email address, or without rights", () => {
        const { unmount } = render(
            <ContactDetailPane contact={conflicted({ keys: [key("encrypt", "eeee2222")] })} onEdit={vi.fn()} onDelete={vi.fn()} />,
        );
        const signing = within(screen.getByRole("region", { name: "Signing key change" }));
        expect(signing.getByText("The key you trust couldn’t be loaded.")).toBeInTheDocument();
        expect(signing.queryByRole("button", { name: "Accept new key" })).not.toBeInTheDocument();
        unmount();

        const second = render(<ContactDetailPane contact={conflicted({ emails: [] })} onEdit={vi.fn()} onDelete={vi.fn()} />);
        expect(screen.queryByRole("button", { name: "Accept new key" })).not.toBeInTheDocument();
        second.unmount();

        render(<ContactDetailPane contact={conflicted()} onEdit={vi.fn()} onDelete={vi.fn()} canResolveKeys={false} />);
        expect(screen.queryByRole("button", { name: "Accept new key" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Keep current key" })).not.toBeInTheDocument();
    });

    it("confirms before accepting the recorded key (no certificate), then refreshes; Cancel changes nothing", async () => {
        resolveKeyConflict.mockResolvedValue({ keys: [] });
        const onKeysChanged = vi.fn();
        const user = userEvent.setup();
        render(<ContactDetailPane contact={conflicted()} onEdit={vi.fn()} onDelete={vi.fn()} onKeysChanged={onKeysChanged} />);

        const signing = within(screen.getByRole("region", { name: "Signing key change" }));
        await user.click(signing.getByRole("button", { name: "Accept new key" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
        expect(resolveKeyConflict).not.toHaveBeenCalled();
        expect(onKeysChanged).not.toHaveBeenCalled();

        await user.click(signing.getByRole("button", { name: "Accept new key" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Accept new key" }));

        expect(await screen.findByText("The new signing key is now trusted for Jane Doe.")).toBeInTheDocument();
        expect(resolveKeyConflict).toHaveBeenCalledWith("mb1", {
            address: "jane@example.com",
            useType: "sign",
            action: "accept",
            expectedPinnedFingerprint: "aaaa1111",
        });
        expect(clearPinnedSignerCache).toHaveBeenCalled();
        expect(onKeysChanged).toHaveBeenCalledTimes(1);
    });

    it("keeps the current key, and works without an onKeysChanged callback", async () => {
        resolveKeyConflict.mockResolvedValue({ keys: [] });
        const user = userEvent.setup();
        render(<ContactDetailPane contact={conflicted()} onEdit={vi.fn()} onDelete={vi.fn()} />);

        await user.click(within(screen.getByRole("region", { name: "Encryption key change" })).getByRole("button", { name: "Keep current key" }));

        expect(await screen.findByText("You kept the current encryption key for Jane Doe.")).toBeInTheDocument();
        expect(resolveKeyConflict).toHaveBeenCalledWith("mb1", {
            address: "jane@example.com",
            useType: "encrypt",
            action: "reject",
            expectedPinnedFingerprint: "eeee2222",
        });
    });

    it("says the keys changed meanwhile after a 409, reloads, and drops the notice for another contact", async () => {
        resolveKeyConflict.mockRejectedValue(new PinnedKeyChangedError("changed"));
        const onKeysChanged = vi.fn();
        const user = userEvent.setup();
        const { rerender } = render(<ContactDetailPane contact={conflicted()} onEdit={vi.fn()} onDelete={vi.fn()} onKeysChanged={onKeysChanged} />);

        await user.click(within(screen.getByRole("region", { name: "Signing key change" })).getByRole("button", { name: "Keep current key" }));

        expect(await screen.findByText(KEY_CHANGE_STALE_MESSAGE)).toBeInTheDocument();
        expect(onKeysChanged).toHaveBeenCalledTimes(1);
        expect(clearPinnedSignerCache).toHaveBeenCalled();

        rerender(<ContactDetailPane contact={conflicted({ uid: "c2" })} onEdit={vi.fn()} onDelete={vi.fn()} onKeysChanged={onKeysChanged} />);
        expect(screen.queryByText(KEY_CHANGE_STALE_MESSAGE)).not.toBeInTheDocument();
    });

    it("hides a change's actions after a 403 without reloading", async () => {
        resolveKeyConflict.mockRejectedValue(new ApiRequestError("forbidden", 403));
        const onKeysChanged = vi.fn();
        const user = userEvent.setup();
        render(<ContactDetailPane contact={conflicted()} onEdit={vi.fn()} onDelete={vi.fn()} onKeysChanged={onKeysChanged} />);

        const signing = within(screen.getByRole("region", { name: "Signing key change" }));
        await user.click(signing.getByRole("button", { name: "Accept new key" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Accept new key" }));

        expect(await signing.findByText(KEY_CHANGE_FORBIDDEN_MESSAGE)).toBeInTheDocument();
        await waitFor(() => expect(signing.queryByRole("button", { name: "Accept new key" })).not.toBeInTheDocument());
        expect(onKeysChanged).not.toHaveBeenCalled();
    });

    it("lists previous keys as a history of automatic renewals and user replacements", () => {
        const contact = contactFixture({
            keys: [key("sign", "cccc5555")],
            previousKeys: [
                { ...key("sign", "aaaa1111", { revokedAt: 5, revocationReason: "superseded" }), replacedAt: REPLACED, replacement: "automatic" },
                { ...key("encrypt", "bbbb2222"), replacedAt: FIRST_SEEN, replacement: "user" },
            ],
        });
        render(<ContactDetailPane contact={contact} onEdit={vi.fn()} onDelete={vi.fn()} />);

        const history = within(screen.getByRole("list", { name: "Key history" }));
        const [renewed, replaced] = history.getAllByRole("listitem");
        expect(renewed).toHaveTextContent("Signing key: aaaa 1111");
        expect(renewed).toHaveTextContent("(superseded)");
        expect(renewed).toHaveTextContent(`Renewed automatically on ${new Date(REPLACED).toLocaleDateString()}`);
        expect(replaced).toHaveTextContent("Encryption key: bbbb 2222");
        expect(replaced).toHaveTextContent(`Replaced by you on ${new Date(FIRST_SEEN).toLocaleDateString()}`);
        expect(replaced).not.toHaveTextContent("(");
    });

    it("shows the Encryption section for a contact with only key history", () => {
        render(
            <ContactDetailPane
                contact={contactFixture({ previousKeys: [{ ...key("sign", "aaaa"), replacedAt: REPLACED, replacement: "user" }] })}
                onEdit={vi.fn()}
                onDelete={vi.fn()}
            />,
        );
        expect(screen.getByText("Encryption")).toBeInTheDocument();
        expect(screen.getByRole("list", { name: "Key history" })).toBeInTheDocument();
    });

    it("labels revoked keys by reason: superseded is routine, compromised or unexplained is revoked", () => {
        const contact = contactFixture({
            keys: [
                key("sign", "1111", { revokedAt: 1, revocationReason: "superseded" }),
                key("sign", "2222", { revokedAt: 1, revocationReason: "compromised" }),
                key("sign", "3333", { revokedAt: 1 }),
                key("sign", "4444"),
            ],
        });
        render(<ContactDetailPane contact={contact} onEdit={vi.fn()} onDelete={vi.fn()} />);

        expect(screen.getByText(/Signing key: 1111/)).toHaveTextContent("(superseded)");
        expect(screen.getByText("(superseded)")).toHaveClass("text-text-muted");
        expect(screen.getByText(/Signing key: 2222/)).toHaveTextContent("(revoked)");
        expect(screen.getByText(/Signing key: 3333/)).toHaveTextContent("(revoked)");
        expect(screen.getAllByText("(revoked)").every((el) => el.classList.contains("text-danger"))).toBe(true);
        expect(screen.getByText(/Signing key: 4444/)).not.toHaveTextContent("(");
    });
});

describe("ContactDetailPane: OpenPGP keys", () => {
    const openPgp = (fingerprint: string) => key("encrypt", fingerprint, { type: "openpgp" });
    const jane = (overrides: Partial<Contact> = {}) => contactFixture({ emails: [{ address: "jane@proton.me", type: "work" }], ...overrides });
    const ARMORED = ["-----BEGIN PGP PUBLIC KEY BLOCK-----", "abc", "-----END PGP PUBLIC KEY BLOCK-----"].join("\n");

    it("labels a pinned OpenPGP key and reviews its change against the pinned OpenPGP key, not the S/MIME one", async () => {
        resolveKeyConflict.mockResolvedValue({ keys: [] });
        const user = userEvent.setup();
        render(
            <ContactDetailPane
                contact={jane({
                    keys: [key("encrypt", "eeee2222"), openPgp("aaaa1111")],
                    keyConflicts: [{ useType: "encrypt", observedKey: openPgp("bbbb3333"), observedAt: Date.UTC(2026, 1, 3), source: "discovery" }],
                })}
                onEdit={vi.fn()}
                onDelete={vi.fn()}
            />,
        );

        expect(screen.getByText(/OpenPGP key: aaaa 1111/)).toBeInTheDocument();
        expect(screen.getByText(/Encryption key: eeee 2222/)).toBeInTheDocument();
        const review = within(screen.getByRole("region", { name: "OpenPGP key change" }));
        expect(review.getByText("aaaa 1111")).toBeInTheDocument();
        await user.click(review.getByRole("button", { name: "Keep current key" }));
        await waitFor(() => expect(resolveKeyConflict).toHaveBeenCalled());
        expect(resolveKeyConflict.mock.calls[0][1]).toMatchObject({ useType: "encrypt", expectedPinnedFingerprint: "aaaa1111", type: "openpgp" });
        // Nothing to add while one is pinned.
        expect(screen.queryByRole("button", { name: /Add OpenPGP key/ })).not.toBeInTheDocument();
    });

    it("pins a pasted OpenPGP key for the contact's address and says so", async () => {
        trustSigner.mockResolvedValue({ keys: [] });
        const onKeysChanged = vi.fn();
        const user = userEvent.setup();
        const { rerender } = render(<ContactDetailPane contact={jane()} onEdit={vi.fn()} onDelete={vi.fn()} onKeysChanged={onKeysChanged} />);

        await user.click(screen.getByRole("button", { name: /Add OpenPGP key/ }));
        const add = screen.getByRole("button", { name: "Add key" });
        expect(add).toBeDisabled();
        fireEvent.change(screen.getByLabelText("OpenPGP public key for jane@proton.me"), { target: { value: `  ${ARMORED}\n` } });
        await user.click(add);

        await waitFor(() => expect(onKeysChanged).toHaveBeenCalled());
        expect(trustSigner).toHaveBeenCalledWith("mb1", { address: "jane@proton.me", certificate: ARMORED, type: "openpgp" }, undefined);
        expect(clearPinnedSignerCache).toHaveBeenCalled();
        // The parent reloads the contact, which now has the key.
        rerender(<ContactDetailPane contact={jane({ keys: [openPgp("aaaa1111")] })} onEdit={vi.fn()} onDelete={vi.fn()} onKeysChanged={onKeysChanged} />);
        expect(screen.getByText("The OpenPGP key is now trusted for this contact.")).toBeInTheDocument();
        expect(screen.queryByLabelText("OpenPGP public key for jane@proton.me")).not.toBeInTheDocument();
    });

    it.each([
        [new ApiRequestError("bad key", 400), "That isn't an OpenPGP public key for jane@proton.me that can be used now."],
        [new ApiRequestError("conflict", 409), "A different OpenPGP key is already trusted for this contact."],
        [new ApiRequestError("down", 503), "Couldn't add the key. Try again."],
        [new Error("offline"), "Couldn't add the key. Try again."],
    ])("explains a refused key (%s)", async (error, message) => {
        trustSigner.mockRejectedValue(error);
        const user = userEvent.setup();
        render(<ContactDetailPane contact={jane()} onEdit={vi.fn()} onDelete={vi.fn()} />);
        await user.click(screen.getByRole("button", { name: /Add OpenPGP key/ }));
        fireEvent.change(screen.getByLabelText("OpenPGP public key for jane@proton.me"), { target: { value: ARMORED } });
        await user.click(screen.getByRole("button", { name: "Add key" }));
        expect(await screen.findByText(message)).toBeInTheDocument();
        expect(clearPinnedSignerCache).not.toHaveBeenCalled();
    });

    it("cancels the form, and offers nothing without an address or write access", async () => {
        const user = userEvent.setup();
        const { unmount } = render(<ContactDetailPane contact={jane()} onEdit={vi.fn()} onDelete={vi.fn()} />);
        await user.click(screen.getByRole("button", { name: /Add OpenPGP key/ }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByRole("button", { name: /Add OpenPGP key/ })).toBeInTheDocument();
        unmount();

        const second = render(<ContactDetailPane contact={contactFixture()} onEdit={vi.fn()} onDelete={vi.fn()} />);
        expect(screen.queryByRole("button", { name: /Add OpenPGP key/ })).not.toBeInTheDocument();
        second.unmount();
        render(<ContactDetailPane contact={jane()} onEdit={vi.fn()} onDelete={vi.fn()} canWrite={false} />);
        expect(screen.queryByRole("button", { name: /Add OpenPGP key/ })).not.toBeInTheDocument();
    });
});

describe("ContactDetailPane: preferred format", () => {
    const openPgp = key("encrypt", "aaaa1111", { type: "openpgp" });
    const both = (overrides: Partial<Contact> = {}) =>
        contactFixture({ emails: [{ address: "jane@example.com", type: "work" }], keys: [key("encrypt", "eeee2222"), openPgp], ...overrides });

    afterEach(() => {
        updateContact.mockReset();
        notifyApiError.mockReset();
    });

    it("is offered only for a contact with an OpenPGP key, to someone who can change the contact", () => {
        const { unmount } = render(<ContactDetailPane contact={both({ keys: [key("encrypt", "eeee2222")] })} onEdit={vi.fn()} onDelete={vi.fn()} />);
        expect(screen.queryByLabelText(/Preferred format/)).not.toBeInTheDocument();
        unmount();
        render(<ContactDetailPane contact={both()} onEdit={vi.fn()} onDelete={vi.fn()} canWrite={false} />);
        expect(screen.queryByLabelText(/Preferred format/)).not.toBeInTheDocument();
    });

    it.each([
        [{}, "Automatic (S/MIME when they have a certificate)"],
        [{ observedFormat: { format: "openpgp" as const, at: 1 } }, "Automatic (OpenPGP, which they used last)"],
        [
            { encryptPreference: { preferEncrypt: "mutual" as const, preferFormat: "smime" as const }, observedFormat: { format: "openpgp" as const, at: 1 } },
            "Automatic (S/MIME, which they asked for)",
        ],
    ])("says what Automatic picks (%o)", (overrides, label) => {
        render(<ContactDetailPane contact={both(overrides)} onEdit={vi.fn()} onDelete={vi.fn()} />);
        expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
        expect(screen.getByLabelText(/Preferred format/)).toHaveValue("auto");
    });

    it("saves the choice on the contact, and Automatic as none", async () => {
        const onChanged = vi.fn();
        updateContact.mockImplementation(async (patch: any) => ({ ...both(), ...patch, version: 1 }));
        const user = userEvent.setup();
        const { rerender } = render(<ContactDetailPane contact={both()} onEdit={vi.fn()} onDelete={vi.fn()} onChanged={onChanged} />);

        await user.selectOptions(screen.getByLabelText(/Preferred format/), "openpgp");
        await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ preferredFormat: "openpgp" })));
        expect(updateContact).toHaveBeenCalledWith({ uid: "c1", version: 0, preferredFormat: "openpgp" }, undefined);

        rerender(<ContactDetailPane contact={both({ preferredFormat: "openpgp", version: 1 })} onEdit={vi.fn()} onDelete={vi.fn()} onChanged={onChanged} />);
        expect(screen.getByLabelText(/Preferred format/)).toHaveValue("openpgp");
        await user.selectOptions(screen.getByLabelText(/Preferred format/), "auto");
        await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(2));
        expect(updateContact.mock.calls[1][0]).toEqual({ uid: "c1", version: 1, preferredFormat: null });
    });

    it("says so when the choice can't be saved", async () => {
        updateContact.mockRejectedValue(new ApiRequestError("conflict", 409));
        const user = userEvent.setup();
        render(<ContactDetailPane contact={both()} onEdit={vi.fn()} onDelete={vi.fn()} />);
        await user.selectOptions(screen.getByLabelText(/Preferred format/), "smime");
        await waitFor(() => expect(notifyApiError).toHaveBeenCalledWith(expect.any(ApiRequestError), "Couldn't update this contact"));
        expect(screen.getByLabelText(/Preferred format/)).not.toBeDisabled();
    });
});

describe("ContactDetailPane photo badge", () => {
    it("changes the picture at once from a small camera badge on the avatar, and hands the changed contact back", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, contactFixture({ version: 6, photoBlobKey: "contact-photos/c1/x" })));
        const onChanged = vi.fn();
        const user = userEvent.setup();
        render(<ContactDetailPane contact={contactFixture({ version: 5 })} onEdit={vi.fn()} onDelete={vi.fn()} onChanged={onChanged} />);
        const badge = screen.getByRole("button", { name: "Change contact photo" });
        expect(badge).toHaveClass("h-5", "w-5");
        await user.upload(screen.getByLabelText("Contact photo file"), new File([new Uint8Array(4)], "me.png", { type: "image/png" }));
        await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ version: 6 })));
        expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/contacts/c1/photo?version=5");
    });

    it("is happy to have nobody listening for the changed contact", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, contactFixture({ version: 6 })));
        const user = userEvent.setup();
        render(<ContactDetailPane contact={contactFixture({ version: 5 })} onEdit={vi.fn()} onDelete={vi.fn()} />);
        await user.upload(screen.getByLabelText("Contact photo file"), new File([new Uint8Array(4)], "me.png", { type: "image/png" }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await waitFor(() => expect(screen.getByRole("button", { name: "Change contact photo" })).toBeEnabled());
    });

    it("uploads against the contact as it is when the picture is ready, not as it was when it was chosen", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, contactFixture({ version: 8, photoBlobKey: "contact-photos/c1/x" })));
        let ready!: (file: File) => void;
        vi.mocked(prepareContactPhoto).mockImplementationOnce(() => new Promise<File>((resolve) => (ready = resolve)));
        const picture = new File([new Uint8Array(4)], "me.png", { type: "image/png" });
        const { rerender } = render(<ContactDetailPane contact={contactFixture({ version: 5 })} onEdit={vi.fn()} onDelete={vi.fn()} />);
        fireEvent.change(screen.getByLabelText("Contact photo file"), { target: { files: [picture] } });
        // The contact is read again (the star was toggled, a live update arrived) while the picture is being made ready.
        rerender(<ContactDetailPane contact={contactFixture({ version: 7 })} onEdit={vi.fn()} onDelete={vi.fn()} />);
        ready(picture);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/contacts/c1/photo?version=7");
    });

    it("turns the star off while the picture is being changed, and gives the badge its focus back afterwards", async () => {
        mockFetch(() => jsonResponse(200, contactFixture({ version: 6 })));
        let ready!: (file: File) => void;
        vi.mocked(prepareContactPhoto).mockImplementationOnce(() => new Promise<File>((resolve) => (ready = resolve)));
        const picture = new File([new Uint8Array(4)], "me.png", { type: "image/png" });
        render(<ContactDetailPane contact={contactFixture({ version: 5 })} onEdit={vi.fn()} onDelete={vi.fn()} />);
        const badge = screen.getByRole("button", { name: "Change contact photo" });
        badge.focus();
        fireEvent.change(screen.getByLabelText("Contact photo file"), { target: { files: [picture] } });
        await waitFor(() => expect(badge).toBeDisabled());
        expect(screen.getByRole("button", { name: "Favorite" })).toBeDisabled();
        // A browser drops the focus of a button that becomes disabled.
        badge.blur();
        ready(picture);
        await waitFor(() => expect(badge).toBeEnabled());
        expect(screen.getByRole("button", { name: "Favorite" })).toBeEnabled();
        expect(badge).toHaveFocus();
    });

    it("leaves the focus where the user put it", async () => {
        mockFetch(() => jsonResponse(200, contactFixture({ version: 6 })));
        let ready!: (file: File) => void;
        vi.mocked(prepareContactPhoto).mockImplementationOnce(() => new Promise<File>((resolve) => (ready = resolve)));
        const picture = new File([new Uint8Array(4)], "me.png", { type: "image/png" });
        render(<ContactDetailPane contact={contactFixture({ version: 5 })} onEdit={vi.fn()} onDelete={vi.fn()} />);
        const badge = screen.getByRole("button", { name: "Change contact photo" });
        fireEvent.change(screen.getByLabelText("Contact photo file"), { target: { files: [picture] } });
        await waitFor(() => expect(badge).toBeDisabled());
        screen.getByRole("button", { name: "Edit" }).focus();
        ready(picture);
        await waitFor(() => expect(badge).toBeEnabled());
        expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus();
    });

    it("is hidden from a reader who may not change the contact", () => {
        render(<ContactDetailPane contact={contactFixture()} onEdit={vi.fn()} onDelete={vi.fn()} canResolveKeys={false} />);
        expect(screen.queryByRole("button", { name: "Change contact photo" })).not.toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Contact details" })).toBeInTheDocument();
    });
});
