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
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinnedKeyChangedError, type PublicKey } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import ContactDetailPane from "../../../apps/shared/components/contacts/ContactDetailPane.js";
import { KEY_CHANGE_FORBIDDEN_MESSAGE, KEY_CHANGE_STALE_MESSAGE } from "../../../apps/shared/components/contacts/contactKeys.js";
import type { Contact } from "@rapidmx/react-shared/contacts/contactsApi.js";

const { resolveKeyConflict, clearPinnedSignerCache } = vi.hoisted(() => ({ resolveKeyConflict: vi.fn(), clearPinnedSignerCache: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/crypto/keyvaultApi.js")>()),
    resolveKeyConflict,
}));
vi.mock("../../../apps/shared/components/mail/pinnedSigners.js", () => ({ clearPinnedSignerCache }));

afterEach(() => {
    resolveKeyConflict.mockReset();
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
        expect(onDelete).toHaveBeenCalledTimes(1);
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
