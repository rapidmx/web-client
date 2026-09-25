// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../../testUtils.js";
import EraseLeftoverDataDialog from "../../../../apps/shared/components/admin/mailboxes/EraseLeftoverDataDialog.js";
import { getNotificationsSnapshot } from "../../../../apps/shared/notifications/store.js";

const ADDRESS = "Admin@Powerlevel.gg";
const ERASE_URL = "/api/mail/erasure-requests/leftover";
const request = (status: string, extra: Record<string, unknown> = {}) => ({
    uid: "der1",
    version: 0,
    dateCreated: "2026-01-01T00:00:00.000Z",
    dateModified: "2026-01-01T00:00:00.000Z",
    mailboxUid: "admin@powerlevel.gg",
    requestedByUserUid: "u1",
    status,
    leftoverOnly: true,
    ...extra,
});

afterEach(() => {
    vi.unstubAllGlobals();
});

function renderDialog(props: Partial<React.ComponentProps<typeof EraseLeftoverDataDialog>> = {}) {
    const onClose = vi.fn();
    const onErased = vi.fn();
    const onDone = vi.fn();
    const view = render(
        <EraseLeftoverDataDialog address={ADDRESS} pollIntervalMs={10} onClose={onClose} onErased={onErased} onDone={onDone} {...props} />,
    );
    return { onClose, onErased, onDone, ...view };
}

