// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { clearMailboxUpdateAccessCache, useMailboxUpdateAccess } from "../../../apps/shared/mail/useMailboxUpdateAccess.js";

const owned = { uid: "mb1", accessRole: "owner" } as never;
const shared = { uid: "mb2", accessRole: "delegate" } as never;

afterEach(() => {
    clearMailboxUpdateAccessCache();
});

describe("useMailboxUpdateAccess", () => {
    it("is true without a request for the reader's own mailbox, and for one the shell does not know", () => {
        const fetchMock = mockFetch(() => jsonResponse(500, {}));
        expect(renderHook(() => useMailboxUpdateAccess(owned)).result.current).toBe(true);
        expect(renderHook(() => useMailboxUpdateAccess(undefined)).result.current).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("turns false for a shared mailbox the server says the reader may not update, asking once for it", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { canRead: true, canCreate: false, canUpdate: false, canDelete: false, canManage: false }));
        const first = renderHook(() => useMailboxUpdateAccess(shared));
        const second = renderHook(() => useMailboxUpdateAccess(shared));
        await waitFor(() => expect(first.result.current).toBe(false));
        await waitFor(() => expect(second.result.current).toBe(false));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/mailboxes/mb2/access/me");
    });

    it("stays true for a shared mailbox the reader may update", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { canRead: true, canCreate: true, canUpdate: true, canDelete: false, canManage: false }));
        const { result } = renderHook(() => useMailboxUpdateAccess(shared));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await fetchMock.mock.results[0].value;
        expect(result.current).toBe(true);
    });

    it("stays true when the access could not be read, and asks again the next time", async () => {
        const fetchMock = mockFetch(() => jsonResponse(500, { message: "boom" }));
        const { result, unmount } = renderHook(() => useMailboxUpdateAccess(shared));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(result.current).toBe(true));
        unmount();
        renderHook(() => useMailboxUpdateAccess(shared));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });

    it("ignores an answer that arrives after the reader has moved on", async () => {
        let answer: (response: Response) => void = () => undefined;
        mockFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
        const { result, unmount } = renderHook(() => useMailboxUpdateAccess(shared));
        unmount();
        answer(jsonResponse(200, { canRead: true, canCreate: false, canUpdate: false, canDelete: false, canManage: false }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(result.current).toBe(true);
    });
});
