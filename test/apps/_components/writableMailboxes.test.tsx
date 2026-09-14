// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    clearMailboxWritabilityCache,
    getMailboxWritability,
    peekMailboxWritability,
    useMailboxWritability,
    useWritableMailboxes,
} from "../../../apps/shared/components/mail/writableMailboxes.js";

const own = { uid: "mb-own", ownerUserUid: "u1" } as Mailbox;
const manager = { uid: "mb-manager", ownerUserUid: "someone" } as Mailbox;
const viewer = { uid: "mb-viewer" } as Mailbox;
const flaky = { uid: "mb-flaky" } as Mailbox;
const all = [own, manager, viewer, flaky];

function access(canCreate: boolean) {
    return { canRead: true, canCreate, canUpdate: canCreate, canDelete: canCreate, canManage: false };
}

function mockAccess() {
    return mockFetch((url) => {
        if (url === "/api/mail/mailboxes/mb-manager/access/me") return jsonResponse(200, access(true));
        if (url === "/api/mail/mailboxes/mb-viewer/access/me") return jsonResponse(200, access(false));
        if (url === "/api/mail/mailboxes/mb-flaky/access/me") return jsonResponse(404, { message: "no such route" });
        throw new Error(`unexpected ${url}`);
    });
}

function accessCalls(fetchMock: ReturnType<typeof mockFetch>) {
    return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/access/me"));
}

beforeEach(() => {
    clearMailboxWritabilityCache();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("writableMailboxes", () => {
    it("answers owned mailboxes (and every mailbox, for a trusted caller) without asking; otherwise uses canCreate, and an error is unknown", async () => {
        const fetchMock = mockAccess();
        await expect(getMailboxWritability(own, "u1")).resolves.toBe(true);
        await expect(getMailboxWritability(viewer, "u1", true)).resolves.toBe(true);
        expect(accessCalls(fetchMock)).toEqual([]);

        await expect(getMailboxWritability(manager, "u1")).resolves.toBe(true);
        await expect(getMailboxWritability(viewer, "u1")).resolves.toBe(false);
        await expect(getMailboxWritability(flaky, "u1")).resolves.toBeUndefined();
    });

    it("asks at most once per mailbox per session - sharing an in-flight request - but retries after a failure", async () => {
        const fetchMock = mockAccess();
        const [first, second] = await Promise.all([getMailboxWritability(viewer, "u1"), getMailboxWritability(viewer, "u1")]);
        expect([first, second]).toEqual([false, false]);
        expect(peekMailboxWritability(viewer, "u1")).toBe(false);
        await getMailboxWritability(viewer, "u1");
        expect(accessCalls(fetchMock)).toEqual(["/api/mail/mailboxes/mb-viewer/access/me"]);

        await getMailboxWritability(flaky, "u1");
        await getMailboxWritability(flaky, "u1");
        expect(accessCalls(fetchMock).filter((url) => url.includes("mb-flaky"))).toHaveLength(2);
        expect(peekMailboxWritability(flaky, "u1")).toBeUndefined();
    });

    it("useWritableMailboxes lists everything straight away, then drops view-only mailboxes as answers arrive - always keeping keepUid", async () => {
        mockAccess();
        const { result } = renderHook(() => useWritableMailboxes(all, "u1"));
        expect(result.current).toEqual(all);
        await waitFor(() => expect(result.current).toEqual([own, manager, flaky]));

        // Already known now, so it's filtered from the first render - except when it's the kept value.
        expect(renderHook(() => useWritableMailboxes(all, "u1")).result.current).toEqual([own, manager, flaky]);
        expect(renderHook(() => useWritableMailboxes(all, "u1", "mb-viewer")).result.current).toEqual(all);
    });

    it("useMailboxWritability ignores answers that settle after unmount", async () => {
        let resolveAccess: ((value: Response) => void) | undefined;
        mockFetch(
            () =>
                new Promise<Response>((resolve) => {
                    resolveAccess = resolve;
                }),
        );
        const { result, unmount } = renderHook(() => useMailboxWritability([own, manager], "u1"));
        expect(result.current).toEqual({ "mb-own": true, "mb-manager": undefined });
        await waitFor(() => expect(resolveAccess).toBeDefined());

        unmount();
        resolveAccess!(jsonResponse(200, access(false)));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(result.current).toEqual({ "mb-own": true, "mb-manager": undefined });
    });
});
