// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder } from "../../../lib/mail/mailApi.js";
import type { ApiClient } from "../../../lib/util/api.js";
import { ApiClientContext } from "../../../lib/util/apiClientContext.js";
import LocalIndexLifecycle, { POLL_INTERVAL_MS, ZERO_ACCESS_SYNC_INTERVAL_MS } from "../../../apps/shared/search/LocalIndexLifecycle.js";

const { getUnlockedKeys } = vi.hoisted(() => ({ getUnlockedKeys: vi.fn() }));
vi.mock("../../../lib/crypto/keySession.js", () => ({ getUnlockedKeys }));

const { buildLocalIndex, cancelLocalIndexBuild } = vi.hoisted(() => ({ buildLocalIndex: vi.fn(), cancelLocalIndexBuild: vi.fn() }));
vi.mock("../../../apps/shared/search/localIndexBuilder.js", () => ({ buildLocalIndex, cancelLocalIndexBuild }));

const { syncZeroAccessIndex } = vi.hoisted(() => ({ syncZeroAccessIndex: vi.fn() }));
vi.mock("../../../apps/shared/search/zeroAccessIndexSync.js", () => ({ syncZeroAccessIndex }));

const { destroyLocalIndex, pruneInaccessibleLocalIndexes } = vi.hoisted(() => ({
    destroyLocalIndex: vi.fn(),
    pruneInaccessibleLocalIndexes: vi.fn(),
}));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ destroyLocalIndex, pruneInaccessibleLocalIndexes }));

const folders = [{ uid: "inbox", type: "inbox" }] as Folder[];
let unlockedMailboxes: Set<string>;

beforeEach(async () => {
    // The component loads the builder with a dynamic import; loaded here, before the timers are faked, so that it resolves from
    // the module cache within a few microtasks (see `flush()`).
    await import("../../../apps/shared/search/localIndexBuilder.js");
    await import("../../../apps/shared/search/zeroAccessIndexSync.js");
    vi.useFakeTimers();
    unlockedMailboxes = new Set();
    getUnlockedKeys.mockImplementation((uid: string) => (unlockedMailboxes.has(uid) ? { masterKey: new Uint8Array(32) } : undefined));
    buildLocalIndex.mockResolvedValue(undefined);
    syncZeroAccessIndex.mockReset();
    syncZeroAccessIndex.mockResolvedValue({});
    destroyLocalIndex.mockResolvedValue(true);
    cancelLocalIndexBuild.mockResolvedValue(undefined);
    pruneInaccessibleLocalIndexes.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.useRealTimers();
});

/** The builder is loaded with a dynamic import when a build is due, so its start is a few microtasks after the render. */
async function flush() {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
    });
}

async function tick() {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
}

