// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { usePermanentDelete } from "../../../apps/shared/mail/usePermanentDelete.js";
import type { EmptyFolderOutcome, PurgeOutcome } from "../../../apps/shared/mail/permanentDelete.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";

// The server, and the rest of the page the hook reports to, stood in for.
const api = vi.hoisted(() => ({ purgeMessage: vi.fn(), emptyFolder: vi.fn(), listMessages: vi.fn() }));
vi.mock("@rapidmx/react-shared/mail/mailApi.js", () => api);
const shell = vi.hoisted(() => ({ settle: vi.fn(), track: vi.fn(), refreshFolderCounts: vi.fn() }));
vi.mock("../../../apps/shared/components/mail/layout/MailShell.js", () => ({
    useMailShell: () => ({ trackMessageChange: shell.track, refreshFolderCounts: shell.refreshFolderCounts }),
}));
const index = vi.hoisted(() => ({ removeLocalEntity: vi.fn() }));
vi.mock("../../../apps/shared/search/localIndexRpcClient.js", () => index);

function message(uid: string): Message {
    return { uid, subject: `Subject ${uid}`, mailboxUid: uid === "z" ? "mb2" : "mb1", folderUid: "trash", flags: { read: true } } as Message;
}

const results: { messages?: PurgeOutcome | null; folder?: EmptyFolderOutcome | null } = {};

function Harness({ messages, count }: { messages: Message[]; count?: number }) {
    const permanent = usePermanentDelete();
    return (
        <div>
            <button type="button" onClick={() => void permanent.requestPermanentDelete(messages).then((outcome) => (results.messages = outcome))}>
                ask messages
            </button>
            <button
                type="button"
                onClick={() => void permanent.requestEmptyFolder({ uid: "trash", name: "Deleted Items" }, count).then((outcome) => (results.folder = outcome))}
            >
                ask folder
            </button>
            <span data-testid="busy">{String(permanent.busy)}</span>
            {permanent.dialog}
        </div>
    );
}

const dialog = () => screen.getByRole("dialog");
const dialogGone = () => expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
const titles = () => getNotificationsSnapshot().visible.map((entry) => entry.title);

beforeEach(() => {
    api.purgeMessage.mockReset().mockResolvedValue(undefined);
    api.emptyFolder.mockReset().mockResolvedValue(undefined);
    api.listMessages.mockReset().mockResolvedValue([]);
    shell.settle.mockReset();
    shell.track.mockReset().mockReturnValue({ settle: shell.settle, revert: vi.fn() });
    shell.refreshFolderCounts.mockReset();
    index.removeLocalEntity.mockReset().mockResolvedValue(undefined);
    delete results.messages;
    delete results.folder;
});

