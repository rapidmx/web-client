// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { formatProfileName, getMyProfile, getMyUsername, profileInitials } from "../../../lib/auth/profileApi.js";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("getMyProfile", () => {
    it("fetches auth-server's /profiles/me with credentials included", async () => {
        const profile = { uid: "u1", givenName: "Jane", familyName: "Doe" };
        const fetchMock = mockFetch(() => jsonResponse(200, profile));
        const result = await getMyProfile("https://auth.example.com");
        expect(fetchMock).toHaveBeenCalledWith(
            "https://auth.example.com/api/profiles/me",
            expect.objectContaining({ credentials: "include" }),
        );
        expect(result).toEqual(profile);
    });
});

describe("getMyUsername", () => {
    it("fetches the caller's own name aliases from auth-server with credentials and returns the first verified one", async () => {
        const fetchMock = mockFetch(() =>
            jsonResponse(200, [
                { alias: "pending", type: "name", verified: false },
                { alias: "arthur", type: "name", verified: true },
                { alias: "arthur2", type: "name", verified: true },
            ]),
        );
        await expect(getMyUsername("https://auth.example.com")).resolves.toBe("arthur");
        expect(fetchMock).toHaveBeenCalledWith(
            "https://auth.example.com/api/aliases?type=name",
            expect.objectContaining({ credentials: "include" }),
        );
    });

    it("ignores aliases of another type, unverified ones and ones with no alias, in case the server didn't filter", async () => {
        mockFetch(() =>
            jsonResponse(200, [
                { alias: "a@example.com", type: "email", verified: true },
                { alias: "unverified", type: "name", verified: false },
                { alias: "noflag", type: "name" },
                { alias: "", type: "name", verified: true },
                null,
            ]),
        );
        await expect(getMyUsername("https://auth.example.com")).resolves.toBeUndefined();
    });

    it("resolves undefined for an empty list", async () => {
        mockFetch(() => jsonResponse(200, []));
        await expect(getMyUsername("https://auth.example.com")).resolves.toBeUndefined();
    });

    it("resolves undefined for a body that is not a list", async () => {
        mockFetch(() => jsonResponse(200, { alias: "arthur" }));
        await expect(getMyUsername("https://auth.example.com")).resolves.toBeUndefined();
    });

    it("resolves undefined instead of rejecting when the request fails", async () => {
        mockFetch(() => jsonResponse(403, { message: "nope" }));
        await expect(getMyUsername("https://auth.example.com")).resolves.toBeUndefined();
        mockFetch(() => {
            throw new TypeError("blocked by CORS");
        });
        await expect(getMyUsername("https://auth.example.com")).resolves.toBeUndefined();
    });
});

describe("formatProfileName", () => {
    it("joins givenName and familyName", () => {
        expect(formatProfileName({ givenName: "Jane", familyName: "Doe" })).toBe("Jane Doe");
    });

    it("uses just givenName when familyName is absent", () => {
        expect(formatProfileName({ givenName: "Jane" })).toBe("Jane");
    });

    it("uses just familyName when givenName is absent", () => {
        expect(formatProfileName({ familyName: "Doe" })).toBe("Doe");
    });

    it("returns undefined when neither is set", () => {
        expect(formatProfileName({})).toBeUndefined();
    });

    it("returns undefined when the profile itself is undefined", () => {
        expect(formatProfileName(undefined)).toBeUndefined();
    });
});

describe("profileInitials", () => {
    it("combines the first letter of givenName and familyName", () => {
        expect(profileInitials({ givenName: "Jane", familyName: "Doe" }, "u1")).toBe("JD");
    });

    it("falls back to the uid's first letter when the profile has no name", () => {
        expect(profileInitials({}, "u1")).toBe("U");
    });

    it("falls back to the username's first letter, ahead of the uid's, when the profile has no name", () => {
        expect(profileInitials({}, "u1", "arthur")).toBe("A");
        expect(profileInitials(undefined, "u1", "arthur")).toBe("A");
    });

    it("prefers the profile's name over the username", () => {
        expect(profileInitials({ givenName: "Jane" }, "u1", "arthur")).toBe("J");
    });

    it("skips an empty username", () => {
        expect(profileInitials(undefined, "u1", "")).toBe("U");
    });

    it("falls back to the uid's first letter when the profile itself is undefined", () => {
        expect(profileInitials(undefined, "jane")).toBe("J");
    });

    it("falls back to '?' when there is no name and no uid", () => {
        expect(profileInitials(undefined, "")).toBe("?");
    });
});
