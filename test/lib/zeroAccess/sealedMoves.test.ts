// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Moving protected contacts, events and tasks to another mailbox: refused before sending, or from the server's 409, never half done.
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch } from "../testUtils.js";
import { updateCalendarEvent } from "../../../lib/calendar/calendarApi.js";
import { updateContact } from "../../../lib/contacts/contactsApi.js";
import { updateTask } from "../../../lib/tasks/tasksApi.js";
import { ApiRequestError } from "../../../lib/util/api.js";
import {
    SEALED_MOVE_CODE,
    SEALED_MOVE_MESSAGE,
    SealedMoveError,
    canMoveToMailbox,
    guardSealedMove,
    isSealedMoveRefusal,
    isSealedRecord,
} from "../../../lib/zeroAccess/sealedMoves.js";

const refusal = () =>
    jsonResponse(409, { code: "api-003", message: "This item's details are sealed to its mailbox's zero-access key, so it can't be moved to another mailbox." });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("sealed moves", () => {
    it("knows a record sealed field by field, as one blob or by its photo, and lets it move only within its mailbox", () => {
        expect(isSealedRecord({ mailboxUid: "a" })).toBe(false);
        expect(isSealedRecord({ mailboxUid: "a", sealedFields: {} })).toBe(false);
        expect(isSealedRecord({ mailboxUid: "a", sealedFields: { title: "c" } })).toBe(true);
        expect(isSealedRecord({ mailboxUid: "a", sealedContent: { sealed: "c" } })).toBe(true);
        expect(isSealedRecord({ mailboxUid: "a", photoSealed: true })).toBe(true);

        expect(canMoveToMailbox({ mailboxUid: "a", photoSealed: true }, "a")).toBe(true);
        expect(canMoveToMailbox({ mailboxUid: "a", photoSealed: true }, "b")).toBe(false);
        expect(canMoveToMailbox({ mailboxUid: "a" }, "b")).toBe(true);
    });

    it("tells the server's refusal from a version conflict", () => {
        expect(isSealedMoveRefusal(new ApiRequestError("sealed", 409, "api-003"))).toBe(true);
        expect(isSealedMoveRefusal(new SealedMoveError())).toBe(true);
        expect(isSealedMoveRefusal(new ApiRequestError("stale", 409, "api-012"))).toBe(false);
        expect(isSealedMoveRefusal(new ApiRequestError("bad", 400, "api-003"))).toBe(false);
        expect(isSealedMoveRefusal(new Error("x"))).toBe(false);
        const err = new SealedMoveError();
        expect([err.status, err.code, err.message, err.name]).toEqual([409, SEALED_MOVE_CODE, SEALED_MOVE_MESSAGE, "SealedMoveError"]);
    });

    it("guards only a write that sets a mailbox, and passes any other failure through", async () => {
        const write = vi.fn(async () => "ok");
        expect(await guardSealedMove({ mailboxUid: "a", sealedFields: { x: "c" } }, undefined, write)).toBe("ok");
        expect(await guardSealedMove({ mailboxUid: "a", sealedFields: { x: "c" } }, "a", write)).toBe("ok");
        await expect(guardSealedMove({ mailboxUid: "a", sealedFields: { x: "c" } }, "b", write)).rejects.toBeInstanceOf(SealedMoveError);
        expect(write).toHaveBeenCalledTimes(2);

        const stale = new ApiRequestError("stale", 409, "api-012");
        await expect(guardSealedMove(undefined, "b", () => Promise.reject(stale))).rejects.toBe(stale);
        // The same mailbox: a 409 there isn't a move's refusal.
        const same = new ApiRequestError("x", 409, "api-003");
        await expect(guardSealedMove({ mailboxUid: "b" }, "b", () => Promise.reject(same))).rejects.toBe(same);
    });

    it("refuses moving a protected contact before sending anything, and turns the server's refusal into the same error", async () => {
        const fetchMock = mockFetch(() => refusal());
        const contact: any = { uid: "c1", version: 2, mailboxUid: "mb1", folderUid: "f1", displayName: "Ann", photoSealed: true };

        await expect(updateContact({ uid: "c1", version: 2, mailboxUid: "mb2", folderUid: "f2" }, undefined, contact)).rejects.toThrow(SEALED_MOVE_MESSAGE);
        expect(fetchMock).not.toHaveBeenCalled();

        const err = await updateContact({ uid: "c1", version: 2, mailboxUid: "mb2", folderUid: "f2" }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SealedMoveError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("lets an unprotected contact move, and leaves a save that doesn't move one alone", async () => {
        const saved = { uid: "c1", version: 3, mailboxUid: "mb2" };
        const fetchMock = mockFetch(() => jsonResponse(200, saved));
        expect(await updateContact({ uid: "c1", version: 2, mailboxUid: "mb2" }, undefined, { mailboxUid: "mb1" } as any)).toEqual(saved);
        expect(await updateContact({ uid: "c1", version: 2, displayName: "Ann" }, undefined, { mailboxUid: "mb1", photoSealed: true } as any)).toEqual(saved);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("refuses moving a protected task, up front or from the server", async () => {
        const fetchMock = mockFetch(() => refusal());
        const task: any = { uid: "t1", version: 1, mailboxUid: "mb1", folderUid: "f1", title: "[...]", sealedFields: { title: "c" } };

        await expect(updateTask({ uid: "t1", version: 1, mailboxUid: "mb2", folderUid: "f2" }, undefined, task)).rejects.toBeInstanceOf(SealedMoveError);
        expect(fetchMock).not.toHaveBeenCalled();
        await expect(updateTask({ uid: "t1", version: 1, mailboxUid: "mb2", folderUid: "f2" })).rejects.toBeInstanceOf(SealedMoveError);
        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(init.body)).toMatchObject({ mailboxUid: "mb2", folderUid: "f2" });
    });

    it("refuses moving an event made from a zero-access invitation before opening or sending anything, and maps the server's refusal", async () => {
        const fetchMock = mockFetch(() => refusal());
        const event: any = {
            uid: "e1",
            version: 0,
            mailboxUid: "mb1",
            folderUid: "f1",
            title: "[...]",
            startDate: "2026-01-05T09:00:00.000Z",
            endDate: "2026-01-05T09:30:00.000Z",
            attendees: [],
            sealedContent: { keyFingerprint: "fp", sealed: "c" },
        };

        await expect(updateCalendarEvent({ uid: "e1", version: 0, mailboxUid: "mb2", folderUid: "f2" }, undefined, event)).rejects.toBeInstanceOf(SealedMoveError);
        expect(fetchMock).not.toHaveBeenCalled();
        await expect(updateCalendarEvent({ uid: "e1", version: 0, mailboxUid: "mb2", folderUid: "f2" })).rejects.toBeInstanceOf(SealedMoveError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
