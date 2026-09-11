// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import IngestQueuePage from "../../../../apps/admin/ingest-queue/index.js";

const entry = {
    uid: "iq1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    envelopeFrom: "sender@example.com",
    envelopeTo: ["recipient@example.com"],
    rawBlobKey: "blob1",
    status: "pending" as const,
};

beforeEach(() => {
    window.history.pushState(null, "", "/admin/ingest-queue?mailboxUid=mb1");
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState(null, "", "/");
});

describe("IngestQueuePage", () => {
    it("shows an alert when no mailboxUid is given", async () => {
        window.history.pushState(null, "", "/admin/ingest-queue");
        mockFetch(() => jsonResponse(200, {}));
        render(<IngestQueuePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText(/No mailbox specified/)).toBeInTheDocument();
    });

    it("shows an empty-state message when there is nothing queued", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/ingest-queue")) return jsonResponse(200, []);
            throw new Error(`unexpected ${url}`);
        });
        render(<IngestQueuePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Nothing pending or failed for this mailbox.")).toBeInTheDocument();
    });

    it("lists entries with their status and error message", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            if (url.startsWith("/api/mail/ingest-queue")) {
                return jsonResponse(200, [
                    entry,
                    {
                        ...entry,
                        uid: "iq2",
                        envelopeFrom: "other-sender@example.com",
                        envelopeTo: ["other-recipient@example.com"],
                        status: "failed",
                        errorMessage: "scan timed out",
                    },
                ]);
            }
            throw new Error(`unexpected ${url}`);
        });
        render(<IngestQueuePage userUid="admin-1" authServerUrl="https://auth.example.com" />);

        expect(await screen.findByText("sender@example.com")).toBeInTheDocument();
        expect(screen.getByText("recipient@example.com")).toBeInTheDocument();
        expect(screen.getByText("other-sender@example.com")).toBeInTheDocument();
        expect(screen.getByText("other-recipient@example.com")).toBeInTheDocument();
        expect(screen.getByText("pending")).toBeInTheDocument();
        expect(screen.getByText("failed")).toBeInTheDocument();
        expect(screen.getByText("scan timed out")).toBeInTheDocument();
    });

    it("shows an error message when loading fails", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(500, { message: "boom" });
        });
        render(<IngestQueuePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when loading fails with a non-API error", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            throw new TypeError("network down");
        });
        render(<IngestQueuePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByText("Could not load the ingest queue.")).toBeInTheDocument();
    });

    it("links back to the mailbox's detail page", async () => {
        mockFetch((url) => {
            if (url === "/api/admin/release-notes") return jsonResponse(200, {});
            return jsonResponse(200, []);
        });
        render(<IngestQueuePage userUid="admin-1" authServerUrl="https://auth.example.com" />);
        expect(await screen.findByRole("link", { name: /Back to mailbox/ })).toHaveAttribute(
            "href",
            "/admin/mailboxes/mb1",
        );
    });
});
