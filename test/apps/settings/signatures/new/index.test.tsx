// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, mockLocation } from "../../../testUtils.js";
import NewSignaturePage from "../../../../../apps/www/settings/signatures/new/index.js";

vi.mock("../../../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
    default: ({
        value,
        onChange,
        onUploadImage,
    }: {
        value: string;
        onChange: (v: string) => void;
        onUploadImage: (file: File) => Promise<string | null>;
    }) => (
        <div>
            <textarea aria-label="Signature content" data-testid="html-editor" value={value} onChange={(e) => onChange(e.target.value)} />
            <button type="button" onClick={() => onUploadImage(new File(["x"], "x.png", { type: "image/png" }))}>
                fake-upload-image
            </button>
        </div>
    ),
}));

const mailbox = {
    uid: "mb1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    ownerUserUid: "u1",
    primarySmtpAddress: "u1@example.com",
    aliasAddresses: [],
    displayName: "My Mail",
    timezone: "UTC",
    quotaBytes: 1_000_000_000,
    usedBytes: 0,
};

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        // The list-all-signatures call `clearPreviousDefaults` makes when saving with a default flag
        // on — defaults to "no other signatures" for tests that aren't specifically about clearing.
        if (url.startsWith("/api/mail/mail-signatures?")) return jsonResponse(200, []);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("NewSignaturePage", () => {
    it("validates the name before submitting", async () => {
        mockShell();
        const user = userEvent.setup();
        render(<NewSignaturePage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Create signature" }));
        expect(await screen.findByText("A name is required.")).toBeInTheDocument();
    });

    it("creates the signature with the entered name/content and redirects to its detail page", async () => {
        let requestBody: any;
        mockShell((url, init) => {
            if (url === "/api/mail/mail-signatures" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "sig1" });
            }
            return undefined;
        });
        const location = mockLocation();
        const user = userEvent.setup();
        render(<NewSignaturePage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Name"), "Work signature");
        await user.type(screen.getByTestId("html-editor"), "<p>Best</p>");
        await user.click(screen.getByRole("button", { name: "Create signature" }));

        await vi.waitFor(() => expect(location.href).toBe("/settings/signatures/sig1?mailboxUid=mb1"));
        expect(requestBody.mailboxUid).toBe("mb1");
        expect(requestBody.name).toBe("Work signature");
        expect(requestBody.contentHtml).toBe("<p>Best</p>");
        expect(requestBody.isDefaultForNewMessages).toBe(false);
        expect(requestBody.isDefaultForReplyForward).toBe(false);
    });

    it("clears the previous default(s) before creating one marked as a new default", async () => {
        const calls: { url: string; method: string; body?: any }[] = [];
        mockShell((url, init) => {
            calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
            if (url.startsWith("/api/mail/mail-signatures") && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, [
                    { uid: "sig-old", version: 2, mailboxUid: "mb1", name: "Old", contentHtml: "", isDefaultForNewMessages: true, isDefaultForReplyForward: false },
                ]);
            }
            if (url === "/api/mail/mail-signatures/sig-old" && init?.method === "PUT") return jsonResponse(200, {});
            if (url === "/api/mail/mail-signatures" && init?.method === "POST") return jsonResponse(200, { uid: "sig-new" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<NewSignaturePage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Name"), "New default");
        await user.click(screen.getByRole("checkbox", { name: "Use for new messages" }));
        await user.click(screen.getByRole("button", { name: "Create signature" }));

        await vi.waitFor(() => expect(calls.some((c) => c.url === "/api/mail/mail-signatures" && c.method === "POST")).toBe(true));
        const clearIndex = calls.findIndex((c) => c.url === "/api/mail/mail-signatures/sig-old");
        const createIndex = calls.findIndex((c) => c.url === "/api/mail/mail-signatures" && c.method === "POST");
        expect(clearIndex).toBeGreaterThanOrEqual(0);
        expect(clearIndex).toBeLessThan(createIndex);
        expect(calls[clearIndex].body).toEqual({ uid: "sig-old", version: 2, isDefaultForNewMessages: false });
    });

    it("does not look up existing signatures at all when neither default checkbox is checked", async () => {
        const fetchMock = mockShell((url, init) =>
            url === "/api/mail/mail-signatures" && init?.method === "POST" ? jsonResponse(200, { uid: "sig1" }) : undefined,
        );
        const user = userEvent.setup();
        render(<NewSignaturePage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Name"), "Plain");
        await user.click(screen.getByRole("button", { name: "Create signature" }));

        await vi.waitFor(() =>
            expect(fetchMock.mock.calls.some(([url, init]) => url === "/api/mail/mail-signatures" && (init as RequestInit)?.method === "POST")).toBe(
                true,
            ),
        );
        // Only the create POST — no separate list-fetch to look for signatures to clear.
        expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/mail/mail-signatures"))).toHaveLength(1);
    });

    it("shows an error message when creation fails", async () => {
        mockShell((url, init) =>
            url === "/api/mail/mail-signatures" && init?.method === "POST" ? jsonResponse(500, { message: "boom" }) : undefined,
        );
        const user = userEvent.setup();
        render(<NewSignaturePage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Name"), "Work signature");
        await user.click(screen.getByRole("button", { name: "Create signature" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
    });

    it("shows a generic error message when creation fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/mail-signatures" && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<NewSignaturePage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Name"), "Work signature");
        await user.click(screen.getByRole("button", { name: "Create signature" }));

        expect(await screen.findByText("Could not create the signature.")).toBeInTheDocument();
    });

    it("the Cancel link returns to the signatures list", async () => {
        mockShell();
        render(<NewSignaturePage userUid="u1" />);
        expect(await screen.findByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/settings/signatures?mailboxUid=mb1");
    });

    it("checks 'Use for replies and forwards' and sends it as true", async () => {
        let requestBody: any;
        mockShell((url, init) => {
            if (url === "/api/mail/mail-signatures" && init?.method === "POST") {
                requestBody = JSON.parse(init.body as string);
                return jsonResponse(200, { uid: "sig1" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<NewSignaturePage userUid="u1" />);
        await screen.findByLabelText("Name");

        await user.type(screen.getByLabelText("Name"), "Replies signature");
        await user.click(screen.getByRole("checkbox", { name: "Use for replies and forwards" }));
        await user.click(screen.getByRole("button", { name: "Create signature" }));

        await vi.waitFor(() => expect(requestBody).toBeDefined());
        expect(requestBody.isDefaultForReplyForward).toBe(true);
        expect(requestBody.isDefaultForNewMessages).toBe(false);
    });

    it("the editor's own image-upload hook is a real no-op, since signatures have no draft/attachment to upload against", async () => {
        mockShell();
        const user = userEvent.setup();
        render(<NewSignaturePage userUid="u1" />);
        await screen.findByLabelText("Name");

        await expect(user.click(screen.getByRole("button", { name: "fake-upload-image" }))).resolves.not.toThrow();
    });
});
