// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it, vi } from "vitest";

const { isOpenedRecord } = vi.hoisted(() => ({ isOpenedRecord: vi.fn((record: any) => !!record?.opened) }));
vi.mock("../../../lib/zeroAccess/sealedRecords.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/zeroAccess/sealedRecords.js")>()),
    isOpenedRecord,
}));

const { invitationContentOf, protectedEventWrite } = await import("../../../lib/calendar/protectedEvents.js");

const sealedFields = { title: "c", location: "c", description: "c" };
const openedEvent: any = { uid: "e1", mailboxUid: "mb", title: "Board meeting", location: "Room 4", description: "Agenda", descriptionHtml: null, sealedFields, opened: true };
const lockedEvent: any = { uid: "e1", mailboxUid: "mb", title: "Protected event", location: null, description: null, sealedFields };

describe("protectedEvents", () => {
    it("leaves a write to an unprotected event as it is", () => {
        const input = { uid: "e1", version: 1, title: "Same", location: null };
        expect(protectedEventWrite({ ...openedEvent, sealedFields: null }, input)).toBe(input);
        expect(protectedEventWrite(undefined, input)).toBe(input);
    });

    it("sends only the content that changed, with the whole content to invite with", () => {
        expect(protectedEventWrite(openedEvent, { uid: "e1", version: 1, title: "Board meeting", location: "Room 5", description: "Agenda", startDate: "s" })).toEqual({
            uid: "e1",
            version: 1,
            location: "Room 5",
            startDate: "s",
            invitationContent: { title: "Board meeting", location: "Room 5", description: "Agenda", descriptionHtml: undefined },
        });
        // A cleared field is a change, and leaves it out of the invitation.
        expect(protectedEventWrite(openedEvent, { uid: "e1", version: 1, location: null })).toEqual({
            uid: "e1",
            version: 1,
            location: null,
            invitationContent: { title: "Board meeting", location: undefined, description: "Agenda", descriptionHtml: undefined },
        });
    });

    it("never overwrites the sealed content from a device showing placeholders, nor invites with them", () => {
        expect(protectedEventWrite(lockedEvent, { uid: "e1", version: 1, title: "Protected event", location: null, description: "", startDate: "s" })).toEqual({
            uid: "e1",
            version: 1,
            startDate: "s",
        });
        expect(invitationContentOf(lockedEvent)).toBeUndefined();
        expect(invitationContentOf({ ...openedEvent, sealedFields: undefined })).toBeUndefined();
        expect(invitationContentOf({ ...openedEvent, title: "" })).toBeUndefined();
    });
});
