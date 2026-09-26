// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import {
    EMPTIABLE_FOLDER_TYPES,
    PURGE_CONCURRENCY,
    messageCount,
    notifyFolderEmptied,
    notifyPurged,
    purgeFolder,
    purgeMessages,
} from "../../../apps/shared/mail/permanentDelete.js";
import { getNotificationsSnapshot } from "../../../apps/shared/notifications/store.js";

// The server, stood in for: what `purgeMessage()`/`emptyFolder()`/`listMessages()` answer is the test's to decide.
const api = vi.hoisted(() => ({ purgeMessage: vi.fn(), emptyFolder: vi.fn(), listMessages: vi.fn() }));
vi.mock("@rapidmx/react-shared/mail/mailApi.js", () => api);

function message(uid: string, subject = `Subject ${uid}`): Message {
    return { uid, subject, mailboxUid: "mb1", folderUid: "trash" } as Message;
}

const refusal = (status: number, text: string) => new ApiRequestError(text, status);
const HOLD = "This action is blocked by an active legal hold: matter-1.";

beforeEach(() => {
    api.purgeMessage.mockReset().mockResolvedValue(undefined);
    api.emptyFolder.mockReset().mockResolvedValue(undefined);
    api.listMessages.mockReset().mockResolvedValue([]);
});

const shown = () => getNotificationsSnapshot().visible;

describe("messageCount", () => {
    it("counts one message and several", () => {
        expect(messageCount(1)).toBe("1 message");
        expect(messageCount(3)).toBe("3 messages");
        expect(messageCount(0)).toBe("0 messages");
    });
});

describe("EMPTIABLE_FOLDER_TYPES", () => {
    it("is Deleted Items and Junk Email, as in Outlook", () => {
        expect([...EMPTIABLE_FOLDER_TYPES]).toEqual(["deleted_items", "junk"]);
    });
});

describe("purgeMessages", () => {
    it("deletes each message with its own request and reports them all deleted", async () => {
        const outcome = await purgeMessages([message("a"), message("b"), message("c")]);

        expect(api.purgeMessage.mock.calls.map((call) => call[0]).sort()).toEqual(["a", "b", "c"]);
        expect(outcome.deleted.map((m) => m.uid)).toEqual(["a", "b", "c"]);
        expect(outcome.failed).toEqual([]);
    });

    it("sends nothing for nothing", async () => {
        expect(await purgeMessages([])).toEqual({ deleted: [], failed: [] });
        expect(api.purgeMessage).not.toHaveBeenCalled();
    });

    it("carries on past a refused message and says which one and why, in the order given", async () => {
        api.purgeMessage.mockImplementation(async (uid: string) => {
            if (uid === "b") throw refusal(409, HOLD);
            if (uid === "d") throw refusal(403, "Forbidden");
        });

        const outcome = await purgeMessages([message("a"), message("b"), message("c"), message("d")]);

        expect(outcome.deleted.map((m) => m.uid)).toEqual(["a", "c"]);
        expect(outcome.failed.map((f) => [f.message.uid, f.reason, f.status])).toEqual([
            ["b", HOLD, 409],
            ["d", "Forbidden", 403],
        ]);
    });

    it("stands a reason in when the server's refusal had none, and when it could not be reached at all", async () => {
        api.purgeMessage.mockImplementation(async (uid: string) => {
            throw uid === "a" ? refusal(500, "") : new TypeError("Failed to fetch");
        });

        const outcome = await purgeMessages([message("a"), message("b")]);

        expect(outcome.failed.map((f) => [f.reason, f.status])).toEqual([
            ["The server answered 500.", 500],
            ["The server couldn't be reached.", undefined],
        ]);
    });

    it("keeps no more than a few requests on the wire at once", async () => {
        let inFlight = 0;
        let peak = 0;
        api.purgeMessage.mockImplementation(async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight--;
        });

        await purgeMessages(Array.from({ length: PURGE_CONCURRENCY * 3 }, (_, i) => message(`m${i}`)));

        expect(peak).toBe(PURGE_CONCURRENCY);
    });
});

