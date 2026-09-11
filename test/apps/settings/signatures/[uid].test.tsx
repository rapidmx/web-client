// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SignatureDetailPage from "../../../../apps/www/settings/signatures/[uid].js";

vi.mock("../../../../apps/shared/components/mail/compose/RichTextEditor.js", () => ({
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
const signature = {
    uid: "sig1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Work signature",
    contentHtml: "<p>Best,<br>Jane</p>",
    isDefaultForNewMessages: true,
    isDefaultForReplyForward: false,
};

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        // The list-all-signatures call `clearPreviousDefaults` makes when saving with a default flag
        // on — distinguished from the single-signature GET/PUT below by the query string. Defaults to
        // "no other signatures", the common case for tests that aren't specifically about clearing.
        if (url.startsWith("/api/mail/mail-signatures?")) return jsonResponse(200, []);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

beforeEach(() => {
    window.history.pushState(null, "", "/settings/signatures/sig1?mailboxUid=mb1");
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState(null, "", "/");
});

describe("SignatureDetailPage", () => {
    it("renders the loaded signature's name, content, and default flags", async () => {
        mockShell((url) => (url === "/api/mail/mail-signatures/sig1" ? jsonResponse(200, signature) : undefined));
        render(<SignatureDetailPage userUid="u1" params={{ uid: "sig1" }} />);

        expect(await screen.findByRole("heading", { name: "Work signature" })).toBeInTheDocument();
        expect(screen.getByLabelText("Name")).toHaveValue("Work signature");
        expect(screen.getByTestId("html-editor")).toHaveValue("<p>Best,<br>Jane</p>");
        expect(screen.getByRole("checkbox", { name: "Use for new messages" })).toBeChecked();
        expect(screen.getByRole("checkbox", { name: "Use for replies and forwards" })).not.toBeChecked();
    });

    it("validates the name before saving", async () => {
        mockShell((url) => (url === "/api/mail/mail-signatures/sig1" ? jsonResponse(200, signature) : undefined));
        const user = userEvent.setup();
        render(<SignatureDetailPage userUid="u1" params={{ uid: "sig1" }} />);
        await screen.findByLabelText("Name");

        await user.clear(screen.getByLabelText("Name"));
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("A name is required.")).toBeInTheDocument();
    });

    it("saves changes and shows a confirmation", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/mail-signatures/sig1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, signature);
            if (url === "/api/mail/mail-signatures/sig1" && init?.method === "PUT") {
                return jsonResponse(200, { ...signature, version: 1, name: "Renamed" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SignatureDetailPage userUid="u1" params={{ uid: "sig1" }} />);
        await screen.findByLabelText("Name");

        await user.clear(screen.getByLabelText("Name"));
        await user.type(screen.getByLabelText("Name"), "Renamed");
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("Saved.")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Renamed" })).toBeInTheDocument();
    });

    it("clears the previous default on another signature, but not on itself, when saving with a default checked", async () => {
        const calls: { url: string; method: string; body?: any }[] = [];
        mockShell((url, init) => {
            calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined });
            if (url === "/api/mail/mail-signatures/sig1" && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, { ...signature, isDefaultForReplyForward: false });
            }
            if (url.startsWith("/api/mail/mail-signatures") && (init?.method ?? "GET") === "GET" && url.includes("mailboxUid=mb1")) {
                return jsonResponse(200, [
                    signature,
                    { uid: "sig2", version: 5, mailboxUid: "mb1", name: "Other", contentHtml: "", isDefaultForNewMessages: false, isDefaultForReplyForward: true },
                ]);
            }
            if (url === "/api/mail/mail-signatures/sig2" && init?.method === "PUT") return jsonResponse(200, {});
            if (url === "/api/mail/mail-signatures/sig1" && init?.method === "PUT") return jsonResponse(200, signature);
            return undefined;
        });
        const user = userEvent.setup();
        render(<SignatureDetailPage userUid="u1" params={{ uid: "sig1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("checkbox", { name: "Use for replies and forwards" }));
        await user.click(screen.getByRole("button", { name: "Save changes" }));

        await vi.waitFor(() => expect(calls.some((c) => c.url === "/api/mail/mail-signatures/sig1" && c.method === "PUT")).toBe(true));
        // sig2 (a different signature) had its default cleared; sig1 (the one being saved) was never
        // itself targeted by clearPreviousDefaults, only by its own final save PUT.
        const sig2Clear = calls.find((c) => c.url === "/api/mail/mail-signatures/sig2");
        expect(sig2Clear?.body).toEqual({ uid: "sig2", version: 5, isDefaultForReplyForward: false });
    });

    it("shows an error message when saving fails, without discarding the loaded signature", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/mail-signatures/sig1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, signature);
            if (url === "/api/mail/mail-signatures/sig1" && init?.method === "PUT") return jsonResponse(409, { message: "version conflict" });
            return undefined;
        });
        const user = userEvent.setup();
        render(<SignatureDetailPage userUid="u1" params={{ uid: "sig1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("version conflict")).toBeInTheDocument();
        expect(screen.getByLabelText("Name")).toHaveValue("Work signature");
    });

    it("shows a generic error message when saving fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/mail-signatures/sig1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, signature);
            if (url === "/api/mail/mail-signatures/sig1" && init?.method === "PUT") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<SignatureDetailPage userUid="u1" params={{ uid: "sig1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("button", { name: "Save changes" }));

        expect(await screen.findByText("Could not save this signature.")).toBeInTheDocument();
    });

    it("shows an error message when the signature fails to load", async () => {
        mockShell((url) => (url === "/api/mail/mail-signatures/sig1" ? jsonResponse(404, { message: "not found" }) : undefined));
        render(<SignatureDetailPage userUid="u1" params={{ uid: "sig1" }} />);
        expect(await screen.findByText("not found")).toBeInTheDocument();
    });

    it("shows a generic error message when loading the signature fails with a non-API error", async () => {
        mockShell((url) => {
            if (url === "/api/mail/mail-signatures/sig1") throw new TypeError("network down");
            return undefined;
        });
        render(<SignatureDetailPage userUid="u1" params={{ uid: "sig1" }} />);
        expect(await screen.findByText("Could not load this signature.")).toBeInTheDocument();
    });

    it("falls back to 'Signature not found.' when the load succeeds with no signature and no error", async () => {
        mockShell((url) => (url === "/api/mail/mail-signatures/sig1" ? jsonResponse(200, null) : undefined));
        render(<SignatureDetailPage userUid="u1" params={{ uid: "sig1" }} />);
        expect(await screen.findByText("Signature not found.")).toBeInTheDocument();
    });

    it("unchecking 'Use for new messages' saves without any clearPreviousDefaults lookup", async () => {
        const calls: string[] = [];
        mockShell((url, init) => {
            calls.push(url);
            if (url === "/api/mail/mail-signatures/sig1" && (init?.method ?? "GET") === "GET") return jsonResponse(200, signature);
            if (url === "/api/mail/mail-signatures/sig1" && init?.method === "PUT") return jsonResponse(200, { ...signature, isDefaultForNewMessages: false });
            return undefined;
        });
        const user = userEvent.setup();
        render(<SignatureDetailPage userUid="u1" params={{ uid: "sig1" }} />);
        await screen.findByLabelText("Name");

        await user.click(screen.getByRole("checkbox", { name: "Use for new messages" }));
        expect(screen.getByRole("checkbox", { name: "Use for new messages" })).not.toBeChecked();

        await user.click(screen.getByRole("button", { name: "Save changes" }));
        await screen.findByText("Saved.");

        expect(calls.some((u) => u.startsWith("/api/mail/mail-signatures?"))).toBe(false);
    });

    it("the editor's own image-upload hook is a real no-op, since signatures have no draft/attachment to upload against", async () => {
        mockShell((url) => (url === "/api/mail/mail-signatures/sig1" ? jsonResponse(200, signature) : undefined));
        const user = userEvent.setup();
        render(<SignatureDetailPage userUid="u1" params={{ uid: "sig1" }} />);
        await screen.findByLabelText("Name");

        await expect(user.click(screen.getByRole("button", { name: "fake-upload-image" }))).resolves.not.toThrow();
    });
});
