// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Forced onto the plain `node` environment so `window` and `document` are genuinely absent, the way they are while the server
// renders the page: the router must render the chrome and the page exactly as the browser will hydrate them, without reading
// the browser's location (the server can't know the query string) or scheduling anything.
import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AppRouter, { useLocation, useNavigate } from "../../../apps/shared/navigation/AppRouter.js";
import { FrameTakeover } from "../../../apps/shared/navigation/frameContext.js";

const chromeProps = vi.hoisted(() => ({ seen: [] as any[] }));
vi.mock("../../../apps/shared/components/layout/AppShell.js", async () => {
    const react = await import("react");
    return {
        AppChrome: (props: any) => {
            chromeProps.seen.push(props);
            return react.createElement("main", { "data-active": props.active, "data-hidden": String(!!props.hideChrome) }, props.children);
        },
    };
});

function Page(props: any) {
    const location = useLocation();
    const navigate = useNavigate();
    return (
        <p>
            {props.params.uid}|{JSON.stringify(location)}|{typeof navigate}
            <FrameTakeover>takeover</FrameTakeover>
        </p>
    );
}

describe("AppRouter server-side", () => {
    it("renders the page inside the chrome, with an unknown location and nothing scheduled", () => {
        expect(typeof window).toBe("undefined");
        const html = renderToString(
            <AppRouter
                routes={[{ path: "/items/:uid", active: "contacts", load: () => Promise.resolve({ default: () => null }), idlePrefetch: true }]}
                initialPath="/items/:uid"
                initialPage={Page}
                pageProps={{
                    userUid: "u1",
                    params: { uid: "abc" },
                    branding: { title: "for the chrome" },
                    appearance: { version: 1, mode: "dark" },
                    other: "not for the chrome",
                }}
            />,
        );
        expect(html).toContain('data-active="contacts"');
        expect(html).toContain('data-hidden="false"');
        expect(html).toContain("abc");
        expect(html).toContain("&quot;pathname&quot;:&quot;&quot;");
        expect(html).toContain("function");
        expect(html).toContain("takeover");
        // Only what the chrome takes is passed to it: the user, the branding and the appearance the server rendered the page with - not the rest.
        expect(chromeProps.seen[0]).toMatchObject({
            userUid: "u1",
            routeKey: "initial",
            branding: { title: "for the chrome" },
            appearance: { version: 1, mode: "dark" },
        });
        expect(chromeProps.seen[0].other).toBeUndefined();
        expect(chromeProps.seen[0].params).toBeUndefined();
    });
});
