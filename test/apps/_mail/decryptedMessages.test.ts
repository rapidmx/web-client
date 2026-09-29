// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type KeyEvent = { mailboxUid: string; state: "locked" | "unlocked" };

const { getUnlockedKeys, subscribeKeySession, getMessageRawContent, evaluateMessageSecurity, listeners } = vi.hoisted(() => {
    const listeners: ((event: KeyEvent) => void)[] = [];
    return {
        listeners,
        getUnlockedKeys: vi.fn(),
        subscribeKeySession: vi.fn((listener: (event: KeyEvent) => void) => {
            listeners.push(listener);
            return () => undefined;
        }),
        getMessageRawContent: vi.fn(),
        evaluateMessageSecurity: vi.fn(),
    };
});
vi.mock("../../../lib/crypto/keySession.js", () => ({ getUnlockedKeys, subscribeKeySession }));
vi.mock("../../../lib/mail/mailApi.js", () => ({ getMessageRawContent }));
vi.mock("../../../lib/crypto/messageSecurity.js", () => ({ evaluateMessageSecurity }));

import { decryptForDisplay, previewOf, rememberDecrypted, useDecryptedMessages, useUnlockEpoch } from "../../../apps/shared/mail/decryptedMessages.js";

const KEYS = { keys: true };

function lock(mailboxUid: string) {
    act(() => listeners.forEach((listener) => listener({ mailboxUid, state: "locked" })));
}

beforeEach(() => {
    vi.clearAllMocks();
    getUnlockedKeys.mockReturnValue(KEYS);
    getMessageRawContent.mockResolvedValue("raw");
    lock("mb1");
    lock("mb2");
});

describe("previewOf", () => {
    it("is the text of the HTML on one line, entities decoded and cut short", () => {
        expect(previewOf("<style>p{}</style><p>a &amp; b&nbsp;&lt;c&gt; &quot;d&quot; &#39;e&#39;</p>\n<script>x()</script><p>f</p>")).toBe(`a & b <c> "d" 'e' f`);
        expect(previewOf("x".repeat(500))).toHaveLength(160);
    });
});

describe("rememberDecrypted and the hooks", () => {
    it("shows what was recovered, ignores nothing-to-show and repeats, and drops a locked mailbox's messages only", () => {
        const { result } = renderHook(() => useDecryptedMessages());
        act(() => rememberDecrypted("m1", "mb1", {}));
        expect(result.current).toEqual({});
        act(() => rememberDecrypted("m1", "mb1", { subject: "Plans" }));
        const first = result.current;
        expect(first.m1).toEqual({ mailboxUid: "mb1", subject: "Plans", preview: undefined });
        act(() => rememberDecrypted("m1", "mb1", { subject: "Plans" }));
        expect(result.current).toBe(first);
        act(() => rememberDecrypted("m2", "mb2", { preview: "hello" }));
        lock("mb3");
        expect(Object.keys(result.current)).toEqual(["m1", "m2"]);
        lock("mb1");
        expect(Object.keys(result.current)).toEqual(["m2"]);
    });

    it("counts unlocks", () => {
        const { result } = renderHook(() => useUnlockEpoch());
        const before = result.current;
        act(() => listeners.forEach((listener) => listener({ mailboxUid: "mb1", state: "unlocked" })));
        expect(result.current).toBe(before + 1);
    });
});

describe("decryptForDisplay", () => {
    it("remembers the subject and an HTML preview of a message it can open", async () => {
        evaluateMessageSecurity.mockResolvedValue({ subject: "Plans", html: "<p>Body</p>" });
        const { result } = renderHook(() => useDecryptedMessages());
        await act(() => decryptForDisplay("m1", "mb1"));
        expect(result.current.m1).toEqual({ mailboxUid: "mb1", subject: "Plans", preview: "Body" });
        // Known now: not fetched again.
        await decryptForDisplay("m1", "mb1");
        expect(getMessageRawContent).toHaveBeenCalledTimes(1);
    });

    it("falls back to the text body for the preview", async () => {
        evaluateMessageSecurity.mockResolvedValue({ subject: "S", text: "plain body" });
        const { result } = renderHook(() => useDecryptedMessages());
        await act(() => decryptForDisplay("m1", "mb1"));
        expect(result.current.m1.preview).toBe("plain body");
    });

    it("does nothing without unlocked keys, and leaves a message it cannot open alone", async () => {
        const { result } = renderHook(() => useDecryptedMessages());
        getUnlockedKeys.mockReturnValue(undefined);
        await decryptForDisplay("m1", "mb1");
        expect(getMessageRawContent).not.toHaveBeenCalled();
        getUnlockedKeys.mockReturnValue(KEYS);
        getMessageRawContent.mockRejectedValueOnce(new Error("offline"));
        await decryptForDisplay("m1", "mb1");
        evaluateMessageSecurity.mockResolvedValue({});
        await act(() => decryptForDisplay("m2", "mb1"));
        expect(result.current).toEqual({});
    });

    it("asks once for a message already being decrypted, and drops a result that a lock overtook", async () => {
        let release: () => void = () => undefined;
        evaluateMessageSecurity.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ subject: "Late" }))));
        const { result } = renderHook(() => useDecryptedMessages());
        const first = decryptForDisplay("m1", "mb1");
        await decryptForDisplay("m1", "mb1");
        await vi.waitFor(() => expect(evaluateMessageSecurity).toHaveBeenCalled());
        getUnlockedKeys.mockReturnValue({ keys: "replaced" });
        release();
        await act(() => first);
        expect(getMessageRawContent).toHaveBeenCalledTimes(1);
        expect(result.current).toEqual({});
    });
});
