// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import {
    FOLDER_FILTER_THRESHOLD,
    MAX_FOLDER_NAME_LENGTH,
    MOVE_TARGET_TYPES,
    folderNameError,
} from "../../../apps/shared/components/mail/MoveToFolderDialog.js";

// The dialog's own behaviour is exercised through the two places it is used (MessageDetailPane.test.tsx
// and MailSelectionBar.test.tsx). This file covers the name rule on its own, including the length cap -
// which the field's own `maxLength` keeps a reader from ever reaching, but a programmatic caller can.
const BACKSLASH = String.fromCharCode(92);
const SEPARATOR_ERROR = `A folder name can't contain / or ${BACKSLASH}.`;
const existing = [{ uid: "f5", mailboxUid: "mb1", name: "Receipts", type: "user" }] as never;

describe("folderNameError", () => {
    it("accepts a plain name this mailbox doesn't already have", () => {
        expect(folderNameError("Trips", existing)).toBeNull();
        expect(folderNameError("  Trips  ", existing)).toBeNull();
    });

    it("refuses an empty or whitespace-only name", () => {
        expect(folderNameError("", existing)).toBe("Enter a name for the new folder.");
        expect(folderNameError("   ", existing)).toBe("Enter a name for the new folder.");
    });

    it("refuses a name longer than the server would accept", () => {
        expect(folderNameError("x".repeat(MAX_FOLDER_NAME_LENGTH), existing)).toBeNull();
        expect(folderNameError("x".repeat(MAX_FOLDER_NAME_LENGTH + 1), existing)).toBe(
            `A folder name can be at most ${MAX_FOLDER_NAME_LENGTH} characters.`,
        );
    });

    it("refuses a path separator, which would read as a nesting this app never creates", () => {
        expect(folderNameError("Trips/2026", existing)).toBe(SEPARATOR_ERROR);
        expect(folderNameError("Trips" + BACKSLASH + "2026", existing)).toBe(SEPARATOR_ERROR);
    });

    it("refuses a duplicate whatever its case, naming the folder that already exists", () => {
        expect(folderNameError("receipts", existing)).toBe(
            'This mailbox already has a folder called "Receipts". Pick it from the list instead.',
        );
    });

    it("offers every folder type that can hold a message, and no other", () => {
        expect([...MOVE_TARGET_TYPES].sort()).toEqual(
            ["archive", "deleted_items", "drafts", "inbox", "junk", "sent_items", "user"].sort(),
        );
        expect(MOVE_TARGET_TYPES.has("outbox")).toBe(false);
        expect(FOLDER_FILTER_THRESHOLD).toBeGreaterThan(0);
    });
});