describe("EraseLeftoverDataDialog", () => {
    it("names the address and what is deleted, says it is irreversible, and will not erase until the address is typed (in any case, trimmed)", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request("approved")));
        const user = userEvent.setup();
        renderDialog();

        const dialog = await screen.findByRole("dialog", { name: "Erase leftover data" });
        expect(within(dialog).getAllByText(ADDRESS).length).toBeGreaterThan(0);
        expect(within(dialog).getByText(/permanently deletes all of it/)).toBeInTheDocument();
        expect(within(dialog).getByText(/mail, drafts and attachments, contacts, calendar events, tasks/)).toBeInTheDocument();
        expect(within(dialog).getByText("This is irreversible and cannot be undone.")).toBeInTheDocument();
        const erase = within(dialog).getByRole("button", { name: "Erase data" });
        expect(erase).toBeDisabled();

        const input = within(dialog).getByLabelText("Type the address to confirm");
        await user.type(input, "admin@powerlevel");
        expect(erase).toBeDisabled();
        await user.type(input, ".gg");
        expect(erase).toBeEnabled();
        await user.clear(input);
        await user.type(input, "  admin@POWERLEVEL.gg ");
        expect(erase).toBeEnabled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("says what is left when it is known, in the singular and the plural", async () => {
        const { unmount } = renderDialog({ counts: { folders: 11, messages: 4 } });
        expect(await screen.findByText(/It still has 11 folders and 4 messages/)).toBeInTheDocument();
        unmount();
        renderDialog({ counts: { folders: 1, messages: 1 } });
        expect(await screen.findByText(/It still has 1 folder and 1 message,/)).toBeInTheDocument();
    });

    it("says what is left in general terms when it is not known", async () => {
        renderDialog();
        expect(await screen.findByText(/It still has its folders and everything stored in them/)).toBeInTheDocument();
    });

    it("Cancel closes it without asking the server anything", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request("approved")));
        const user = userEvent.setup();
        const { onClose } = renderDialog();

        await user.click(await screen.findByRole("button", { name: "Cancel" }));

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("files the erasure for the address as typed, watches it until it is done, then offers the button it was given", async () => {
        // The job's progress is the test's to advance, so each step is seen before the next.
        let current = "approved";
        const fetchMock = mockFetch((url, init) => {
            if (url === ERASE_URL && init.method === "POST") return jsonResponse(200, request("approved"));
            if (url === "/api/mail/erasure-requests/der1") return jsonResponse(200, request(current, { purgedCount: 12 }));
            throw new Error(`unexpected ${init.method} ${url}`);
        });
        const user = userEvent.setup();
        const { onClose, onErased, onDone } = renderDialog({ doneLabel: "Create mailbox" });

        await user.type(await screen.findByLabelText("Type the address to confirm"), ADDRESS);
        await user.click(screen.getByRole("button", { name: "Erase data" }));

        expect(await screen.findByText("Waiting for the erasure to start…")).toBeInTheDocument();
        current = "in_progress";
        expect(await screen.findByText("Erasing the data…")).toBeInTheDocument();
        expect(screen.getByText(/carries on in the background/)).toBeInTheDocument();
        current = "completed";
        const done = await screen.findByRole("button", { name: "Create mailbox" });
        expect(screen.getByText(/The address is free to use again/)).toBeInTheDocument();
        expect(onErased).toHaveBeenCalledTimes(1);
        expect(onErased).toHaveBeenCalledWith(ADDRESS);
        expect(getNotificationsSnapshot().visible.some((n) => n.title === "Leftover data erased")).toBe(true);
        const post = fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
        expect(JSON.parse(post![1].body as string)).toEqual({ mailboxUid: ADDRESS });

        // Its button closes the dialog and then runs what the caller wanted next.
        expect(onClose).not.toHaveBeenCalled();
        await user.click(done);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onDone).toHaveBeenCalledTimes(1);
        // Nothing asks about the request once it is done.
        const asked = fetchMock.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(fetchMock.mock.calls.length).toBe(asked);
    });

    it("erases when Enter is pressed in the field, and its finished button closes it when it was given no other", async () => {
        mockFetch((url, init) => {
            if (url === ERASE_URL && init.method === "POST") return jsonResponse(200, request("completed"));
            if (url === "/api/mail/erasure-requests/der1") return jsonResponse(200, request("completed"));
            throw new Error(`unexpected ${init.method} ${url}`);
        });
        const user = userEvent.setup();
        const { onClose, onDone } = renderDialog({ onDone: undefined });

        await user.type(await screen.findByLabelText("Type the address to confirm"), `${ADDRESS}{Enter}`);
        await user.click(await screen.findByRole("button", { name: "Done" }));

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onDone).not.toHaveBeenCalled();
    });

    it("does not file anything when Enter is pressed before the address matches", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request("approved")));
        const user = userEvent.setup();
        renderDialog();

        await user.type(await screen.findByLabelText("Type the address to confirm"), "admin{Enter}");

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows the server's own words when it refuses - a legal hold names its matter - and lets it be tried again", async () => {
        let refuse = true;
        mockFetch((url, init) => {
            if (url === ERASE_URL && init.method === "POST") {
                return refuse
                    ? jsonResponse(409, { message: "This action is blocked by an active legal hold: matter-1." })
                    : jsonResponse(200, request("completed"));
            }
            if (url === "/api/mail/erasure-requests/der1") return jsonResponse(200, request("completed"));
            throw new Error(`unexpected ${init.method} ${url}`);
        });
        const user = userEvent.setup();
        renderDialog();

        await user.type(await screen.findByLabelText("Type the address to confirm"), ADDRESS);
        await user.click(screen.getByRole("button", { name: "Erase data" }));
        expect(await screen.findByText("This action is blocked by an active legal hold: matter-1.")).toBeInTheDocument();
        // Still asking, with what was typed kept.
        expect(screen.getByLabelText("Type the address to confirm")).toHaveValue(ADDRESS);

        refuse = false;
        await user.click(screen.getByRole("button", { name: "Erase data" }));
        expect(await screen.findByText(/The address is free to use again/)).toBeInTheDocument();
        expect(screen.queryByText(/legal hold/)).not.toBeInTheDocument();
    });

    it("explains a failure that is not an API error", async () => {
        mockFetch(() => {
            throw new TypeError("network down");
        });
        const user = userEvent.setup();
        renderDialog();

        await user.type(await screen.findByLabelText("Type the address to confirm"), ADDRESS);
        await user.click(screen.getByRole("button", { name: "Erase data" }));

        expect(await screen.findByText("Could not start the erasure.")).toBeInTheDocument();
    });

    it("ignores closing while the request that files the erasure is under way", async () => {
        let answer: (response: Response) => void = () => undefined;
        mockFetch((url, init) => {
            if (url === ERASE_URL && init.method === "POST") return new Promise<Response>((resolve) => (answer = resolve));
            return jsonResponse(200, request("completed"));
        });
        const user = userEvent.setup();
        const { onClose } = renderDialog();

        await user.type(await screen.findByLabelText("Type the address to confirm"), ADDRESS);
        await user.click(screen.getByRole("button", { name: "Erase data" }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled());
        expect(screen.getByLabelText("Type the address to confirm")).toBeDisabled();
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).not.toHaveBeenCalled();

        answer(jsonResponse(200, request("completed")));
        expect(await screen.findByText(/The address is free to use again/)).toBeInTheDocument();
    });

    it("says why an erasure was refused", async () => {
        mockFetch((url, init) => {
            if (url === ERASE_URL && init.method === "POST") return jsonResponse(200, request("approved"));
            return jsonResponse(200, request("denied", { reason: "The mailbox exists, so it is not leftover data." }));
        });
        const user = userEvent.setup();
        const { onClose, onErased } = renderDialog();

        await user.type(await screen.findByLabelText("Type the address to confirm"), ADDRESS);
        await user.click(screen.getByRole("button", { name: "Erase data" }));
        expect(await screen.findByText("The mailbox exists, so it is not leftover data.")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "OK" }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onErased).not.toHaveBeenCalled();
    });

    it("says an erasure was refused when the server gave no reason", async () => {
        mockFetch(() => jsonResponse(200, request("denied")));
        renderDialog({ resume: { uid: "der1", status: "approved" } });

        expect(await screen.findByText("The erasure was refused.")).toBeInTheDocument();
    });

    it("watches an erasure that is already filed instead of asking first, and tells the admin when a check fails and is retried", async () => {
        // The connection stays down until the test has seen the warning, so it can't come and go between two looks.
        let connected = false;
        const fetchMock = mockFetch((url, init) => {
            if (url === "/api/mail/erasure-requests/der1") {
                if (!connected) throw new TypeError("network down");
                return jsonResponse(200, request("completed"));
            }
            throw new Error(`unexpected ${init.method} ${url}`);
        });
        const { onErased } = renderDialog({ resume: { uid: "der1", status: "approved" }, doneLabel: "Create mailbox" });

        expect(screen.queryByLabelText("Type the address to confirm")).not.toBeInTheDocument();
        expect(await screen.findByText(/Could not check how far the erasure has got/)).toBeInTheDocument();
        connected = true;
        await waitFor(() => expect(screen.queryByText(/Could not check how far the erasure has got/)).not.toBeInTheDocument());
        expect(await screen.findByRole("button", { name: "Create mailbox" })).toBeInTheDocument();
        expect(onErased).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.every((call) => call[1]?.method !== "POST")).toBe(true);
    });

    it("stops watching when it is closed, and the erasure is left to carry on", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request("in_progress")));
        const user = userEvent.setup();
        const { onClose, onErased, rerender } = renderDialog({ resume: { uid: "der1", status: "in_progress" } });

        expect(await screen.findByText("Erasing the data…")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Stop watching" }));
        expect(onClose).toHaveBeenCalledTimes(1);
        // The owner unmounts it when it is closed; nothing asks about the request after that.
        rerender(<div />);
        const asked = fetchMock.mock.calls.length;
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(fetchMock.mock.calls.length).toBe(asked);
        expect(onErased).not.toHaveBeenCalled();
    });

    it("files nothing when the form is submitted by any means before the address matches", async () => {
        const fetchMock = mockFetch(() => jsonResponse(200, request("approved")));
        renderDialog();

        fireEvent.submit((await screen.findByLabelText("Type the address to confirm")).closest("form")!);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Erase data" })).toBeDisabled();
    });

    it("ignores the answer of a check that was still under way when it was closed - a finished erasure is not announced by a dialog that is gone", async () => {
        let answer: (response: Response) => void = () => undefined;
        mockFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
        const { onErased, unmount } = renderDialog({ resume: { uid: "der1", status: "in_progress" } });
        await waitFor(() => expect(screen.getByText("Erasing the data…")).toBeInTheDocument());

        unmount();
        answer(jsonResponse(200, request("completed")));
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(onErased).not.toHaveBeenCalled();
        expect(getNotificationsSnapshot().visible.some((n) => n.title === "Leftover data erased")).toBe(false);
    });

    it("ignores the failure of a check that was still under way when it was closed", async () => {
        let fail: (error: Error) => void = () => undefined;
        const fetchMock = mockFetch(() => new Promise<Response>((_resolve, reject) => (fail = reject)));
        const { unmount } = renderDialog({ resume: { uid: "der1", status: "in_progress" } });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

        unmount();
        fail(new TypeError("network down"));
        await new Promise((resolve) => setTimeout(resolve, 40));

        // Nothing was asked again.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("can be closed with Escape and its close button while it is only asking", async () => {
        mockFetch(() => jsonResponse(200, request("approved")));
        const user = userEvent.setup();
        const { onClose } = renderDialog();

        await screen.findByRole("dialog", { name: "Erase leftover data" });
        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
