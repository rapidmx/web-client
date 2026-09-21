// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { RouteDefinition, matchRoute } from "../../../apps/shared/navigation/routes.js";

const load = () => Promise.resolve({ default: () => null });
const routes: RouteDefinition[] = [
    { path: "/", active: "mail", load },
    { path: "/settings/filters/new", active: "settings", load },
    { path: "/settings/filters/:uid", active: "settings", load },
    { path: "/messages/:uid", active: "mail", load },
];

describe("matchRoute", () => {
    it("matches the root and ignores a trailing slash", () => {
        expect(matchRoute(routes, "/")?.route.path).toBe("/");
        expect(matchRoute(routes, "")?.route.path).toBe("/");
        expect(matchRoute(routes, "/settings/filters/new/")?.route.path).toBe("/settings/filters/new");
    });

    it("returns the first route that matches, so literal routes listed before parameterized ones win", () => {
        expect(matchRoute(routes, "/settings/filters/new")?.route.path).toBe("/settings/filters/new");
        expect(matchRoute(routes, "/settings/filters/abc")).toMatchObject({ route: { path: "/settings/filters/:uid" }, params: { uid: "abc" } });
    });

    it("decodes parameters", () => {
        expect(matchRoute(routes, "/messages/a%20b%2Fc")?.params).toEqual({ uid: "a b/c" });
    });

    it("does not match a parameter that is not valid percent-encoding", () => {
        expect(matchRoute(routes, "/messages/%E0%A4%A")).toBeUndefined();
    });

    it("does not match another number of segments, or another literal", () => {
        expect(matchRoute(routes, "/messages")).toBeUndefined();
        expect(matchRoute(routes, "/messages/a/b")).toBeUndefined();
        expect(matchRoute(routes, "/admin")).toBeUndefined();
        expect(matchRoute(routes, "/settings/other/new")).toBeUndefined();
    });
});
