// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Verification seals in the reading pane: evaluating with `evaluateMessageSecurityWithSeal()` against the vault's
// master key generation, best-effort seal writes (one per message and generation, 409/403 ignored), and the
// "Verified when first opened" badge, detail line and later-compromised warning. The seal crypto itself is covered in
// react-shared; here it is mocked and the real `verificationSeals.ts` and `mailApi.ts` talk to a mocked fetch.
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import MessageDetailPane from "../../../apps/shared/components/mail/MessageDetailPane.js";
import { clearVerificationSealCache } from "../../../apps/shared/components/mail/verificationSeals.js";

const { evaluateMessageSecurity, evaluateMessageSecurityWithSeal, getUnlockedKeys, getPinnedSignerFingerprints, getSignerKeyState, getMyMailboxAccess } =
    vi.hoisted(() => ({
        evaluateMessageSecurity: vi.fn(),
        evaluateMessageSecurityWithSeal: vi.fn(),
        getUnlockedKeys: vi.fn(),
        getPinnedSignerFingerprints: vi.fn(),
        getSignerKeyState: vi.fn(),
        getMyMailboxAccess: vi.fn(),
    }));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity, evaluateMessageSecurityWithSeal }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("@rapidmx/react-shared/mail/mailboxAccessApi.js", () => ({ getMyMailboxAccess }));
vi.mock("../../../apps/shared/components/mail/pinnedSigners.js", () => ({ getPinnedSignerFingerprints, getSignerKeyState, clearPinnedSignerCache: vi.fn() }));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock: vi.fn() }) }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ moveLocalEntity: vi.fn() }));
const { mailShellOverride } = vi.hoisted(() => ({ mailShellOverride: { current: undefined as Record<string, unknown> | undefined } }));
vi.mock("../../../apps/shared/components/mail/layout/MailShell.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../apps/shared/components/mail/layout/MailShell.js")>();
    return { ...actual, useMailShell: () => mailShellOverride.current ?? actual.useMailShell() };
});

function messageFixture(overrides: Record<string, unknown> = {}) {
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
        ...overrides,
    };
}

const unlocked = { masterKey: new Uint8Array(32) };
const VERIFIED_AT = Date.UTC(2026, 2, 4);
const pinnedKey = { publicKey: "b2xk", type: "x509", useType: "sign", fingerprint: "aaaa1111bbbb2222", notBefore: 1, notAfter: 2 };
const previousKey = { ...pinnedKey, fingerprint: "cccc3333dddd4444", replacedAt: 5, revokedAt: 4, revocationReason: "compromised" };
const verified = { state: "signed_verified", html: "<p>Hi</p>", signerFingerprint: "aaaa1111bbbb2222", sealToWrite: { seal: "v1.new.tag", masterKeyGeneration: 3 } };
const sealed = {
    state: "verified_at_first_open",
    html: "<p>Sealed body</p>",
    signerFingerprint: "cccc3333dddd4444",
    signerEmails: ["sender@example.com"],
    signerCertificate: "bmV3Y2VydA==",
    protectedHeaders: { from: "Sender One <sender@example.com>", to: "u1@example.com", subject: "Signed subject" },
    verifiedAt: VERIFIED_AT,
    sealedState: "signed_verified",
    liveState: "signature_failed",
    liveSignatureFailureReason: "signer_key_changed",
};

interface Server {
    vault?: Response | (() => Response);
    seal?: () => Response;
}

function mockServer({ vault = jsonResponse(200, { wrappedKeys: [], masterKeyWraps: [], masterKeyGeneration: 3 }), seal = () => jsonResponse(200, {}) }: Server = {}) {
    return mockFetch((url) => {
        if (url.endsWith("/raw")) return new Response("raw mime");
        if (url.endsWith("/keyvault")) return typeof vault === "function" ? vault() : vault.clone();
        if (url.endsWith("/verification-seal")) return seal();
        return jsonResponse(200, {});
    });
}

function sealWrites(fetch: ReturnType<typeof mockServer>) {
    return fetch.mock.calls.filter(([url]) => String(url).endsWith("/verification-seal"));
}

function renderPane(overrides: Record<string, unknown> = {}) {
    return render(<MessageDetailPane message={messageFixture(overrides) as never} attachments={[]} />);
}

