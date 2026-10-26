// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
    getUnlockedKeys: vi.fn(),
    personallyUnlockedKeys: vi.fn(),
    listeners: [] as ((event: { mailboxUid: string; state: string }) => void)[],
}));
vi.mock("../../../lib/crypto/keySession.js", () => ({
    getUnlockedKeys: session.getUnlockedKeys,
    personallyUnlockedKeys: session.personallyUnlockedKeys,
    subscribeKeySession: (listener: any) => {
        session.listeners.push(listener);
        return () => session.listeners.splice(session.listeners.indexOf(listener), 1);
    },
}));
const shared = vi.hoisted(() => ({ unlockSharedMailbox: vi.fn(), maintainSharedMailbox: vi.fn() }));
vi.mock("../../../lib/crypto/sharedMailboxKeys.js", () => ({ unlockSharedMailbox: shared.unlockSharedMailbox, maintainSharedMailbox: shared.maintainSharedMailbox }));

const notifications = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("../../../apps/shared/notifications/store.js", () => ({ notify: notifications.notify }));

const { default: SharedMailboxKeyManager, SHARED_MAILBOX_CHECK_INTERVAL_MS, resetSharedMailboxKeyManager } = await import("../../../apps/shared/components/layout/SharedMailboxKeyManager.js");

const mailboxes = [
    { uid: "mine", ownerUserUid: "me", primarySmtpAddress: "me@example.com" },
    { uid: "theirs", ownerUserUid: "boss", primarySmtpAddress: "boss@example.com" },
    { uid: "support", primarySmtpAddress: "support@example.com" },
] as any[];

async function flush() {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
    });
}

beforeEach(async () => {
    await import("../../../lib/crypto/sharedMailboxKeys.js");
    vi.useFakeTimers();
    session.listeners.length = 0;
    session.personallyUnlockedKeys.mockReturnValue([{}]);
    session.getUnlockedKeys.mockImplementation((uid: string) => (uid === "mine" ? { masterKey: new Uint8Array(1) } : undefined));
    shared.unlockSharedMailbox.mockResolvedValue("unlocked");
    shared.maintainSharedMailbox.mockResolvedValue({});
});

