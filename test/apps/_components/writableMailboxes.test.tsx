// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mailbox } from "@rapidmx/react-shared/mail/mailApi.js";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { filterWritableMailboxes, useWritableMailboxes } from "../../../apps/shared/components/mail/writableMailboxes.js";

const own = { uid: "mb-own", ownerUserUid: "u1" } as Mailbox;
const manager = { uid: "mb-manager", ownerUserUid: "someone" } as Mailbox;
const viewer = { uid: "mb-viewer" } as Mailbox;
const flaky = { uid: "mb-flaky" } as Mailbox;
const all = [own, manager, viewer, flaky];

function mockAccess() {
    return mockFetch((url) => {
        if (url === "/api/mail/mailboxes/mb-manager/access") return jsonResponse(200, []);
        if (url === "/api/mail/mailboxes/mb-viewer/access") return jsonResponse(403, { message: "forbidden" });
        if (url === "/api/mail/mailboxes/mb-flaky/access") return jsonResponse(500, { message: "boom" });
        throw new Error(`unexpected ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("writableMailboxes", () => {
    it("keeps owned mailboxes without asking, drops a 403 (view-only) share, and fails open on any other error", async () => {
        const fetchMock = mockAccess();
        await expect(filterWritableMailboxes(all, "u1")).resolves.toEqual([own, manager, flaky]);
        expect(fetchMock).not.toHaveBeenCalledWith("/api/mail/mailboxes/mb-own/access", expect.anything());
    });

    it("useWritableMailboxes offers only owned mailboxes (plus keepUid) until the check settles", async () => {
        mockAccess();
        const { result } = renderHook(() => useWritableMailboxes(all, "u1", "mb-viewer"));
        expect(result.current).toEqual([own, viewer]);
        await waitFor(() => expect(result.current).toEqual([own, manager, viewer, flaky]));
    });

    it("useWritableMailboxes with no known user waits for the check before offering anything", async () => {
        mockFetch((url) => (url === "/api/mail/mailboxes/mb-viewer/access" ? jsonResponse(403, {}) : jsonResponse(200, [])));
        const { result, unmount } = renderHook(() => useWritableMailboxes([own, viewer], undefined));
        expect(result.current).toEqual([]);
        await waitFor(() => expect(result.current).toEqual([own]));
        unmount();
    });

    it("useWritableMailboxes ignores a check that settles after unmount", async () => {
        let resolveAccess: ((value: Response) => void) | undefined;
        mockFetch(
            () =>
                new Promise<Response>((resolve) => {
                    resolveAccess = resolve;
                }),
        );
        const { result, unmount } = renderHook(() => useWritableMailboxes([own, manager], "u1"));
        await waitFor(() => expect(resolveAccess).toBeDefined());

        unmount();
        resolveAccess!(jsonResponse(200, []));
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(result.current).toEqual([own]);
    });
});