beforeEach(() => {
    getUnlockedKeys.mockReturnValue(unlocked);
    getPinnedSignerFingerprints.mockResolvedValue(["aaaa1111bbbb2222"]);
    getSignerKeyState.mockResolvedValue({ pinned: [pinnedKey], previous: [previousKey], contactUid: "c1", pinnedSince: 1 });
    getMyMailboxAccess.mockResolvedValue({ canRead: true, canCreate: true, canUpdate: true, canDelete: true, canManage: false });
    evaluateMessageSecurity.mockResolvedValue({ state: "signed_verified", html: "<p>Hi</p>" });
    evaluateMessageSecurityWithSeal.mockResolvedValue(verified);
});

afterEach(() => {
    vi.unstubAllGlobals();
    clearVerificationSealCache();
    mailShellOverride.current = undefined;
    for (const fn of [evaluateMessageSecurity, evaluateMessageSecurityWithSeal, getUnlockedKeys, getPinnedSignerFingerprints, getSignerKeyState, getMyMailboxAccess]) {
        fn.mockReset();
    }
});

describe("MessageDetailPane: verification seal writes", () => {
    it("evaluates with the seal, generation and signer keys, then stores the new seal with one PUT", async () => {
        const fetch = mockServer();
        renderPane({ verificationSeal: "v1.old.tag", verificationSealGeneration: 3 });

        expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
        expect(evaluateMessageSecurityWithSeal).toHaveBeenCalledWith("raw mime", unlocked, ["aaaa1111bbbb2222"], undefined, {
            mailboxUid: "mb1",
            messageUid: "m1",
            seal: "v1.old.tag",
            sealGeneration: 3,
            masterKeyGeneration: 3,
            signerKeys: [pinnedKey, previousKey],
        });
        expect(evaluateMessageSecurity).not.toHaveBeenCalled();
        await waitFor(() => expect(sealWrites(fetch)).toHaveLength(1));
        const [url, init] = sealWrites(fetch)[0];
        expect(url).toBe("/api/mail/messages/m1/verification-seal");
        expect(init).toMatchObject({ method: "PUT", body: JSON.stringify({ seal: "v1.new.tag", masterKeyGeneration: 3 }) });
    });

    it("doesn't send another seal for the same message and generation, and checks the stored one on reopening", async () => {
        const fetch = mockServer();
        const { unmount } = renderPane();
        await waitFor(() => expect(sealWrites(fetch)).toHaveLength(1));
        unmount();

        evaluateMessageSecurityWithSeal.mockResolvedValue({ ...verified, sealToWrite: { seal: "v1.newer.tag", masterKeyGeneration: 3 } });
        renderPane();
        await waitFor(() => expect(evaluateMessageSecurityWithSeal).toHaveBeenCalledTimes(2));
        expect(evaluateMessageSecurityWithSeal.mock.calls[1][4]).toMatchObject({ seal: "v1.new.tag", sealGeneration: 3 });
        await screen.findByText("Signed & verified");
        expect(sealWrites(fetch)).toHaveLength(1);
        // The vault generation is cached per mailbox too.
        expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/keyvault"))).toHaveLength(1);
    });

    it.each([
        ["a conflict (409)", 409],
        ["a refusal (403)", 403],
    ])("ignores %s without showing anything or trying again", async (_label, status) => {
        const fetch = mockServer({ seal: () => jsonResponse(status, { message: "no" }) });
        const { unmount } = renderPane();
        await waitFor(() => expect(sealWrites(fetch)).toHaveLength(1));
        expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        unmount();

        renderPane();
        await waitFor(() => expect(evaluateMessageSecurityWithSeal).toHaveBeenCalledTimes(2));
        await screen.findByText("Signed & verified");
        expect(evaluateMessageSecurityWithSeal.mock.calls[1][4]).toMatchObject({ seal: undefined });
        expect(sealWrites(fetch)).toHaveLength(1);
    });

    it("lets a later opening try again after a transient failure, without retrying on its own", async () => {
        const fetch = mockServer({ seal: () => jsonResponse(500, { message: "down" }) });
        const { unmount } = renderPane();
        await waitFor(() => expect(sealWrites(fetch)).toHaveLength(1));
        await screen.findByText("Signed & verified");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sealWrites(fetch)).toHaveLength(1);
        unmount();

        renderPane();
        await waitFor(() => expect(sealWrites(fetch)).toHaveLength(2));
    });

    it("re-seals a message whose stored seal is from an older generation", async () => {
        const fetch = mockServer({ vault: jsonResponse(200, { masterKeyGeneration: 4 }) });
        evaluateMessageSecurityWithSeal.mockResolvedValue({ ...verified, sealToWrite: { seal: "v1.gen4.tag", masterKeyGeneration: 4 } });
        const { unmount } = renderPane({ verificationSeal: "v1.gen3.tag", verificationSealGeneration: 3 });

        await waitFor(() => expect(sealWrites(fetch)).toHaveLength(1));
        expect(evaluateMessageSecurityWithSeal.mock.calls[0][4]).toMatchObject({ seal: "v1.gen3.tag", sealGeneration: 3, masterKeyGeneration: 4 });
        expect(sealWrites(fetch)[0][1]).toMatchObject({ body: JSON.stringify({ seal: "v1.gen4.tag", masterKeyGeneration: 4 }) });
        unmount();

        // The list copy still carries the generation 3 seal; the one stored this session is newer and wins.
        renderPane({ verificationSeal: "v1.gen3.tag", verificationSealGeneration: 3 });
        await waitFor(() => expect(evaluateMessageSecurityWithSeal).toHaveBeenCalledTimes(2));
        expect(evaluateMessageSecurityWithSeal.mock.calls[1][4]).toMatchObject({ seal: "v1.gen4.tag", sealGeneration: 4 });
    });

    it("sends nothing when the evaluation has no seal to write", async () => {
        const fetch = mockServer();
        evaluateMessageSecurityWithSeal.mockResolvedValue({ state: "signed_verified", html: "<p>Hi</p>" });
        renderPane();

        await screen.findByText("Signed & verified");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sealWrites(fetch)).toHaveLength(0);
    });

    it.each([
        ["the vault can't be read", jsonResponse(500, { message: "down" })],
        ["the vault reports no generation", jsonResponse(200, { wrappedKeys: [] })],
        ["the vault reports an invalid generation", jsonResponse(200, { masterKeyGeneration: -1 })],
    ])("evaluates without seals when %s", async (_label, vault) => {
        const fetch = mockServer({ vault });
        renderPane();

        await screen.findByText("Signed & verified");
        expect(evaluateMessageSecurity).toHaveBeenCalledWith("raw mime", unlocked, ["aaaa1111bbbb2222"], undefined);
        expect(evaluateMessageSecurityWithSeal).not.toHaveBeenCalled();
        expect(getSignerKeyState).not.toHaveBeenCalled();
        expect(sealWrites(fetch)).toHaveLength(0);
    });

    it("reads the vault again after it couldn't be read", async () => {
        let vaultCalls = 0;
        const fetch = mockServer({ vault: () => (++vaultCalls === 1 ? jsonResponse(500, {}) : jsonResponse(200, { masterKeyGeneration: 3 })) });
        const { unmount } = renderPane();
        await screen.findByText("Signed & verified");
        unmount();

        renderPane();
        await waitFor(() => expect(evaluateMessageSecurityWithSeal).toHaveBeenCalledTimes(1));
        expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/keyvault"))).toHaveLength(2);
    });

    it("neither reads the vault nor seals without unlocked keys", async () => {
        const fetch = mockServer();
        getUnlockedKeys.mockReturnValue(undefined);
        renderPane();

        await screen.findByText("Signed & verified");
        expect(evaluateMessageSecurity).toHaveBeenCalledWith("raw mime", undefined, ["aaaa1111bbbb2222"], undefined);
        expect(evaluateMessageSecurityWithSeal).not.toHaveBeenCalled();
        expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/keyvault"))).toBe(false);
    });

    it("evaluates without seals when the keys lock before evaluating, and as locked when sealing throws", async () => {
        mockServer();
        getUnlockedKeys.mockReturnValueOnce(unlocked).mockReturnValue(undefined);
        const { unmount } = renderPane();
        await screen.findByText("Signed & verified");
        expect(evaluateMessageSecurityWithSeal).not.toHaveBeenCalled();
        expect(evaluateMessageSecurity).toHaveBeenCalledWith("raw mime", undefined, ["aaaa1111bbbb2222"], undefined);
        unmount();

        getUnlockedKeys.mockReturnValue(unlocked);
        evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "No key." });
        evaluateMessageSecurityWithSeal.mockRejectedValue(new Error("locked"));
        renderPane();
        expect(await screen.findByText("No key.")).toBeInTheDocument();
        expect(evaluateMessageSecurity).toHaveBeenLastCalledWith("raw mime", undefined, ["aaaa1111bbbb2222"], undefined);
    });

    it("passes the mailbox's own keys for mail it sent itself, and no signer keys when neither is known", async () => {
        const ownKey = { ...pinnedKey, fingerprint: "eeee" };
        mailShellOverride.current = { mailboxes: [{ uid: "mb1", keys: [ownKey], primarySmtpAddress: "sender@example.com" }], mailboxFolders: [] };
        mockServer();
        getSignerKeyState.mockRejectedValue(new Error("contacts down"));
        const { unmount } = renderPane();
        await waitFor(() => expect(evaluateMessageSecurityWithSeal).toHaveBeenCalledTimes(1));
        expect(evaluateMessageSecurityWithSeal.mock.calls[0][2]).toEqual(["aaaa1111bbbb2222", "eeee"]);
        expect(evaluateMessageSecurityWithSeal.mock.calls[0][3]).toBe("sender@example.com");
        expect(evaluateMessageSecurityWithSeal.mock.calls[0][4].signerKeys).toEqual([ownKey]);
        await screen.findByText("Signed & verified");
        unmount();

        mailShellOverride.current = { mailboxes: [{ uid: "mb1", primarySmtpAddress: "sender@example.com" }], mailboxFolders: [] };
        renderPane({ uid: "m2" });
        await waitFor(() => expect(evaluateMessageSecurityWithSeal).toHaveBeenCalledTimes(2));
        expect(evaluateMessageSecurityWithSeal.mock.calls[1][4].signerKeys).toEqual([]);
    });
});

