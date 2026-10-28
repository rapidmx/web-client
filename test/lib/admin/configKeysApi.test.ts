// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { ApiRequestError, createApiClient } from "../../../lib/util/api.js";
import { activateConfigKey, ConfigKeys, configKeysOfRefusal, getConfigKeys, rotateConfigKey } from "../../../lib/admin/configKeysApi.js";

const view: ConfigKeys = {
    available: true,
    activeKid: "aaaa1111",
    keys: [{ kid: "aaaa1111", createdAt: "2026-04-01T00:00:00.000Z", active: true, envelopes: 12 }],
    countedAt: "2026-10-28T00:00:00.000Z",
    rotation: null,
    reencryption: null,
    pluginSecrets: null,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("configKeysApi", () => {
    it("reads the keyring's state", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, view));
        expect(await getConfigKeys()).toEqual(view);
        expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["/api/system/config-keys"]);
    });

    it("starts a rotation, normal or compromised", async () => {
        const fetchMock = mockFetch(() => jsonResponse(202, view));
        await rotateConfigKey();
        await rotateConfigKey({ compromised: true });
        expect(fetchMock.mock.calls.map((call) => [call[0], call[1].method, JSON.parse(call[1].body as string)])).toEqual([
            ["/api/system/config-keys/rotate", "POST", {}],
            ["/api/system/config-keys/rotate", "POST", { compromised: true }],
        ]);
    });

    it("activates a key anyway, naming it", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, view));
        await activateConfigKey("bbbb2222");
        expect(fetchMock.mock.calls[0][0]).toBe("/api/system/config-keys/activate");
        expect(fetchMock.mock.calls[0][1].method).toBe("POST");
        expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ kid: "bbbb2222" });
    });

    it("goes through an explicit client", async () => {
        const client = createApiClient({ baseUrl: "https://mail.example.com", getAccessToken: async () => "tok" });
        const fetchMock = mockFetch(() => jsonResponse(200, view));
        await getConfigKeys(client);
        await rotateConfigKey({ compromised: true }, client);
        await activateConfigKey("bbbb2222", client);
        expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
            "https://mail.example.com/api/system/config-keys",
            "https://mail.example.com/api/system/config-keys/rotate",
            "https://mail.example.com/api/system/config-keys/activate",
        ]);
    });

    describe("configKeysOfRefusal", () => {
        it("takes the progress a 409 carries as its body", () => {
            const busy = { ...view, rotation: { previousKids: [], compromised: false, phase: "adding" } };
            expect(configKeysOfRefusal(new ApiRequestError("Conflict", 409, undefined, busy))).toEqual(busy);
        });

        it("takes nothing from any other failure or a body that is not the keyring's state", () => {
            expect(configKeysOfRefusal(new ApiRequestError("Down", 503, undefined, view))).toBeUndefined();
            expect(configKeysOfRefusal(new ApiRequestError("Conflict", 409, undefined, { message: "no" }))).toBeUndefined();
            expect(configKeysOfRefusal(new ApiRequestError("Conflict", 409))).toBeUndefined();
            expect(configKeysOfRefusal(new Error("x"))).toBeUndefined();
        });
    });
});
