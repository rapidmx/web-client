// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder } from "@rapidmx/react-shared/mail/mailApi.js";
import LocalIndexLifecycle, { POLL_INTERVAL_MS } from "../../../apps/shared/search/LocalIndexLifecycle.js";

const { getUnlockedKeys } = vi.hoisted(() => ({ getUnlockedKeys: vi.fn() }));
vi.mock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys }));

const { buildLocalIndex } = vi.hoisted(() => ({ buildLocalIndex: vi.fn() }));
vi.mock("../../../apps/shared/search/localIndexBuilder.js", () => ({ buildLocalIndex }));

const { destroyLocalIndex, pruneInaccessibleLocalIndexes } = vi.hoisted(() => ({
    destroyLocalIndex: vi.fn(),
    pruneInaccessibleLocalIndexes: vi.fn(),
}));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => ({ destroyLocalIndex, pruneInaccessibleLocalIndexes }));

const folders = [{ uid: "inbox", type: "inbox" }] as Folder[];
let unlockedMailboxes: Set<string>;

beforeEach(() => {
    vi.useFakeTimers();
    unlockedMailboxes = new Set();
    getUnlockedKeys.mockImplementation((uid: string) => (unlockedMailboxes.has(uid) ? { masterKey: new Uint8Array(32) } : undefined));
    buildLocalIndex.mockResolvedValue(undefined);
    destroyLocalIndex.mockResolvedValue(true);
    pruneInaccessibleLocalIndexes.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.useRealTimers();
});

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
        expect(buildLocalIndex).toHaveBeenCalledWith("mb1", expect.anything(), folders);
    });

    it("waits for folders, and starts the build once the active mailbox is unlocked later", async () => {
        const { rerender } = render(<LocalIndexLifecycle mailboxUid="mb1" folders={[]} />);
        unlockedMailboxes.add("mb1");
        await tick();
        expect(buildLocalIndex).not.toHaveBeenCalled();
        rerender(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        expect(buildLocalIndex).toHaveBeenCalledTimes(1);

        const late = render(<LocalIndexLifecycle mailboxUid="mb2" folders={folders} />);
        expect(buildLocalIndex).toHaveBeenCalledTimes(1);
        unlockedMailboxes.add("mb2");
        await tick();
        expect(buildLocalIndex).toHaveBeenLastCalledWith("mb2", expect.anything(), folders);
        late.unmount();
    });

    it("destroys a built mailbox's index when its keys go away - even after switching to another mailbox, or a folders refresh in between", async () => {
        unlockedMailboxes.add("mb1");
        unlockedMailboxes.add("mb2");
        const { rerender } = render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        rerender(<LocalIndexLifecycle mailboxUid="mb2" folders={folders} />);
        expect(buildLocalIndex).toHaveBeenCalledTimes(2);

        // Keys destroyed between polls, then an unrelated re-render before the next poll fires.
        unlockedMailboxes.clear();
        rerender(<LocalIndexLifecycle mailboxUid="mb2" folders={[...folders]} />);
        await tick();
        expect(destroyLocalIndex).toHaveBeenCalledWith("mb1");
        expect(destroyLocalIndex).toHaveBeenCalledWith("mb2");

        // Not destroyed twice; rebuilt after a re-unlock.
        await tick();
        expect(destroyLocalIndex).toHaveBeenCalledTimes(2);
        unlockedMailboxes.add("mb2");
        await tick();
        expect(buildLocalIndex).toHaveBeenCalledTimes(3);
    });

    it("never produces an unhandled rejection from a failed build", async () => {
        unlockedMailboxes.add("mb1");
        buildLocalIndex.mockRejectedValue(new Error("no OPFS"));
        render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        await tick();
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