describe("MessageDetailPane: verified when first opened", () => {
    it("shows a muted badge, when it was verified, the signed content and the key change actions", async () => {
        mockServer();
        evaluateMessageSecurityWithSeal.mockResolvedValue(sealed);
        renderPane();

        const badge = await screen.findByText("Verified when first opened");
        expect(badge.className).toContain("text-text-muted");
        expect(badge.className).not.toMatch(/success|warning/);
        expect(screen.queryByText("Signed & verified")).not.toBeInTheDocument();
        expect(
            screen.getByText(`This signature was verified on ${new Date(VERIFIED_AT).toLocaleDateString()}. The sender has since started signing with a different key.`),
        ).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 1, name: "Signed subject" })).toBeInTheDocument();
        expect(screen.getByTitle("Hello there").getAttribute("srcdoc")).toContain("<p>Sealed body</p>");

        const notice = within(await screen.findByRole("region", { name: "Signing key changed" }));
        expect(notice.getByText(/with a different key than the one you trust for this sender\.$/)).toBeInTheDocument();
        expect(notice.queryByText(/isn.t verified/)).not.toBeInTheDocument();
        expect(await notice.findByRole("button", { name: "Accept new key" })).toBeInTheDocument();
        expect(screen.queryByText(/signature couldn.t be verified/)).not.toBeInTheDocument();
        expect(getMyMailboxAccess).toHaveBeenCalledWith("mb1");
    });

    it("explains a signer key that is no longer trusted, without the key change notice", async () => {
        mockServer();
        const { liveSignatureFailureReason: _reason, ...rest } = sealed;
        evaluateMessageSecurityWithSeal.mockResolvedValue({ ...rest, liveState: "signed_unverified_signer" });
        renderPane();

        expect(await screen.findByText(/The sender.s key is no longer trusted since then/)).toBeInTheDocument();
        expect(screen.queryByRole("region", { name: "Signing key changed" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Trust this signer" })).not.toBeInTheDocument();
    });

    it("warns in amber, never green, when the signer key was later reported compromised", async () => {
        mockServer();
        evaluateMessageSecurityWithSeal.mockResolvedValue({ ...sealed, laterCompromised: true });
        renderPane();

        const badge = await screen.findByText("Verified when first opened");
        expect(badge.className).toContain("bg-warning/15");
        expect(badge.className).not.toContain("success");
        const warning = screen.getByText(
            `This signature was verified on ${new Date(VERIFIED_AT).toLocaleDateString()}, but the sender's key was later reported compromised; treat this message with caution.`,
        );
        expect(warning.className).toContain("bg-warning/15");
        expect(screen.getByTitle("Hello there").getAttribute("srcdoc")).toContain("<p>Sealed body</p>");
    });
});
