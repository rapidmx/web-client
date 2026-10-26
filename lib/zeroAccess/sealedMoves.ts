///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * A calendar event, contact or task whose content is sealed to its mailbox's zero-access key - field by field (`sealedFields`), as one
 * blob (`sealedContent`, an event from a zero-access invitation) or its photo (`photoSealed`) - can't move to another mailbox: what it
 * keeps sealed is addressed to the mailbox it is in, and the server can't seal it again to the destination's key. restapi refuses such a
 * move with a `409` (`ZeroAccessRouteSealing.refuseSealedMove()`).
 *
 * The record API wrappers (`updateContact()`, `updateCalendarEvent()`, `updateTask()`) refuse it before sending anything when they know the
 * record (`guardSealedMove()`), and turn the server's refusal into the same `SealedMoveError` when they don't - one request, so nothing is
 * left half moved. A UI offering a move asks `canMoveToMailbox()` first, and shows `SealedMoveError`'s message.
 */
import { ApiRequestError } from "../util/api.js";

/** The fields of a record that say whether its content is sealed, and where. */
export interface MovableRecord {
    mailboxUid: string;
    sealedFields?: Record<string, string> | null;
    sealedContent?: unknown;
    photoSealed?: boolean | null;
}

/** What a refused move says. */
export const SEALED_MOVE_MESSAGE =
    "This item is protected by its mailbox's zero-access encryption, so it can't be moved to another mailbox. Create a copy there instead.";

/** `SealedMoveError.code`. */
export const SEALED_MOVE_CODE = "sealed-move";

/** restapi's `ApiErrors.INVALID_REQUEST`, the code of its sealed-move refusal and of its other zero-access refusals (a version conflict,
 * also a `409`, is `api-012`; an identifier already taken, `api-011`). */
export const INVALID_REQUEST_CODE = "api-003";

/** A move of a protected record to another mailbox, refused - by this client before sending it, or by the server. Nothing was written. */
export class SealedMoveError extends ApiRequestError {
    constructor(message: string = SEALED_MOVE_MESSAGE) {
        super(message, 409, SEALED_MOVE_CODE);
        this.name = "SealedMoveError";
    }
}

/** Whether `record` keeps any of its content sealed to its mailbox's key. */
export function isSealedRecord(record: MovableRecord): boolean {
    return (!!record.sealedFields && Object.keys(record.sealedFields).length > 0) || !!record.sealedContent || !!record.photoSealed;
}

/** Whether `record` may move to mailbox `targetMailboxUid`: always within its own mailbox, and to another only when nothing of it is sealed. */
export function canMoveToMailbox(record: MovableRecord, targetMailboxUid: string): boolean {
    return targetMailboxUid === record.mailboxUid || !isSealedRecord(record);
}

/** Whether `err` is restapi's refusal of a sealed record's move. */
export function isSealedMoveRefusal(err: unknown): err is ApiRequestError {
    return err instanceof SealedMoveError || (err instanceof ApiRequestError && err.status === 409 && err.code === INVALID_REQUEST_CODE);
}

/**
 * Runs `write`, a save of a record that sets its `mailboxUid` to `targetMailboxUid` (`undefined`: the save doesn't set it). With `current`,
 * the record as this device has it, a move of a sealed one is refused before anything is sent. A move the server refuses for the same reason
 * rejects with `SealedMoveError` too.
 */
export async function guardSealedMove<T>(current: MovableRecord | undefined, targetMailboxUid: string | undefined, write: () => Promise<T>): Promise<T> {
    if (targetMailboxUid === undefined) {
        return write();
    }
    if (current && !canMoveToMailbox(current, targetMailboxUid)) {
        throw new SealedMoveError();
    }
    try {
        return await write();
    } catch (err) {
        if (current?.mailboxUid !== targetMailboxUid && isSealedMoveRefusal(err) && !(err instanceof SealedMoveError)) {
            throw new SealedMoveError();
        }
        throw err;
    }
}
