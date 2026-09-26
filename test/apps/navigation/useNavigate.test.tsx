// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useNavigate, type NavigateFn } from "../../../apps/shared/navigation/index.js";
import { mockLocation } from "../testUtils.js";
import { createFakeRouter, TestRouter } from "../routerTestUtils.js";

let navigate: NavigateFn;
const seen: NavigateFn[] = [];

function Probe() {
    navigate = useNavigate();
    useEffect(() => {
        seen.push(navigate);
    });
    return null;
}

function mount(url: string) {
    const router = createFakeRouter({ url });
    render(
        <TestRouter router={router}>
            <Probe />
        </TestRouter>,
    );
    return router;
}

describe("useNavigate", () => {
    it("goes to another page of the app through the router, as an ordinary navigation that remounts the page", () => {
        const router = mount("/calendar");
        act(() => navigate("/contacts"));
        expect(router.navigate).toHaveBeenCalledWith("/contacts", { replace: undefined, shallow: false });
    });

    it("keeps the page for an address with the same path and another query - a folder, a mailbox - a shallow navigation", () => {
        const router = mount("/?mailboxUid=a&folderUid=x");
        act(() => navigate("/?mailboxUid=a&folderUid=y"));
        expect(router.navigate).toHaveBeenLastCalledWith("/?mailboxUid=a&folderUid=y", { replace: undefined, shallow: true });

        const tasks = mount("/tasks");
        act(() => navigate("/tasks?mailboxUid=b"));
        expect(tasks.navigate).toHaveBeenLastCalledWith("/tasks?mailboxUid=b", { replace: undefined, shallow: true });
    });

    it("is not shallow for the same query on a page with another path, or for another site", () => {
        const location = mockLocation();
        const router = mount("/contacts/c1");
        act(() => navigate("/contacts?mailboxUid=a"));
        expect(router.navigate).toHaveBeenLastCalledWith("/contacts?mailboxUid=a", { replace: undefined, shallow: false });
        act(() => navigate("https://auth.example.com/contacts/c1"));
        expect(router.navigate).toHaveBeenLastCalledWith("https://auth.example.com/contacts/c1", { replace: undefined, shallow: false });
        // (The fake router leaves what is not a page of the app to the browser, as the real one does.)
        expect(location.href).toBe("https://auth.example.com/contacts/c1");
    });

    it("passes on replace", () => {
        const router = mount("/");
        act(() => navigate("/calendar", { replace: true }));
        expect(router.navigate).toHaveBeenLastCalledWith("/calendar", { replace: true, shallow: false });
    });

    it("is the same function for the life of the page, and compares with the path the router is at when it is called", () => {
        seen.length = 0;
        const router = mount("/tasks");
        act(() => navigate("/tasks?mailboxUid=a"));
        act(() => navigate("/tasks?mailboxUid=b"));
        // The router moves the page on screen to another path without remounting it (a shallow navigation, made elsewhere).
        act(() => void router.api.navigate("/calendar", { shallow: true }));
        act(() => navigate("/calendar?x=1"));
        expect(router.navigate).toHaveBeenLastCalledWith("/calendar?x=1", { replace: undefined, shallow: true });
        expect(seen.length).toBeGreaterThan(2);
        expect(new Set(seen).size).toBe(1);
    });

    it("loads the page the ordinary way outside a router", () => {
        const location = { href: "http://localhost/", assign: vi.fn() };
        Object.defineProperty(window, "location", { configurable: true, writable: true, value: location });
        render(<Probe />);
        act(() => navigate("/contacts"));
        expect(location.assign).toHaveBeenCalledWith("/contacts");
    });
});
