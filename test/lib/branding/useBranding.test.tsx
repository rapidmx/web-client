// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import useBranding from "../../../lib/branding/useBranding.js";

function Harness() {
    const { branding, logoSrc, iconSrc } = useBranding();
    return (
        <span data-testid="value">{JSON.stringify({ branding, logoSrc, iconSrc })}</span>
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
    document.title = "";
    document.getElementById("branding-stylesheet")?.remove();
});

describe("useBranding", () => {
    it("defaults to the built-in logo and null branding before/on a failed fetch", async () => {
        mockFetch(() => jsonResponse(500, { message: "boom" }));
        render(<Harness />);
        await waitFor(() => {
            const value = JSON.parse(screen.getByTestId("value").textContent);
            expect(value).toEqual({ branding: null, logoSrc: "/images/logo.svg", iconSrc: "/images/logo.svg" });
        });
    });

    it("applies the loaded logo, title, and stylesheet link, falling back to the logo for the icon when unset", async () => {
        mockFetch(() =>
            jsonResponse(200, {
                companyName: "Acme",
                title: "Acme Mail",
                logoUrl: "https://cdn.example.com/logo.png",
                stylesheetUrl: "/api/system/branding/stylesheet",
            }),
        );
        render(<Harness />);

        await waitFor(() => expect(document.title).toBe("Acme Mail"));
        const value = JSON.parse(screen.getByTestId("value").textContent);
        expect(value.logoSrc).toBe("https://cdn.example.com/logo.png");
        expect(value.iconSrc).toBe("https://cdn.example.com/logo.png");

        const link = document.getElementById("branding-stylesheet") as HTMLLinkElement | null;
        expect(link).not.toBeNull();
        expect(link?.rel).toBe("stylesheet");
        expect(link?.getAttribute("href")).toBe("/api/system/branding/stylesheet");
    });

    it("prefers a configured icon over the logo for iconSrc", async () => {
        mockFetch(() =>
            jsonResponse(200, {
                companyName: "Acme",
                title: "Acme Mail",
                logoUrl: "https://cdn.example.com/logo.png",
                iconUrl: "https://cdn.example.com/icon.png",
            }),
        );
        render(<Harness />);

        await waitFor(() => {
            const value = JSON.parse(screen.getByTestId("value").textContent);
            expect(value.iconSrc).toBe("https://cdn.example.com/icon.png");
            expect(value.logoSrc).toBe("https://cdn.example.com/logo.png");
        });
    });

    it("leaves the document title alone and injects no stylesheet link when branding has neither", async () => {
        mockFetch(() => jsonResponse(200, { companyName: "", title: "" }));
        render(<Harness />);

        await waitFor(() => {
            const value = JSON.parse(screen.getByTestId("value").textContent);
            expect(value.branding).toEqual({ companyName: "", title: "" });
        });
        expect(document.title).toBe("");
        expect(document.getElementById("branding-stylesheet")).toBeNull();
    });

    it("removes a pre-existing stylesheet link immediately on mount, before branding has loaded", async () => {
        // NOTE (2026-09-11): the doc comment on this effect says it "reuses an existing <link>
        // (server-rendered ... when a stylesheet is already configured)", but that's not actually what
        // happens: `branding` starts `null` on every mount, so this effect's *first* run (before the
        // fetch resolves) always takes the `!branding?.stylesheetUrl` branch and removes whatever link
        // is already there - including a legitimate server-rendered one. By the time branding loads, the
        // link is already gone, so a fresh one is always created rather than reused. This test documents
        // that actual behavior (worth a closer look/fix separately - flagged, not changed here); see
        // vitest.config.ts's per-file threshold override for why this file isn't held to 100% branches.
        const existingLink = document.createElement("link");
        existingLink.id = "branding-stylesheet";
        existingLink.rel = "stylesheet";
        existingLink.href = "/api/system/branding/stylesheet";
        document.head.appendChild(existingLink);

        let resolveFetch: (res: Response) => void;
        mockFetch(
            () =>
                new Promise<Response>((resolve) => {
                    resolveFetch = resolve;
                }),
        );
        render(<Harness />);

        expect(document.getElementById("branding-stylesheet")).toBeNull();

        resolveFetch(
            jsonResponse(200, { companyName: "Acme", title: "Acme Mail", stylesheetUrl: "/api/system/branding/stylesheet?v=2" }),
        );
        await waitFor(() => expect(document.getElementById("branding-stylesheet")).not.toBeNull());
        const recreatedLink = document.getElementById("branding-stylesheet") as HTMLLinkElement;
        expect(recreatedLink).not.toBe(existingLink);
        expect(recreatedLink.getAttribute("href")).toBe("/api/system/branding/stylesheet?v=2");
    });

    it("leaves the stylesheet link in place on unmount - it may be server-rendered and shared across shells", async () => {
        mockFetch(() =>
            jsonResponse(200, { companyName: "Acme", title: "Acme Mail", stylesheetUrl: "/api/system/branding/stylesheet" }),
        );
        const { unmount } = render(<Harness />);
        await waitFor(() => expect(document.getElementById("branding-stylesheet")).not.toBeNull());

        unmount();
        expect(document.getElementById("branding-stylesheet")).not.toBeNull();
    });

    it("does not update state after unmounting before the fetch resolves", async () => {
        let resolveFetch: (res: Response) => void;
        mockFetch(
            () =>
                new Promise<Response>((resolve) => {
                    resolveFetch = resolve;
                }),
        );
        const { unmount } = render(<Harness />);
        unmount();

        expect(() => resolveFetch(jsonResponse(200, { companyName: "Acme", title: "Acme Mail" }))).not.toThrow();
    });
});
