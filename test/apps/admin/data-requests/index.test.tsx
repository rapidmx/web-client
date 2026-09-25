// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import DataRequestsPage from "../../../../apps/admin/data-requests/index.js";

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
        uid: "eer1",
        version: 0,
        dateCreated: "2026-01-01T00:00:00.000Z",
        dateModified: "2026-01-01T00:00:00.000Z",
        mailboxUid: "mb1",
        requestedByUserUid: "u1",
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

function mockShell(extra?: (url: string, init?: RequestInit) => Response | undefined) {
    return mockFetch((url, init) => {
        const custom = extra?.(url, init);
        if (custom) return custom;
        if (url === "/api/admin/release-notes") return jsonResponse(200, {});
        if (url.startsWith("/api/mail/data-export-requests") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
        if (url.startsWith("/api/mail/mailbox-import-requests") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
        if (url.startsWith("/api/mail/erasure-requests") && (init?.method ?? "GET") === "GET") return jsonResponse(200, []);
        throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("DataRequestsPage — paging", () => {
    it("requests newest-first pages of 50 and appends the next page with Load more, skipping repeats", async () => {
        const firstPage = Array.from({ length: 50 }, (_, i) => exportRequest({ uid: `der${i}`, mailboxUid: `mb-${i}` }));
        const fetchMock = mockShell((url) => {
            if (url === "/api/mail/data-export-requests?limit=50&page=0") return jsonResponse(200, firstPage);
            if (url === "/api/mail/data-export-requests?limit=50&page=1") {
                return jsonResponse(200, [exportRequest({ uid: "der49", mailboxUid: "mb-49" }), exportRequest({ uid: "der50", mailboxUid: "mb-50" })]);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        expect(await screen.findByText(/^mb-49/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Load more export requests" }));

        expect(await screen.findByText(/^mb-50/)).toBeInTheDocument();
        expect(screen.getAllByText(/^mb-49/)).toHaveLength(1);
        expect(screen.queryByRole("button", { name: "Load more export requests" })).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/mail/erasure-requests?limit=50&page=0");
        expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/mail/mailbox-import-requests?limit=50&page=0");
    });

    it("shows a Load more failure and drops a Load more response that lands after a newer reload", async () => {
        const firstPage = Array.from({ length: 50 }, (_, i) => erasureRequest({ uid: `eer${i}`, mailboxUid: `mb-${i}`, status: "completed" }));
        let moreCalls = 0;
        mockShell((url) => {
            if (url === "/api/mail/erasure-requests?limit=50&page=0") return jsonResponse(200, firstPage);
            if (url === "/api/mail/erasure-requests?limit=50&page=1") {
                moreCalls++;
                if (moreCalls === 1) return jsonResponse(500, { message: "page failed" });
                if (moreCalls === 2) throw new TypeError("network down");
                return new Promise<Response>(() => undefined) as unknown as Response;
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Load more erasure requests" }));
        expect(await screen.findByText("page failed")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Load more erasure requests" }));
        expect(await screen.findByText("Could not load erasure requests.")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Load more erasure requests" }));
        expect(screen.getByRole("button", { name: "Load more erasure requests" })).toBeDisabled();
    });

    it("drops a Load more response (or failure) that lands after a newer reload", async () => {
        const firstPage = Array.from({ length: 50 }, (_, i) => exportRequest({ uid: `der${i}`, mailboxUid: `mb-${i}` }));
        const pendingMore: ((response: Response) => void)[] = [];
        mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") return jsonResponse(200, exportRequest());
            if (url === "/api/mail/data-export-requests?limit=50&page=0") return jsonResponse(200, firstPage);
            if (url === "/api/mail/data-export-requests?limit=50&page=1") {
                return new Promise<Response>((resolve) => pendingMore.push(resolve)) as unknown as Response;
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Load more export requests" }));
        await user.type(screen.getByLabelText("Export mailbox UID"), "mb-new");
        await user.click(screen.getByRole("button", { name: "Create export" }));
        await vi.waitFor(() => expect(screen.getByLabelText("Export mailbox UID")).toHaveValue(""));

        pendingMore[0](jsonResponse(200, [exportRequest({ uid: "der-stale", mailboxUid: "mb-stale" })]));
        await vi.waitFor(() => expect(screen.getByRole("button", { name: "Load more export requests" })).not.toBeDisabled());
        expect(screen.queryByText(/^mb-stale/)).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Load more export requests" }));
        await user.type(screen.getByLabelText("Export mailbox UID"), "mb-new");
        await user.click(screen.getByRole("button", { name: "Create export" }));
        await vi.waitFor(() => expect(screen.getByLabelText("Export mailbox UID")).toHaveValue(""));
        pendingMore[1](jsonResponse(500, { message: "stale failure" }));
        await vi.waitFor(() => expect(screen.getByRole("button", { name: "Load more export requests" })).not.toBeDisabled());
        expect(screen.queryByText("stale failure")).not.toBeInTheDocument();
    });
});

describe("DataRequestsPage — paging after deletions", () => {
    it("doesn't skip rows that moved onto the previous page because rows were deleted since", async () => {
        const all = Array.from({ length: 60 }, (_, i) => exportRequest({ uid: `der${i}`, mailboxUid: `mb-${i}` }));
        let rows = all;
        const pageOf = (page: number) => rows.slice(page * 50, page * 50 + 50);
        const fetchMock = mockShell((url) => {
            const match = /^\/api\/mail\/data-export-requests\?limit=50&page=(\d+)$/.exec(url);
            return match ? jsonResponse(200, pageOf(Number(match[1]))) : undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText(/^mb-49 /)).toBeInTheDocument();

        // Three rows already shown are deleted: der50-der52 now sit on page 0, and page 1 starts at der53.
        rows = all.filter((row) => !["der1", "der2", "der3"].includes(row.uid));
        await user.click(screen.getByRole("button", { name: "Load more export requests" }));

        expect(await screen.findByText(/^mb-50 /)).toBeInTheDocument();
        for (const i of [51, 52, 53, 59]) {
            expect(screen.getByText(new RegExp(`^mb-${i} `))).toBeInTheDocument();
        }
        expect(screen.getAllByText(/^mb-49 /)).toHaveLength(1);
        expect(fetchMock.mock.calls.map(([url]) => url)).toContain("/api/mail/data-export-requests?limit=50&page=1");
        expect(screen.queryByRole("button", { name: "Load more export requests" })).not.toBeInTheDocument();
    });

    it("reloads from the start when the last row shown can't be found again", async () => {
        const all = Array.from({ length: 60 }, (_, i) => exportRequest({ uid: `der${i}`, mailboxUid: `mb-${i}` }));
        let rows = all;
        const pageOf = (page: number) => rows.slice(page * 50, page * 50 + 50);
        mockShell((url) => {
            const match = /^\/api\/mail\/data-export-requests\?limit=50&page=(\d+)$/.exec(url);
            return match ? jsonResponse(200, pageOf(Number(match[1]))) : undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText(/^mb-49 /)).toBeInTheDocument();

        // The last row shown was itself deleted.
        rows = all.filter((row) => row.uid !== "der49");
        await user.click(screen.getByRole("button", { name: "Load more export requests" }));

        await vi.waitFor(() => expect(screen.queryByText(/^mb-49 /)).not.toBeInTheDocument());
        expect(screen.getByText(/^mb-50 /)).toBeInTheDocument();
        expect(screen.queryByText(/^mb-51 /)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Load more export requests" })).toBeEnabled();
    });
});

describe("DataRequestsPage — export requests", () => {
    it("shows an empty state and disables Create export until a mailbox UID is entered", async () => {
        mockShell();
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText("No export requests.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Create export" })).toBeDisabled();
    });

    it("lists existing export requests, with a Download link only once ready", async () => {
        mockShell((url) =>
            url === "/api/mail/data-export-requests?limit=50&page=0" ? jsonResponse(200, [exportRequest({ status: "ready" })]) : undefined,
        );
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByRole("link", { name: "Download" })).toHaveAttribute(
            "href",
            "/api/mail/data-export-requests/der1/download",
        );
    });

    it("shows the failure reason for a failed export request", async () => {
        mockShell((url) =>
            url === "/api/mail/data-export-requests?limit=50&page=0"
                ? jsonResponse(200, [exportRequest({ status: "failed", errorMessage: "The requested mailbox no longer exists." })])
                : undefined,
        );
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText(/The requested mailbox no longer exists\./)).toBeInTheDocument();
    });

    it("shows the server's own message when loading export requests fails", async () => {
        mockShell((url) => (url === "/api/mail/data-export-requests?limit=50&page=0" ? jsonResponse(500, { message: "server unavailable" }) : undefined));
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText("server unavailable")).toBeInTheDocument();
    });

    it("shows a generic message when loading export requests fails with a non-API error", async () => {
        mockShell((url) => {
            if (url === "/api/mail/data-export-requests?limit=50&page=0") throw new TypeError("network down");
            return undefined;
        });
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText("Could not load export requests.")).toBeInTheDocument();
    });

    it("creates an export for the entered mailbox UID and reloads the list", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") return jsonResponse(200, exportRequest());
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No export requests.");

        await user.type(screen.getByLabelText("Export mailbox UID"), "mb1");
        await user.selectOptions(screen.getByLabelText("Export format"), "mbox");
        await user.click(screen.getByRole("button", { name: "Create export" }));

        const postCall = await vi.waitFor(() => {
            const call = fetchMock.mock.calls.find(([u, i]) => u === "/api/mail/data-export-requests" && i?.method === "POST");
            expect(call).toBeDefined();
            return call!;
        });
        expect(JSON.parse(postCall[1]!.body as string)).toEqual({ format: "mbox", mailboxUid: "mb1" });
        expect(screen.getByLabelText("Export mailbox UID")).toHaveValue("");
    });

    it("shows the server's own message when creating an export fails", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") {
                return jsonResponse(404, { message: "no resource could be found" });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No export requests.");

        await user.type(screen.getByLabelText("Export mailbox UID"), "mb-missing");
        await user.click(screen.getByRole("button", { name: "Create export" }));

        expect(await screen.findByText("no resource could be found")).toBeInTheDocument();
    });

    it("shows a generic message when creating an export fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests" && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No export requests.");

        await user.type(screen.getByLabelText("Export mailbox UID"), "mb1");
        await user.click(screen.getByRole("button", { name: "Create export" }));

        expect(await screen.findByText("Could not start this export.")).toBeInTheDocument();
    });

    it("discards a stale initial-load response that resolves after a newer create-triggered reload", async () => {
        // The create form isn't gated behind this section's own `loading`, so a slow initial mount fetch
        // can still be in flight when the user creates a request and its own faster reload completes -
        // without a sequencing guard, the stale initial response landing last would silently revert the
        // list back to empty.
        let resolveInitialLoad!: (response: Response) => void;
        let getCallCount = 0;
        mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests?limit=50&page=0" && (init?.method ?? "GET") === "GET") {
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
        render(<DataRequestsPage userUid="admin-1" />);

        // This section's own list fetch never resolves yet in this test, so wait on the create form
        // itself (rendered unconditionally, not gated behind this section's `loading`) rather than
        // "No export requests." to know the shell has finished its own admin-access check and mounted.
        await user.type(await screen.findByLabelText("Export mailbox UID"), "mb1");
        await user.click(screen.getByRole("button", { name: "Create export" }));

        // The create's own reload (the second GET call) resolves and updates `requests`, even though the
        // page still shows "Loading…" until the still-pending initial mount fetch itself settles (only
        // its own .finally() clears `loading`) - confirm the reload actually completed via the mock
        // rather than the DOM, which won't reflect it until loading clears below.
        await vi.waitFor(() => expect(getCallCount).toBe(2));

        // Now let the stale initial load resolve with an empty list - since it's a strictly older call
        // than the reload above, its response must be discarded rather than overwriting the fresher data
        // once `loading` clears and the list actually renders.
        resolveInitialLoad(jsonResponse(200, []));

        expect(await screen.findByText(/mb1/)).toBeInTheDocument();
        expect(screen.queryByText("No export requests.")).not.toBeInTheDocument();
    });

    it("discards a stale initial-load error that resolves after a newer, successful create-triggered reload", async () => {
        // Same sequencing guard, exercised on the .catch() side: a slow initial load that eventually
        // fails must not surface its error once a newer reload has already succeeded.
        let resolveInitialLoad!: (response: Response) => void;
        let getCallCount = 0;
        mockShell((url, init) => {
            if (url === "/api/mail/data-export-requests?limit=50&page=0" && (init?.method ?? "GET") === "GET") {
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
        render(<DataRequestsPage userUid="admin-1" />);

        await user.type(await screen.findByLabelText("Export mailbox UID"), "mb1");
        await user.click(screen.getByRole("button", { name: "Create export" }));
        await vi.waitFor(() => expect(getCallCount).toBe(2));

        resolveInitialLoad(jsonResponse(500, { message: "server unavailable" }));

        expect(await screen.findByText("pending")).toBeInTheDocument();
        expect(screen.queryByText("server unavailable")).not.toBeInTheDocument();
    });
});

describe("DataRequestsPage — import requests", () => {
    it("shows an empty state", async () => {
        mockShell();
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText("No import requests.")).toBeInTheDocument();
    });

    it("lists existing import requests, showing counts once completed", async () => {
        mockShell((url) =>
            url === "/api/mail/mailbox-import-requests?limit=50&page=0"
                ? jsonResponse(200, [importRequest({ status: "completed", importedCount: 10, failedCount: 1 })])
                : undefined,
        );
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText(/10 imported, 1 failed/)).toBeInTheDocument();
    });

    it("defaults imported count to 0 and omits the failed-count clause when both are unset", async () => {
        mockShell((url) =>
            url === "/api/mail/mailbox-import-requests?limit=50&page=0"
                ? jsonResponse(200, [importRequest({ status: "completed", importedCount: undefined, failedCount: undefined })])
                : undefined,
        );
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText(/— 0 imported/)).toBeInTheDocument();
    });

    it("hides the destination-folder picker when a mailbox has no mail-type folders", async () => {
        mockShell((url) => (url.startsWith("/api/mail/folders") ? jsonResponse(200, [{ ...folder, type: "calendar" as const }]) : undefined));
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No import requests.");

        await user.type(screen.getByLabelText("Import mailbox UID"), "mb1");
        await user.tab();

        expect(screen.queryByLabelText("Import destination folder")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Upload Mbox or PST file" })).toBeDisabled();
    });

    it("shows the failure reason for a failed import request", async () => {
        mockShell((url) =>
            url === "/api/mail/mailbox-import-requests?limit=50&page=0"
                ? jsonResponse(200, [importRequest({ status: "failed", errorMessage: "boom" })])
                : undefined,
        );
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText(/boom/)).toBeInTheDocument();
    });

    it("shows the server's own message when loading import requests fails", async () => {
        mockShell((url) => (url === "/api/mail/mailbox-import-requests?limit=50&page=0" ? jsonResponse(500, { message: "server unavailable" }) : undefined));
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText("server unavailable")).toBeInTheDocument();
    });

    it("shows a generic message when loading import requests fails with a non-API error", async () => {
        mockShell((url) => {
            if (url === "/api/mail/mailbox-import-requests?limit=50&page=0") throw new TypeError("network down");
            return undefined;
        });
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText("Could not load import requests.")).toBeInTheDocument();
    });

    it("loads a mailbox's folders on blur and enables uploading once one is selected", async () => {
        mockShell((url) => (url.startsWith("/api/mail/folders") ? jsonResponse(200, [folder]) : undefined));
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No import requests.");

        await user.type(screen.getByLabelText("Import mailbox UID"), "mb1");
        await user.tab();

        expect(await screen.findByLabelText("Import destination folder")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Upload Mbox or PST file" })).toBeEnabled();
    });

    it("clears the folder picker when the mailbox UID is blurred while empty", async () => {
        mockShell();
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No import requests.");

        await user.click(screen.getByLabelText("Import mailbox UID"));
        await user.tab();

        expect(screen.queryByLabelText("Import destination folder")).not.toBeInTheDocument();
    });

    it("shows the server's own message when loading a mailbox's folders fails", async () => {
        mockShell((url) => (url.startsWith("/api/mail/folders") ? jsonResponse(404, { message: "no resource could be found" }) : undefined));
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No import requests.");

        await user.type(screen.getByLabelText("Import mailbox UID"), "mb-missing");
        await user.tab();

        expect(await screen.findByText("no resource could be found")).toBeInTheDocument();
    });

    it("shows a generic message when loading a mailbox's folders fails with a non-API error", async () => {
        mockShell((url) => {
            if (url.startsWith("/api/mail/folders")) throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No import requests.");

        await user.type(screen.getByLabelText("Import mailbox UID"), "mb1");
        await user.tab();

        expect(await screen.findByText("Could not load this mailbox's folders.")).toBeInTheDocument();
    });

    it("changes the destination folder, uploads a file (via the visible button) for the entered mailbox/folder, and reloads the list", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder, secondFolder]);
            if (url.startsWith("/api/mail/mailbox-import-requests") && init?.method === "POST") return jsonResponse(200, importRequest());
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No import requests.");

        await user.type(screen.getByLabelText("Import mailbox UID"), "mb1");
        await user.tab();
        await screen.findByLabelText("Import destination folder");

        await user.selectOptions(screen.getByLabelText("Import destination folder"), "f2");
        // Exercises the visible button's own onClick (delegates to the hidden file input), separately
        // from the actual file-selection simulation below.
        await user.click(screen.getByRole("button", { name: "Upload Mbox or PST file" }));

        const file = new File(["From x\n"], "archive.mbox");
        await user.upload(screen.getByLabelText("Upload mail archive"), file);

        const postCall = await vi.waitFor(() => {
            const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
            expect(call).toBeDefined();
            return call!;
        });
        expect(postCall[0] as string).toContain("mailboxUid=mb1");
        expect(postCall[0] as string).toContain("targetFolderUid=f2");
    });

    it("infers the pst format from a .pst filename", async () => {
        const fetchMock = mockShell((url, init) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder]);
            if (url.startsWith("/api/mail/mailbox-import-requests") && init?.method === "POST") {
                return jsonResponse(200, importRequest({ format: "pst" }));
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No import requests.");

        await user.type(screen.getByLabelText("Import mailbox UID"), "mb1");
        await user.tab();
        await screen.findByLabelText("Import destination folder");
        await user.upload(screen.getByLabelText("Upload mail archive"), new File(["..."], "archive.pst"));

        const postCall = await vi.waitFor(() => {
            const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
            expect(call).toBeDefined();
            return call!;
        });
        expect(postCall[0] as string).toContain("format=pst");
    });

    it("does nothing when the file input change fires with no file selected", async () => {
        const fetchMock = mockShell((url) => (url.startsWith("/api/mail/folders") ? jsonResponse(200, [folder]) : undefined));
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No import requests.");

        await user.type(screen.getByLabelText("Import mailbox UID"), "mb1");
        await user.tab();
        await screen.findByLabelText("Import destination folder");

        fireEvent.change(screen.getByLabelText("Upload mail archive"), { target: { files: [] } });

        expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    });

    it("shows the server's own message when uploading fails", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder]);
            if (url.startsWith("/api/mail/mailbox-import-requests") && init?.method === "POST") {
                return jsonResponse(400, { message: "targetFolderUid is required." });
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No import requests.");

        await user.type(screen.getByLabelText("Import mailbox UID"), "mb1");
        await user.tab();
        await screen.findByLabelText("Import destination folder");
        await user.upload(screen.getByLabelText("Upload mail archive"), new File(["..."], "archive.mbox"));

        expect(await screen.findByText("targetFolderUid is required.")).toBeInTheDocument();
    });

    it("shows a generic message when uploading fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder]);
            if (url.startsWith("/api/mail/mailbox-import-requests") && init?.method === "POST") throw new TypeError("network down");
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);
        await screen.findByText("No import requests.");

        await user.type(screen.getByLabelText("Import mailbox UID"), "mb1");
        await user.tab();
        await screen.findByLabelText("Import destination folder");
        await user.upload(screen.getByLabelText("Upload mail archive"), new File(["..."], "archive.mbox"));

        expect(await screen.findByText("Could not upload this file.")).toBeInTheDocument();
    });

    it("discards a stale initial-load response that resolves after a newer upload-triggered reload", async () => {
        // Same "the Upload button isn't gated behind this section's own `loading`" race as the export
        // section's own equivalent test - a slow initial mount fetch resolving after a faster
        // upload-triggered reload must not revert the list.
        let resolveInitialLoad!: (response: Response) => void;
        let getCallCount = 0;
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder]);
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
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        // This section's own list fetch never resolves in this test, so wait on the mailbox UID field
        // itself (rendered unconditionally) rather than "No import requests." to know the shell has
        // finished its own admin-access check and mounted the page.
        await user.type(await screen.findByLabelText("Import mailbox UID"), "mb1");
        await user.tab();
        await screen.findByLabelText("Import destination folder");
        await user.upload(screen.getByLabelText("Upload mail archive"), new File(["..."], "archive.mbox"));

        // The upload's own reload (the second GET call) resolves and updates `requests`, even though the
        // page still shows "Loading…" until the still-pending initial mount fetch itself settles - confirm
        // the reload actually completed via the mock rather than the DOM, which won't reflect it yet.
        await vi.waitFor(() => expect(getCallCount).toBe(2));

        // Now let the stale initial load resolve with an empty list - it must be discarded rather than
        // overwriting the fresher data once `loading` clears and the list actually renders.
        resolveInitialLoad(jsonResponse(200, []));

        expect(await screen.findByText(/mb1/)).toBeInTheDocument();
        expect(screen.queryByText("No import requests.")).not.toBeInTheDocument();
    });

    it("discards a stale initial-load error that resolves after a newer, successful upload-triggered reload", async () => {
        // Same sequencing guard, exercised on the .catch() side: a slow initial load that eventually
        // fails must not surface its error once a newer reload has already succeeded.
        let resolveInitialLoad!: (response: Response) => void;
        let getCallCount = 0;
        mockShell((url, init) => {
            if (url.startsWith("/api/mail/folders")) return jsonResponse(200, [folder]);
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
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.type(await screen.findByLabelText("Import mailbox UID"), "mb1");
        await user.tab();
        await screen.findByLabelText("Import destination folder");
        await user.upload(screen.getByLabelText("Upload mail archive"), new File(["..."], "archive.mbox"));
        await vi.waitFor(() => expect(getCallCount).toBe(2));

        resolveInitialLoad(jsonResponse(500, { message: "server unavailable" }));

        expect(await screen.findByText(/mb1/)).toBeInTheDocument();
        expect(screen.queryByText("server unavailable")).not.toBeInTheDocument();
    });
});

describe("DataRequestsPage — erasure requests", () => {
    it("shows an empty state", async () => {
        mockShell();
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText("No erasure requests.")).toBeInTheDocument();
    });

    it("shows Approve/Deny only for a pending request, and the denial reason for a denied one", async () => {
        mockShell((url) =>
            url === "/api/mail/erasure-requests?limit=50&page=0"
                ? jsonResponse(200, [erasureRequest({ uid: "e1", status: "pending" }), erasureRequest({ uid: "e2", status: "denied", reason: "not verified" })])
                : undefined,
        );
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText(/not verified/)).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
        expect(screen.getAllByRole("button", { name: "Deny" })).toHaveLength(1);
    });

    it("shows processing exports and an in-progress erasure with a neutral badge, not success, and no Download link (round 5)", async () => {
        mockShell((url) => {
            if (url === "/api/mail/data-export-requests?limit=50&page=0") return jsonResponse(200, [exportRequest({ status: "processing" })]);
            if (url === "/api/mail/erasure-requests?limit=50&page=0") return jsonResponse(200, [erasureRequest({ status: "in_progress" })]);
            return undefined;
        });
        render(<DataRequestsPage userUid="admin-1" />);

        const processing = await screen.findByText("processing");
        expect(processing).toHaveClass("text-text-muted");
        expect(processing).not.toHaveClass("bg-success");
        const inProgress = await screen.findByText("in progress");
        expect(inProgress).toHaveClass("text-text-muted");
        expect(inProgress).not.toHaveClass("bg-success");
        expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
    });

    it("marks a request filed for the data of a deleted mailbox, says where those are started, and offers no review for it", async () => {
        mockShell((url) =>
            url === "/api/mail/erasure-requests?limit=50&page=0"
                ? jsonResponse(200, [
                      erasureRequest({ uid: "e1", mailboxUid: "gone@example.com", status: "approved", leftoverOnly: true }),
                      erasureRequest({ uid: "e2", mailboxUid: "mb2", status: "approved" }),
                  ])
                : undefined,
        );
        render(<DataRequestsPage userUid="admin-1" />);

        const marked = (await screen.findByText(/gone@example.com/)).closest("li")!;
        expect(within(marked).getByText(/Deleted mailbox data/)).toBeInTheDocument();
        expect(within(screen.getByText(/mb2/).closest("li")!).queryByText(/Deleted mailbox data/)).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Mailboxes page" })).toHaveAttribute("href", "/admin");
        expect(screen.queryByText(/there is no admin-initiated path/)).not.toBeInTheDocument();
    });

    it("shows the purged-record count for a completed request", async () => {
        mockShell((url) =>
            url === "/api/mail/erasure-requests?limit=50&page=0" ? jsonResponse(200, [erasureRequest({ status: "completed", purgedCount: 128 })]) : undefined,
        );
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText(/128 records purged/)).toBeInTheDocument();
    });

    it("shows the server's own message when loading erasure requests fails", async () => {
        mockShell((url) => (url === "/api/mail/erasure-requests?limit=50&page=0" ? jsonResponse(500, { message: "server unavailable" }) : undefined));
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText("server unavailable")).toBeInTheDocument();
    });

    it("shows a generic message when loading erasure requests fails with a non-API error", async () => {
        mockShell((url) => {
            if (url === "/api/mail/erasure-requests?limit=50&page=0") throw new TypeError("network down");
            return undefined;
        });
        render(<DataRequestsPage userUid="admin-1" />);
        expect(await screen.findByText("Could not load erasure requests.")).toBeInTheDocument();
    });

    it("approves a pending request and reloads the list", async () => {
        let approved = false;
        mockShell((url, init) => {
            if (url === "/api/mail/erasure-requests/eer1/approve" && init?.method === "POST") {
                approved = true;
                return jsonResponse(200, erasureRequest({ status: "approved" }));
            }
            if (url === "/api/mail/erasure-requests?limit=50&page=0" && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, [erasureRequest({ status: approved ? "approved" : "pending" })]);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Approve" }));
        // Nothing is approved until the irreversible-erasure confirmation, naming the mailbox, is accepted.
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("mb1")).toBeInTheDocument();
        expect(within(dialog).getByText("This is irreversible and cannot be undone.")).toBeInTheDocument();
        expect(approved).toBe(false);
        await user.click(within(dialog).getByRole("button", { name: "Erase mailbox" }));

        expect(await screen.findByText("approved")).toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("cancels the approve confirmation without approving", async () => {
        const fetchMock = mockShell((url) =>
            url === "/api/mail/erasure-requests?limit=50&page=0" ? jsonResponse(200, [erasureRequest()]) : undefined,
        );
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Approve" }));
        await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([url]) => (url as string).endsWith("/approve"))).toBe(false);
    });

    it("shows the server's own message when approval fails, e.g. an active legal hold", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/erasure-requests/eer1/approve" && init?.method === "POST") {
                return jsonResponse(409, { message: "This action is blocked by an active legal hold: matter-1." });
            }
            if (url === "/api/mail/erasure-requests?limit=50&page=0" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [erasureRequest()]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Approve" }));
        await user.click(await screen.findByRole("button", { name: "Erase mailbox" }));

        expect(await screen.findByText("This action is blocked by an active legal hold: matter-1.")).toBeInTheDocument();
    });

    it("shows a generic message when approval fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/erasure-requests/eer1/approve" && init?.method === "POST") throw new TypeError("network down");
            if (url === "/api/mail/erasure-requests?limit=50&page=0" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [erasureRequest()]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Approve" }));
        await user.click(await screen.findByRole("button", { name: "Erase mailbox" }));

        expect(await screen.findByText("Could not approve this request.")).toBeInTheDocument();
    });

    it("opens the deny modal, requires a reason, submits, and reloads the list", async () => {
        let denied = false;
        mockShell((url, init) => {
            if (url === "/api/mail/erasure-requests/eer1/deny" && init?.method === "POST") {
                denied = true;
                expect(JSON.parse(init.body as string)).toEqual({ reason: "not verified" });
                return jsonResponse(200, erasureRequest({ status: "denied", reason: "not verified" }));
            }
            if (url === "/api/mail/erasure-requests?limit=50&page=0" && (init?.method ?? "GET") === "GET") {
                return jsonResponse(200, [erasureRequest(denied ? { status: "denied", reason: "not verified" } : {})]);
            }
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Deny" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByRole("button", { name: "Deny" })).toBeDisabled();
        await user.type(within(dialog).getByLabelText("Denial reason"), "not verified");
        await user.click(within(dialog).getByRole("button", { name: "Deny" }));

        expect(await screen.findByText(/not verified/)).toBeInTheDocument();
    });

    it("closes the deny modal via Cancel without submitting", async () => {
        const fetchMock = mockShell((url) => (url === "/api/mail/erasure-requests?limit=50&page=0" ? jsonResponse(200, [erasureRequest()]) : undefined));
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Deny" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.some(([u, init]) => (u as string).endsWith("/deny") && init?.method === "POST")).toBe(false);
    });

    it("closes the deny modal via its own close button", async () => {
        mockShell((url) => (url === "/api/mail/erasure-requests?limit=50&page=0" ? jsonResponse(200, [erasureRequest()]) : undefined));
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Deny" }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: /close/i }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("shows the server's own message when denial fails", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/erasure-requests/eer1/deny" && init?.method === "POST") {
                return jsonResponse(409, { message: "This request is not pending review." });
            }
            if (url === "/api/mail/erasure-requests?limit=50&page=0" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [erasureRequest()]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Deny" }));
        const dialog = await screen.findByRole("dialog");
        await user.type(within(dialog).getByLabelText("Denial reason"), "not verified");
        await user.click(within(dialog).getByRole("button", { name: "Deny" }));

        expect(await screen.findByText("This request is not pending review.")).toBeInTheDocument();
    });

    it("shows a generic message when denial fails with a non-API error", async () => {
        mockShell((url, init) => {
            if (url === "/api/mail/erasure-requests/eer1/deny" && init?.method === "POST") throw new TypeError("network down");
            if (url === "/api/mail/erasure-requests?limit=50&page=0" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [erasureRequest()]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Deny" }));
        const dialog = await screen.findByRole("dialog");
        await user.type(within(dialog).getByLabelText("Denial reason"), "not verified");
        await user.click(within(dialog).getByRole("button", { name: "Deny" }));

        expect(await screen.findByText("Could not deny this request.")).toBeInTheDocument();
    });

    it("keeps the approve and deny confirmations open while their decision is being sent", async () => {
        const pending: ((response: Response) => void)[] = [];
        mockShell((url, init) => {
            if ((url.endsWith("/approve") || url.endsWith("/deny")) && init?.method === "POST") {
                return new Promise<Response>((resolve) => pending.push(resolve)) as unknown as Response;
            }
            if (url === "/api/mail/erasure-requests?limit=50&page=0" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [erasureRequest()]);
            return undefined;
        });
        const user = userEvent.setup();
        render(<DataRequestsPage userUid="admin-1" />);

        await user.click(await screen.findByRole("button", { name: "Approve" }));
        let dialog = await screen.findByRole("dialog", { name: "Approve erasure request" });
        await user.click(within(dialog).getByRole("button", { name: "Erase mailbox" }));
        await vi.waitFor(() => expect(pending).toHaveLength(1));
        await user.keyboard("{Escape}");
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        expect(screen.getByRole("dialog", { name: "Approve erasure request" })).toBeInTheDocument();
        pending[0](jsonResponse(409, { message: "blocked by a legal hold" }));
        expect(await within(dialog).findByText("blocked by a legal hold")).toBeInTheDocument();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Deny" }));
        dialog = await screen.findByRole("dialog", { name: "Deny erasure request" });
        await user.type(within(dialog).getByLabelText("Denial reason"), "not verified");
        await user.click(within(dialog).getByRole("button", { name: "Deny" }));
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        await user.click(within(dialog).getByRole("button", { name: "Close" }));
        expect(screen.getByRole("dialog", { name: "Deny erasure request" })).toBeInTheDocument();
        pending[1](jsonResponse(409, { message: "not pending" }));
        expect(await within(dialog).findByText("not pending")).toBeInTheDocument();
    });
});
