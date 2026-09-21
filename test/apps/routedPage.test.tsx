// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { wwwRoutes } from "../../apps/www/_routes.js";
import { routedPage } from "../../apps/www/_routedPage.js";
import { matchRoute } from "../../apps/shared/navigation/routes.js";

const router = vi.hoisted(() => ({ props: [] as any[] }));
vi.mock("../../apps/shared/navigation/AppRouter.js", () => ({
    default: (props: any) => {
        router.props.push(props);
        return null;
    },
    // What the pages loaded below import from it (none of it is called while a module is only loaded).
    useNavigate: () => () => undefined,
    useLocation: () => ({ pathname: "", search: "", hash: "" }),
    useLocationSearch: () => "",
}));

/** The route template a page file serves, as `@rapidrest/react` derives it: `index.tsx` is its directory, `[uid].tsx` is `:uid`. */
function templateOf(file: string): string {
    const segments = file
        .replace(/\.tsx$/, "")
        .replace(/(^|\/)index$/, "")
        .split("/")
        .filter(Boolean)
        .map((segment) => (segment.startsWith("[") ? `:${segment.slice(1, -1)}` : segment));
    return "/" + segments.join("/");
}

function pageFiles(dir: string, base = dir): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith("_")) {
            return [];
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return pageFiles(full, base);
        }
        return entry.name.endsWith(".tsx") ? [path.relative(base, full).split(path.sep).join("/")] : [];
    });
}

describe("routedPage", () => {
    it("renders the router with the page as its first content and the page's own props", () => {
        function Page() {
            return null;
        }
        const Routed = routedPage("/somewhere", Page);
        renderToStaticMarkup(<Routed {...({ userUid: "u1" } as any)} />);
        expect(router.props[0]).toMatchObject({ initialPath: "/somewhere", initialPage: Page, pageProps: { userUid: "u1" }, routes: wwwRoutes });
    });

    it("carries the plain page as .page, which is what the router shows when it loads the module", () => {
        function Page() {
            return null;
        }
        expect(routedPage("/x", Page).page).toBe(Page);
    });
});

describe("the www route table", () => {
    const pagesDir = path.resolve(__dirname, "../../apps/www");

    it("has a route for every page under apps/www, and only for those, so a new page is never left out of the router by accident", () => {
        const fromFiles = pageFiles(pagesDir).map(templateOf).sort();
        expect(wwwRoutes.map((route) => route.path).sort()).toEqual(fromFiles);
    });

    it("has no route that shadows a later one, so each page matches its own path", () => {
        for (const route of wwwRoutes) {
            const concrete = route.path.replace(/:\w+/g, "abc");
            expect(matchRoute(wwwRoutes, concrete)?.route.path).toBe(route.path);
        }
    });

    it("loads each page as a module whose default export is a routedPage(), with the plain page inside", async () => {
        for (const route of wwwRoutes) {
            const module = await route.load();
            expect(typeof module.default, route.path).toBe("function");
            expect(typeof (module.default as any).page, route.path).toBe("function");
        }
    }, 60_000);

    it("marks the four app-rail pages for idle prefetching", () => {
        expect(wwwRoutes.filter((route) => route.idlePrefetch).map((route) => route.path)).toEqual(["/", "/calendar", "/contacts", "/tasks"]);
    });

    it("highlights the rail entry each page belongs to", () => {
        const active = Object.fromEntries(wwwRoutes.map((route) => [route.path, route.active]));
        expect(active["/"]).toBe("mail");
        expect(active["/messages/:uid"]).toBe("mail");
        expect(active["/calendar"]).toBe("calendar");
        expect(active["/contacts/:uid"]).toBe("contacts");
        expect(active["/tasks"]).toBe("tasks");
        expect(active["/settings/privacy"]).toBe("settings");
    });
});
