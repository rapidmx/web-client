// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { useLocation } from "../../../apps/shared/navigation/index.js";
import { createFakeRouter, TestRouter } from "../routerTestUtils.js";

let seen: { pathname: string; search: string; hash: string };

function Probe() {
    seen = useLocation();
    return <span>{seen.search}</span>;
}

describe("useLocation", () => {
    afterEach(() => window.history.pushState(null, "", "/"));

    it("is the router's location under a router", () => {
        window.history.pushState(null, "", "/elsewhere?x=1");
        render(
            <TestRouter router={createFakeRouter({ url: "/settings?mailboxUid=mb2#top" })}>
                <Probe />
            </TestRouter>,
        );
        expect(seen).toEqual({ pathname: "/settings", search: "?mailboxUid=mb2", hash: "#top" });
    });

    it("is the browser's address for a page with no router, a plugin's page, so its query is not lost", () => {
        window.history.pushState(null, "", "/settings/booking-types/new?mailboxUid=mb2#form");
        const { container } = render(<Probe />);
        expect(container.textContent).toBe("?mailboxUid=mb2");
        expect(seen).toEqual({ pathname: "/settings/booking-types/new", search: "?mailboxUid=mb2", hash: "#form" });
    });

    it("follows the browser's history for a page with no router", () => {
        render(<Probe />);
        expect(seen.search).toBe("");
        act(() => {
            window.history.pushState(null, "", "/tasks?mailboxUid=mb3");
            window.dispatchEvent(new PopStateEvent("popstate"));
        });
        expect(seen).toEqual({ pathname: "/tasks", search: "?mailboxUid=mb3", hash: "" });
    });

    it("is empty on the server, where there is no browser, so the page renders as the server rendered it", () => {
        expect(renderToString(<Probe />)).toBe("<span></span>");
        expect(seen).toEqual({ pathname: "", search: "", hash: "" });
    });
});