describe("LocalIndexLifecycle", () => {
    it("builds an unlocked mailbox once, however often it re-renders with new folder arrays", async () => {
        unlockedMailboxes.add("mb1");
        const { rerender } = render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        rerender(<LocalIndexLifecycle mailboxUid="mb1" folders={[...folders]} />);
        await tick();
        expect(buildLocalIndex).toHaveBeenCalledTimes(1);
        expect(buildLocalIndex).toHaveBeenCalledWith("mb1", expect.anything(), folders, undefined, undefined);
    });

    it("waits for folders, and starts the build once the active mailbox is unlocked later", async () => {
        const { rerender } = render(<LocalIndexLifecycle mailboxUid="mb1" folders={[]} />);
        unlockedMailboxes.add("mb1");
        await tick();
        expect(buildLocalIndex).not.toHaveBeenCalled();
        rerender(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        await flush();
        expect(buildLocalIndex).toHaveBeenCalledTimes(1);

        const late = render(<LocalIndexLifecycle mailboxUid="mb2" folders={folders} />);
        expect(buildLocalIndex).toHaveBeenCalledTimes(1);
        unlockedMailboxes.add("mb2");
        await tick();
        expect(buildLocalIndex).toHaveBeenLastCalledWith("mb2", expect.anything(), folders, undefined, undefined);
        late.unmount();
    });

    it("destroys a built mailbox's index when its keys go away - even after switching to another mailbox, or a folders refresh in between", async () => {
        unlockedMailboxes.add("mb1");
        unlockedMailboxes.add("mb2");
        const { rerender } = render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        rerender(<LocalIndexLifecycle mailboxUid="mb2" folders={folders} />);
        await flush();
        expect(buildLocalIndex).toHaveBeenCalledTimes(2);

        // Keys destroyed between polls, then an unrelated re-render before the next poll fires.
        unlockedMailboxes.clear();
        rerender(<LocalIndexLifecycle mailboxUid="mb2" folders={[...folders]} />);
        await tick();
        expect(destroyLocalIndex).toHaveBeenCalledWith("mb1");
        expect(destroyLocalIndex).toHaveBeenCalledWith("mb2");
        // Any pass still running with the destroyed keys is stopped too.
        expect(cancelLocalIndexBuild).toHaveBeenCalledWith("mb1");
        expect(cancelLocalIndexBuild).toHaveBeenCalledWith("mb2");

        // Not destroyed twice; rebuilt after a re-unlock.
        await tick();
        expect(destroyLocalIndex).toHaveBeenCalledTimes(2);
        unlockedMailboxes.add("mb2");
        await tick();
        await flush();
        expect(buildLocalIndex).toHaveBeenCalledTimes(3);
    });

    it("never produces an unhandled rejection from a cancel that fails", async () => {
        unlockedMailboxes.add("mb1");
        cancelLocalIndexBuild.mockRejectedValue(new Error("worker gone"));
        render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        await tick();
        await flush();
        unlockedMailboxes.clear();
        await tick();
        await flush();
        expect(cancelLocalIndexBuild).toHaveBeenCalledWith("mb1");
        expect(destroyLocalIndex).toHaveBeenCalledWith("mb1");
    });

    it("never produces an unhandled rejection from a failed build", async () => {
        unlockedMailboxes.add("mb1");
        buildLocalIndex.mockRejectedValue(new Error("no OPFS"));
        render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        await tick();
        await flush();
        expect(buildLocalIndex).toHaveBeenCalledTimes(1);
    });

    it("prunes indexes for inaccessible mailboxes once the accessible list is known, and only when it changes", () => {
        const { rerender } = render(<LocalIndexLifecycle folders={[]} />);
        expect(pruneInaccessibleLocalIndexes).not.toHaveBeenCalled();
        rerender(<LocalIndexLifecycle folders={[]} accessibleMailboxUids={["mb2", "mb1"]} />);
        rerender(<LocalIndexLifecycle folders={[]} accessibleMailboxUids={["mb1", "mb2"]} />);
        expect(pruneInaccessibleLocalIndexes).toHaveBeenCalledTimes(1);
        expect(pruneInaccessibleLocalIndexes).toHaveBeenCalledWith(["mb1", "mb2"]);
    });

    it("polls without starting any build while no mailbox is active", async () => {
        unlockedMailboxes.add("mb1");
        render(<LocalIndexLifecycle folders={folders} />);
        await tick();
        expect(buildLocalIndex).not.toHaveBeenCalled();
    });
});

// A native, multi-account host mounts this component under its own account's `ApiClientContext.Provider` (see `useApiClient()`'s own doc
// comment), which must reach `buildLocalIndex()`'s own trailing `client` argument - both for the mailbox/folders-driven build and for one the
// long-lived poll interval starts later (the interval closure reads the latest client from `latestRef`, not the one captured at mount). Every
// test above renders with no provider at all, proving the other half: `client` is `undefined` there throughout.
describe("LocalIndexLifecycle - an explicit ApiClient is threaded through", () => {
    it("passes the provided client to the build it starts directly", async () => {
        const client: ApiClient = { fetch: vi.fn(), setUnauthorizedObserver: vi.fn() };
        unlockedMailboxes.add("mb1");
        render(
            <ApiClientContext.Provider value={client}>
                <LocalIndexLifecycle mailboxUid="mb1" folders={folders} />
            </ApiClientContext.Provider>,
        );
        await tick();
        expect(buildLocalIndex).toHaveBeenCalledWith("mb1", expect.anything(), folders, undefined, client);
    });

    it("passes the current client to a build the poll interval starts once the mailbox unlocks later", async () => {
        const client: ApiClient = { fetch: vi.fn(), setUnauthorizedObserver: vi.fn() };
        render(
            <ApiClientContext.Provider value={client}>
                <LocalIndexLifecycle mailboxUid="mb1" folders={folders} />
            </ApiClientContext.Provider>,
        );
        expect(buildLocalIndex).not.toHaveBeenCalled();
        unlockedMailboxes.add("mb1");
        await tick();
        expect(buildLocalIndex).toHaveBeenCalledWith("mb1", expect.anything(), folders, undefined, client);
    });
});

describe("LocalIndexLifecycle (zero-access sync)", () => {
    const zeroAccessUnlocked = (uid: string) => (unlockedMailboxes.has(uid) ? { masterKey: new Uint8Array(32), zeroAccessKeys: [{}] } : undefined);

    it("syncs a zero-access mailbox once its build finished, then again each interval, never two at once", async () => {
        getUnlockedKeys.mockImplementation(zeroAccessUnlocked);
        unlockedMailboxes.add("mb1");
        let finish: (() => void) | undefined;
        syncZeroAccessIndex.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
        render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        await flush();
        expect(syncZeroAccessIndex).toHaveBeenCalledTimes(1);
        expect(syncZeroAccessIndex).toHaveBeenCalledWith("mb1", expect.anything(), undefined);

        // Still running when the interval comes round: no second pass alongside it.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ZERO_ACCESS_SYNC_INTERVAL_MS + POLL_INTERVAL_MS);
        });
        expect(syncZeroAccessIndex).toHaveBeenCalledTimes(1);
        await act(async () => {
            finish!();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        });
        expect(syncZeroAccessIndex).toHaveBeenCalledTimes(2);

        // A failed pass is tried again at the next interval.
        syncZeroAccessIndex.mockRejectedValueOnce(new Error("offline"));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ZERO_ACCESS_SYNC_INTERVAL_MS + POLL_INTERVAL_MS);
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ZERO_ACCESS_SYNC_INTERVAL_MS + POLL_INTERVAL_MS);
        });
        expect(syncZeroAccessIndex.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it("syncs a zero-access mailbox even when its build failed: the sync is how its mail reaches the index", async () => {
        getUnlockedKeys.mockImplementation(zeroAccessUnlocked);
        unlockedMailboxes.add("mb1");
        buildLocalIndex.mockRejectedValueOnce(new Error("listing failed"));
        render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        await flush();
        expect(syncZeroAccessIndex).toHaveBeenCalledTimes(1);
    });

    it("doesn't let a pass still running from before a lock hold up the next unlock's first sync", async () => {
        getUnlockedKeys.mockImplementation(zeroAccessUnlocked);
        unlockedMailboxes.add("mb1");
        let finishOld: (() => void) | undefined;
        let finishNew: (() => void) | undefined;
        syncZeroAccessIndex
            .mockImplementationOnce(() => new Promise<void>((resolve) => (finishOld = resolve)))
            .mockImplementationOnce(() => new Promise<void>((resolve) => (finishNew = resolve)));
        render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        await flush();
        expect(syncZeroAccessIndex).toHaveBeenCalledTimes(1);

        unlockedMailboxes.delete("mb1");
        await tick();
        unlockedMailboxes.add("mb1");
        await tick();
        await flush();
        expect(syncZeroAccessIndex).toHaveBeenCalledTimes(2);
        // The old pass ending doesn't clear the new one's mark: no third pass alongside the new one.
        await act(async () => {
            finishOld!();
            await vi.advanceTimersByTimeAsync(ZERO_ACCESS_SYNC_INTERVAL_MS + POLL_INTERVAL_MS);
        });
        expect(syncZeroAccessIndex).toHaveBeenCalledTimes(2);
        await act(async () => {
            finishNew!();
            await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        });
        expect(syncZeroAccessIndex).toHaveBeenCalledTimes(3);
    });

    it("starts no sync for a build a lock overtook", async () => {
        getUnlockedKeys.mockImplementation(zeroAccessUnlocked);
        unlockedMailboxes.add("mb1");
        let finishBuild: (() => void) | undefined;
        buildLocalIndex.mockImplementationOnce(() => new Promise<void>((resolve) => (finishBuild = resolve)));
        render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        await flush();
        unlockedMailboxes.delete("mb1");
        await tick();
        await act(async () => {
            finishBuild!();
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(syncZeroAccessIndex).not.toHaveBeenCalled();

        // Unlocked again while the first build still ran: only the new build's end starts one.
        unlockedMailboxes.add("mb1");
        let finishSecond: (() => void) | undefined;
        buildLocalIndex.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSecond = resolve)));
        await tick();
        await flush();
        expect(syncZeroAccessIndex).not.toHaveBeenCalled();
        await act(async () => {
            finishSecond!();
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(syncZeroAccessIndex).toHaveBeenCalledTimes(1);
    });

    it("never syncs a mailbox without zero-access keys, and starts over after it is locked and unlocked again", async () => {
        unlockedMailboxes.add("mb1");
        render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        await flush();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ZERO_ACCESS_SYNC_INTERVAL_MS + POLL_INTERVAL_MS);
        });
        expect(syncZeroAccessIndex).not.toHaveBeenCalled();

        getUnlockedKeys.mockImplementation(zeroAccessUnlocked);
        unlockedMailboxes.delete("mb1");
        await tick();
        unlockedMailboxes.add("mb1");
        await tick();
        await flush();
        expect(syncZeroAccessIndex).toHaveBeenCalledTimes(1);
    });
});
