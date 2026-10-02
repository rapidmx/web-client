// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyResponse, jsonResponse, mockFetch } from "../testUtils.js";
import {
    Branding,
    deleteBrandingIcon,
    deleteBrandingLogo,
    deleteBrandingStylesheet,
    getBranding,
    updateBranding,
    uploadBrandingIcon,
    uploadBrandingLogo,
    uploadBrandingStylesheet,
} from "../../../lib/branding/brandingApi.js";
import { configureApiBaseUrl, createApiClient } from "../../../lib/util/api.js";

const branding: Branding = { companyName: "Acme", title: "Acme Mail" };

afterEach(() => {
    vi.unstubAllGlobals();
    configureApiBaseUrl("");
});

describe("getBranding", () => {
    it("fetches the singleton branding row", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, branding));
        const result = await getBranding();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/branding", expect.anything());
        expect(result).toEqual(branding);
    });
});

describe("updateBranding", () => {
    it("PUTs the given input", async () => {
        const updated: Branding = { ...branding, title: "New Title" };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));
        const result = await updateBranding({ title: "New Title" });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/branding",
            expect.objectContaining({ method: "PUT", body: JSON.stringify({ title: "New Title" }) }),
        );
        expect(result).toEqual(updated);
    });
});

describe("uploadBrandingLogo", () => {
    it("echoes the csrf cookie as x-csrf-token, which the server refuses an upload without", async () => {
        document.cookie = "csrf=tok-brand";
        const fetchMock = mockFetch(() => jsonResponse(200, {}));
        await uploadBrandingStylesheet(new File(["a{}"], "brand.css", { type: "text/css" }));
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get("x-csrf-token")).toBe("tok-brand");
        document.cookie = "csrf=; Max-Age=0; path=/";
    });

    it("posts the file's raw bytes with its own content-type, not JSON", async () => {
        const file = new File(["png-bytes"], "logo.png", { type: "image/png" });
        const updated: Branding = { ...branding, logoUrl: "/api/system/branding/logo" };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));

        const result = await uploadBrandingLogo(file);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/branding/logo",
            expect.objectContaining({ method: "POST", body: file, credentials: "include" }),
        );
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get("Content-Type")).toBe("image/png");
        expect(result).toEqual(updated);
    });

    it("targets the configured API base URL", async () => {
        configureApiBaseUrl("https://mail.example.com");
        const fetchMock = mockFetch(() => jsonResponse(200, branding));
        await uploadBrandingLogo(new File(["png-bytes"], "logo.png", { type: "image/png" }));
        expect(fetchMock.mock.calls[0][0]).toBe("https://mail.example.com/api/system/branding/logo");
    });

    it("falls back to application/octet-stream when the file has no type", async () => {
        const file = new File(["bytes"], "logo");
        const fetchMock = mockFetch(() => jsonResponse(200, branding));

        await uploadBrandingLogo(file);

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(new Headers(init.headers).get("Content-Type")).toBe("application/octet-stream");
    });

    it("throws ApiRequestError using the body's message field on a non-ok response", async () => {
        const file = new File(["png-bytes"], "logo.png", { type: "image/png" });
        mockFetch(() => jsonResponse(400, { message: "too large", code: "api-101" }));

        await expect(uploadBrandingLogo(file)).rejects.toMatchObject({ message: "too large", status: 400, code: "api-101" });
    });

    it("falls back to the response's statusText when the error body has no message/error field", async () => {
        const file = new File(["png-bytes"], "logo.png", { type: "image/png" });
        mockFetch(() => new Response(null, { status: 500, statusText: "Server Error" }));

        await expect(uploadBrandingLogo(file)).rejects.toMatchObject({ message: "Server Error", status: 500 });
    });

    it("falls back to the body's error field when message is absent", async () => {
        const file = new File(["png-bytes"], "logo.png", { type: "image/png" });
        mockFetch(() => jsonResponse(400, { error: "too large" }));

        await expect(uploadBrandingLogo(file)).rejects.toMatchObject({ message: "too large" });
    });

    it("treats an unparseable JSON body as no body", async () => {
        const file = new File(["png-bytes"], "logo.png", { type: "image/png" });
        mockFetch(() => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }));

        const result = await uploadBrandingLogo(file);
        expect(result).toBeUndefined();
    });

    it("falls back to the literal 'Upload failed.' when there is neither a body nor a statusText", async () => {
        const file = new File(["png-bytes"], "logo.png", { type: "image/png" });
        mockFetch(() => new Response(null, { status: 500, statusText: "" }));

        await expect(uploadBrandingLogo(file)).rejects.toMatchObject({ message: "Upload failed." });
    });
});

