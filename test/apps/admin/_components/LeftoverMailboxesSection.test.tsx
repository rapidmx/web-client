// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import LeftoverMailboxesSection from "../../../../apps/shared/components/admin/mailboxes/LeftoverMailboxesSection.js";

const LIST_URL = "/api/mail/mailboxes/leftover?limit=50";
const ERASE_URL = "/api/mail/erasure-requests/leftover";

const leftover = (address: string, extra: Record<string, unknown> = {}) => ({ mailboxUid: address, folderCount: 11, messageCount: 4, ...extra });
const request = (status: string, mailboxUid = "gone@example.com", extra: Record<string, unknown> = {}) => ({
    uid: "der1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid,
    requestedByUserUid: "u1",
    status,
    leftoverOnly: true,
    ...extra,
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("LeftoverMailboxesSection", () => {
    it("renders nothing at all while there is nothing left", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { items: [] }));
        const { container } = render(<LeftoverMailboxesSection />);

        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(LIST_URL, expect.anything()));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(container).toBeEmptyDOMElement();
    });

    it("lists each deleted mailbox with its folders and messages, and an Erase data button for it", async () => {
        mockFetch(() => jsonResponse(200, { items: [leftover("gone@example.com"), leftover("other@example.com", { folderCount: 2, messageCount: 0 })] }));
        render(<LeftoverMailboxesSection />);

        const section = await screen.findByRole("region", { name: "Deleted mailboxes with remaining data" });
        expect(within(section).getByText(/can.t be used for a new mailbox until that data is erased/)).toBeInTheDocument();
        const rows = within(within(section).getByRole("table")).getAllByRole("row");
        expect(rows).toHaveLength(3);
        expect(within(rows[1]).getByText("gone@example.com")).toBeInTheDocument();
        expect(within(rows[1]).getByText("11")).toBeInTheDocument();
        expect(within(rows[1]).getByText("4")).toBeInTheDocument();
        expect(within(rows[1]).getByText("Not erased")).toBeInTheDocument();
        expect(within(rows[2]).getByText("other@example.com")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Erase data of gone@example.com" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Erase data of other@example.com" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    });

    it("erases one after its address is typed, shows the erasure finish, and takes the row away", async () => {
        let erased = false;
        const fetchMock = mockFetch((url, init) => {
            if (url === LIST_URL) return jsonResponse(200, { items: erased ? [leftover("other@example.com")] : [leftover("gone@example.com"), leftover("other@example.com")] });
            if (url === ERASE_URL && init.method === "POST") return jsonResponse(200, request("approved"));
            if (url === "/api/mail/erasure-requests/der1") {
                erased = true;
                return jsonResponse(200, request("completed"));
            }
            throw new Error(`unexpected ${init.method} ${url}`);
        });
        const user = userEvent.setup();
        render(<LeftoverMailboxesSection pollIntervalMs={10} />);

        await user.click(await screen.findByRole("button", { name: "Erase data of gone@example.com" }));
        const dialog = await screen.findByRole("dialog", { name: "Erase leftover data" });
        expect(within(dialog).getByText(/It still has 11 folders and 4 messages/)).toBeInTheDocument();
        await user.type(within(dialog).getByLabelText("Type the address to confirm"), "gone@example.com");
        await user.click(within(dialog).getByRole("button", { name: "Erase data" }));

        expect(await within(dialog).findByText(/The address is free to use again/)).toBeInTheDocument();
        // The list was asked again, and the row is gone while the finished message is still up.
        await waitFor(() => expect(screen.queryByRole("button", { name: "Erase data of gone@example.com" })).not.toBeInTheDocument());
        expect(screen.getByRole("button", { name: "Erase data of other@example.com" })).toBeInTheDocument();
        expect(JSON.parse(fetchMock.mock.calls.find((call) => call[1]?.method === "POST")![1].body as string)).toEqual({ mailboxUid: "gone@example.com" });

        await user.click(within(dialog).getByRole("button", { name: "Done" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("keeps the finished message up when the last one is erased, and shows nothing once it is closed", async () => {
        let erased = false;
        mockFetch((url, init) => {
            if (url === LIST_URL) return jsonResponse(200, { items: erased ? [] : [leftover("gone@example.com")] });
            if (url === ERASE_URL && init.method === "POST") return jsonResponse(200, request("approved"));
            if (url === "/api/mail/erasure-requests/der1") {
                erased = true;
                return jsonResponse(200, request("completed"));
            }
            throw new Error(`unexpected ${init.method} ${url}`);
        });
        const user = userEvent.setup();
        const { container } = render(<LeftoverMailboxesSection pollIntervalMs={10} />);

        await user.click(await screen.findByRole("button", { name: "Erase data of gone@example.com" }));
        await user.type(screen.getByLabelText("Type the address to confirm"), "gone@example.com");
        await user.click(screen.getByRole("button", { name: "Erase data" }));

        expect(await screen.findByText(/The address is free to use again/)).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole("region")).not.toBeInTheDocument());
        await user.click(screen.getByRole("button", { name: "Done" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(container).toBeEmptyDOMElement();
    });

    it("shows an erasure that is under way, opens it without asking again, and refreshes itself until the row is gone", async () => {
        // The erasure ends when the test says, not after a number of requests.
        let finished = false;
        let asked = 0;
        const fetchMock = mockFetch((url, init) => {
            if (url === LIST_URL) {
                asked++;
                return jsonResponse(200, {
                    items: finished ? [] : [leftover("gone@example.com", { erasure: { uid: "der1", status: "in_progress", dateCreated: "2026-01-01T00:00:00.000Z" } })],
                });
            }
            if (url === "/api/mail/erasure-requests/der1") return jsonResponse(200, request("in_progress"));
            throw new Error(`unexpected ${init.method} ${url}`);
        });
        const user = userEvent.setup();
        render(<LeftoverMailboxesSection refreshIntervalMs={20} pollIntervalMs={10} />);

        const row = (await screen.findByText("gone@example.com")).closest("tr")!;
        expect(within(row).getByText("Erasing")).toBeInTheDocument();
        await user.click(within(row).getByRole("button", { name: "Show the erasure of gone@example.com" }));
        const dialog = await screen.findByRole("dialog", { name: "Erase leftover data" });
        expect(await within(dialog).findByText("Erasing the data…")).toBeInTheDocument();
        expect(within(dialog).queryByLabelText("Type the address to confirm")).not.toBeInTheDocument();
        expect(fetchMock.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);

        // The list refreshes while it runs, and the row goes when the server stops listing it.
        await waitFor(() => expect(asked).toBeGreaterThanOrEqual(3));
        expect(screen.getByRole("button", { name: "Show the erasure of gone@example.com" })).toBeInTheDocument();
        finished = true;
        await waitFor(() => expect(screen.queryByRole("button", { name: "Show the erasure of gone@example.com" })).not.toBeInTheDocument());
        expect(screen.queryByText("Erasing")).not.toBeInTheDocument();
    });

    it("treats an erasure that finished or was refused as not erased - the data is still listed, so it can be erased again", async () => {
        mockFetch(() =>
            jsonResponse(200, {
                items: [
                    leftover("done@example.com", { erasure: { uid: "d1", status: "completed", dateCreated: "2026-01-01T00:00:00.000Z" } }),
                    leftover("denied@example.com", { erasure: { uid: "d2", status: "denied", dateCreated: "2026-01-01T00:00:00.000Z" } }),
                ],
            }),
        );
        render(<LeftoverMailboxesSection />);

        expect(await screen.findByRole("button", { name: "Erase data of done@example.com" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Erase data of denied@example.com" })).toBeInTheDocument();
        expect(screen.getAllByText("Not erased")).toHaveLength(2);
        expect(screen.queryByText("Erasing")).not.toBeInTheDocument();
    });

    it("reloads the list when the dialog is closed without erasing", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, { items: [leftover("gone@example.com")] }));
        const user = userEvent.setup();
        render(<LeftoverMailboxesSection />);

        await user.click(await screen.findByRole("button", { name: "Erase data of gone@example.com" }));
        const listCalls = () => fetchMock.mock.calls.filter((call) => call[0] === LIST_URL).length;
        expect(listCalls()).toBe(1);
        await user.click(await screen.findByRole("button", { name: "Cancel" }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await waitFor(() => expect(listCalls()).toBe(2));
    });

    it("pages: Load more asks after the last address, appends what is new and hides the button at the end", async () => {
        const fetchMock = mockFetch((url) => {
            if (url === LIST_URL) return jsonResponse(200, { items: [leftover("a@example.com"), leftover("b@example.com")], next: "b@example.com" });
            if (url === `${LIST_URL}&after=b%40example.com`) return jsonResponse(200, { items: [leftover("b@example.com"), leftover("c@example.com")] });
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<LeftoverMailboxesSection />);

        await user.click(await screen.findByRole("button", { name: "Load more" }));

        expect(await screen.findByText("c@example.com")).toBeInTheDocument();
        expect(screen.getAllByText("b@example.com")).toHaveLength(1);
        expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("says why loading more failed and keeps what is listed", async () => {
        mockFetch((url) => {
            if (url === LIST_URL) return jsonResponse(200, { items: [leftover("a@example.com")], next: "a@example.com" });
            return jsonResponse(500, { message: "boom" });
        });
        const user = userEvent.setup();
        render(<LeftoverMailboxesSection />);

        await user.click(await screen.findByRole("button", { name: "Load more" }));

        expect(await screen.findByText("boom")).toBeInTheDocument();
        expect(screen.getByText("a@example.com")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
    });

    it("says why loading more failed when it is not an API error", async () => {
        mockFetch((url) => {
            if (url === LIST_URL) return jsonResponse(200, { items: [leftover("a@example.com")], next: "a@example.com" });
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        render(<LeftoverMailboxesSection />);

        await user.click(await screen.findByRole("button", { name: "Load more" }));

        expect(await screen.findByText("Could not load more deleted mailboxes.")).toBeInTheDocument();
    });

    it("says why the check failed - the server's own words, or a general one - instead of showing nothing", async () => {
        mockFetch(() => jsonResponse(403, { message: "This operation requires elevation." }));
        const { unmount } = render(<LeftoverMailboxesSection />);
        expect(await screen.findByText("This operation requires elevation.")).toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Deleted mailboxes with remaining data" })).toBeInTheDocument();
        expect(screen.queryByRole("table")).not.toBeInTheDocument();
        unmount();

        mockFetch(() => {
            throw new TypeError("network down");
        });
        render(<LeftoverMailboxesSection />);
        expect(await screen.findByText("Could not check for deleted mailboxes with remaining data.")).toBeInTheDocument();
    });

    it("applies only the newest list: a slow earlier answer can't put back a row a later one already removed", async () => {
        const erasing = { erasure: { uid: "der1", status: "in_progress", dateCreated: "2026-01-01T00:00:00.000Z" } };
        let slow: (response: Response) => void = () => undefined;
        let asked = 0;
        mockFetch((url) => {
            if (url !== LIST_URL) throw new Error(`unexpected ${url}`);
            asked++;
            if (asked === 1) return jsonResponse(200, { items: [leftover("gone@example.com", erasing)] });
            // The second refresh is slow; the third (the next tick of the interval) answers at once, and the row is gone.
            if (asked === 2) return new Promise<Response>((resolve) => (slow = resolve));
            return jsonResponse(200, { items: [] });
        });
        render(<LeftoverMailboxesSection refreshIntervalMs={20} />);

        await screen.findByText("gone@example.com");
        await waitFor(() => expect(screen.queryByText("gone@example.com")).not.toBeInTheDocument());
        slow(jsonResponse(200, { items: [leftover("gone@example.com", erasing)] }));
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(screen.queryByText("gone@example.com")).not.toBeInTheDocument();
    });

    it("drops a page that Load more fetched when the list was reloaded meanwhile", async () => {
        const erasing = { erasure: { uid: "der1", status: "in_progress", dateCreated: "2026-01-01T00:00:00.000Z" } };
        let more: (response: Response) => void = () => undefined;
        let refreshes = 0;
        mockFetch((url) => {
            if (url === LIST_URL) {
                refreshes++;
                return jsonResponse(200, { items: [leftover("a@example.com", erasing)], next: "a@example.com" });
            }
            if (url === `${LIST_URL}&after=a%40example.com`) return new Promise<Response>((resolve) => (more = resolve));
            throw new Error(`unexpected ${url}`);
        });
        const user = userEvent.setup();
        render(<LeftoverMailboxesSection refreshIntervalMs={20} />);

        await user.click(await screen.findByRole("button", { name: "Load more" }));
        const before = refreshes;
        await waitFor(() => expect(refreshes).toBeGreaterThan(before));
        more(jsonResponse(200, { items: [leftover("late@example.com")] }));
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(screen.queryByText("late@example.com")).not.toBeInTheDocument();
    });

    it("can be used from the keyboard alone: the erase buttons are reachable by Tab and open the confirmation with Enter", async () => {
        mockFetch(() => jsonResponse(200, { items: [leftover("gone@example.com")] }));
        const user = userEvent.setup();
        render(<LeftoverMailboxesSection />);

        const button = await screen.findByRole("button", { name: "Erase data of gone@example.com" });
        await user.tab();
        expect(button).toHaveFocus();
        await user.keyboard("{Enter}");

        expect(await screen.findByRole("dialog", { name: "Erase leftover data" })).toBeInTheDocument();
    });
});
