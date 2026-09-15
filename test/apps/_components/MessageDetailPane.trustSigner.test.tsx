// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// "Trust this signer": offered only for an unverified-signer result carrying a certificate when the sender has no
// pinned signing key, confirmed in a dialog, then pinned with trustSigner() and re-evaluated. Mocks mirror
// MessageDetailPane.round6.test.tsx.
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { SignerKeyConflictError } from "@rapidmx/react-shared/crypto/keyvaultApi.js";
import { mockFetch } from "../testUtils.js";
import MessageDetailPane, {
    TRUST_SIGNER_CONFLICT_MESSAGE,
    TRUST_SIGNER_FORBIDDEN_MESSAGE,
    TRUST_SIGNER_GENERIC_MESSAGE,
    TRUST_SIGNER_INVALID_MESSAGE,
    formatFingerprint,
    trustSignerErrorMessage,
} from "../../../apps/shared/components/mail/MessageDetailPane.js";

const { evaluateMessageSecurity, getUnlockedKeys, getPinnedSignerFingerprints, clearPinnedSignerCache, trustSigner } = vi.hoisted(() => ({
    evaluateMessageSecurity: vi.fn(),
    getUnlockedKeys: vi.fn(),
    getPinnedSignerFingerprints: vi.fn(),
    clearPinnedSignerCache: vi.fn(),
    trustSigner: vi.fn(),
}));
vi.mock("@rapidmx/react-shared/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("@rapidmx/react-shared/crypto/keyvaultApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/crypto/keyvaultApi.js")>()),
    trustSigner,
}));
vi.mock("../../../apps/shared/components/mail/pinnedSigners.js", () => ({
    getPinnedSignerFingerprints,
    clearPinnedSignerCache,
    // No recorded key conflicts - see MessageDetailPane.keyChange.test.tsx for those.
    getSignerKeyState: async () => ({ pinned: [], previous: [] }),
}));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock: vi.fn() }) }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ moveLocalEntity: vi.fn() }));

