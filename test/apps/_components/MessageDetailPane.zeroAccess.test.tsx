// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// A message the server sealed at rest (zero-access): the pane always evaluates it (it has no readable /content), labels it "Protected
// at rest" - unlocked or not - and shows the subject, body and attachments recovered from inside it. Mocks mirror
// MessageDetailPane.round6.test.tsx.
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetchWithServerBody as mockFetch } from "./paneFetch.js";
import MessageDetailPane from "../../../apps/shared/components/mail/MessageDetailPane.js";

const { evaluateMessageSecurity, getUnlockedKeys, getPinnedSignerFingerprints } = vi.hoisted(() => ({
    evaluateMessageSecurity: vi.fn(),
    getUnlockedKeys: vi.fn(),
    getPinnedSignerFingerprints: vi.fn(),
}));
vi.mock("../../../lib/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));
vi.mock("../../../lib/crypto/keySession.js", () => ({ getUnlockedKeys, subscribeKeySession: () => () => undefined }));
vi.mock("../../../apps/shared/components/mail/pinnedSigners.js", () => ({
    getPinnedSignerFingerprints,
    getSignerKeyState: async () => ({ pinned: [], previous: [] }),
}));
vi.mock("../../../apps/shared/components/layout/UnlockPromptProvider.js", () => ({ useUnlockPrompt: () => ({ requestUnlock: vi.fn() }) }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ moveLocalEntity: vi.fn() }));

function sealedMessage(overrides: Record<string, unknown> = {}) {
    return {
        uid: "m1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        folderUid: "f1",
        mailboxUid: "mb1",
        messageId: "abc@example.com",
        subject: "[...]",
        from: { address: "sender@example.com", displayName: "Sender One", type: "to" as const },
        recipients: [{ address: "u1@example.com", displayName: "Me", type: "to" as const }],
        sentDate: "2026-01-01T00:00:00.000Z",
        receivedDate: "2026-01-01T00:00:00.000Z",
        bodyPreview: "",
        flags: { read: false, flagged: false, answered: false, forwarded: false },
        importance: "normal" as const,
        hasAttachments: false,
        zeroAccess: { keyFingerprint: "fp", sealedSummary: "c2VhbGVk" },
        ...overrides,
    };
}

function renderSealed(raw: (url: string) => Response | Promise<Response> = () => new Response("sealed mime")) {
    mockFetch((url) => (url.endsWith("/raw") ? raw(url) : new Response("{}")));
    return render(<MessageDetailPane message={sealedMessage() as never} attachments={[]} />);
}

afterEach(() => {
    vi.unstubAllGlobals();
    evaluateMessageSecurity.mockReset();
    getUnlockedKeys.mockReset();
    getPinnedSignerFingerprints.mockReset();
});

describe("MessageDetailPane (zero-access)", () => {
    it("opens a sealed message with no attachments, showing its real subject, body and attachments under 'Protected at rest'", async () => {
        getPinnedSignerFingerprints.mockResolvedValue([]);
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [{}] });
        evaluateMessageSecurity.mockResolvedValue({
            state: "protected_at_rest",
            zeroAccess: true,
            subject: "Quarterly numbers",
            text: "The numbers are up.",
            html: "<p>The numbers are up.</p>",
            attachments: [{ filename: "minutes.txt", contentType: "text/plain", disposition: "attachment", decode: () => new Uint8Array([1]) }],
        });
        renderSealed();

        expect(await screen.findByText("Protected at rest")).toBeInTheDocument();
        expect(evaluateMessageSecurity.mock.calls[0][0]).toBe("sealed mime");
        expect(screen.getAllByText("Quarterly numbers").length).toBeGreaterThan(0);
        expect(screen.getByText("minutes.txt")).toBeInTheDocument();
        expect(screen.queryByText("Encrypted")).not.toBeInTheDocument();
    });

    it("labels a sealed message 'Protected at rest', not 'Encrypted', while the keys are locked, and offers to unlock", async () => {
        getPinnedSignerFingerprints.mockResolvedValue([]);
        getUnlockedKeys.mockReturnValue(undefined);
        evaluateMessageSecurity.mockResolvedValue({ state: "encrypted", decryptError: "This device doesn't have the key needed to decrypt this message." });
        renderSealed();

        expect(await screen.findByText("Protected at rest")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /unlock/i })).toBeInTheDocument();
    });

    it("still labels it 'Protected at rest' when its stored copy can't be fetched", async () => {
        getPinnedSignerFingerprints.mockResolvedValue([]);
        getUnlockedKeys.mockReturnValue(undefined);
        renderSealed(() => new Response("nope", { status: 500 }));

        expect(await screen.findByText("Protected at rest")).toBeInTheDocument();
        expect(evaluateMessageSecurity).not.toHaveBeenCalled();
    });
});
