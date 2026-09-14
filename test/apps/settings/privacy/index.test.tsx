// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import SettingsPrivacyPage from "../../../../apps/www/settings/privacy/index.js";

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

function exportRequest(overrides: Record<string, unknown> = {}) {
    return {
        uid: "der1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        requestedByUserUid: "u1",
        format: "json" as const,
        status: "pending" as const,
        ...overrides,
    };
}

const folder = {
    uid: "f1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "mb1",
    name: "Inbox",
    type: "inbox" as const,
    unreadCount: 0,
    totalCount: 0,
};

const secondFolder = { ...folder, uid: "f2", name: "Archive", type: "user" as const };

function importRequest(overrides: Record<string, unknown> = {}) {
    return {
        uid: "mir1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        requestedByUserUid: "u1",
        targetFolderUid: "f1",
        format: "mbox" as const,
        sourceBlobKey: "mailbox-imports/abc",
        status: "pending" as const,
        ...overrides,
    };
}

function erasureRequest(overrides: Record<string, unknown> = {}) {
    return {
        uid: "der1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        requestedByUserUid: "u1",
        status: "pending" as const,
        ...overrides,
    };
}

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url.startsWith("/api/mail/mailboxes/auto-provision")) return jsonResponse(404, { message: "not enabled" });
        if (url.startsWith("/api/mail/mailboxes")) return jsonResponse(200, [mailbox]);
        if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder, secondFolder]);
        if (url.startsWith("/api/mail/mailbox-import-requests") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
        if (url.startsWith("/api/mail/erasure-requests") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("SettingsPrivacyPage", () => {
    it("shows an empty state when there are no export requests", async () => {
        mockShell((url) => (url === "/api/mail/data-export-requests" ? jsonResponse(200, []) : undefined));
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText("No export requests yet.")).toBeInTheDocument();
    });

    it("lists existing export requests, with a Download link only once ready", async () => {
        mockShell((url) =>
            url === "/api/mail/data-export-requests"
                ? jsonResponse(200, [exportRequest({ uid: "der1", status: "pending" }), exportRequest({ uid: "der2", status: "ready" })])
                : undefined,
        );
        render(<SettingsPrivacyPage userUid="u1" />);

        expect(await screen.findByText("pending")).toBeInTheDocument();
        expect(screen.getByText("ready")).toBeInTheDocument();
        const downloadLinks = screen.getAllByRole("link", { name: "Download" });
        expect(downloadLinks).toHaveLength(1);
        expect(downloadLinks[0]).toHaveAttribute("href", "/api/mail/data-export-requests/der2/download");
    });

    it("shows the failure reason for a failed request", async () => {
        mockShell((url) =>
            url === "/api/mail/data-export-requests"
                ? jsonResponse(200, [exportRequest({ status: "failed", errorMessage: "The requested mailbox no longer exists." })])
                : undefined,
        );
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText(/The requested mailbox no longer exists\./)).toBeInTheDocument();
    });

    it("shows the server's own message when loading export requests fails", async () => {
        mockShell((url) => (url === "/api/mail/data-export-requests" ? jsonResponse(500, { message: "server unavailable" }) : undefined));
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText("server unavailable")).toBeInTheDocument();
    });

    it("shows a generic message when loading export requests fails with a non-API error", async () => {
        mockShell((url) => {
            if (url === "/api/mail/data-export-requests") throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText("Could not load your export requests.")).toBeInTheDocument();
    });

    it("requests an export and reloads the list", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") return jsonResponse(200, exportRequest());
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByText("No export requests yet.");

        await user.selectOptions(screen.getByLabelText("Export format"), "mbox");
        await user.click(screen.getByRole("button", { name: "Request export" }));

        const postCall = await vi.waitFor(() => {
            const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
            expect(call).toBeDefined();
            return call!;
        });
        expect(JSON.parse(postCall[1]!.body as string)).toEqual({ format: "mbox" });
    });

    it("shows the server's own message when requesting an export fails", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") {
                return jsonResponse(403, { message: "caller is not this mailbox's owner" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByText("No export requests yet.");

        await user.click(screen.getByRole("button", { name: "Request export" }));

        expect(await screen.findByText("caller is not this mailbox's owner")).toBeInTheDocument();
    });

    it("shows a generic message when requesting an export fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByText("No export requests yet.");

        await user.click(screen.getByRole("button", { name: "Request export" }));

        expect(await screen.findByText("Could not start this export.")).toBeInTheDocument();
    });

    it("discards a stale initial-load response that resolves after a newer create-triggered reload", async () => {
        // The create form isn't gated behind this section's own `loading`, so a slow initial mount fetch
        // can still be in flight when the user requests an export and its own faster reload completes -
        // without a sequencing guard, the stale initial response landing last would silently revert the
        // list back to empty.
        let resolveInitialLoad!: (response: Response) => void;
        let getCallCount = 0;
        mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && (init?.method ?? "GET") === "GET") {
                getCallCount++;
                if (getCallCount === 1) {
                    return new Promise<Response>((resolve) => {
                        resolveInitialLoad = resolve;
                    });
                }
                return jsonResponse(200, [exportRequest()]);
            }
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") return jsonResponse(200, exportRequest());
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);

        // This section's own list fetch never resolves yet in this test, so wait on the create form
        // itself (rendered unconditionally) rather than "No export requests yet." to know the page mounted.
        await user.click(await screen.findByRole("button", { name: "Request export" }));

        // The create's own reload (the second GET call) resolves and updates `requests`, even though the
        // page still shows "Loading…" until the still-pending initial mount fetch itself settles.
        await vi.waitFor(() => expect(getCallCount).toBe(2));

        // Now let the stale initial load resolve with an empty list - it must be discarded rather than
        // overwriting the fresher data once `loading` clears and the list actually renders.
        resolveInitialLoad(jsonResponse(200, []));

        expect(await screen.findByText("pending")).toBeInTheDocument();
        expect(screen.queryByText("No export requests yet.")).not.toBeInTheDocument();
    });

    it("discards a stale initial-load error that resolves after a newer, successful create-triggered reload", async () => {
        // Same sequencing guard, exercised on the .catch() side: a slow initial load that eventually
        // fails must not surface its error once a newer reload has already succeeded.
        let resolveInitialLoad!: (response: Response) => void;
        let getCallCount = 0;
        mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && (init?.method ?? "GET") === "GET") {
                getCallCount++;
                if (getCallCount === 1) {
                    return new Promise<Response>((resolve) => {
                        resolveInitialLoad = resolve;
                    });
                }
                return jsonResponse(200, [exportRequest()]);
            }
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") return jsonResponse(200, exportRequest());
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);

        await user.click(await screen.findByRole("button", { name: "Request export" }));
        await vi.waitFor(() => expect(getCallCount).toBe(2));

        resolveInitialLoad(jsonResponse(500, { message: "server unavailable" }));

        expect(await screen.findByText("pending")).toBeInTheDocument();
        expect(screen.queryByText("server unavailable")).not.toBeInTheDocument();
    });

    it("shows an empty state when there are no import requests", async () => {
        mockShell();
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText("No import requests yet.")).toBeInTheDocument();
    });

    it("lists existing import requests, showing counts once completed", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/mailbox-import-requests") && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, [importRequest({ status: "completed", importedCount: 42, failedCount: 3 })]);
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText(/42 imported, 3 failed/)).toBeInTheDocument();
    });

    it("hides the destination-folder picker and disables uploading when the mailbox has no mail-type folders", async () => {
        mockShell((url) => (url.startsWith("/api/mail/folders") ? jsonResponse(200, [{ ...folder, type: "calendar" as const }]) : undefined));
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByText("No import requests yet.");

        expect(screen.queryByLabelText("Destination folder")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Upload Mbox or PST file" })).toBeDisabled();
    });

    it("defaults imported count to 0 and omits the failed-count clause when both are unset", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/mailbox-import-requests") && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, [importRequest({ status: "completed", importedCount: undefined, failedCount: undefined })]);
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText(/— 0 imported/)).toBeInTheDocument();
        expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
    });

    it("shows the failure reason for a failed import request", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/mailbox-import-requests") && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, [importRequest({ status: "failed", errorMessage: "The requested mailbox no longer exists." })]);
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText(/The requested mailbox no longer exists\./)).toBeInTheDocument();
    });

    it("shows the server's own message when loading import requests fails", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/mailbox-import-requests") && (init?.method ?? "GET") === "GET") {
                return jsonResponse(500, { message: "server unavailable" });
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText("server unavailable")).toBeInTheDocument();
    });

    it("shows a generic message when loading import requests fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/mailbox-import-requests") && (init?.method ?? "GET") === "GET") {
                throw new TypeError("network down");
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText("Could not load your import requests.")).toBeInTheDocument();
    });

    it("changes the destination folder, uploads a file (via the visible button), infers the mbox format, and reloads the list", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url.startsWith("/api/mail/mailbox-import-requests") && init?.method === "POST") return jsonResponse(200, importRequest());
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByLabelText("Destination folder");

        await user.selectOptions(screen.getByLabelText("Destination folder"), "f2");
        // Exercises the visible button's own onClick (delegates to the hidden file input), separately
        // from the actual file-selection simulation below - same two-step precedent
        // apps/admin/branding/index.test.tsx already established for its own hidden file inputs.
        await user.click(screen.getByRole("button", { name: "Upload Mbox or PST file" }));

        const file = new File(["From x\n"], "archive.mbox");
        await user.upload(screen.getByLabelText("Upload mail archive"), file);

        const postCall = await vi.waitFor(() => {
            const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
            expect(call).toBeDefined();
            return call!;
        });
        expect(postCall[0] as string).toContain("format=mbox");
        expect(postCall[0] as string).toContain("targetFolderUid=f2");
    });

    it("infers the pst format from a .pst filename", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url.startsWith("/api/mail/mailbox-import-requests") && init?.method === "POST") {
                return jsonResponse(200, importRequest({ format: "pst" }));
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByLabelText("Destination folder");

        const file = new File(["..."], "archive.pst");
        const user = userEvent.setup();
        await user.upload(screen.getByLabelText("Upload mail archive"), file);

        const postCall = await vi.waitFor(() => {
            const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
            expect(call).toBeDefined();
            return call!;
        });
        expect(postCall[0] as string).toContain("format=pst");
    });

    it("does nothing when the file input change fires with no file selected", async () => {
        const fetchMock = mockShell();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByLabelText("Destination folder");

        fireEvent.change(screen.getByLabelText("Upload mail archive"), { target: { files: [] } });

        expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    });

    it("shows the server's own message when uploading fails", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/mailbox-import-requests") && init?.method === "POST") {
                return jsonResponse(400, { message: "targetFolderUid is required." });
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByLabelText("Destination folder");

        const file = new File(["..."], "archive.mbox");
        const user = userEvent.setup();
        await user.upload(screen.getByLabelText("Upload mail archive"), file);

        expect(await screen.findByText("targetFolderUid is required.")).toBeInTheDocument();
    });

    it("shows a generic message when uploading fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/mailbox-import-requests") && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByLabelText("Destination folder");

        const file = new File(["..."], "archive.mbox");
        const user = userEvent.setup();
        await user.upload(screen.getByLabelText("Upload mail archive"), file);

        expect(await screen.findByText("Could not upload this file.")).toBeInTheDocument();
    });

    it("discards a stale initial-load response that resolves after a newer upload-triggered reload", async () => {
        // Same "the Upload button isn't gated behind this section's own `loading`" race as the export
        // section's own equivalent test above - a slow initial mount fetch resolving after a faster
        // upload-triggered reload must not revert the list.
        let resolveInitialLoad!: (response: Response) => void;
        let getCallCount = 0;
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/mailbox-import-requests") && init?.method === "POST") return jsonResponse(200, importRequest());
            if (url.startsWith("/api/mail/mailbox-import-requests") && (init?.method ?? "GET") === "GET") {
                getCallCount++;
                if (getCallCount === 1) {
                    return new Promise<Response>((resolve) => {
                        resolveInitialLoad = resolve;
                    });
                }
                return jsonResponse(200, [importRequest()]);
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);

        // This section's own list fetch never resolves yet in this test, so wait on the destination
        // folder picker (populated from the separate, unblocked folders fetch) to know the page mounted.
        await screen.findByLabelText("Destination folder");

        const user = userEvent.setup();
        await user.upload(screen.getByLabelText("Upload mail archive"), new File(["..."], "archive.mbox"));

        // The upload's own reload (the second GET call) resolves and updates `requests`, even though the
        // page still shows "Loading…" until the still-pending initial mount fetch itself settles.
        await vi.waitFor(() => expect(getCallCount).toBe(2));

        // Now let the stale initial load resolve with an empty list - it must be discarded rather than
        // overwriting the fresher data once `loading` clears and the list actually renders.
        resolveInitialLoad(jsonResponse(200, []));

        expect(await screen.findByText("pending")).toBeInTheDocument();
        expect(screen.queryByText("No import requests yet.")).not.toBeInTheDocument();
    });

    it("discards a stale initial-load error that resolves after a newer, successful upload-triggered reload", async () => {
        // Same sequencing guard, exercised on the .catch() side: a slow initial load that eventually
        // fails must not surface its error once a newer reload has already succeeded.
        let resolveInitialLoad!: (response: Response) => void;
        let getCallCount = 0;
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/mailbox-import-requests") && init?.method === "POST") return jsonResponse(200, importRequest());
            if (url.startsWith("/api/mail/mailbox-import-requests") && (init?.method ?? "GET") === "GET") {
                getCallCount++;
                if (getCallCount === 1) {
                    return new Promise<Response>((resolve) => {
                        resolveInitialLoad = resolve;
                    });
                }
                return jsonResponse(200, [importRequest()]);
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);

        await screen.findByLabelText("Destination folder");
        const user = userEvent.setup();
        await user.upload(screen.getByLabelText("Upload mail archive"), new File(["..."], "archive.mbox"));
        await vi.waitFor(() => expect(getCallCount).toBe(2));

        resolveInitialLoad(jsonResponse(500, { message: "server unavailable" }));

        expect(await screen.findByText("pending")).toBeInTheDocument();
        expect(screen.queryByText("server unavailable")).not.toBeInTheDocument();
    });

    it("shows no request list when there are no erasure requests, with the button enabled", async () => {
        mockShell();
        render(<SettingsPrivacyPage userUid="u1" />);
        const button = await screen.findByRole("button", { name: "Request account erasure" });
        expect(button).toBeEnabled();
    });

    it("lists existing erasure requests and shows a denial reason", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/erasure-requests") && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, [erasureRequest({ status: "denied", reason: "identity not verified" })]);
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText(/identity not verified/)).toBeInTheDocument();
        expect(screen.getByText("denied")).toBeInTheDocument();
    });

    it("disables the button while a request is already pending", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/erasure-requests") && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, [erasureRequest({ status: "pending" })]);
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByRole("button", { name: "Request account erasure" })).toBeDisabled();
    });

    it("shows the server's own message when loading erasure requests fails", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/erasure-requests") && (init?.method ?? "GET") === "GET") {
                return jsonResponse(500, { message: "server unavailable" });
            }
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText("server unavailable")).toBeInTheDocument();
    });

    it("shows a generic message when loading erasure requests fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/erasure-requests") && (init?.method ?? "GET") === "GET") throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);
        expect(await screen.findByText("Could not load your erasure requests.")).toBeInTheDocument();
    });

    it("opens the confirmation modal, submits an erasure request, and reloads the list", async () => {
        let created = false;
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/erasure-requests" && init?.method === "POST") {
                created = true;
                return jsonResponse(200, erasureRequest());
            }
            if (url === "/api/mail/erasure-requests" && (init?.method ?? "GET") === "GET" && created) {
                return jsonResponse(200, [erasureRequest()]);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByRole("button", { name: "Request account erasure" });

        await user.click(screen.getByRole("button", { name: "Request account erasure" }));
        expect(await screen.findByText(/cannot be cancelled once submitted/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Request erasure" }));

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/mail/erasure-requests", expect.objectContaining({ method: "POST" })));
        expect(await screen.findByText("pending")).toBeInTheDocument();
    });

    it("closes the confirmation modal via Cancel without submitting", async () => {
        const fetchMock = mockShell();
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByRole("button", { name: "Request account erasure" });

        await user.click(screen.getByRole("button", { name: "Request account erasure" }));
        await user.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.queryByText(/cannot be cancelled once submitted/)).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    });

    it("closes the confirmation modal via its own close button", async () => {
        mockShell();
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByRole("button", { name: "Request account erasure" });

        await user.click(screen.getByRole("button", { name: "Request account erasure" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: /close/i }));

        expect(screen.queryByText(/cannot be cancelled once submitted/)).not.toBeInTheDocument();
    });

    it("shows the server's own message when submitting an erasure request fails", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/erasure-requests" && init?.method === "POST") {
                return jsonResponse(409, { message: "An erasure request for this mailbox is already pending review." });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByRole("button", { name: "Request account erasure" });

        await user.click(screen.getByRole("button", { name: "Request account erasure" }));
        await user.click(screen.getByRole("button", { name: "Request erasure" }));

        expect(await screen.findByText("An erasure request for this mailbox is already pending review.")).toBeInTheDocument();
    });

    it("shows a generic message when submitting an erasure request fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/erasure-requests" && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<SettingsPrivacyPage userUid="u1" />);
        await screen.findByRole("button", { name: "Request account erasure" });

        await user.click(screen.getByRole("button", { name: "Request account erasure" }));
        await user.click(screen.getByRole("button", { name: "Request erasure" }));

        expect(await screen.findByText("Could not submit this request.")).toBeInTheDocument();
    });
    describe("mailbox scoping", () => {
        const sharedMailbox = { ...mailbox, uid: "mb2", ownerUserUid: undefined, displayName: "Team Mail", primarySmtpAddress: "team@example.com" };

        afterEach(() => {
            window.history.pushState(null, "", "/");
        });

        it("names the caller's own mailbox as the export/erasure target", async () => {
            mockShell((url) => (url === "/api/mail/data-export-requests" ? jsonResponse(200, []) : undefined));
            render(<SettingsPrivacyPage userUid="u1" />);

            expect(await screen.findByText("No export requests yet.")).toBeInTheDocument();
            expect(screen.getAllByText("My Mail (u1@example.com)").length).toBeGreaterThanOrEqual(2);
        });

        it("hides export and erasure while a shared mailbox is selected, pointing at the caller's own mailbox", async () => {
            window.history.pushState(null, "", "/settings/privacy?mailboxUid=mb2");
            const fetchMock = mockShell((url) => (url.startsWith("/api/mail/mailboxes?") || url === "/api/mail/mailboxes" ? jsonResponse(200, [mailbox, sharedMailbox]) : undefined));
            render(<SettingsPrivacyPage userUid="u1" />);

            expect(await screen.findByText(/Switch to My Mail \(u1@example.com\) to manage them\./)).toBeInTheDocument();
            expect(await screen.findByText("No import requests yet.")).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Request export" })).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Request account erasure" })).not.toBeInTheDocument();
            expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/mail/data-export-requests"))).toBe(false);
        });

        it("explains there's nothing to manage when the caller has no mailbox of their own", async () => {
            mockShell((url) => (url.startsWith("/api/mail/mailboxes?") || url === "/api/mail/mailboxes" ? jsonResponse(200, [sharedMailbox]) : undefined));
            render(<SettingsPrivacyPage userUid="u1" />);

            expect(await screen.findByText(/You don't have a mailbox of your own to manage here\./)).toBeInTheDocument();
        });
    });

    it("shows the server's own message when loading the import destination folders fails", async () => {
        mockShell((url) => (url.startsWith("/api/mail/folders") ? jsonResponse(503, { message: "folders unavailable" }) : undefined));
        render(<SettingsPrivacyPage userUid="u1" />);

        expect(await screen.findByText("folders unavailable")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Upload Mbox or PST file" })).toBeDisabled();
    });

    it("shows a generic message when loading the import destination folders fails with a non-API error", async () => {
        mockShell((url) => {
            if (url.startsWith("/api/mail/folders")) throw new TypeError("network down");
            return undefined;
        });
        render(<SettingsPrivacyPage userUid="u1" />);

        expect(await screen.findByText("Could not load this mailbox's folders.")).toBeInTheDocument();
    });
});
