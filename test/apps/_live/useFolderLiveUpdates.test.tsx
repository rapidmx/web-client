// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushEvent } from "../../../lib/mail/pushClient.js";
import { changedItemOf, useFolderLiveUpdates } from "../../../apps/shared/live/useFolderLiveUpdates.js";

// The shared push connection: the hook subscribes through it and adds a listener, and the tests are the server.
const listeners = new Set<(event: PushEvent) => void>();
const channelGroups = new Map<string, readonly string[]>();
const start = vi.fn();
vi.mock("../../../lib/mail/pushClient.js", () => ({
    getPushClient: () => ({
        onEvent: (listener: (event: PushEvent) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setChannels: (channels: readonly string[], group: string) => {
            if (channels.length > 0) {
                channelGroups.set(group, channels);
            } else {
                channelGroups.delete(group);
            }
        },
        start,
    }),
}));

function push(event: PushEvent) {
    act(() => {
        for (const listener of [...listeners]) {
            listener(event);
        }
    });
}

const TASK = /^Task(Mongo|SQL)$/;

beforeEach(() => {
    listeners.clear();
    channelGroups.clear();
    start.mockClear();
});

describe("changedItemOf", () => {
    it("names the item a create, update or delete of the model is about, and whether it is gone", () => {
        expect(changedItemOf({ type: "TaskMongo", action: "create", data: { uid: "t1", title: "x" } }, TASK)).toEqual({ uid: "t1", deleted: false });
        expect(changedItemOf({ type: "TaskSQL", action: "update", data: { uid: "t1" } }, TASK)).toEqual({ uid: "t1", deleted: false });
        expect(changedItemOf({ type: "TaskMongo", action: "delete", data: { uid: "t1" } }, TASK)).toEqual({ uid: "t1", deleted: true });
    });

    it("ignores another model, another action, and an event without a uid", () => {
        expect(changedItemOf({ type: "TaskListMongo", action: "create", data: { uid: "l1" } }, TASK)).toBeUndefined();
        expect(changedItemOf({ type: "TaskMongo", action: "reminder", data: { uid: "t1" } }, TASK)).toBeUndefined();
        expect(changedItemOf({ type: "TaskMongo", data: { uid: "t1" } }, TASK)).toBeUndefined();
        expect(changedItemOf({ type: "TaskMongo", action: "update", data: { uid: 5 } }, TASK)).toBeUndefined();
        expect(changedItemOf({ type: "TaskMongo", action: "update", data: null }, TASK)).toBeUndefined();
    });
});

describe("useFolderLiveUpdates", () => {
    const parse = (event: PushEvent) => changedItemOf(event, TASK);

    it("subscribes to the folders under its group while mounted, follows a change of folders, and lets them go when unmounted", () => {
        const { rerender, unmount } = renderHook(({ folders }) => useFolderLiveUpdates("tasks", folders, parse, () => undefined), {
            initialProps: { folders: ["f2", "f1", "f1"] },
        });
        expect(channelGroups.get("tasks")).toEqual(["f1", "f2"]);
        expect(start).toHaveBeenCalled();

        rerender({ folders: ["f3"] });
        expect(channelGroups.get("tasks")).toEqual(["f3"]);
        rerender({ folders: [] });
        expect(channelGroups.has("tasks")).toBe(false);

        rerender({ folders: ["f1"] });
        unmount();
        expect(channelGroups.has("tasks")).toBe(false);
        expect(listeners.size).toBe(0);
    });

    it("calls the latest onChange with each item the parser recognizes, and nothing else", () => {
        const first = vi.fn();
        const second = vi.fn();
        const { rerender } = renderHook(({ onChange }) => useFolderLiveUpdates("tasks", ["f1"], parse, onChange), { initialProps: { onChange: first } });

        push({ type: "TaskMongo", action: "create", data: { uid: "t1" } });
        expect(first).toHaveBeenCalledWith({ uid: "t1", deleted: false });

        rerender({ onChange: second });
        push({ type: "MessageMongo", action: "create", data: { uid: "m1" } });
        push({ type: "TaskMongo", action: "delete", data: { uid: "t1" } });
        expect(first).toHaveBeenCalledTimes(1);
        expect(second.mock.calls).toEqual([[{ uid: "t1", deleted: true }]]);
    });
});