describe("usePermanentDelete - messages", () => {
    it("asks first, in a dialog that says how many and that it cannot be undone, and sends nothing until confirmed", async () => {
        const user = userEvent.setup();
        render(<Harness messages={[message("a"), message("b")]} />);

        await user.click(screen.getByRole("button", { name: "ask messages" }));

        expect(await screen.findByRole("dialog", { name: "Delete permanently" })).toBeInTheDocument();
        expect(within(dialog()).getByText("Permanently delete 2 messages? This can't be undone.")).toBeInTheDocument();
        expect(screen.getByTestId("busy")).toHaveTextContent("true");
        expect(api.purgeMessage).not.toHaveBeenCalled();
    });

    it("says one message in the singular", async () => {
        const user = userEvent.setup();
        render(<Harness messages={[message("a")]} />);

        await user.click(screen.getByRole("button", { name: "ask messages" }));

        expect(await screen.findByText("Permanently delete 1 message? This can't be undone.")).toBeInTheDocument();
    });

    it("starts with focus on the dialog, not on the destructive button, so Enter keeps the mail", async () => {
        const user = userEvent.setup();
        render(<Harness messages={[message("a")]} />);

        await user.click(screen.getByRole("button", { name: "ask messages" }));

        await waitFor(() => expect(dialog()).toHaveFocus());
        await user.keyboard("{Enter}");
        expect(dialog()).toBeInTheDocument();
        expect(api.purgeMessage).not.toHaveBeenCalled();
    });

    it("can be confirmed from the keyboard: Tab to the destructive button, then Enter", async () => {
        const user = userEvent.setup();
        render(<Harness messages={[message("a")]} />);
        await user.click(screen.getByRole("button", { name: "ask messages" }));
        await waitFor(() => expect(dialog()).toHaveFocus());

        await user.tab();
        await user.tab();
        await user.tab();
        expect(within(dialog()).getByRole("button", { name: "Delete permanently" })).toHaveFocus();
        await user.keyboard("{Enter}");

        await waitFor(() => expect(results.messages).toMatchObject({ deleted: [{ uid: "a" }] }));
    });

    it("sends nothing and resolves null when the reader cancels", async () => {
        const user = userEvent.setup();
        render(<Harness messages={[message("a")]} />);
        await user.click(screen.getByRole("button", { name: "ask messages" }));

        await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Cancel" }));

        await waitFor(dialogGone);
        await waitFor(() => expect(results.messages).toBeNull());
        expect(api.purgeMessage).not.toHaveBeenCalled();
        expect(shell.track).not.toHaveBeenCalled();
        expect(screen.getByTestId("busy")).toHaveTextContent("false");
    });

    it("cancels with Escape too", async () => {
        const user = userEvent.setup();
        render(<Harness messages={[message("a")]} />);
        await user.click(screen.getByRole("button", { name: "ask messages" }));
        await screen.findByRole("dialog");

        await user.keyboard("{Escape}");

        await waitFor(dialogGone);
        expect(results.messages).toBeNull();
        expect(api.purgeMessage).not.toHaveBeenCalled();
    });

    it("deletes on confirm, follows the folder badges and the local index, says how many went, and resolves what came of it", async () => {
        const user = userEvent.setup();
        render(<Harness messages={[message("a"), message("z")]} />);
        await user.click(screen.getByRole("button", { name: "ask messages" }));

        await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Delete permanently" }));

        await waitFor(() => expect(results.messages).toMatchObject({ deleted: [{ uid: "a" }, { uid: "z" }], failed: [] }));
        dialogGone();
        expect(api.purgeMessage.mock.calls.map((call) => call[0]).sort()).toEqual(["a", "z"]);
        // Each message is one fewer in its folder - deleted, not moved.
        expect(shell.track.mock.calls.map(([previous, next]) => [previous.uid, next])).toEqual([
            ["a", null],
            ["z", null],
        ]);
        expect(shell.settle).toHaveBeenCalledTimes(2);
        expect(index.removeLocalEntity.mock.calls).toEqual([
            ["mb1", "a"],
            ["mb2", "z"],
        ]);
        expect(titles()).toEqual(["2 messages permanently deleted"]);
        expect(screen.getByTestId("busy")).toHaveTextContent("false");
    });

    it("reports the messages the server refused and follows the badges only for those that went", async () => {
        api.purgeMessage.mockImplementation(async (uid: string) => {
            if (uid === "b") throw new ApiRequestError("This action is blocked by an active legal hold: m1.", 409);
        });
        const user = userEvent.setup();
        render(<Harness messages={[message("a"), message("b")]} />);
        await user.click(screen.getByRole("button", { name: "ask messages" }));

        await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Delete permanently" }));

        await waitFor(() => expect(results.messages).toMatchObject({ deleted: [{ uid: "a" }], failed: [{ message: { uid: "b" }, status: 409 }] }));
        expect(titles()).toEqual(["1 deleted, 1 could not be deleted"]);
        expect(shell.track).toHaveBeenCalledTimes(1);
        expect(index.removeLocalEntity).toHaveBeenCalledTimes(1);
    });

    it("holds the dialog - neither dismissed nor confirmed again - while the delete is on the wire", async () => {
        let finish!: () => void;
        api.purgeMessage.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
        const user = userEvent.setup();
        render(<Harness messages={[message("a")]} />);
        await user.click(screen.getByRole("button", { name: "ask messages" }));
        await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Delete permanently" }));

        await waitFor(() => expect(api.purgeMessage).toHaveBeenCalledTimes(1));
        expect(within(dialog()).getByRole("button", { name: "Cancel" })).toBeDisabled();
        expect(within(dialog()).getByRole("button", { name: "Delete permanently" })).toBeDisabled();
        fireEvent.keyDown(document, { key: "Escape" });
        fireEvent.mouseDown(dialog().parentElement!);
        expect(dialog()).toBeInTheDocument();
        expect(results.messages).toBeUndefined();

        await act(async () => finish());
        await waitFor(() => expect(results.messages).toMatchObject({ deleted: [{ uid: "a" }] }));
        dialogGone();
    });

    it("does not open a second dialog for a second request, and resolves it null without sending anything", async () => {
        const user = userEvent.setup();
        render(<Harness messages={[message("a")]} />);
        await user.click(screen.getByRole("button", { name: "ask messages" }));
        await screen.findByRole("dialog");

        await user.click(screen.getByRole("button", { name: "ask folder", hidden: true }));

        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        await waitFor(() => expect(results.folder).toBeNull());
        expect(api.emptyFolder).not.toHaveBeenCalled();
    });

    it("has nothing to ask about an empty list", async () => {
        const user = userEvent.setup();
        render(<Harness messages={[]} />);

        await user.click(screen.getByRole("button", { name: "ask messages" }));

        await waitFor(() => expect(results.messages).toBeNull());
        dialogGone();
    });
});

