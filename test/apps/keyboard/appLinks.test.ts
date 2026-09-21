///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { accountUrlOf } from "../../../apps/shared/auth/accountUrl.js";
import { APP_HREFS, SETTINGS_HREF, isSettingsPath } from "../../../apps/shared/navigation/appHrefs.js";
import { wwwRoutes } from "../../../apps/www/_routes.js";

describe("appHrefs", () => {
    it("points each rail app and Settings at a route of the client-side router", () => {
        const paths = wwwRoutes.map((route) => route.path);
        for (const href of [...Object.values(APP_HREFS), SETTINGS_HREF]) {
            expect(paths, href).toContain(href);
        }
    });

    it("knows a page of Settings from one that merely starts with the same letters", () => {
        expect(isSettingsPath("/settings")).toBe(true);
        expect(isSettingsPath("/settings/labels")).toBe(true);
        expect(isSettingsPath("/settings-not")).toBe(false);
        expect(isSettingsPath("/")).toBe(false);
    });
});

describe("accountUrlOf", () => {
    it("is auth-server's /account, without a doubled slash", () => {
        expect(accountUrlOf("https://auth.example.com")).toBe("https://auth.example.com/account");
        expect(accountUrlOf("https://auth.example.com/")).toBe("https://auth.example.com/account");
        expect(accountUrlOf("https://auth.example.com///")).toBe("https://auth.example.com/account");
    });

    it("is undefined without an auth-server", () => {
        expect(accountUrlOf(undefined)).toBeUndefined();
        expect(accountUrlOf("")).toBeUndefined();
    });
});
