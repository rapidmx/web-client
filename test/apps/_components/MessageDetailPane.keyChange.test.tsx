// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Key rotation continuity in the reading pane: the "This sender's signing key changed" notice for a
// `signer_key_changed` result (comparison, accept and keep, errors, rights), and pointing an unpinned signer with a
// recorded conflict to the contact instead of offering "Trust this signer". Mocks mirror
// MessageDetailPane.trustSigner.test.tsx.
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { PinnedKeyChangedError } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { mockFetch } from "../testUtils.js";
import MessageDetailPane, { KEPT_CURRENT_SIGNING_KEY_MESSAGE } from "../../../apps/shared/components/mail/MessageDetailPane.js";
import {
    KEY_CHANGE_FORBIDDEN_MESSAGE,
    KEY_CHANGE_GENERIC_MESSAGE,
    KEY_CHANGE_INVALID_MESSAGE,
    KEY_CHANGE_NOT_FOUND_MESSAGE,
    KEY_CHANGE_STALE_MESSAGE,
} from "../../../apps/shared/components/contacts/contactKeys.js";

const { evaluateMessageSecurity, getUnlockedKeys, getPinnedSignerFingerprints, getSignerKeyState, clearPinnedSignerCache, resolveKeyConflict, getMyMailboxAccess } =
    vi.hoisted(() => ({
        evaluateMessageSecurity: vi.fn(),
        getUnlockedKeys: vi.fn(),
        getPinnedSignerFingerprints: vi.fn(),
        getSignerKeyState: vi.fn(),
        clearPinnedSignerCache: vi.fn(),
        resolveKeyConflict: vi.fn(),
        getMyMailboxAccess: vi.fn(),
    }));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/crypto/keyvaultApi.js")>()),
    resolveKeyConflict,
}));
vi.mock("@rapidmx/react-shared/mail/mailboxAccessApi.js", () => ({ getMyMailboxAccess }));
vi.mock("../../../apps/shared/components/mail/pinnedSigners.js", () => ({ getPinnedSignerFingerprints, getSignerKeyState, clearPinnedSignerCache }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock: vi.fn() }) }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ moveLocalEntity: vi.fn() }));

