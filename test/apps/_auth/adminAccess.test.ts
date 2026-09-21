// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import {
    ADMIN_ACCESS_KEY_PREFIX,
    ADMIN_ACCESS_TTL_MS,
    DEFAULT_TRUSTED_ROLES,
    lookUpAdminAccess,
    resetAdminAccessLookups,
} from "../../../apps/shared/auth/adminAccess.js";

const AUTH = "https://auth.example.com";
const KEY = `${ADMIN_ACCESS_KEY_PREFIX}jane`;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAdminAccessLookups();
});

describe("lookUpAdminAccess", () => {
    it("reads the caller's own User record and is true for a trusted role, without elevation", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "jane", roles: ["user", "admin"], scopes: [] }));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(`${AUTH}/api/users/me`);
        expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe("include");
    });

    it("is false for a user with no trusted role", async () => {
        mockFetch(() => jsonResponse(200, { uid: "jane", roles: ["user"] }));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBe(false);
    });

    it("looks for the configured role names instead of admin", async () => {
        mockFetch(() => jsonResponse(200, { uid: "jane", roles: ["operator"] }));
        expect(await lookUpAdminAccess(AUTH, "jane", ["operator", "root"])).toBe(true);
        sessionStorage.clear();
        expect(await lookUpAdminAccess(AUTH, "jane", ["root"])).toBe(false);
        expect(DEFAULT_TRUSTED_ROLES).toEqual(["admin"]);
    });

    it("remembers the answer for the session, so the next call makes no request", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "jane", roles: ["admin"] }));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBe(true);
        expect(await lookUpAdminAccess(AUTH, "jane")).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(sessionStorage.getItem(KEY)!)).toMatchObject({ admin: true });
    });

    it("remembers a negative answer too", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "jane", roles: [] }));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBe(false);
        expect(await lookUpAdminAccess(AUTH, "jane")).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not reuse an answer remembered for another user, or one past its lifetime", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "jane", roles: ["admin"] }));
        sessionStorage.setItem(`${ADMIN_ACCESS_KEY_PREFIX}bob`, JSON.stringify({ admin: false, at: Date.now() }));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const now = Date.now() + ADMIN_ACCESS_TTL_MS + 1;
        expect(await lookUpAdminAccess(AUTH, "jane", ["admin"], now)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("ignores a remembered answer that is malformed or from the future", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { uid: "jane", roles: ["admin"] }));
        for (const junk of ["not json", JSON.stringify({ admin: "yes", at: Date.now() }), JSON.stringify({ admin: true }), JSON.stringify({ admin: true, at: Date.now() + 60_000 })]) {
            sessionStorage.setItem(KEY, junk);
            expect(await lookUpAdminAccess(AUTH, "jane")).toBe(true);
        }
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("makes one request for two callers asking at the same time", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const fetchMock = mockFetch(async () => {
            await gate;
            return jsonResponse(200, { uid: "jane", roles: ["admin"] });
        });
        const first = lookUpAdminAccess(AUTH, "jane");
        const second = lookUpAdminAccess(AUTH, "jane");
        release();
        expect(await Promise.all([first, second])).toEqual([true, true]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("is undefined, and remembers nothing, when the request fails", async () => {
        mockFetch(() => jsonResponse(401, { message: "no" }));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBeUndefined();
        expect(sessionStorage.getItem(KEY)).toBeNull();

        mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBeUndefined();
    });

    it("is undefined for a body that isn't this user's record", async () => {
        mockFetch(() => jsonResponse(200, { uid: "someone-else", roles: ["admin"] }));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBeUndefined();
        mockFetch(() => jsonResponse(200, { uid: "jane" }));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBeUndefined();
        mockFetch(() => jsonResponse(200, null));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBeUndefined();
    });

    it("ignores non-string entries in roles", async () => {
        mockFetch(() => jsonResponse(200, { uid: "jane", roles: [42, null, { admin: true }] }));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBe(false);
    });

    it("still answers when storage is unavailable", async () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        mockFetch(() => jsonResponse(200, { uid: "jane", roles: ["admin"] }));
        expect(await lookUpAdminAccess(AUTH, "jane")).toBe(true);
    });
});