function messageFixture(overrides: Record<string, unknown> = {}) {
    return {
        uid: "m1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb-shared",
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

const unverified = {
    state: "signed_unverified_signer",
    html: "<p>Hi</p>",
    signerEmails: ["sender@example.com", "alt@example.com"],
    signerFingerprint: "ab12cd34ef56",
    signerCertificate: "Y2VydA==",
    protectedHeaders: { from: "Sender One <Sender@Example.com>", to: "u1@example.com", subject: "Hello there" },
};

function renderPane(overrides: Record<string, unknown> = {}) {
    mockFetch((url) => (url.endsWith("/raw") ? new Response("raw mime") : new Response("{}")));
    return render(<MessageDetailPane message={messageFixture(overrides) as never} attachments={[]} />);
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Trust this signer" }));
    return screen.findByRole("dialog");
}

afterEach(() => {
    vi.unstubAllGlobals();
    evaluateMessageSecurity.mockReset();
    getUnlockedKeys.mockReset();
    getPinnedSignerFingerprints.mockReset();
    trustSigner.mockReset();
});

describe("formatFingerprint", () => {
    it("groups into uppercase blocks of four, dropping separators", () => {
        expect(formatFingerprint("ab:12:cd:34:ef")).toBe("AB12 CD34 EF");
        expect(formatFingerprint("")).toBe("");
    });
});

describe("trustSignerErrorMessage", () => {
    it.each([
        [new SignerKeyConflictError("conflict"), TRUST_SIGNER_CONFLICT_MESSAGE],
        [new ApiRequestError("bad", 400), TRUST_SIGNER_INVALID_MESSAGE],
        [new ApiRequestError("nope", 403), TRUST_SIGNER_FORBIDDEN_MESSAGE],
        [new ApiRequestError("gone", 404), TRUST_SIGNER_GENERIC_MESSAGE],
        [new Error("network"), TRUST_SIGNER_GENERIC_MESSAGE],
    ])("%s", (err, expected) => {
        expect(trustSignerErrorMessage(err)).toBe(expected);
    });
});

describe("MessageDetailPane: Trust this signer", () => {
    describe("visibility", () => {
        it.each(["signed_unverified_signer", "encrypted_unverified_signer"])(
            "offers it for %s with a certificate and no pinned key",
            async (state) => {
                getPinnedSignerFingerprints.mockResolvedValue([]);
                evaluateMessageSecurity.mockResolvedValue({ ...unverified, state });
                renderPane({ encrypted: state === "encrypted_unverified_signer" });

                expect(await screen.findByRole("button", { name: "Trust this signer" })).toBeInTheDocument();
            },
        );

        it("isn't offered without a signer certificate", async () => {
            getPinnedSignerFingerprints.mockResolvedValue([]);
            evaluateMessageSecurity.mockResolvedValue({ ...unverified, signerCertificate: undefined });
            renderPane();

            await screen.findByText("Signed - signer not verified");
            expect(screen.queryByRole("button", { name: "Trust this signer" })).not.toBeInTheDocument();
        });

        it("isn't offered when the sender already has a pinned signing key", async () => {
            getPinnedSignerFingerprints.mockResolvedValue(["other-pin"]);
            // Whatever the evaluation says, a pinned key is never replaced from here.
            evaluateMessageSecurity.mockResolvedValue(unverified);
            renderPane();

            await screen.findByText("Signed - signer not verified");
            expect(screen.queryByRole("button", { name: "Trust this signer" })).not.toBeInTheDocument();
        });

        it("isn't offered when the pinned-signer lookup failed", async () => {
            getPinnedSignerFingerprints.mockRejectedValue(new Error("contacts unavailable"));
            evaluateMessageSecurity.mockResolvedValue(unverified);
            renderPane();

            await screen.findByText("Signed - signer not verified");
            expect(screen.queryByRole("button", { name: "Trust this signer" })).not.toBeInTheDocument();
        });

        it.each(["signed_verified", "signature_failed"])("isn't offered for %s", async (state) => {
            getPinnedSignerFingerprints.mockResolvedValue([]);
            evaluateMessageSecurity.mockResolvedValue({ ...unverified, state });
            renderPane();

            await screen.findByText(state === "signed_verified" ? "Signed & verified" : "Signature failed");
            expect(screen.queryByRole("button", { name: "Trust this signer" })).not.toBeInTheDocument();
        });
    });

    it("shows the certificate emails, grouped fingerprint and the protected From address, and Cancel changes nothing", async () => {
        getPinnedSignerFingerprints.mockResolvedValue([]);
        evaluateMessageSecurity.mockResolvedValue(unverified);
        const user = userEvent.setup();
        renderPane();

        const dialog = await openDialog(user);
        expect(dialog).toHaveTextContent("Mail from sender@example.com signed with this certificate will show as verified.");
        expect(dialog).toHaveTextContent("sender@example.com, alt@example.com");
        expect(dialog).toHaveTextContent("AB12 CD34 EF56");
        expect(dialog).toHaveTextContent(/confirm this fingerprint with the sender through another channel/);

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(trustSigner).not.toHaveBeenCalled();
    });

    it("falls back to the outer From address, and says when the certificate has no email or fingerprint", async () => {
        getPinnedSignerFingerprints.mockResolvedValue([]);
        evaluateMessageSecurity.mockResolvedValue({
            ...unverified,
            state: "encrypted_unverified_signer",
            protectedHeaders: undefined,
            signerEmails: undefined,
            signerFingerprint: undefined,
        });
        const user = userEvent.setup();
        renderPane({ encrypted: true });

        const dialog = await openDialog(user);
        expect(dialog).toHaveTextContent("Mail from sender@example.com signed");
        expect(dialog).toHaveTextContent("No email address");
        expect(dialog).toHaveTextContent("Unknown");
    });

    it("trusts the signer for the message's own mailbox, clears the pin cache and re-evaluates to verified", async () => {
        getPinnedSignerFingerprints.mockResolvedValueOnce([]).mockResolvedValue(["ab12cd34ef56"]);
        evaluateMessageSecurity.mockResolvedValueOnce(unverified).mockResolvedValue({ ...unverified, state: "signed_verified" });
        trustSigner.mockResolvedValue({ keys: [] });
        const user = userEvent.setup();
        renderPane();

        await openDialog(user);
        await user.click(screen.getByRole("button", { name: "Trust" }));

        expect(await screen.findByText("Signed & verified")).toBeInTheDocument();
        expect(trustSigner).toHaveBeenCalledWith("mb-shared", { address: "sender@example.com", certificate: "Y2VydA==" });
        expect(clearPinnedSignerCache).toHaveBeenCalled();
        expect(evaluateMessageSecurity).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Trust this signer" })).not.toBeInTheDocument();
    });

    it.each([
        ["a different pinned key (409)", new SignerKeyConflictError("conflict"), TRUST_SIGNER_CONFLICT_MESSAGE],
        ["an unusable certificate (400)", new ApiRequestError("bad cert", 400), TRUST_SIGNER_INVALID_MESSAGE],
        ["a delegate without rights (403)", new ApiRequestError("forbidden", 403), TRUST_SIGNER_FORBIDDEN_MESSAGE],
        ["anything else", new Error("offline"), TRUST_SIGNER_GENERIC_MESSAGE],
    ])("keeps the dialog open with an explanation for %s", async (_label, err, expected) => {
        getPinnedSignerFingerprints.mockResolvedValue([]);
        evaluateMessageSecurity.mockResolvedValue(unverified);
        trustSigner.mockRejectedValue(err);
        const user = userEvent.setup();
        renderPane();

        await openDialog(user);
        await user.click(screen.getByRole("button", { name: "Trust" }));

        expect(await screen.findByText(expected)).toBeInTheDocument();
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(clearPinnedSignerCache).not.toHaveBeenCalled();
        expect(evaluateMessageSecurity).toHaveBeenCalledTimes(1);
    });

    it("clears a previous error when the dialog is opened again", async () => {
        getPinnedSignerFingerprints.mockResolvedValue([]);
        evaluateMessageSecurity.mockResolvedValue(unverified);
        trustSigner.mockRejectedValue(new Error("offline"));
        const user = userEvent.setup();
        renderPane();

        await openDialog(user);
        await user.click(screen.getByRole("button", { name: "Trust" }));
        await screen.findByText(TRUST_SIGNER_GENERIC_MESSAGE);
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await openDialog(user);
        expect(screen.queryByText(TRUST_SIGNER_GENERIC_MESSAGE)).not.toBeInTheDocument();
    });

    it("disables the dialog's buttons and ignores Escape while the request runs", async () => {
        getPinnedSignerFingerprints.mockResolvedValue([]);
        evaluateMessageSecurity.mockResolvedValue(unverified);
        let rejectTrust!: (err: Error) => void;
        trustSigner.mockImplementation(() => new Promise((_resolve, reject) => (rejectTrust = reject)));
        const user = userEvent.setup();
        renderPane();

        await openDialog(user);
        await user.click(screen.getByRole("button", { name: "Trust" }));

        await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled());
        expect(screen.getByRole("button", { name: /^Trust$/ })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Trust this signer" })).toBeDisabled();
        await user.keyboard("{Escape}");
        expect(screen.getByRole("dialog")).toBeInTheDocument();

        rejectTrust(new ApiRequestError("forbidden", 403));
        expect(await screen.findByText(TRUST_SIGNER_FORBIDDEN_MESSAGE)).toBeInTheDocument();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
});
