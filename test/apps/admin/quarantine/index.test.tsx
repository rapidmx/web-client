// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import QuarantinePage from "../../../../apps/admin/quarantine/index.js";

const entry = {
    uid: "q1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    reason: "spam_policy" as const,
    scanResultUid: "sr1",
    rawBlobKey: "blob1",
};

beforeEach(() => {
    window.history.pushState(null, "", "/admin/quarantine?mailboxUid=mb1");
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState(null, "", "/");
});

describe("QuarantinePage", () => {
    it("shows an alert when no mailboxUid is given", async () => {
        window.history.pushState(null, "", "/admin/quarantine");
        mockFetch(() => jsonResponse(200, {}));
        render(<QuarantinePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText(/No mailbox specified/)).toBeInTheDocument();
    });

    it("shows an empty-state message when nothing is quarantined", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/quarantine")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<QuarantinePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Nothing quarantined for this mailbox.")).toBeInTheDocument();
    });

    it("lists held entries and releases one", async () => {
        let entries = [entry];
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            const method = init?.method ?? "GET";
            if (method === "GET" && url.startsWith("/api/mail/quarantine")) return jsonResponse(200, entries);
            if (method === "PUT") {
                const body = JSON.parse(init.body as string);
                entries = entries.map((e) => (e.uid === body.uid ? { ...e, releasedAt: body.releasedAt, releasedByUserUid: body.releasedByUserUid } : e));
                return jsonResponse(200, entries[0]);
            }
            throw new Error(`unexpected ${method} ${url}`);
        });
        const user = userEvent.setup();
        render(<QuarantinePage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByText("spam_policy")).toBeInTheDocument();
        expect(screen.getByText("Held")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Release" }));

        expect(await screen.findByText("Released")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Release" })).not.toBeInTheDocument();
    });

    it("shows an error message when loading fails", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(500, { message: "boom" });
        });
        render(<QuarantinePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<QuarantinePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Could not load quarantine.")).toBeInTheDocument();
    });

    it("shows an error message when releasing fails", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            const method = init?.method ?? "GET";
            if (method === "GET") return jsonResponse(200, [entry]);
            return jsonResponse(500, { message: "release failed" });
        });
        const user = userEvent.setup();
        render(<QuarantinePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("spam_policy");

        await user.click(screen.getByRole("button", { name: "Release" }));

        expect(await screen.findByText("release failed")).toBeInTheDocument();
    });

    it("shows a generic error message when releasing fails with a non-API error", async () => {
        mockFetch((url, init) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            const method = init?.method ?? "GET";
            if (method === "GET") return jsonResponse(200, [entry]);
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<QuarantinePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        await screen.findByText("spam_policy");

        await user.click(screen.getByRole("button", { name: "Release" }));

        expect(await screen.findByText("Could not release this message.")).toBeInTheDocument();
    });

    it("paginates: Next fetches the following page, Previous returns to the first", async () => {
        const fullPage = Array.from({ length: 25 }, (_, i) => ({ ...entry, uid: `q${i}`, reason: "infected" as const }));
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (!url.startsWith("/api/mail/quarantine")) throw new Error(`unexpected ${url}`);
            if (url.includes("page=0")) return jsonResponse(200, fullPage);
            if (url.includes("page=1")) return jsonResponse(200, [{ ...entry, uid: "q99", reason: "other" as const }]);
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<QuarantinePage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findAllByText("infected")).toHaveLength(25);
        expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(await screen.findByText("other")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Previous" }));
        expect(await screen.findAllByText("infected")).toHaveLength(25);
    });

    it("links back to the mailbox's detail page", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(200, []);
        });
        render(<QuarantinePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByRole("link", { name: /Back to mailbox/ })).toHaveAttribute(
            "href",
            "/admin/mailboxes/mb1",
        );
    });
});
