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

import {
    clearDecryptedMessages,
    decryptFailedBefore,
    decryptForDisplay,
    mapWithConcurrency,
    markDecryptFailed,
    previewOf,
    rememberDecrypted,
    useDecryptedMessages,
    useUnlockEpoch,
} from "../../../apps/shared/mail/decryptedMessages.js";

const KEYS = { keys: true };

function lock(mailboxUid: string) {
    act(() => listeners.forEach((listener) => listener({ mailboxUid, state: "locked" })));
}

beforeEach(() => {
    vi.clearAllMocks();
    clearDecryptedMessages();
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

describe("messages that could not be decrypted", () => {
    it("are not downloaded again on the next try, until the keys are unlocked again", async () => {
        getMessageRawContent.mockRejectedValue(new Error("offline"));
        await decryptForDisplay("m1", "mb1");
        expect(getMessageRawContent).toHaveBeenCalledTimes(1);
        expect(decryptFailedBefore("m1")).toBe(true);

        await decryptForDisplay("m1", "mb1");
        expect(getMessageRawContent).toHaveBeenCalledTimes(1);

        act(() => listeners.forEach((listener) => listener({ mailboxUid: "mb1", state: "unlocked" })));
        expect(decryptFailedBefore("m1")).toBe(false);
        await decryptForDisplay("m1", "mb1");
        expect(getMessageRawContent).toHaveBeenCalledTimes(2);
    });

    it("also cover a message that opened to nothing readable", async () => {
        evaluateMessageSecurity.mockResolvedValue({});
        await decryptForDisplay("m1", "mb1");
        await decryptForDisplay("m1", "mb1");
        expect(getMessageRawContent).toHaveBeenCalledTimes(1);
        expect(decryptFailedBefore("m1")).toBe(true);
    });

    it("are tried again after ten minutes", () => {
        vi.useFakeTimers();
        try {
            markDecryptFailed("m1");
            expect(decryptFailedBefore("m1")).toBe(true);
            vi.advanceTimersByTime(10 * 60_000 + 1);
            expect(decryptFailedBefore("m1")).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("are remembered up to a limit, the oldest being forgotten first", () => {
        for (let i = 0; i < 1001; i++) {
            markDecryptFailed(`m${i}`);
        }
        expect(decryptFailedBefore("m0")).toBe(false);
        expect(decryptFailedBefore("m1")).toBe(true);
        expect(decryptFailedBefore("m1000")).toBe(true);
        // Marking one again moves it to the newest end rather than growing the list.
        markDecryptFailed("m1");
        markDecryptFailed("new");
        expect(decryptFailedBefore("m1")).toBe(true);
        expect(decryptFailedBefore("m2")).toBe(false);
    });

    it("are forgotten, with everything decrypted, on clearDecryptedMessages", () => {
        const { result } = renderHook(() => useDecryptedMessages());
        act(() => rememberDecrypted("m2", "mb1", { subject: "S" }));
        markDecryptFailed("m1");
        act(() => clearDecryptedMessages());
        expect(decryptFailedBefore("m1")).toBe(false);
        expect(result.current).toEqual({});
    });
});

describe("mapWithConcurrency", () => {
    it("runs at most the limit at once and answers in the order of the items", async () => {
        let running = 0;
        let peak = 0;
        const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 5));
            running--;
            return n * 2;
        });
        expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
        expect(peak).toBe(3);
        expect(await mapWithConcurrency([], 3, async (n: number) => n)).toEqual([]);
    });
});