afterEach(() => {
    resetSharedMailboxKeyManager();
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe("SharedMailboxKeyManager", () => {
    it("once an own mailbox is unlocked, opens the mailboxes shared with the user and looks after every one it can", async () => {
        render(<SharedMailboxKeyManager mailboxes={mailboxes} userUid="me" />);
        await flush();

        expect(shared.unlockSharedMailbox.mock.calls.map(([uid]) => uid)).toEqual(["theirs", "support"]);
        expect(shared.maintainSharedMailbox.mock.calls.map(([uid, address]) => [uid, address])).toEqual([
            ["mine", "me@example.com"],
            ["theirs", "boss@example.com"],
            ["support", "support@example.com"],
        ]);
    });

    it("asks every pass to open a shared mailbox again when a rotation left it without the active key, and right after making a key itself", async () => {
        shared.maintainSharedMailbox.mockImplementation(async (uid: string) => ({ provisioned: false, rotated: uid === "support" }));
        render(<SharedMailboxKeyManager mailboxes={mailboxes} userUid="me" />);
        await flush();

        expect(shared.unlockSharedMailbox.mock.calls.map(([uid, , refresh]) => [uid, refresh])).toEqual([
            ["theirs", true],
            ["support", true],
            ["support", true],
        ]);
    });

    it("does nothing while no own mailbox is unlocked, and leaves an own mailbox that is locked or open only as shared", async () => {
        session.personallyUnlockedKeys.mockReturnValue([]);
        render(<SharedMailboxKeyManager mailboxes={mailboxes} userUid="me" />);
        await flush();
        expect(shared.maintainSharedMailbox).not.toHaveBeenCalled();

        session.personallyUnlockedKeys.mockReturnValue([{}]);
        session.getUnlockedKeys.mockImplementation((uid: string) => (uid === "mine" ? { masterKey: new Uint8Array(1), shared: true } : undefined));
        await act(async () => {
            session.listeners.forEach((listener) => listener({ mailboxUid: "other-own", state: "unlocked" }));
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(shared.maintainSharedMailbox.mock.calls.map(([uid]) => uid)).toEqual(["theirs", "support"]);
    });

    it("runs again when an own mailbox unlocks and every interval, never two passes at once, and survives failures", async () => {
        let release: (() => void) | undefined;
        shared.maintainSharedMailbox.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
        shared.unlockSharedMailbox.mockRejectedValueOnce(new Error("offline"));
        render(<SharedMailboxKeyManager mailboxes={mailboxes} userUid="me" />);
        await flush();
        const calls = () => shared.maintainSharedMailbox.mock.calls.length;
        expect(calls()).toBe(1);

        // An event while the first pass still runs starts nothing; one for a shared session never does.
        await act(async () => {
            session.listeners.forEach((listener) => listener({ mailboxUid: "mine", state: "unlocked" }));
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(calls()).toBe(1);
        await act(async () => {
            release!();
            await vi.advanceTimersByTimeAsync(0);
        });
        const afterFirst = calls();
        session.getUnlockedKeys.mockImplementation((uid: string) => (uid === "support" ? { masterKey: new Uint8Array(1), shared: true } : uid === "mine" ? { masterKey: new Uint8Array(1) } : undefined));
        await act(async () => {
            session.listeners.forEach((listener) => listener({ mailboxUid: "support", state: "unlocked" }));
            session.listeners.forEach((listener) => listener({ mailboxUid: "mine", state: "locked" }));
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(calls()).toBe(afterFirst);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(SHARED_MAILBOX_CHECK_INTERVAL_MS);
        });
        expect(calls()).toBeGreaterThan(afterFirst);
    });

    it("tries the download again on the next pass after it failed, and stops when unmounted", async () => {
        vi.resetModules();
        let loads = 0;
        vi.doMock("../../../lib/crypto/sharedMailboxKeys.js", () => {
            if (++loads === 1) {
                throw new Error("chunk failed");
            }
            return { unlockSharedMailbox: shared.unlockSharedMailbox, maintainSharedMailbox: shared.maintainSharedMailbox };
        });
        const { default: Manager } = await import("../../../apps/shared/components/layout/SharedMailboxKeyManager.js");
        const { unmount } = render(<Manager mailboxes={mailboxes} userUid="me" />);
        await flush();
        expect(shared.maintainSharedMailbox).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(SHARED_MAILBOX_CHECK_INTERVAL_MS);
        });
        expect(shared.maintainSharedMailbox).toHaveBeenCalled();

        unmount();
        expect(session.listeners).toHaveLength(0);
    });
    it("warns once per mailbox when the server refuses a rotation, again after one went through, and for a new reason", async () => {
        let reason: string | undefined = "the current key stays active";
        shared.maintainSharedMailbox.mockImplementation(async (uid: string) => ({ provisioned: false, rotated: false, ...(uid === "support" && reason ? { rotationRefused: reason } : {}) }));
        const support = { uid: "support", displayName: "Support", primarySmtpAddress: "support@example.com" };
        render(<SharedMailboxKeyManager mailboxes={[mailboxes[2], { ...mailboxes[1], uid: "nameless" }, support] as any[]} userUid="me" />);
        await flush();

        expect(notifications.notify).toHaveBeenCalledTimes(1);
        expect(notifications.notify.mock.calls[0][0]).toMatchObject({
            kind: "warning",
            title: "support@example.com: the zero-access key wasn't replaced",
            details: "the current key stays active",
            dedupeKey: "shared-rotation-refused:support",
        });

        // The next pass is refused the same way: nothing new to say.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SHARED_MAILBOX_CHECK_INTERVAL_MS);
        });
        expect(notifications.notify).toHaveBeenCalledTimes(1);

        reason = undefined;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SHARED_MAILBOX_CHECK_INTERVAL_MS);
        });
        reason = "full again";
        await act(async () => {
            await vi.advanceTimersByTimeAsync(SHARED_MAILBOX_CHECK_INTERVAL_MS);
        });
        expect(notifications.notify).toHaveBeenCalledTimes(2);
        expect(notifications.notify.mock.calls[1][0]).toMatchObject({ details: "full again" });
    });
});