describe("purgeFolder", () => {
    it("empties the folder with one request, and never lists it", async () => {
        const outcome = await purgeFolder("trash");

        expect(api.emptyFolder).toHaveBeenCalledWith("trash");
        expect(api.listMessages).not.toHaveBeenCalled();
        expect(outcome).toEqual({ emptied: true, deleted: [], failed: [] });
    });

    it("falls back to message by message when the server refuses the whole folder over a legal hold", async () => {
        api.emptyFolder.mockRejectedValue(refusal(409, HOLD));
        api.listMessages.mockResolvedValue([message("a"), message("b")]);
        api.purgeMessage.mockImplementation(async (uid: string) => {
            if (uid === "b") throw refusal(409, HOLD);
        });

        const outcome = await purgeFolder("trash");

        expect(api.listMessages).toHaveBeenCalledWith("trash", { limit: 500, page: 0 });
        expect(outcome.deleted.map((m) => m.uid)).toEqual(["a"]);
        expect(outcome.failed.map((f) => f.message.uid)).toEqual(["b"]);
        expect(outcome.emptied).toBe(false);
    });

    it("falls back the same way for a delegate who may delete messages but not empty a folder (403), and can then empty it", async () => {
        api.emptyFolder.mockRejectedValue(refusal(403, "Forbidden"));
        api.listMessages.mockResolvedValue([message("a"), message("b")]);

        const outcome = await purgeFolder("trash");

        expect(outcome.deleted.map((m) => m.uid)).toEqual(["a", "b"]);
        expect(outcome.emptied).toBe(true);
    });

    it("lists every page of a big folder before deleting", async () => {
        api.emptyFolder.mockRejectedValue(refusal(409, HOLD));
        api.listMessages.mockImplementation(async (_folder: string, params: { page: number }) =>
            params.page === 0 ? [message("a"), message("b")] : params.page === 1 ? [message("c")] : [],
        );

        const outcome = await purgeFolder("trash", { pageSize: 2, maxPages: 5 });

        expect(outcome.deleted.map((m) => m.uid)).toEqual(["a", "b", "c"]);
        expect(outcome.emptied).toBe(true);
    });

    it("is not emptied when the listing was cut short, though nothing it listed was refused", async () => {
        api.emptyFolder.mockRejectedValue(refusal(409, HOLD));
        api.listMessages.mockResolvedValue([message("a"), message("b")]);

        const outcome = await purgeFolder("trash", { pageSize: 2, maxPages: 1 });

        expect(outcome.deleted).toHaveLength(2);
        expect(outcome.emptied).toBe(false);
    });

    it("rejects for a failure that is not a refusal - the server is down, or the folder is not found", async () => {
        api.emptyFolder.mockRejectedValue(refusal(500, "boom"));
        await expect(purgeFolder("trash")).rejects.toMatchObject({ status: 500 });

        api.emptyFolder.mockRejectedValue(new TypeError("Failed to fetch"));
        await expect(purgeFolder("trash")).rejects.toBeInstanceOf(TypeError);
        expect(api.listMessages).not.toHaveBeenCalled();
    });
});

