// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// The index builder is loaded with a dynamic import when a build is due. A download that fails is not remembered: the next
// build that is due tries again. The loader keeps its state for the life of the module, so this test loads a fresh copy.
import React from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder } from "@rapidmx/react-shared/mail/mailApi.js";

const state = vi.hoisted(() => ({ loads: 0, failures: 0, builds: [] as string[] }));

beforeEach(() => {
    vi.resetModules();
    state.loads = 0;
    state.failures = 0;
    state.builds = [];
    vi.doMock("@rapidmx/react-shared/crypto/keySession.js", () => ({ getUnlockedKeys: () => ({ masterKey: new Uint8Array(32) }) }));
    vi.doMock("../../../apps/shared/search/localIndexRpcClient.js", () => ({
        destroyLocalIndex: vi.fn().mockResolvedValue(true),
        pruneInaccessibleLocalIndexes: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("../../../apps/shared/search/localIndexBuilder.js", () => {
        state.loads++;
        if (state.failures > 0) {
            state.failures--;
            throw new Error("chunk failed");
        }
        return {
            buildLocalIndex: (mailboxUid: string) => {
                state.builds.push(mailboxUid);
                return Promise.resolve();
            },
            cancelLocalIndexBuild: vi.fn(),
        };
    });
});

const folders = [{ uid: "inbox", type: "inbox" }] as Folder[];

describe("LocalIndexLifecycle's builder download", () => {
    it("tries again for the next build after a download failed, and never rejects", async () => {
        state.failures = 1;
        const { default: LocalIndexLifecycle } = await import("../../../apps/shared/search/LocalIndexLifecycle.js");
        const { rerender } = render(<LocalIndexLifecycle mailboxUid="mb1" folders={folders} />);
        await act(async () => undefined);
        expect(state.loads).toBe(1);
        expect(state.builds).toEqual([]);

        rerender(<LocalIndexLifecycle mailboxUid="mb2" folders={folders} />);
        await act(async () => undefined);
        expect(state.loads).toBe(2);
        expect(state.builds).toEqual(["mb2"]);
    });
});