describe("uploadBrandingIcon", () => {
    it("posts the file's raw bytes", async () => {
        const file = new File(["png-bytes"], "icon.png", { type: "image/png" });
        const updated: Branding = { ...branding, iconUrl: "/api/system/branding/icon" };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));

        const result = await uploadBrandingIcon(file);

        expect(fetchMock).toHaveBeenCalledWith("/api/system/branding/icon", expect.objectContaining({ method: "POST", body: file }));
        expect(result).toEqual(updated);
    });
});

describe("uploadBrandingStylesheet", () => {
    it("posts the file's raw bytes", async () => {
        const file = new File(["body{}"], "theme.css", { type: "text/css" });
        const updated: Branding = { ...branding, stylesheetUrl: "/api/system/branding/stylesheet" };
        const fetchMock = mockFetch(() => jsonResponse(200, updated));

        const result = await uploadBrandingStylesheet(file);

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/system/branding/stylesheet",
            expect.objectContaining({ method: "POST", body: file }),
        );
        expect(result).toEqual(updated);
    });
});

describe("deleteBrandingLogo", () => {
    it("DELETEs the logo", async () => {
        const fetchMock = mockFetch(() => emptyResponse(204));
        await deleteBrandingLogo();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/branding/logo", expect.objectContaining({ method: "DELETE" }));
    });
});

describe("deleteBrandingIcon", () => {
    it("DELETEs the icon", async () => {
        const fetchMock = mockFetch(() => emptyResponse(204));
        await deleteBrandingIcon();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/branding/icon", expect.objectContaining({ method: "DELETE" }));
    });
});

describe("deleteBrandingStylesheet", () => {
    it("DELETEs the stylesheet", async () => {
        const fetchMock = mockFetch(() => emptyResponse(204));
        await deleteBrandingStylesheet();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/branding/stylesheet", expect.objectContaining({ method: "DELETE" }));
    });
});

describe("with an explicit ApiClient", () => {
    it("every function routes through the given client's own baseUrl/token instead of the default global apiFetch()", async () => {
        const client = createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, branding));

        await getBranding(client);
        await updateBranding({ title: "New Title" }, client);
        await deleteBrandingLogo(client);
        await deleteBrandingIcon(client);
        await deleteBrandingStylesheet(client);

        expect(fetchMock).toHaveBeenCalledTimes(5);
        for (const call of fetchMock.mock.calls) {
            expect(call[0]).toMatch(/^https:\/\/account-a\.example\.com\/api\//);
            expect((call[1].headers as Headers).get("Authorization")).toBe("jwt tok-a");
            expect(call[1].credentials).toBeUndefined();
        }
    });

    it("omitting the client still calls the default global apiFetch(), unaffected by any client existing elsewhere", async () => {
        createApiClient({ baseUrl: "https://account-a.example.com", getAccessToken: async () => "tok-a" });
        const fetchMock = mockFetch(() => jsonResponse(200, branding));
        await getBranding();
        expect(fetchMock).toHaveBeenCalledWith("/api/system/branding", expect.anything());
        expect((fetchMock.mock.calls[0][1].headers as Headers).has("Authorization")).toBe(false);
    });
});

describe("branding uploads with a client", () => {
    it("goes through an explicit client, to that account's origin with its token, when given one", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { companyName: "A", title: "B" }));
        const client = createApiClient({ baseUrl: "https://a.example.com", getAccessToken: async () => "tok" });
        await uploadBrandingLogo(new File(["x"], "l.png", { type: "image/png" }), client);
        expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/a\.example\.com\/api\//);
        expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers).get("Authorization")).toBe("jwt tok");
    });

    it("passes the client to the icon and stylesheet uploads too", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { companyName: "A", title: "B" }));
        const client = createApiClient({ baseUrl: "https://a.example.com", getAccessToken: async () => "tok" });
        await uploadBrandingIcon(new File(["x"], "i.png", { type: "image/png" }), client);
        await uploadBrandingStylesheet(new File(["a{}"], "b.css", { type: "text/css" }), client);
        expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
            "https://a.example.com/api/system/branding/icon",
            "https://a.example.com/api/system/branding/stylesheet",
        ]);
    });
});
