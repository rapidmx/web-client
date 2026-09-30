// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { appRailItems } from "../../../apps/shared/components/layout/AppShell.js";
import type { PluginUiNavItem } from "../../../apps/shared/plugins/pluginNav.js";
import { useResolvedRailItems } from "../../../apps/shared/plugins/useResolvedRailItems.js";
import { ApiClientContext } from "../../../lib/util/apiClientContext.js";
import { createApiClient } from "../../../lib/util/api.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

const meet: PluginUiNavItem = { id: "meet", label: "Meet", href: "/meet", icon: "HiOutlineVideoCamera", resolveFrom: "/mail/video-meetings/personal-room" };
const board: PluginUiNavItem = { id: "board", label: "Board", href: "/board" };

describe("useResolvedRailItems", () => {
    it("asks for the entries that name a path, and takes the link the answer gives", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { href: "/meet/abc123", label: "Jean-Philippe's Meeting Room" }));
        const { result } = renderHook(() => useResolvedRailItems([meet, board], "u1"));

        await waitFor(() => expect(result.current).toEqual({ meet: "/meet/abc123" }));
        // Only the entry that names a path is asked about.
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/mail/video-meetings/personal-room"]);
    });

    it.each([
        ["nothing for this user", () => jsonResponse(404, { message: "No personal room." })],
        ["a server error", () => jsonResponse(500, { message: "boom" })],
        ["a link to another site", () => jsonResponse(200, { href: "https://evil.example/meet" })],
        ["a protocol-relative link", () => jsonResponse(200, { href: "//evil.example/meet" })],
        ["no link", () => jsonResponse(200, {})],
        ["a link that is not text", () => jsonResponse(200, { href: 42 })],
        ["nothing readable", () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } })],
    ])("leaves the entry out for %s", async (_name, answer) => {
        const fetchMock = mockFetch(() => answer());
        const { result } = renderHook(() => useResolvedRailItems([meet], "u1"));

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(result.current).toEqual({});
    });

    it("leaves the entry out when the request fails outright", async () => {
        const fetchMock = mockFetch(() => {
            throw new TypeError("network down");
        });
        const { result } = renderHook(() => useResolvedRailItems([meet], "u1"));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(result.current).toEqual({});
    });

    it("asks nothing without a signed-in user, or when no entry names a path", () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { href: "/meet/abc" }));
        const signedOut = renderHook(() => useResolvedRailItems([meet], undefined));
        const plain = renderHook(() => useResolvedRailItems([board], "u1"));
        const none = renderHook(() => useResolvedRailItems(undefined, "u1"));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(signedOut.result.current).toEqual({});
        expect(plain.result.current).toEqual({});
        expect(none.result.current).toEqual({});
    });

    it("does not ask again for the same entries handed over as a new list, and asks again for another user", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { href: "/meet/abc" }));
        const { result, rerender } = renderHook(({ items, user }) => useResolvedRailItems(items, user), {
            initialProps: { items: [meet] as PluginUiNavItem[], user: "u1" },
        });
        await waitFor(() => expect(result.current).toEqual({ meet: "/meet/abc" }));

        rerender({ items: [{ ...meet }], user: "u1" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fetchMock).toHaveBeenCalledTimes(1);

        rerender({ items: [{ ...meet }], user: "u2" });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

        // Signing out forgets what was found.
        rerender({ items: [{ ...meet }], user: undefined });
        await waitFor(() => expect(result.current).toEqual({}));
    });

    it("ignores an answer that arrives after the page is gone", async () => {
        let answer: (() => void) | undefined;
        mockFetch(
            () =>
                new Promise<Response>((resolve) => {
                    answer = () => resolve(jsonResponse(200, { href: "/meet/abc" }));
                }),
        );
        const { result, unmount } = renderHook(() => useResolvedRailItems([meet], "u1"));
        await waitFor(() => expect(answer).toBeDefined());
        unmount();
        answer!();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(result.current).toEqual({});
    });

    it("asks through the explicit client of a host app, not the browser's cookie session", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { href: "/meet/abc" }));
        const client = createApiClient({ baseUrl: "https://acct-a.example.com", getAccessToken: async () => "tok-a" });
        const { result } = renderHook(() => useResolvedRailItems([meet], "u1"), {
            wrapper: ({ children }) => <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>,
        });
        await waitFor(() => expect(result.current).toEqual({ meet: "/meet/abc" }));
        expect(fetchMock.mock.calls[0][0]).toBe("https://acct-a.example.com/api/mail/video-meetings/personal-room");
    });

    it("takes a client given directly over the one in context", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { href: "/meet/abc" }));
        const client = createApiClient({ baseUrl: "https://acct-b.example.com", getAccessToken: async () => "tok-b" });
        const { result } = renderHook(() => useResolvedRailItems([meet], "u1", client));
        await waitFor(() => expect(result.current).toEqual({ meet: "/meet/abc" }));
        expect(fetchMock.mock.calls[0][0]).toBe("https://acct-b.example.com/api/mail/video-meetings/personal-room");
    });
});

describe("appRailItems with entries worked out per user", () => {
    const pluginNav = { appRail: [meet, board] };

    it("leaves out an entry that names a path until it has been answered, and keeps the others", () => {
        expect(appRailItems(pluginNav).map((item) => item.id)).toEqual(["mail", "calendar", "contacts", "tasks", "board"]);
        expect(appRailItems(pluginNav, {}).map((item) => item.id)).not.toContain("meet");
    });

    it("drops an entry whose answer is not a same-origin path, the way any plugin entry is", () => {
        expect(appRailItems(pluginNav, { meet: "https://evil.example/x" }).map((item) => item.id)).not.toContain("meet");
    });

    it("shows it, linked where the answer said, once it has been answered", () => {
        const items = appRailItems(pluginNav, { meet: "/meet/abc123" });
        const entry = items.find((item) => item.id === "meet")!;
        expect(entry.href).toBe("/meet/abc123");
        expect(entry.label).toBe("Meet");
        expect(items.map((item) => item.id)).toEqual(["mail", "calendar", "contacts", "tasks", "meet", "board"]);
    });

    it("does not let an answer redirect an entry that never asked for one", () => {
        const items = appRailItems(pluginNav, { board: "/elsewhere" });
        expect(items.find((item) => item.id === "board")?.href).toBe("/board");
    });
});