describe("notifyPurged", () => {
    it("says how many were permanently deleted, with no Undo", () => {
        notifyPurged({ deleted: [message("a"), message("b")], failed: [] });

        expect(shown()).toHaveLength(1);
        expect(shown()[0]).toMatchObject({ kind: "success", title: "2 messages permanently deleted" });
        expect(shown()[0].actions).toEqual([]);
    });

    it("says one message in the singular", () => {
        notifyPurged({ deleted: [message("a")], failed: [] });
        expect(shown()[0].title).toBe("1 message permanently deleted");
    });

    it("reports the ones that could not be deleted beside the ones that were, with the server's reason for each", () => {
        notifyPurged({
            deleted: [message("a")],
            failed: [
                { message: message("b", "Contract"), reason: HOLD, status: 409 },
                { message: message("c", ""), reason: "Forbidden", status: 403 },
                { message: message("d", "[...]"), reason: HOLD, status: 409 },
            ],
        });

        const [entry] = shown();
        expect(entry).toMatchObject({ kind: "warning", title: "1 deleted, 3 could not be deleted", sticky: true });
        expect(entry.message).toBe(`${HOLD} Forbidden`);
        expect(entry.details).toEqual([`Contract: ${HOLD}`, "(no subject): Forbidden", `Encrypted message: ${HOLD}`]);
    });

    it("is an error, naming the reason, when none could be deleted", () => {
        notifyPurged({ deleted: [], failed: [{ message: message("b"), reason: HOLD, status: 409 }] });
        expect(shown()[0]).toMatchObject({ kind: "error", title: "Couldn't permanently delete that message", message: HOLD });

        notifyPurged({
            deleted: [],
            failed: [
                { message: message("b"), reason: HOLD, status: 409 },
                { message: message("c"), reason: HOLD, status: 409 },
            ],
        });
        expect(shown().map((entry) => entry.title)).toContain("Couldn't permanently delete those messages");
    });

    it("names the first few reasons and counts the rest", () => {
        notifyPurged({
            deleted: [],
            failed: ["r1", "r2", "r3", "r4", "r5"].map((reason, i) => ({ message: message(`m${i}`), reason })),
        });

        expect(shown()[0].message).toBe("r1 r2 r3 (and 2 more reasons)");
    });

    it("is the session-expired pop-up, once, when the session ended part-way", () => {
        notifyPurged({
            deleted: [],
            failed: [
                { message: message("a"), reason: "Unauthorized", status: 401 },
                { message: message("b"), reason: "Unauthorized", status: 401 },
            ],
        });

        expect(shown().map((entry) => entry.title)).toEqual(["Your session expired"]);
    });
});

describe("notifyFolderEmptied", () => {
    it("says how many messages went when that was known", () => {
        notifyFolderEmptied("Deleted Items", { emptied: true, deleted: [], failed: [] }, 12);

        expect(shown()[0]).toMatchObject({ kind: "success", title: "12 messages permanently deleted", message: "Deleted Items is now empty." });
    });

    it("says the folder was emptied when the count was not known", () => {
        notifyFolderEmptied("Junk Email", { emptied: true, deleted: [], failed: [] });

        expect(shown()[0]).toMatchObject({ kind: "success", title: "Junk Email emptied", message: "Everything in it was permanently deleted." });
    });

    it("reports a folder deleted message by message as a delete of those messages", () => {
        notifyFolderEmptied("Deleted Items", { emptied: false, deleted: [message("a")], failed: [{ message: message("b"), reason: HOLD, status: 409 }] }, 9);

        expect(shown()).toHaveLength(1);
        expect(shown()[0]).toMatchObject({ kind: "warning", title: "1 deleted, 1 could not be deleted" });
    });

    it("says so when a very big folder is not empty yet, though nothing was refused", () => {
        notifyFolderEmptied("Deleted Items", { emptied: false, deleted: [message("a")], failed: [] });

        expect(shown().map((entry) => entry.title)).toEqual(["1 message permanently deleted", "Deleted Items is not empty yet"]);
    });

    it("reports a folder deleted message by message, all of them, as a delete of those messages", () => {
        notifyFolderEmptied("Deleted Items", { emptied: true, deleted: [message("a"), message("b")], failed: [] });

        expect(shown().map((entry) => entry.title)).toEqual(["2 messages permanently deleted"]);
    });

    it("is not emptied yet, and says so, when nothing at all could be listed to delete", () => {
        notifyFolderEmptied("Deleted Items", { emptied: false, deleted: [], failed: [] });

        expect(shown().map((entry) => entry.title)).toEqual(["0 messages permanently deleted", "Deleted Items is not empty yet"]);
    });
});
