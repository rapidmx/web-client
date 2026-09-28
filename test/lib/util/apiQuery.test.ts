// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { buildQuery, buildRequestListQuery } from "../../../lib/util/apiQuery.js";

describe("buildQuery", () => {
    it("defaults limit to 25 and page to 0 when neither is supplied", () => {
        expect(buildQuery({})).toBe("limit=25&page=0");
    });

    it("forwards an explicit limit/page", () => {
        expect(buildQuery({ limit: 10, page: 3 })).toBe("limit=10&page=3");
    });

    it("appends extra params after limit/page, in insertion order", () => {
        expect(buildQuery({ page: 1 }, { folderUid: "f1", status: "unread" })).toBe(
            "limit=25&page=1&folderUid=f1&status=unread",
        );
    });

    it("URL-encodes extra param values but not their keys", () => {
        expect(buildQuery({}, { startDate: "gte(2026-01-01T00:00:00.000Z)" })).toBe(
            "limit=25&page=0&startDate=gte(2026-01-01T00%3A00%3A00.000Z)",
        );
    });

    it("treats an explicit 0 limit/page as supplied, not as 'use the default'", () => {
        expect(buildQuery({ limit: 0, page: 0 })).toBe("limit=0&page=0");
    });
});

describe("buildRequestListQuery", () => {
    it("returns an empty string when called with no params at all", () => {
        expect(buildRequestListQuery()).toBe("");
    });

    it("returns an empty string when given an empty object", () => {
        expect(buildRequestListQuery({})).toBe("");
    });

    it("includes only the params actually supplied, applying no default page size", () => {
        expect(buildRequestListQuery({ limit: 50 })).toBe("?limit=50");
        expect(buildRequestListQuery({ page: 2 })).toBe("?page=2");
    });

    it("includes matterId only for Matter-scoped request lists", () => {
        expect(buildRequestListQuery({ matterId: "m1" })).toBe("?matterId=m1");
    });

    it("combines every supplied param", () => {
        const query = buildRequestListQuery({ limit: 10, page: 1, matterId: "m1" });
        expect(query).toBe("?limit=10&page=1&matterId=m1");
    });

    it("omits matterId when it's an empty string", () => {
        expect(buildRequestListQuery({ matterId: "" })).toBe("");
    });
});