describe("usePermanentDelete - empty folder", () => {
    it("asks with the count when it is known, and empties the folder in one request on confirm", async () => {
        const user = userEvent.setup();
        render(<Harness messages={[]} count={12} />);

        await user.click(screen.getByRole("button", { name: "ask folder" }));

        expect(await screen.findByRole("dialog", { name: "Empty Deleted Items" })).toBeInTheDocument();
        expect(within(dialog()).getByText("Permanently delete all 12 items in Deleted Items? This can't be undone.")).toBeInTheDocument();
        expect(api.emptyFolder).not.toHaveBeenCalled();

        await user.click(within(dialog()).getByRole("button", { name: "Delete all permanently" }));

        await waitFor(() => expect(results.folder).toEqual({ emptied: true, deleted: [], failed: [] }));
        expect(api.emptyFolder).toHaveBeenCalledWith("trash");
        expect(shell.refreshFolderCounts).toHaveBeenCalledTimes(1);
        expect(titles()).toEqual(["12 messages permanently deleted"]);
        dialogGone();
    });

    it("says the only item, and all items when the count is not known", async () => {
        const user = userEvent.setup();
        const { rerender } = render(<Harness messages={[]} count={1} />);
        await user.click(screen.getByRole("button", { name: "ask folder" }));
        expect(await screen.findByText("Permanently delete the only item in Deleted Items? This can't be undone.")).toBeInTheDocument();
        await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
        await waitFor(dialogGone);

        rerender(<Harness messages={[]} />);
        await user.click(screen.getByRole("button", { name: "ask folder" }));
        expect(await screen.findByText("Permanently delete all items in Deleted Items? This can't be undone.")).toBeInTheDocument();
    });

    it("sends nothing when the reader cancels", async () => {
        const user = userEvent.setup();
        render(<Harness messages={[]} count={3} />);
        await user.click(screen.getByRole("button", { name: "ask folder" }));

        await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Cancel" }));

        await waitFor(() => expect(results.folder).toBeNull());
        expect(api.emptyFolder).not.toHaveBeenCalled();
        expect(shell.refreshFolderCounts).not.toHaveBeenCalled();
    });

    it("deletes message by message when the server refused the whole folder, following the badges of those that went", async () => {
        api.emptyFolder.mockRejectedValue(new ApiRequestError("This action is blocked by an active legal hold: m1.", 409));
        api.listMessages.mockResolvedValue([message("a"), message("b")]);
        api.purgeMessage.mockImplementation(async (uid: string) => {
            if (uid === "b") throw new ApiRequestError("This action is blocked by an active legal hold: m1.", 409);
        });
        const user = userEvent.setup();
        render(<Harness messages={[]} count={2} />);
        await user.click(screen.getByRole("button", { name: "ask folder" }));

        await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Delete all permanently" }));

        await waitFor(() => expect(results.folder).toMatchObject({ emptied: false, deleted: [{ uid: "a" }], failed: [{ message: { uid: "b" } }] }));
        expect(shell.track).toHaveBeenCalledTimes(1);
        expect(index.removeLocalEntity).toHaveBeenCalledWith("mb1", "a");
        expect(shell.refreshFolderCounts).toHaveBeenCalledTimes(1);
        expect(titles()).toEqual(["1 deleted, 1 could not be deleted"]);
    });

    it("says so, and resolves an outcome with nothing deleted, when the request failed outright", async () => {
        api.emptyFolder.mockRejectedValue(new ApiRequestError("Internal error", 500));
        const user = userEvent.setup();
        render(<Harness messages={[]} count={2} />);
        await user.click(screen.getByRole("button", { name: "ask folder" }));

        await user.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Delete all permanently" }));

        await waitFor(() => expect(results.folder).toEqual({ emptied: false, deleted: [], failed: [] }));
        expect(titles()).toEqual(["Couldn't empty Deleted Items"]);
        expect(shell.refreshFolderCounts).toHaveBeenCalledTimes(1);
        dialogGone();
    });
});