function messageFixture() {
    return {
        uid: "m1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: "abc@example.com",
        subject: "Hello there",
        from: { address: "sender@example.com", displayName: "Sender One", type: "to" as const },
        recipients: [{ address: "u1@example.com", displayName: "Me", type: "to" as const }],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "Hi",
        flags: { read: false, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: true,
    };
}

const PINNED_SINCE = Date.UTC(2025, 5, 1);
const OBSERVED_AT = Date.UTC(2026, 1, 3);
const pinnedKey = { publicKey: "b2xk", type: "x509", useType: "sign", fingerprint: "aaaa1111bbbb2222", notBefore: 1, notAfter: 2 };
const keyChanged = {
    state: "signature_failed",
    signatureFailureReason: "signer_key_changed",
    html: "<p>Hi</p>",
    signerFingerprint: "cccc3333dddd4444",
    signerEmails: ["sender@example.com"],
    signerCertificate: "bmV3Y2VydA==",
    protectedHeaders: { from: "Sender One <sender@example.com>", to: "u1@example.com", subject: "Hello there" },
};
const recordedConflict = {
    useType: "sign",
    observedKey: { ...pinnedKey, fingerprint: "CCCC3333DDDD4444" },
    observedAt: OBSERVED_AT,
    source: "header",
};
const keyState = { pinned: [pinnedKey], previous: [], contactUid: "c1", pinnedSince: PINNED_SINCE };

function renderPane() {
    mockFetch((url) => (url.endsWith("/raw") ? new Response("raw mime") : new Response("{}")));
    return render(<MessageDetailPane message={messageFixture() as never} attachments={[]} />);
}

function setUp(state: Record<string, unknown> | Error = keyState, access: boolean | Error = true) {
    getPinnedSignerFingerprints.mockResolvedValue(["aaaa1111bbbb2222"]);
    evaluateMessageSecurity.mockResolvedValue(keyChanged);
    if (state instanceof Error) {
        getSignerKeyState.mockRejectedValue(state);
    } else {
        getSignerKeyState.mockResolvedValue(state);
    }
    if (access instanceof Error) {
        getMyMailboxAccess.mockRejectedValue(access);
    } else {
        getMyMailboxAccess.mockResolvedValue({ canRead: true, canCreate: true, canUpdate: access, canDelete: true, canManage: false });
    }
}

async function findNotice() {
    return within(await screen.findByRole("region", { name: "Signing key changed" }));
}

afterEach(() => {
    vi.unstubAllGlobals();
    evaluateMessageSecurity.mockReset();
    getUnlockedKeys.mockReset();
    getPinnedSignerFingerprints.mockReset();
    getSignerKeyState.mockReset();
    resolveKeyConflict.mockReset();
    getMyMailboxAccess.mockReset();
});

describe("MessageDetailPane: signing key changed", () => {
    it("shows the notice with the pinned and new keys instead of the generic failure text", async () => {
        setUp();
        renderPane();

        const notice = await findNotice();
        expect(notice.getByRole("heading", { name: "This sender’s signing key changed" })).toBeInTheDocument();
        expect(notice.getByText(/certificate names sender@example.com, but it was made with a different key/)).toBeInTheDocument();
        expect(notice.getByText("aaaa 1111 bbbb 2222")).toBeInTheDocument();
        expect(notice.getByText(`First seen ${new Date(PINNED_SINCE).toLocaleDateString()}`)).toBeInTheDocument();
        expect(notice.getByText("cccc 3333 dddd 4444")).toBeInTheDocument();
        expect(notice.getByText("Certificate for sender@example.com")).toBeInTheDocument();
        expect(notice.getByText("Only seen in this message")).toBeInTheDocument();
        expect(notice.getByText(/routine when the sender renews a certificate, but it can also mean someone is impersonating them/)).toBeInTheDocument();
        expect(notice.getByRole("button", { name: "Accept new key" })).toBeInTheDocument();
        // No recorded conflict for this key, so there's nothing to reject.
        expect(notice.queryByRole("button", { name: "Keep current key" })).not.toBeInTheDocument();
        expect(screen.getByText("Signature failed")).toBeInTheDocument();
        expect(screen.queryByText(/signed with a different key than the one you trust/)).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Trust this signer" })).not.toBeInTheDocument();
        expect(getSignerKeyState).toHaveBeenCalledWith("mb1", "sender@example.com");
        expect(getMyMailboxAccess).toHaveBeenCalledWith("mb1");
    });

    it("dates the new key and offers Keep current key when a conflict for that key is recorded", async () => {
        setUp({ ...keyState, conflict: recordedConflict });
        renderPane();

        const notice = await findNotice();
        expect(notice.getByText(`First seen ${new Date(OBSERVED_AT).toLocaleDateString()}, from an incoming message`)).toBeInTheDocument();
        expect(notice.getByRole("button", { name: "Keep current key" })).toBeInTheDocument();
    });

    it("doesn't offer Keep current key for a recorded conflict about a different key", async () => {
        setUp({ ...keyState, conflict: { ...recordedConflict, observedKey: { ...pinnedKey, fingerprint: "eeee" } } });
        renderPane();

        const notice = await findNotice();
        expect(notice.getByText("Only seen in this message")).toBeInTheDocument();
        expect(notice.queryByRole("button", { name: "Keep current key" })).not.toBeInTheDocument();
    });

    it.each([
        ["the key state couldn't be loaded", new Error("contacts unavailable")],
        ["no signing key is pinned on a contact", { pinned: [], previous: [] }],
    ])("shows the new key without actions when %s", async (_label, state) => {
        setUp(state);
        renderPane();

        const notice = await findNotice();
        expect(notice.getByText("The key you trust couldn’t be loaded.")).toBeInTheDocument();
        expect(notice.getByText("cccc 3333 dddd 4444")).toBeInTheDocument();
        expect(notice.queryByRole("button", { name: "Accept new key" })).not.toBeInTheDocument();
    });

    it("hides the actions up front when the reader can't update the mailbox, and keeps them when that's unknown", async () => {
        setUp(keyState, false);
        const { unmount } = renderPane();
        let notice = await findNotice();
        expect(notice.queryByRole("button", { name: "Accept new key" })).not.toBeInTheDocument();
        unmount();

        setUp(keyState, new Error("access check failed"));
        renderPane();
        notice = await findNotice();
        expect(notice.getByRole("button", { name: "Accept new key" })).toBeInTheDocument();
    });

    it("confirms, then accepts the signer's certificate against the pinned fingerprint shown and re-evaluates", async () => {
        setUp();
        resolveKeyConflict.mockResolvedValue({ keys: [] });
        const user = userEvent.setup();
        renderPane();

        const notice = await findNotice();
        await user.click(notice.getByRole("button", { name: "Accept new key" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
        expect(resolveKeyConflict).not.toHaveBeenCalled();

        evaluateMessageSecurity.mockResolvedValue({ ...keyChanged, state: "signed_verified", signatureFailureReason: undefined });
        await user.click(notice.getByRole("button", { name: "Accept new key" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Accept new key" }));

        expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
        expect(resolveKeyConflict).toHaveBeenCalledWith("mb1", {
            address: "sender@example.com",
            useType: "sign",
            action: "accept",
            expectedPinnedFingerprint: "aaaa1111bbbb2222",
            certificate: "bmV3Y2VydA==",
        });
        expect(clearPinnedSignerCache).toHaveBeenCalled();
        expect(evaluateMessageSecurity).toHaveBeenCalledTimes(2);
        expect(getPinnedSignerFingerprints).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("region", { name: "Signing key changed" })).not.toBeInTheDocument();
    });

    it("keeps the current key for a recorded conflict, then says so after re-evaluating", async () => {
        setUp({ ...keyState, conflict: recordedConflict });
        resolveKeyConflict.mockResolvedValue({ keys: [] });
        const user = userEvent.setup();
        renderPane();

        const notice = await findNotice();
        getSignerKeyState.mockResolvedValue(keyState);
        await user.click(notice.getByRole("button", { name: "Keep current key" }));

        expect(await screen.findByText(KEPT_CURRENT_SIGNING_KEY_MESSAGE)).toBeInTheDocument();
        expect(resolveKeyConflict).toHaveBeenCalledWith("mb1", {
            address: "sender@example.com",
            useType: "sign",
            action: "reject",
            expectedPinnedFingerprint: "aaaa1111bbbb2222",
        });
        expect(clearPinnedSignerCache).toHaveBeenCalled();
        await waitFor(() => expect(evaluateMessageSecurity).toHaveBeenCalledTimes(2));
        const refreshed = await findNotice();
        await waitFor(() => expect(refreshed.queryByRole("button", { name: "Keep current key" })).not.toBeInTheDocument());
    });

    it("says the keys changed meanwhile after a 409 and reloads the key state", async () => {
        setUp();
        resolveKeyConflict.mockRejectedValue(new PinnedKeyChangedError("changed"));
        const user = userEvent.setup();
        renderPane();

        const notice = await findNotice();
        await user.click(notice.getByRole("button", { name: "Accept new key" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Accept new key" }));

        expect(await screen.findByText(KEY_CHANGE_STALE_MESSAGE)).toBeInTheDocument();
        expect(clearPinnedSignerCache).toHaveBeenCalled();
        await waitFor(() => expect(getSignerKeyState).toHaveBeenCalledTimes(2));
        expect(evaluateMessageSecurity).toHaveBeenCalledTimes(2);
    });

    it.each([
        [new ApiRequestError("bad certificate", 400), KEY_CHANGE_INVALID_MESSAGE],
        [new ApiRequestError("no conflict", 404), KEY_CHANGE_NOT_FOUND_MESSAGE],
        [new Error("network"), KEY_CHANGE_GENERIC_MESSAGE],
    ])("explains %s without re-evaluating", async (err, expected) => {
        setUp();
        resolveKeyConflict.mockRejectedValue(err);
        const user = userEvent.setup();
        renderPane();

        const notice = await findNotice();
        await user.click(notice.getByRole("button", { name: "Accept new key" }));
        await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Accept new key" }));

        expect(await notice.findByText(expected)).toBeInTheDocument();
        expect(notice.getByRole("button", { name: "Accept new key" })).toBeInTheDocument();
        expect(evaluateMessageSecurity).toHaveBeenCalledTimes(1);
        expect(clearPinnedSignerCache).not.toHaveBeenCalled();
    });

    it("hides the actions after a 403", async () => {
        setUp({ ...keyState, conflict: recordedConflict });
        resolveKeyConflict.mockRejectedValue(new ApiRequestError("forbidden", 403));
        const user = userEvent.setup();
        renderPane();

        const notice = await findNotice();
        await user.click(notice.getByRole("button", { name: "Keep current key" }));

        expect(await notice.findByText(KEY_CHANGE_FORBIDDEN_MESSAGE)).toBeInTheDocument();
        expect(notice.queryByRole("button", { name: "Accept new key" })).not.toBeInTheDocument();
        expect(notice.queryByRole("button", { name: "Keep current key" })).not.toBeInTheDocument();
    });
});

describe("MessageDetailPane: unpinned signer with a recorded key conflict", () => {
    const unverified = {
        state: "signed_unverified_signer",
        html: "<p>Hi</p>",
        signerEmails: ["sender@example.com"],
        signerFingerprint: "cccc3333dddd4444",
        signerCertificate: "bmV3Y2VydA==",
    };

    it("points to the contact instead of offering Trust this signer", async () => {
        getPinnedSignerFingerprints.mockResolvedValue([]);
        evaluateMessageSecurity.mockResolvedValue(unverified);
        getSignerKeyState.mockResolvedValue({ pinned: [], previous: [], conflict: recordedConflict, contactUid: "c 1" });
        renderPane();

        expect(await screen.findByRole("link", { name: "Review it in Contacts" })).toHaveAttribute("href", "/contacts/c%201");
        expect(screen.getByText(/has a signing key change waiting for your review/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Trust this signer" })).not.toBeInTheDocument();
        expect(getMyMailboxAccess).not.toHaveBeenCalled();
    });

    it.each([
        ["no conflict is recorded", () => getSignerKeyState.mockResolvedValue({ pinned: [], previous: [] })],
        ["the key state couldn't be loaded", () => getSignerKeyState.mockRejectedValue(new Error("down"))],
    ])("still offers Trust this signer when %s", async (_label, arrange) => {
        getPinnedSignerFingerprints.mockResolvedValue([]);
        evaluateMessageSecurity.mockResolvedValue(unverified);
        arrange();
        renderPane();

        expect(await screen.findByRole("button", { name: "Trust this signer" })).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Review it in Contacts" })).not.toBeInTheDocument();
    });

    it("doesn't load the key state for a verified signature or a pinned sender's unverified one", async () => {
        getPinnedSignerFingerprints.mockResolvedValue(["pin"]);
        evaluateMessageSecurity.mockResolvedValue(unverified);
        const { unmount } = renderPane();
        await screen.findByText("Signed - signer not verified");
        unmount();

        getPinnedSignerFingerprints.mockResolvedValue([]);
        evaluateMessageSecurity.mockResolvedValue({ ...unverified, state: "signed_verified" });
        renderPane();
        await screen.findByText("Signed & verified");

        expect(getSignerKeyState).not.toHaveBeenCalled();
    });
});
